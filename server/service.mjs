import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { reports, departments, HttpError, validateCreate, nextNightWindow, inNightWindow, isoDate, moscowDate } from './domain.mjs';
import { writeWorkbook } from './workbook.mjs';
import { createS3Storage } from './s3-storage.mjs';

const JOB_METADATA = 'id,report_id,parameters,status,stage,created_at,started_at,completed_at,expires_at,result_metadata,error_json,ready_at';

function positiveInteger(value, fallback, name, maximum = 365) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

export async function createService(options = {}) {
  const now = options.now ?? (() => new Date());
  const dbPath = options.dbPath ?? process.env['DB_PATH'] ?? '.data/reports.sqlite';
  const maxPeriodDays = positiveInteger(options.maxPeriodDays ?? process.env['MAX_PERIOD_DAYS'], 31, 'MAX_PERIOD_DAYS');
  const retentionDays = positiveInteger(options.retentionDays ?? process.env['RETENTION_DAYS'], 7, 'RETENTION_DAYS');
  const processingDelayMs = options.processingDelayMs ?? 4000;
  const storage = options.storage ?? createS3Storage();
  const ownsStorage = !options.storage;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, parameters TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, expires_at TEXT, result_metadata TEXT,
      error_json TEXT, ready_at TEXT, file BLOB
    );
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS object_cleanup (
      object_key TEXT PRIMARY KEY, bucket TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const remember = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key, value);
  remember('object_namespace', randomUUID());
  remember('object_prefix', options.storagePrefix ?? storage.prefix ?? 'reports/');
  const namespace = setting('object_namespace');
  const prefix = setting('object_prefix').replace(/^\/+|\/+$/g, '');
  const objectKey = (id, reportId) => `${prefix ? `${prefix}/` : ''}${namespace}/report-${id}-${reportId}.xlsx`;
  // Recovered jobs reuse their object key. An upload intent remains durable until
  // S3 completion and the job metadata/notification transaction both succeed.
  db.prepare("UPDATE jobs SET status='queued',stage='Ожидает запуска',ready_at=NULL WHERE status='running'").run();

  function present(row) {
    if (!row) throw new HttpError(404, 'JOB_NOT_FOUND', 'Задание не найдено.');
    const report = reports.find(item => item.id === row.report_id);
    return {
      id: row.id, reportId: row.report_id, reportName: report.name,
      parameters: JSON.parse(row.parameters), status: row.status, stage: row.stage,
      createdAt: row.created_at,
      ...(row.started_at && { startedAt: row.started_at }),
      ...(row.completed_at && { completedAt: row.completed_at }),
      ...(row.expires_at && { expiresAt: row.expires_at }),
      ...(row.result_metadata && { result: publicResult(JSON.parse(row.result_metadata)) }),
      ...(row.error_json && { error: JSON.parse(row.error_json) }),
      ...(row.status === 'queued' && report.nightOnly && { nextWindow: nextNightWindow(now()) }),
    };
  }

  function publicResult(result) {
    return { fileName: result.fileName, sizeBytes: result.sizeBytes, rowCount: result.rowCount };
  }

  function registerCleanup(key, reason = 'upload') {
    db.prepare('INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET reason=excluded.reason')
      .run(key, storage.bucket, reason, now().toISOString());
  }

  async function cleanupObject(entry) {
    if (entry.bucket !== storage.bucket) throw new Error('S3_BUCKET does not match the stored object bucket');
    await storage.delete(entry.object_key);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (entry.reason === 'expired') {
        for (const row of db.prepare("SELECT id,result_metadata FROM jobs WHERE status='completed' AND expires_at<=? AND result_metadata IS NOT NULL").all(now().toISOString())) {
          const metadata = JSON.parse(row.result_metadata);
          if (metadata.key === entry.object_key) {
            metadata.objectDeletedAt = now().toISOString();
            db.prepare('UPDATE jobs SET result_metadata=? WHERE id=?').run(JSON.stringify(metadata), row.id);
          }
        }
      }
      db.prepare('DELETE FROM object_cleanup WHERE object_key=?').run(entry.object_key);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async function cleanupPending() {
    for (const entry of db.prepare('SELECT * FROM object_cleanup ORDER BY created_at LIMIT 20').all()) {
      try { await cleanupObject(entry); }
      catch { /* Retain the durable intent; retry on the next worker tick/restart. */ }
    }
  }

  async function cleanExpired() {
    for (const row of db.prepare("SELECT result_metadata FROM jobs WHERE status='completed' AND expires_at<=? AND result_metadata IS NOT NULL").all(now().toISOString())) {
      const metadata = JSON.parse(row.result_metadata);
      if (metadata.key && !metadata.objectDeletedAt) registerCleanup(metadata.key, 'expired');
    }
    await cleanupPending();
  }

  function resultMetadata(row, uploaded) {
    return { fileName: `report-${row.id}-${row.report_id}.xlsx`, sizeBytes: uploaded.sizeBytes,
      rowCount: uploaded.rowCount, storage: 's3', bucket: uploaded.bucket, key: uploaded.key,
      ...(uploaded.etag && { etag: uploaded.etag }) };
  }

  async function uploadReport(row, signal) {
    const key = objectKey(row.id, row.report_id);
    registerCleanup(key);
    const report = reports.find(item => item.id === row.report_id);
    return storage.upload(key, (output, uploadSignal) => writeWorkbook(report, JSON.parse(row.parameters), output, { signal: uploadSignal }), { signal });
  }

  async function migrateLegacyFiles() {
    const rows = db.prepare(`SELECT ${JOB_METADATA},length(file) AS file_size FROM jobs WHERE file IS NOT NULL`).all();
    const readChunk = db.prepare('SELECT substr(file,?,?) AS chunk FROM jobs WHERE id=?');
    for (const row of rows) {
      if (row.status !== 'completed' || (row.expires_at && row.expires_at <= now().toISOString())) {
        db.prepare('UPDATE jobs SET file=NULL WHERE id=?').run(row.id);
        continue;
      }
      const previous = JSON.parse(row.result_metadata);
      const key = objectKey(row.id, row.report_id);
      registerCleanup(key);
      // substr reads a bounded slice through SQLite; SELECT file would materialize
      // the entire legacy workbook in the JS heap before uploading it.
      async function* chunks() {
        for (let offset = 1; offset <= row.file_size; offset += 65536) {
          yield readChunk.get(offset, 65536, row.id).chunk;
        }
      }
      const uploaded = await storage.upload(key, async (output, signal) => {
        await pipeline(Readable.from(chunks(), { objectMode: false }), output, { signal });
        return { rowCount: previous.rowCount };
      });
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE jobs SET result_metadata=?,file=NULL WHERE id=?')
          .run(JSON.stringify({ ...resultMetadata(row, uploaded), fileName: previous.fileName }), row.id);
        db.prepare('DELETE FROM object_cleanup WHERE object_key=?').run(key);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }

  function getJob(id) { return present(db.prepare(`SELECT ${JOB_METADATA} FROM jobs WHERE id=?`).get(id)); }

  function insertJob(report, parameters, createdAt = now().toISOString()) {
    const stage = report.nightOnly && !inNightWindow(now()) ? 'Ожидает окна запуска' : 'Ожидает запуска';
    const result = db.prepare("INSERT INTO jobs(report_id,parameters,status,stage,created_at) VALUES(?,?,'queued',?,?)")
      .run(report.id, JSON.stringify(parameters), stage, createdAt);
    return getJob(Number(result.lastInsertRowid));
  }

  function complete(row, uploaded, completedAt, notify = true) {
    const expiresAt = new Date(Date.parse(completedAt) + retentionDays * 86400000).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE jobs SET status='completed',stage='Готово к скачиванию',completed_at=?,expires_at=?,result_metadata=?,file=NULL,ready_at=NULL WHERE id=?")
        .run(completedAt, expiresAt, JSON.stringify(resultMetadata(row, uploaded)), row.id);
      if (notify) db.prepare('INSERT INTO notifications(job_id,title,created_at) VALUES(?,?,?)')
        .run(row.id, `Отчет по заданию №${row.id} готов к скачиванию`, completedAt);
      db.prepare('DELETE FROM object_cleanup WHERE object_key=?').run(uploaded.key);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function fail(row, code, message, completedAt, notify = true) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE jobs SET status='failed',stage='Файл не создан',completed_at=?,error_json=?,ready_at=NULL,file=NULL WHERE id=?")
        .run(completedAt, JSON.stringify({ code, message, at: completedAt }), row.id);
      if (notify) db.prepare('INSERT INTO notifications(job_id,title,created_at) VALUES(?,?,?)')
        .run(row.id, `Не удалось сформировать отчет по заданию №${row.id}`, completedAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async function seed() {
    const created = now().getTime();
    const period = { startDate: '2026-11-01', endDate: '2026-11-15', department: '6000' };
    const seeds = [
      { id: 1043, reportId: 'reconciliation', parameters: { ...period, endDate: '2026-11-14' }, status: 'completed', offset: 23 * 3600000 },
      { id: 1044, reportId: 'balances', parameters: { asOfDate: '2026-11-15', department: '6000' }, status: 'completed', offset: 22 * 3600000 },
      { id: 1045, reportId: 'payments', parameters: period, status: 'failed', offset: 25 * 60000 },
      { id: 1046, reportId: 'turnovers', parameters: { startDate: '2026-10-01', endDate: '2026-10-31', department: '6000', account: '03210001234' }, status: 'completed', offset: 10 * 60000 },
      { id: 1047, reportId: 'obligations', parameters: period, status: 'running', offset: 3 * 60000 },
      { id: 1048, reportId: 'operations', parameters: period, status: 'queued', offset: 60000 },
    ];
    const prepared = [];
    // Stream one demo file at a time. Only metadata is retained for the final
    // transaction; upload intents survive startup failure and allow cleanup.
    for (const sample of seeds) {
      const createdAt = new Date(created - sample.offset).toISOString();
      let completedAt = null;
      let expiresAt = null;
      let metadata = null;
      let error = null;
      let stage = sample.status === 'running' ? 'Получение данных' : 'Ожидает окна запуска';
      if (sample.status === 'completed') {
        const built = await uploadReport({ id: sample.id, report_id: sample.reportId, parameters: JSON.stringify(sample.parameters) });
        completedAt = new Date(created - sample.offset + 60000).toISOString();
        expiresAt = new Date(Date.parse(completedAt) + retentionDays * 86400000).toISOString();
        metadata = JSON.stringify(resultMetadata({ id: sample.id, report_id: sample.reportId }, built));
        stage = 'Готово к скачиванию';
      }
      if (sample.status === 'failed') {
        completedAt = new Date(created - sample.offset + 60000).toISOString();
        error = JSON.stringify({ code: 'REPORT_FORMAT_MISMATCH', message: 'Полученные данные не соответствуют формату отчета. Файл не создан.', at: completedAt });
        stage = 'Файл не создан';
      }
      prepared.push([sample.id, sample.reportId, JSON.stringify(sample.parameters), sample.status, stage, createdAt,
        sample.status === 'queued' ? null : createdAt,
        sample.status === 'running' ? new Date(created + processingDelayMs).toISOString() : null,
        completedAt, expiresAt, metadata, null, error]);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT INTO jobs(id,report_id,parameters,status,stage,created_at,started_at,ready_at,completed_at,expires_at,result_metadata,file,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const row of prepared) insert.run(...row);
      db.prepare("INSERT INTO settings(key,value) VALUES('initialized','1')").run();
      for (const row of prepared) {
        if (row[10]) db.prepare('DELETE FROM object_cleanup WHERE object_key=?').run(JSON.parse(row[10]).key);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  try {
    if (setting('object_bucket') && setting('object_bucket') !== storage.bucket) throw new Error('S3_BUCKET differs from the bucket associated with this database');
    await storage.check();
    remember('object_bucket', storage.bucket);
    await cleanupPending();
    await migrateLegacyFiles();
    if (!setting('initialized')) {
      const seedDemo = options.seedDemo ?? process.env['SEED_DEMO'] !== 'false';
      if (seedDemo) await seed();
      else db.prepare("INSERT INTO settings(key,value) VALUES('initialized','1')").run();
    }
  } catch (error) {
    await cleanupPending();
    db.close();
    if (ownsStorage) await storage.close();
    throw error;
  }

  let busy = false;
  let closing = false;
  let currentUpload;
  let currentTick = Promise.resolve();
  async function performTick() {
    if (busy || closing) return;
    busy = true;
    try {
      const stamp = now().toISOString();
      await cleanExpired();
      const active = db.prepare(`SELECT ${JOB_METADATA} FROM jobs WHERE status='running' ORDER BY id LIMIT 1`).get();
      if (active) {
        if (active.ready_at <= stamp) {
          try {
            currentUpload = new AbortController();
            const uploaded = await uploadReport(active, currentUpload.signal);
            complete(active, uploaded, now().toISOString());
          } catch (error) {
            if (closing) db.prepare("UPDATE jobs SET status='queued',stage='Ожидает запуска',ready_at=NULL WHERE id=?").run(active.id);
            else fail(active, error.code === 'REPORT_FORMAT_MISMATCH' ? error.code : 'REPORT_STORAGE_FAILED',
              error.code === 'REPORT_FORMAT_MISMATCH' ? 'Полученные данные не соответствуют формату отчета. Файл не создан.' : 'Не удалось сформировать или сохранить отчет. Обратитесь в поддержку и укажите номер задания.', now().toISOString());
            await cleanupPending();
          } finally { currentUpload = undefined; }
        }
        return;
      }
      const candidates = db.prepare(`SELECT ${JOB_METADATA} FROM jobs WHERE status='queued' ORDER BY created_at,id`).all();
      for (const row of candidates) {
        const report = reports.find(item => item.id === row.report_id);
        if (report.nightOnly && !inNightWindow(now())) continue;
        db.prepare("UPDATE jobs SET status='running',stage='Получение данных',started_at=?,ready_at=? WHERE id=? AND status='queued'")
          .run(stamp, new Date(now().getTime() + processingDelayMs).toISOString(), row.id);
        break;
      }
    } finally { busy = false; }
  }

  function tick() {
    if (busy) return currentTick;
    currentTick = performTick();
    return currentTick;
  }
  let timer;
  function startWorker() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(error => console.error('Report worker failed:', error.message)); }, options.workerIntervalMs ?? 1000);
    timer.unref();
  }

  return {
    db,
    getJob,
    tick,
    startWorker,
    async readiness() { await storage.check(); return { status: 'ok', storage: 's3' }; },
    catalog() {
      return { reports, departments, config: { maxPeriodDays, retentionDays, timeZone: 'Europe/Moscow', nightStartHour: 0, nightEndHour: 6 }, serverTime: now().toISOString(), nextNightWindow: nextNightWindow(now()) };
    },
    createJob(body) {
      const { report, parameters } = validateCreate(body, maxPeriodDays);
      return insertJob(report, parameters);
    },
    listJobs(query) {
      const search = query.get('search') ?? '';
      const status = query.get('status') ?? '';
      const from = query.get('createdFrom') ?? '';
      const to = query.get('createdTo') ?? '';
      const page = Number(query.get('page') ?? 1);
      const pageSize = Number(query.get('pageSize') ?? 20);
      const sort = query.get('sort') ?? 'desc';
      if (!Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || search.length > 200 || !['asc', 'desc'].includes(sort) || (status && !['queued', 'running', 'completed', 'failed'].includes(status)) || (from && !isoDate(from)) || (to && !isoDate(to)) || (from && to && from > to)) throw new HttpError(400, 'INVALID_FILTER', 'Некорректные параметры поиска.');
      const all = db.prepare(`SELECT ${JOB_METADATA} FROM jobs ORDER BY created_at DESC,id DESC`).all();
      let filtered = all.filter(row => {
        const title = reports.find(item => item.id === row.report_id).name;
        const date = moscowDate(new Date(row.created_at));
        return (!search || `${title} ${row.id}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru').replace(/^№\s*/, ''))) && (!status || row.status === status) && (!from || date >= from) && (!to || date <= to);
      });
      if (sort === 'asc') filtered.reverse();
      return { items: filtered.slice((page - 1) * pageSize, page * pageSize).map(present), total: filtered.length, allCount: all.length, updatedAt: now().toISOString() };
    },
    async download(id, { signal } = {}) {
      const row = db.prepare(`SELECT ${JOB_METADATA} FROM jobs WHERE id=?`).get(id);
      const job = present(row);
      if (job.status !== 'completed') throw new HttpError(409, 'RESULT_NOT_READY', 'Файл еще не готов.');
      if (row.expires_at <= now().toISOString()) throw new HttpError(410, 'RESULT_EXPIRED', 'Срок хранения файла истек. Сформируйте новый отчет.');
      const metadata = JSON.parse(row.result_metadata);
      if (!metadata.key || metadata.objectDeletedAt) throw new HttpError(410, 'RESULT_UNAVAILABLE', 'Файл больше недоступен. Сформируйте новый отчет.');
      try {
        const object = await storage.get(metadata.key, { signal });
        return { ...object, fileName: job.result.fileName };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (['NoSuchKey', 'NotFound'].includes(error.name) || error.$metadata?.httpStatusCode === 404) throw new HttpError(410, 'RESULT_UNAVAILABLE', 'Файл больше недоступен. Сформируйте новый отчет.');
        throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Хранилище отчетов временно недоступно. Повторите попытку позже.');
      }
    },
    notifications() {
      const items = db.prepare('SELECT * FROM notifications ORDER BY is_read ASC,id DESC LIMIT 100').all().map(row => ({ id: row.id, jobId: row.job_id, title: row.title, createdAt: row.created_at, read: Boolean(row.is_read) }));
      return { items, unreadCount: db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE is_read=0').get().count };
    },
    markNotifications(body) {
      if (!body || !Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new HttpError(400, 'INVALID_NOTIFICATION_IDS', 'Некорректный список уведомлений.');
      const update = db.prepare('UPDATE notifications SET is_read=1 WHERE id=?');
      for (const id of body.ids) update.run(id);
      return { ok: true };
    },
    async close() {
      if (closing) return currentTick;
      closing = true;
      clearInterval(timer);
      currentUpload?.abort(new Error('Service shutting down'));
      try { await currentTick; }
      finally { db.close(); if (ownsStorage) await storage.close(); }
    },
  };
}
