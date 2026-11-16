import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { migrateSqlite } from '../scripts/migrate-sqlite.mjs';
import { postgresFixture } from './test-support/postgres.mjs';
import { createFakeStorage } from './test-support/fake-storage.mjs';

const now = () => new Date('2026-11-16T10:00:00Z');
const timestamp = '2026-11-15T10:00:00.000Z';
const key = 'original-namespace/report-13-turnovers.xlsx';
const hash = value => createHash('sha256').update(value).digest('hex');

async function sourceFor(t, { file, secondStatus = 'queued' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'report-sqlite-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.sqlite');
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,report_id TEXT NOT NULL,
        parameters TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,created_at TEXT NOT NULL,
        started_at TEXT,completed_at TEXT,expires_at TEXT,result_metadata TEXT,error_json TEXT,ready_at TEXT,file BLOB);
      CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL,
        title TEXT NOT NULL,created_at TEXT NOT NULL,is_read INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE object_cleanup (object_key TEXT PRIMARY KEY,bucket TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    for (const [name, value] of Object.entries({ initialized: '1', object_namespace: 'original-namespace', object_prefix: 'reports/', object_bucket: 'test-reports' })) {
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(name, value);
    }
    db.prepare('INSERT INTO jobs(id,report_id,parameters,status,stage,created_at,completed_at,expires_at,result_metadata,file) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      13, 'turnovers', JSON.stringify({ department: '6000', startDate: '2026-10-01', endDate: '2026-10-31', account: '03210001234' }),
      'completed', 'Готово к скачиванию', timestamp, timestamp, '2026-11-22T10:00:00.000Z',
      JSON.stringify({ fileName: 'original.xlsx', sizeBytes: file?.length ?? 100, rowCount: 7,
        ...(!file && { key, storage: 's3', bucket: 'test-reports' }) }), file ?? null,
    );
    db.prepare('INSERT INTO jobs(id,report_id,parameters,status,stage,created_at) VALUES(?,?,?,?,?,?)').run(
      17, 'operations', JSON.stringify({ department: '6000', startDate: '2026-11-01', endDate: '2026-11-15' }),
      secondStatus, 'Ожидает запуска', timestamp,
    );
    db.prepare('INSERT INTO notifications(id,job_id,title,created_at,is_read) VALUES(?,?,?,?,?)').run(24, 13, 'Отчет готов', timestamp, 0);
    db.prepare('INSERT INTO notifications(id,job_id,title,created_at,is_read) VALUES(?,?,?,?,?)').run(25, 13, 'Прочитанное уведомление', timestamp, 1);
    db.prepare('INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES(?,?,?,?)').run('old-pending-key', 'test-reports', 'expired', timestamp);
  } finally { db.close(); }
  return { sourcePath, bytes: await readFile(sourcePath) };
}

test('SQLite import preserves IDs, JSON, timestamps, notifications and S3 references, and refuses an occupied target', async t => {
  const database = await postgresFixture(t);
  const source = await sourceFor(t);
  const storage = createFakeStorage();
  storage.objects.set(key, Buffer.from('existing S3 object'));
  storage.objects.set('old-pending-key', Buffer.from('pending cleanup belongs to source'));
  const result = await migrateSqlite({ ...source, ...database, storage, now });
  assert.deepEqual(result, { jobs: 2, notifications: 2, cleanupRecords: 1, uploadedFiles: 0, schema: database.databaseSchema });
  const job = (await database.query('SELECT * FROM jobs WHERE id=13')).rows[0];
  assert.equal(job.parameters.account, '03210001234');
  assert.equal(job.result_metadata.key, key);
  assert.equal(job.created_at.toISOString(), timestamp);
  assert.equal(job.result_metadata.rowCount, 7);
  const notifications = (await database.query('SELECT id,is_read FROM notifications ORDER BY id')).rows;
  assert.deepEqual(notifications, [{ id: 24, is_read: false }, { id: 25, is_read: true }]);
  assert.equal((await database.query("SELECT value FROM settings WHERE key='object_namespace'")).rows[0].value, 'original-namespace');
  assert.equal((await database.query('SELECT reason FROM object_cleanup')).rows[0].reason, 'expired');
  assert.deepEqual(storage.deleted, [], 'existing objects and source cleanup intents are never executed during import');
  const nextJob = await database.query("INSERT INTO jobs(report_id,parameters,status,stage,created_at) VALUES('operations','{}','queued','queued',now()) RETURNING id");
  assert.equal(nextJob.rows[0].id, 18);
  const nextNotification = await database.query("INSERT INTO notifications(job_id,title,created_at) VALUES(13,'new',now()) RETURNING id");
  assert.equal(nextNotification.rows[0].id, 26);
  await assert.rejects(migrateSqlite({ ...source, ...database, storage, now }), /target is not empty/);
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM jobs')).rows[0].count, 3);
  assert.equal(hash(await readFile(source.sourcePath)), hash(source.bytes), 'source SQLite must be byte-identical');
});

