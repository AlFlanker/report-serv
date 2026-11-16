import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './legacy/database.mjs';
import { createS3Storage } from './legacy/s3-storage.mjs';

const IMPORT_REASON = 'sqlite-import';
const CHUNK_BYTES = 64 * 1024;
const JOB_COLUMNS = ['id', 'report_id', 'parameters', 'status', 'stage', 'created_at',
  'started_at', 'completed_at', 'expires_at', 'result_metadata', 'error_json', 'ready_at'];

/** One-time, read-only source import. Runtime does not depend on SQLite. */
export async function migrateSqlite({ sourcePath, databaseUrl, databaseSchema, storage: providedStorage, now = () => new Date() } = {}) {
  if (!sourcePath) throw new Error('SQLite source path is required (--source PATH).');
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  let target;
  let storage;
  let committed = false;
  const uploadedKeys = [];
  try {
    // A single read snapshot also protects against an accidental concurrent old
    // process. Stop that process before migration so no later writes are lost.
    source.exec('BEGIN');
    const tables = new Set(source.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    for (const table of ['settings', 'jobs', 'notifications']) {
      if (!tables.has(table)) throw new Error(`SQLite source is missing the ${table} table.`);
    }
    const settings = new Map(source.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value]));
    storage = providedStorage ?? createS3Storage();
    const originalBucket = settings.get('object_bucket');
    if (originalBucket && originalBucket !== storage.bucket) throw new Error('S3_BUCKET differs from the bucket associated with the SQLite source.');
    settings.set('object_bucket', storage.bucket);
    if (!settings.has('object_namespace')) settings.set('object_namespace', randomUUID());
    if (!settings.has('object_prefix')) settings.set('object_prefix', storage.prefix ?? 'reports/');
    // An imported empty cabinet must remain empty instead of receiving demo jobs.
    settings.set('initialized', '1');

    target = await openDatabase({ connectionString: databaseUrl, schema: databaseSchema, acquireLock: true });
    const occupied = await target.query(`SELECT
      EXISTS(SELECT 1 FROM settings) OR EXISTS(SELECT 1 FROM jobs) OR
      EXISTS(SELECT 1 FROM notifications) OR
      EXISTS(SELECT 1 FROM object_cleanup WHERE reason<>$1) AS occupied`, [IMPORT_REASON]);
    if (occupied.rows[0].occupied) throw new Error('PostgreSQL target is not empty. Use a new database/schema; existing data was not changed.');
    await storage.check();

    // A terminated earlier import may have left a completed object. These
    // records are durable and contain only that import's unique keys; source
    // objects and ordinary service cleanup records are never touched here.
    const abandoned = await target.query('SELECT object_key,bucket FROM object_cleanup WHERE reason=$1', [IMPORT_REASON]);
    for (const entry of abandoned.rows) {
      if (entry.bucket !== storage.bucket) throw new Error('An unfinished import belongs to another S3 bucket; its cleanup records were preserved.');
      await storage.delete(entry.object_key);
      await target.query('DELETE FROM object_cleanup WHERE object_key=$1 AND reason=$2', [entry.object_key, IMPORT_REASON]);
    }

    const columns = new Set(source.prepare('PRAGMA table_info(jobs)').all().map(row => row.name));
    const hasFiles = columns.has('file');
    const jobs = source.prepare(`SELECT ${JOB_COLUMNS.join(',')}${hasFiles ? ',length(file) AS file_size' : ',NULL AS file_size'} FROM jobs ORDER BY id`);
    const readChunk = hasFiles ? source.prepare('SELECT substr(file,?,?) AS chunk FROM jobs WHERE id=?') : null;
    const prefix = settings.get('object_prefix').replace(/^\/+|\/+$/g, '');
    const importNamespace = `${prefix ? `${prefix}/` : ''}migration-${randomUUID()}/`;
    const stats = { jobs: 0, notifications: 0, cleanupRecords: 0, uploadedFiles: 0, schema: target.schema };

    await target.transaction(async client => {
      for (const [key, value] of settings) {
        await client.query('INSERT INTO settings(key,value) VALUES($1,$2)', [key, value]);
      }
      for (const row of jobs.iterate()) {
        let metadata = row.result_metadata ? JSON.parse(row.result_metadata) : null;
        if (metadata?.bucket && metadata.bucket !== storage.bucket) throw new Error(`Job ${row.id} references another S3 bucket.`);
        const expired = row.expires_at && Date.parse(row.expires_at) <= now().getTime();
        if (row.status === 'completed' && !expired && row.file_size !== null) {
          const key = `${importNamespace}report-${row.id}-${row.report_id}.xlsx`;
          // Written outside the import transaction: a crash or rollback must
          // not lose the cleanup intent for an already transmitted S3 object.
          await target.query('INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES($1,$2,$3,$4)',
            [key, storage.bucket, IMPORT_REASON, now().toISOString()]);
          uploadedKeys.push(key);
          async function* chunks() {
            for (let offset = 1; offset <= row.file_size; offset += CHUNK_BYTES) {
              yield readChunk.get(offset, CHUNK_BYTES, row.id).chunk;
            }
          }
          const uploaded = await storage.upload(key, async (output, signal) => {
            await pipeline(Readable.from(chunks(), { objectMode: false }), output, { signal });
            return { rowCount: metadata?.rowCount ?? 0 };
          });
          metadata = { ...metadata, fileName: metadata?.fileName ?? `report-${row.id}-${row.report_id}.xlsx`,
            rowCount: uploaded.rowCount, sizeBytes: uploaded.sizeBytes, storage: 's3',
            bucket: uploaded.bucket, key: uploaded.key, ...(uploaded.etag && { etag: uploaded.etag }) };
          stats.uploadedFiles++;
        } else if (row.status === 'completed' && !expired && !metadata?.key) {
          throw new Error(`Completed job ${row.id} has neither an S3 key nor a legacy file.`);
        }
        const values = JOB_COLUMNS.map(column => column === 'result_metadata' ? (metadata && JSON.stringify(metadata)) : row[column]);
        await client.query(`INSERT INTO jobs(${JOB_COLUMNS.join(',')}) VALUES(${JOB_COLUMNS.map((_, index) => `$${index + 1}`).join(',')})`, values);
        stats.jobs++;
      }
      for (const row of source.prepare('SELECT id,job_id,title,created_at,is_read FROM notifications ORDER BY id').iterate()) {
        await client.query('INSERT INTO notifications(id,job_id,title,created_at,is_read) VALUES($1,$2,$3,$4,$5)',
          [row.id, row.job_id, row.title, row.created_at, Boolean(row.is_read)]);
        stats.notifications++;
      }
      if (tables.has('object_cleanup')) {
        for (const row of source.prepare('SELECT object_key,bucket,reason,created_at FROM object_cleanup').iterate()) {
          if (row.bucket !== storage.bucket) throw new Error('A SQLite cleanup record references another S3 bucket.');
          await client.query('INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES($1,$2,$3,$4)',
            [row.object_key, row.bucket, row.reason, row.created_at]);
          stats.cleanupRecords++;
        }
      }
      for (const table of ['jobs', 'notifications']) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE(MAX(id),1),MAX(id) IS NOT NULL) FROM ${table}`,
          [`${target.schema}.${table}`]);
      }
      for (const key of uploadedKeys) await client.query('DELETE FROM object_cleanup WHERE object_key=$1 AND reason=$2', [key, IMPORT_REASON]);
    });
    committed = true;
    return stats;
  } finally {
    if (!committed && target && storage) {
      for (const key of uploadedKeys) {
        try {
          // A lost COMMIT response is ambiguous. Never delete an object if
          // PostgreSQL already committed its job, or cannot confirm the intent.
          const pending = await target.query(`SELECT EXISTS(SELECT 1 FROM object_cleanup WHERE object_key=$1 AND reason=$2)
            AND NOT EXISTS(SELECT 1 FROM jobs WHERE result_metadata->>'key'=$1) AS pending`, [key, IMPORT_REASON]);
          if (!pending.rows[0].pending) continue;
          await storage.delete(key);
          await target.query('DELETE FROM object_cleanup WHERE object_key=$1 AND reason=$2', [key, IMPORT_REASON]);
        } catch { /* Keep the durable record for retry, or service cleanup after restart. */ }
      }
    }
    source.close();
    await target?.close();
    if (!providedStorage) await storage?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i] === '--source' ? 'sourcePath' : args[i] === '--schema' ? 'databaseSchema' : null;
      if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) throw new Error('Usage: npm run db:migrate:sqlite -- --source PATH [--schema SCHEMA]');
      options[name] = args[i + 1];
    }
    console.log('SQLite import completed:', JSON.stringify(await migrateSqlite(options)));
  } catch (error) {
    console.error('SQLite import failed:', error.message);
    process.exitCode = 1;
  }
}
