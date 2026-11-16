import { randomUUID } from 'node:crypto';
import { reports, departments, HttpError, validateCreate, nextNightWindow, inNightWindow, isoDate } from './domain.mjs';
import { writeWorkbook } from './workbook.mjs';
import { createS3Storage } from './s3-storage.mjs';
import { openDatabase } from './database.mjs';

const JOB_METADATA = 'id,report_id,parameters,status,stage,created_at,started_at,completed_at,expires_at,result_metadata,error_json,ready_at';
const timestamp = value => value instanceof Date ? value.toISOString() : value;

function positiveInteger(value, fallback, name, maximum = 365) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

export async function createService(options = {}) {
  const now = options.now ?? (() => new Date());
  const maxPeriodDays = positiveInteger(options.maxPeriodDays ?? process.env.MAX_PERIOD_DAYS, 31, 'MAX_PERIOD_DAYS');
  const retentionDays = positiveInteger(options.retentionDays ?? process.env.RETENTION_DAYS, 7, 'RETENTION_DAYS');
  const processingDelayMs = options.processingDelayMs ?? 4000;
  const storage = options.storage ?? createS3Storage();
  const ownsStorage = !options.storage;
  let db;
  try {
    db = await openDatabase({ connectionString: options.databaseUrl, schema: options.databaseSchema, acquireLock: true });
  } catch (error) {
    if (ownsStorage) await storage.close();
    throw error;
  }
  const setting = async key => (await db.query('SELECT value FROM settings WHERE key=$1', [key])).rows[0]?.value;
  const remember = (key, value) => db.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [key, value]);
  let namespace;
  let prefix;
  // A lost PostgreSQL owner session can overlap with an old S3 request still
  // settling. Each attempt has its own object, so its eventual cleanup cannot
  // delete a replacement worker's successful result for the same job.
  const objectKey = (id, reportId) => `${prefix ? `${prefix}/` : ''}${namespace}/report-${id}-${reportId}-${randomUUID()}.xlsx`;

  function present(row) {
    if (!row) throw new HttpError(404, 'JOB_NOT_FOUND', 'Задание не найдено.');
    const report = reports.find(item => item.id === row.report_id);
    return {
      id: row.id, reportId: row.report_id, reportName: report.name,
      parameters: row.parameters, status: row.status, stage: row.stage,
      createdAt: timestamp(row.created_at),
      ...(row.started_at && { startedAt: timestamp(row.started_at) }),
      ...(row.completed_at && { completedAt: timestamp(row.completed_at) }),
      ...(row.expires_at && { expiresAt: timestamp(row.expires_at) }),
      ...(row.result_metadata && { result: publicResult(row.result_metadata) }),
      ...(row.error_json && { error: row.error_json }),
      ...(row.status === 'queued' && report.nightOnly && { nextWindow: nextNightWindow(now()) }),
    };
  }

  function publicResult(result) {
    return { fileName: result.fileName, sizeBytes: result.sizeBytes, rowCount: result.rowCount };
  }

  async function registerCleanup(key, reason = 'upload') {
    await db.query(`INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(object_key) DO UPDATE SET reason=excluded.reason`, [key, storage.bucket, reason, now()]);
  }

  async function cleanupObject(entry) {
    if (entry.bucket !== storage.bucket) throw new Error('S3_BUCKET does not match the stored object bucket');
    await storage.delete(entry.object_key);
    await db.transaction(async client => {
      if (entry.reason === 'expired') {
        await client.query(`UPDATE jobs SET result_metadata=result_metadata || jsonb_build_object('objectDeletedAt',$1::text)
          WHERE status='completed' AND expires_at<=$2 AND result_metadata->>'key'=$3`,
        [now().toISOString(), now(), entry.object_key]);
      }
      await client.query('DELETE FROM object_cleanup WHERE object_key=$1', [entry.object_key]);
    });
  }

  async function cleanupPending() {
    for (const entry of (await db.query('SELECT * FROM object_cleanup ORDER BY created_at LIMIT 20')).rows) {
      try { await cleanupObject(entry); }
      catch { /* Keep durable intent; retry on the next worker tick/restart. */ }
    }
  }

  async function cleanExpired() {
    await db.query(`INSERT INTO object_cleanup(object_key,bucket,reason,created_at)
      SELECT result_metadata->>'key',$1,'expired',$2 FROM jobs
      WHERE status='completed' AND expires_at<=$2 AND result_metadata->>'key' IS NOT NULL
        AND result_metadata->>'objectDeletedAt' IS NULL
      ON CONFLICT(object_key) DO UPDATE SET reason=excluded.reason`, [storage.bucket, now()]);
    await cleanupPending();
  }

  function resultMetadata(row, uploaded) {
    return { fileName: `report-${row.id}-${row.report_id}.xlsx`, sizeBytes: uploaded.sizeBytes,
      rowCount: uploaded.rowCount, storage: 's3', bucket: uploaded.bucket, key: uploaded.key,
      ...(uploaded.etag && { etag: uploaded.etag }) };
  }

  async function uploadReport(row, signal) {
    const key = objectKey(row.id, row.report_id);
    await registerCleanup(key);
    const report = reports.find(item => item.id === row.report_id);
    return storage.upload(key, (output, uploadSignal) => writeWorkbook(report, row.parameters, output, { signal: uploadSignal }), { signal });
  }

  async function getJob(id) {
    return present((await db.query(`SELECT ${JOB_METADATA} FROM jobs WHERE id=$1::bigint`, [id])).rows[0]);
  }

  async function insertJob(report, parameters, createdAt = now()) {
    const stage = report.nightOnly && !inNightWindow(now()) ? 'Ожидает окна запуска' : 'Ожидает запуска';
    const result = await db.query(`INSERT INTO jobs(report_id,parameters,status,stage,created_at)
      VALUES($1,$2,'queued',$3,$4) RETURNING ${JOB_METADATA}`, [report.id, parameters, stage, createdAt]);
    return present(result.rows[0]);
  }

  async function complete(row, uploaded, completedAt, notify = true) {
    const expiresAt = new Date(Date.parse(completedAt) + retentionDays * 86400000);
    await db.transaction(async client => {
      await client.query(`UPDATE jobs SET status='completed',stage='Готово к скачиванию',completed_at=$1,
        expires_at=$2,result_metadata=$3,ready_at=NULL WHERE id=$4`,
      [completedAt, expiresAt, resultMetadata(row, uploaded), row.id]);
      if (notify) await client.query('INSERT INTO notifications(job_id,title,created_at) VALUES($1,$2,$3)',
        [row.id, `Отчет по заданию №${row.id} готов к скачиванию`, completedAt]);
      await client.query('DELETE FROM object_cleanup WHERE object_key=$1', [uploaded.key]);
    });
  }

  async function fail(row, code, message, completedAt, notify = true) {
    await db.transaction(async client => {
      // COMMIT may have succeeded even if its acknowledgement was lost. Never
      // overwrite a completed result (or emit a failure notification) then.
      const updated = await client.query(`UPDATE jobs SET status='failed',stage='Файл не создан',completed_at=$1,
        error_json=$2,ready_at=NULL WHERE id=$3 AND status='running' RETURNING id`,
      [completedAt, { code, message, at: completedAt }, row.id]);
      if (notify && updated.rowCount) await client.query('INSERT INTO notifications(job_id,title,created_at) VALUES($1,$2,$3)',
        [row.id, `Не удалось сформировать отчет по заданию №${row.id}`, completedAt]);
    });
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
    // Generate outside a DB transaction. Only metadata accumulates, and durable
    // upload intents allow cleanup if the later atomic seed transaction fails.
    for (const sample of seeds) {
      const createdAt = new Date(created - sample.offset).toISOString();
      let completedAt = null;
      let expiresAt = null;
      let metadata = null;
      let error = null;
      let stage = sample.status === 'running' ? 'Получение данных' : 'Ожидает окна запуска';
      if (sample.status === 'completed') {
        const built = await uploadReport({ id: sample.id, report_id: sample.reportId, parameters: sample.parameters }, db.signal);
        completedAt = new Date(created - sample.offset + 60000).toISOString();
        expiresAt = new Date(Date.parse(completedAt) + retentionDays * 86400000).toISOString();
        metadata = resultMetadata({ id: sample.id, report_id: sample.reportId }, built);
        stage = 'Готово к скачиванию';
      }
      if (sample.status === 'failed') {
        completedAt = new Date(created - sample.offset + 60000).toISOString();
        error = { code: 'REPORT_FORMAT_MISMATCH', message: 'Полученные данные не соответствуют формату отчета. Файл не создан.', at: completedAt };
        stage = 'Файл не создан';
      }
      prepared.push([sample.id, sample.reportId, sample.parameters, sample.status, stage, createdAt,
        sample.status === 'queued' ? null : createdAt,
        sample.status === 'running' ? new Date(created + processingDelayMs).toISOString() : null,
        completedAt, expiresAt, metadata, error]);
    }
    await db.transaction(async client => {
      for (const row of prepared) await client.query(`INSERT INTO jobs(id,report_id,parameters,status,stage,created_at,
        started_at,ready_at,completed_at,expires_at,result_metadata,error_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, row);
      await client.query("SELECT setval(pg_get_serial_sequence('jobs','id'),(SELECT max(id) FROM jobs),true)");
      await client.query("INSERT INTO settings(key,value) VALUES('initialized','1')");
      for (const row of prepared) {
        if (row[10]) await client.query('DELETE FROM object_cleanup WHERE object_key=$1', [row[10].key]);
      }
    });
  }

  try {
    const bucket = await setting('object_bucket');
    if (bucket && bucket !== storage.bucket) throw new Error('S3_BUCKET differs from the bucket associated with this database');
    await storage.check();
    await remember('object_namespace', randomUUID());
    await remember('object_prefix', options.storagePrefix ?? storage.prefix ?? 'reports/');
    await remember('object_bucket', storage.bucket);
    namespace = await setting('object_namespace');
    prefix = (await setting('object_prefix')).replace(/^\/+|\/+$/g, '');
    // The session advisory lock excludes another service before recovery or
    // cleanup, so a second startup cannot requeue or delete an active upload.
    await db.query("UPDATE jobs SET status='queued',stage='Ожидает запуска',ready_at=NULL WHERE status='running'");
    await cleanupPending();
    if (!await setting('initialized')) {
      if (options.seedDemo ?? process.env.SEED_DEMO !== 'false') await seed();
      else await remember('initialized', '1');
    }
  } catch (error) {
    await cleanupPending().catch(() => {});
    await db.close();
    if (ownsStorage) await storage.close();
    throw error;
  }

  let busy = false;
  let closing = false;
  let closePromise;
  let currentUpload;
  let currentTick = Promise.resolve();
  const onDatabaseLost = () => currentUpload?.abort(db.signal.reason);
  db.signal.addEventListener('abort', onDatabaseLost, { once: true });
  async function performTick() {
    if (busy || closing) return;
    busy = true;
    try {
      const stamp = now().toISOString();
      await cleanExpired();
      if (closing) return;
      const active = (await db.query(`SELECT ${JOB_METADATA} FROM jobs WHERE status='running' ORDER BY id LIMIT 1`)).rows[0];
      if (active) {
        if (timestamp(active.ready_at) <= stamp) {
          try {
            currentUpload = new AbortController();
            const signal = AbortSignal.any([currentUpload.signal, db.signal]);
            const uploaded = await uploadReport(active, signal);
            await complete(active, uploaded, now().toISOString());
          } catch (error) {
            if (closing) await db.query("UPDATE jobs SET status='queued',stage='Ожидает запуска',ready_at=NULL WHERE id=$1 AND status='running'", [active.id]);
            else await fail(active, error.code === 'REPORT_FORMAT_MISMATCH' ? error.code : 'REPORT_STORAGE_FAILED',
              error.code === 'REPORT_FORMAT_MISMATCH' ? 'Полученные данные не соответствуют формату отчета. Файл не создан.' : 'Не удалось сформировать или сохранить отчет. Обратитесь в поддержку и укажите номер задания.', now().toISOString());
            await cleanupPending();
          } finally { currentUpload = undefined; }
        }
        return;
      }
      const allowedReports = reports.filter(report => !report.nightOnly || inNightWindow(now())).map(report => report.id);
      await db.query(`UPDATE jobs SET status='running',stage='Получение данных',started_at=$1,ready_at=$2
        WHERE id=(SELECT id FROM jobs WHERE status='queued' AND report_id=ANY($3::text[])
          ORDER BY created_at,id LIMIT 1) AND status='queued'`,
      [stamp, new Date(now().getTime() + processingDelayMs), allowedReports]);
    } finally { busy = false; }
  }

  function tick() {
    if (busy) return currentTick;
    currentTick = performTick();
    return currentTick;
  }
  let timer;
  function startWorker() {
    if (timer || closing) return;
    timer = setInterval(() => { tick().catch(error => console.error('Report worker failed:', error.message)); }, options.workerIntervalMs ?? 1000);
    timer.unref();
  }

  return {
    db,
    getJob,
    tick,
    startWorker,
    async readiness() {
      await Promise.all([db.query('SELECT 1'), storage.check()]);
      return { status: 'ok', storage: 's3', database: 'postgresql' };
    },
    catalog() {
      return { reports, departments, config: { maxPeriodDays, retentionDays, timeZone: 'Europe/Moscow', nightStartHour: 0, nightEndHour: 6 }, serverTime: now().toISOString(), nextNightWindow: nextNightWindow(now()) };
    },
    async createJob(body) {
      const { report, parameters } = validateCreate(body, maxPeriodDays);
      return insertJob(report, parameters);
    },
    async listJobs(query) {
      const search = query.get('search') ?? '';
      const status = query.get('status') ?? '';
      const from = query.get('createdFrom') ?? '';
      const to = query.get('createdTo') ?? '';
      const page = Number(query.get('page') ?? 1);
      const pageSize = Number(query.get('pageSize') ?? 20);
      const sort = query.get('sort') ?? 'desc';
      if (!Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || search.length > 200 || !['asc', 'desc'].includes(sort) || (status && !['queued', 'running', 'completed', 'failed'].includes(status)) || (from && !isoDate(from)) || (to && !isoDate(to)) || (from && to && from > to)) throw new HttpError(400, 'INVALID_FILTER', 'Некорректные параметры поиска.');
      const values = [reports.map(report => report.id), reports.map(report => report.name), search.toLocaleLowerCase('ru').replace(/^№\s*/, '')];
      const filters = ["strpos(lower(c.title || ' ' || j.id::text),$3)>0"];
      if (status) { values.push(status); filters.push(`j.status=$${values.length}`); }
      if (from) { values.push(from); filters.push(`j.created_at>=($${values.length}::date::timestamp AT TIME ZONE 'Europe/Moscow')`); }
      if (to) { values.push(to); filters.push(`j.created_at<(($${values.length}::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')`); }
      const source = `FROM jobs j JOIN unnest($1::text[],$2::text[]) c(report_id,title) ON c.report_id=j.report_id WHERE ${filters.join(' AND ')}`;
      return db.transaction(async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const allCount = Number((await client.query('SELECT count(*) AS count FROM jobs')).rows[0].count);
        const total = Number((await client.query(`SELECT count(*) AS count ${source}`, values)).rows[0].count);
        const rows = (await client.query(`SELECT j.* ${source} ORDER BY j.created_at ${sort},j.id ${sort}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, pageSize, (page - 1) * pageSize])).rows;
        return { items: rows.map(present), total, allCount, updatedAt: now().toISOString() };
      });
    },
    async download(id, { signal } = {}) {
      const row = (await db.query(`SELECT ${JOB_METADATA} FROM jobs WHERE id=$1::bigint`, [id])).rows[0];
      const job = present(row);
      if (job.status !== 'completed') throw new HttpError(409, 'RESULT_NOT_READY', 'Файл еще не готов.');
      if (timestamp(row.expires_at) <= now().toISOString()) throw new HttpError(410, 'RESULT_EXPIRED', 'Срок хранения файла истек. Сформируйте новый отчет.');
      const metadata = row.result_metadata;
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
    async notifications() {
      const result = await db.query('SELECT * FROM notifications ORDER BY is_read ASC,id DESC LIMIT 100');
      const items = result.rows.map(row => ({ id: row.id, jobId: row.job_id, title: row.title, createdAt: timestamp(row.created_at), read: row.is_read }));
      const unreadCount = Number((await db.query('SELECT count(*) AS count FROM notifications WHERE NOT is_read')).rows[0].count);
      return { items, unreadCount };
    },
    async markNotifications(body) {
      if (!body || !Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new HttpError(400, 'INVALID_NOTIFICATION_IDS', 'Некорректный список уведомлений.');
      await db.query('UPDATE notifications SET is_read=true WHERE id=ANY($1::bigint[])', [body.ids]);
      return { ok: true };
    },
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(timer);
      currentUpload?.abort(new Error('Service shutting down'));
      closePromise = (async () => {
        try { await currentTick; }
        finally {
          db.signal.removeEventListener('abort', onDatabaseLost);
          await db.close();
          if (ownsStorage) await storage.close();
        }
      })();
      return closePromise;
    },
  };
}