test('SQLite BLOB import streams bounded slices into new S3 keys without changing the source', async t => {
  const database = await postgresFixture(t);
  const file = randomBytes(3 * 64 * 1024 + 123);
  const source = await sourceFor(t, { file });
  const storage = createFakeStorage();
  storage.objects.set(key, Buffer.from('must survive'));
  const result = await migrateSqlite({ ...source, ...database, storage, now });
  assert.equal(result.uploadedFiles, 1);
  const metadata = (await database.query('SELECT result_metadata FROM jobs WHERE id=13')).rows[0].result_metadata;
  assert.match(metadata.key, /^reports\/migration-[a-f0-9-]+\/report-13-turnovers\.xlsx$/);
  assert.equal(metadata.fileName, 'original.xlsx');
  assert.equal(metadata.sizeBytes, file.length);
  assert.equal(hash(storage.objects.get(metadata.key)), hash(file));
  assert.equal(storage.objects.get(key).toString(), 'must survive');
  assert.equal(storage.uploadChunkSizes.length, 4);
  assert.ok(storage.uploadChunkSizes.every(size => size <= 64 * 1024));
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM object_cleanup WHERE reason='sqlite-import'")).rows[0].count, 0);
  assert.equal(hash(await readFile(source.sourcePath)), hash(source.bytes));
});

test('SQLite import rollback removes only newly uploaded objects when PostgreSQL rejects a later row', async t => {
  const database = await postgresFixture(t);
  const source = await sourceFor(t, { file: randomBytes(100_000), secondStatus: 'invalid' });
  const storage = createFakeStorage();
  storage.objects.set(key, Buffer.from('existing object'));
  await assert.rejects(migrateSqlite({ ...source, ...database, storage, now }), error => error.code === '23514');
  for (const table of ['settings', 'jobs', 'notifications', 'object_cleanup']) {
    assert.equal((await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
  assert.equal(storage.objects.size, 1);
  assert.equal(storage.objects.get(key).toString(), 'existing object');
  assert.equal(storage.deleted.length, 1);
  assert.notEqual(storage.deleted[0], key);
  assert.equal(hash(await readFile(source.sourcePath)), hash(source.bytes));
});

test('failed import cleanup remains durable and a retry clears it before importing again', async t => {
  const database = await postgresFixture(t);
  const source = await sourceFor(t, { file: randomBytes(100_000) });
  const storage = createFakeStorage();
  const upload = storage.upload.bind(storage);
  const remove = storage.delete.bind(storage);
  storage.upload = async (...args) => { await upload(...args); throw new Error('upload response lost'); };
  storage.delete = async () => { throw new Error('S3 unavailable'); };
  await assert.rejects(migrateSqlite({ ...source, ...database, storage, now }), /upload response lost/);
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM jobs')).rows[0].count, 0);
  const orphan = (await database.query('SELECT * FROM object_cleanup')).rows[0];
  assert.equal(orphan.reason, 'sqlite-import');
  assert.ok(storage.objects.has(orphan.object_key));
  storage.upload = upload;
  storage.delete = remove;
  const result = await migrateSqlite({ ...source, ...database, storage, now });
  assert.equal(result.jobs, 2);
  assert.ok(!storage.objects.has(orphan.object_key));
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM object_cleanup WHERE reason='sqlite-import'")).rows[0].count, 0);
  assert.equal(hash(await readFile(source.sourcePath)), hash(source.bytes));
});
