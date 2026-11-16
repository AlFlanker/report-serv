import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { get as httpGet } from 'node:http';
import { once } from 'node:events';
import { createService } from './service.mjs';
import { createApp } from './index.mjs';
import { inNightWindow, nextNightWindow } from './domain.mjs';
import { createFakeStorage, readDownload } from './test-support/fake-storage.mjs';
import { postgresFixture } from './test-support/postgres.mjs';

const request = (reportId = 'obligations', parameters = {}) => ({ reportId, parameters: { startDate: '2026-11-01', endDate: '2026-11-15', department: '6000', ...parameters } });
const makeClock = (initial = '2026-11-16T10:00:00Z') => {
  let value = new Date(initial);
  return { now: () => new Date(value), set: stamp => { value = new Date(stamp); }, advance: milliseconds => { value = new Date(value.getTime() + milliseconds); } };
};
async function serviceFor(t, options = {}) {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  service = await createService({ ...database, seedDemo: false, processingDelayMs: 0, storage: createFakeStorage(), ...options });
  return service;
}
async function appFor(t, options = {}) {
  let app;
  t.after(() => app?.close());
  const database = await postgresFixture(t);
  app = await createApp({ ...database, seedDemo: false, processingDelayMs: 0, startWorker: false, storage: createFakeStorage(), ...options });
  const address = await app.listen(0);
  return { app, url: `http://127.0.0.1:${address.port}` };
}
async function row(service, sql, values = []) {
  return (await service.db.query(sql, values)).rows[0];
}
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'report-serv-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('ordinary job persists state transitions and produces a readable XLSX with parameters and fixture rows', async t => {
  const clock = makeClock();
  const service = await serviceFor(t, { now: clock.now });
  const job = await service.createJob(request());
  assert.equal(job.status, 'queued');
  await assert.rejects(service.download(job.id), error => error.status === 409);
  await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'running');
  await service.tick();
  const result = await service.getJob(job.id);
  assert.equal(result.status, 'completed');
  const { file, fileName } = await readDownload(service, job.id);
  assert.match(fileName, /^report-\d+-obligations\.xlsx$/);
  assert.equal(file.length, result.result.sizeBytes);
  assert.equal((await row(service, "SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='jobs' AND column_name='file'")).count, 0);
  assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 0);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  assert.equal(workbook.getWorksheet('Данные').actualRowCount, result.result.rowCount + 1);
  assert.ok(result.result.rowCount > 0);
  assert.equal(workbook.getWorksheet('Параметры').getCell('B3').value, '6000');
  assert.equal((await service.notifications()).unreadCount, 1);
  await service.tick();
  assert.equal((await service.notifications()).unreadCount, 1, 'completion must not notify twice');
});

test('night-only jobs wait outside 00–06 MSK and do not block ordinary jobs', async t => {
  const clock = makeClock();
  const service = await serviceFor(t, { now: clock.now });
  const night = await service.createJob(request('operations'));
  const ordinary = await service.createJob(request('payments'));
  await service.tick();
  assert.equal((await service.getJob(night.id)).status, 'queued');
  assert.equal((await service.getJob(ordinary.id)).status, 'running');
  await service.tick();
  assert.equal((await service.getJob(ordinary.id)).status, 'completed');
  clock.set('2026-11-16T21:00:00Z');
  await service.tick();
  assert.equal((await service.getJob(night.id)).status, 'running');
  await service.tick();
  assert.equal((await service.getJob(night.id)).status, 'completed');
});

test('Moscow night-window boundaries and nearest date are exact', () => {
  assert.equal(inNightWindow(new Date('2026-11-16T20:59:59Z')), false);
  assert.equal(inNightWindow(new Date('2026-11-16T21:00:00Z')), true);
  assert.equal(inNightWindow(new Date('2026-11-17T02:59:59Z')), true);
  assert.equal(inNightWindow(new Date('2026-11-17T03:00:00Z')), false);
  assert.deepEqual(nextNightWindow(new Date('2026-11-16T10:00:00Z')), { start: '2026-11-16T21:00:00.000Z', end: '2026-11-17T03:00:00.000Z' });
  assert.deepEqual(nextNightWindow(new Date('2026-11-17T01:00:00Z')), { start: '2026-11-16T21:00:00.000Z', end: '2026-11-17T03:00:00.000Z' });
});

test('inclusive period validation, calendar dates, department and account are enforced on the server', async t => {
  const service = await serviceFor(t);
  assert.equal((await service.createJob(request('obligations', { startDate: '2026-10-01', endDate: '2026-10-31' }))).status, 'queued');
  for (const body of [
    request('obligations', { startDate: '2026-10-01', endDate: '2026-11-01' }),
    request('obligations', { startDate: '2026-11-16', endDate: '2026-11-15' }),
    request('obligations', { startDate: '2026-02-30' }),
    request('obligations', { startDate: '01.11.2026' }),
    request('obligations', { department: 'unknown' }),
    request('turnovers'),
    request('turnovers', { account: '03210001234x' }),
    { reportId: 'balances', parameters: { department: '6000', asOfDate: '2026-11-31' } },
  ]) await assert.rejects(() => service.createJob(body), error => error.status === 400 && error.code === 'INVALID_PARAMETERS');
  await assert.rejects(() => service.createJob(request('missing')), error => error.code === 'UNKNOWN_REPORT');
  assert.equal((await service.createJob(request('turnovers', { account: '03210001234' }))).parameters.account, '03210001234');
  assert.equal((await service.createJob({ reportId: 'balances', parameters: { department: '6000', asOfDate: '2026-11-15' } })).status, 'queued');
});

test('configured limits are reflected in catalog and backend validation', async t => {
  const service = await serviceFor(t, { maxPeriodDays: 2, retentionDays: 1 });
  assert.equal(service.catalog().config.maxPeriodDays, 2);
  assert.equal(service.catalog().config.retentionDays, 1);
  await assert.rejects(() => service.createJob(request()), error => error.code === 'INVALID_PARAMETERS');
  assert.equal((await service.createJob(request('payments', { endDate: '2026-11-02' }))).status, 'queued');
});

test('download expires exactly at retention boundary and worker removes the S3 object', async t => {
  const clock = makeClock();
  const storage = createFakeStorage();
  const service = await serviceFor(t, { now: clock.now, retentionDays: 1, storage });
  const job = await service.createJob(request());
  await service.tick();
  await service.tick();
  const expiresAt = (await service.getJob(job.id)).expiresAt;
  clock.set(new Date(Date.parse(expiresAt) - 1));
  assert.ok((await readDownload(service, job.id)).file.length > 0);
  clock.set(expiresAt);
  await assert.rejects(service.download(job.id), error => error.status === 410 && error.code === 'RESULT_EXPIRED');
  await service.tick();
  assert.equal((await row(service, "SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='jobs' AND column_name='file'")).count, 0);
  assert.equal(storage.objects.size, 0);
  assert.equal(storage.deleted.length, 1);
  assert.ok((await row(service, 'SELECT result_metadata FROM jobs WHERE id=$1', [job.id])).result_metadata.objectDeletedAt);
  assert.equal((await service.getJob(job.id)).status, 'completed');
});

test('queued/running jobs survive restart and completed file remains identical after reopening', async t => {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  const storage = createFakeStorage();
  const clock = makeClock();
  service = await createService({ ...database, storage, seedDemo: false, now: clock.now, processingDelayMs: 0 });
  const job = await service.createJob(request());
  await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'running');
  await service.close();
  service = await createService({ ...database, storage, seedDemo: true, now: clock.now, processingDelayMs: 0 });
  assert.equal((await service.listJobs(new URLSearchParams())).allCount, 1, 'existing empty-mode database must not be reseeded');
  assert.equal((await service.getJob(job.id)).status, 'queued');
  await service.tick();
  await service.tick();
  const before = (await readDownload(service, job.id)).file;
  await service.close();
  service = await createService({ ...database, storage, seedDemo: false, now: clock.now });
  assert.deepEqual((await readDownload(service, job.id)).file, before);
  assert.equal((await service.notifications()).unreadCount, 1);
  await service.close();
});

test('six demo tasks include a terminal failure, real files and relative creation timestamps', async t => {
  const clock = makeClock('2030-05-08T10:00:00Z');
  const service = await serviceFor(t, { seedDemo: true, now: clock.now });
  const jobs = await service.listJobs(new URLSearchParams({ createdFrom: '2030-05-01', createdTo: '2030-05-08' }));
  assert.equal(jobs.total, 6);
  assert.deepEqual(jobs.items.map(job => job.id), [1048, 1047, 1046, 1045, 1044, 1043]);
  assert.equal((await service.getJob(1045)).error.code, 'REPORT_FORMAT_MISMATCH');
  await assert.rejects(service.download(1045), error => error.status === 409);
  await service.tick();
  await service.tick();
  assert.equal((await service.getJob(1045)).status, 'failed');
  assert.ok((await readDownload(service, 1046)).file.length > 0);
});

test('demo seed inserts and initialized marker roll back together if insertion fails', async t => {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  const storage = createFakeStorage();
  service = await createService({ ...database, storage, seedDemo: false });
  await service.db.query(`
    DELETE FROM settings WHERE key='initialized';
    CREATE FUNCTION reject_demo_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id=1045 THEN RAISE EXCEPTION 'test interruption'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_demo BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_demo_insert();
  `);
  await service.close();
  await assert.rejects(createService({ ...database, storage, seedDemo: true }), /test interruption/);
  assert.equal(storage.objects.size, 0, 'rolled back demo seed must not leave completed S3 objects');
  assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count, 0);
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM settings WHERE key='initialized'")).rows[0].count, 0);
  await database.query('DROP TRIGGER reject_demo ON jobs; DROP FUNCTION reject_demo_insert()');
  service = await createService({ ...database, storage, seedDemo: true });
  assert.equal((await service.listJobs(new URLSearchParams())).total, 6);
  assert.ok((await service.createJob(request())).id > 1048, 'identity sequence advances past explicitly seeded IDs');
});

test('list supports search, status, Moscow creation date, ordering and pagination without exposing file bytes', async t => {
  const clock = makeClock('2026-11-15T22:00:00Z');
  const service = await serviceFor(t, { now: clock.now });
  const first = await service.createJob(request('payments'));
  clock.advance(1000);
  const second = await service.createJob(request('obligations'));
  assert.equal((await service.listJobs(new URLSearchParams({ createdFrom: '2026-11-16', createdTo: '2026-11-16' }))).total, 2);
  assert.equal((await service.listJobs(new URLSearchParams({ createdTo: '2026-11-15' }))).total, 0);
  assert.deepEqual((await service.listJobs(new URLSearchParams({ pageSize: '1' }))).items.map(job => job.id), [second.id]);
  assert.deepEqual((await service.listJobs(new URLSearchParams({ pageSize: '1', page: '2' }))).items.map(job => job.id), [first.id]);
  assert.deepEqual((await service.listJobs(new URLSearchParams({ sort: 'asc' }))).items.map(job => job.id), [first.id, second.id]);
  assert.equal((await service.listJobs(new URLSearchParams({ search: 'ПЛАТЕЖНЫХ' }))).total, 1);
  for (const search of ['%', '_', "' OR 1=1 --"]) assert.equal((await service.listJobs(new URLSearchParams({ search }))).total, 0, 'search treats SQL metacharacters as literal text');
  assert.equal((await service.listJobs(new URLSearchParams({ search: `№ ${second.id}` }))).items[0].id, second.id);
  assert.equal((await service.listJobs(new URLSearchParams({ status: 'completed' }))).total, 0);
  for (const query of [{ page: '-1' }, { pageSize: '1000' }, { status: 'other' }, { createdFrom: '2026-02-30' }, { sort: 'DROP TABLE' }]) await assert.rejects(() => service.listJobs(new URLSearchParams(query)), error => error.status === 400);
  assert.equal('file' in (await service.getJob(first.id)), false);
});

test('older unread notifications remain reachable beyond first page and marking read is durable', async t => {
  const service = await serviceFor(t);
  const job = await service.createJob(request());
  await service.db.query("INSERT INTO notifications(job_id,title,created_at) SELECT $1, 'Report ' || n, NOW() FROM generate_series(1,105) AS n", [job.id]);
  const page = await service.notifications();
  assert.equal(page.items.length, 100);
  assert.equal(page.unreadCount, 105);
  await service.markNotifications({ ids: page.items.map(item => item.id) });
  const remainder = await service.notifications();
  assert.equal(remainder.unreadCount, 5);
  assert.equal(remainder.items.filter(item => !item.read).length, 5);
  await service.markNotifications({ ids: remainder.items.filter(item => !item.read).map(item => item.id) });
  assert.equal((await service.notifications()).unreadCount, 0);
});

test('HTTP API returns useful errors, creates jobs and streams actual XLSX with correct headers', async t => {
  const { app, url } = await appFor(t);
  const send = payload => fetch(`${url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await (await fetch(`${url}/api/catalog`)).json()).reports.length, 6);
  assert.equal((await send(request('missing'))).status, 400);
  const response = await send(request());
  assert.equal(response.status, 201);
  const job = await response.json();
  assert.equal((await fetch(`${url}/api/jobs/${job.id}/download`)).status, 409);
  await app.service.tick();
  await app.service.tick();
  const file = await fetch(`${url}/api/jobs/${job.id}/download`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);
  assert.match(file.headers.get('content-disposition'), /attachment; filename="report-/);
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await fetch(`${url}/api/jobs/99999`)).status, 404);
  assert.equal((await fetch(`${url}/api/missing`)).status, 404);
  assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(70000) }) })).status, 413);
});

test('built UI static serving blocks path escape and symlinks outside public root', async t => {
  const directory = await temp(t);
  const publicRoot = join(directory, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicRoot);
  await writeFile(join(publicRoot, 'index.html'), '<h1>Reports</h1>');
  await writeFile(join(directory, 'secret.txt'), 'secret data');
  await symlink(join(directory, 'secret.txt'), join(publicRoot, 'leak.txt'));
  const { url } = await appFor(t, { staticRoot: publicRoot });
  assert.equal(await (await fetch(`${url}/`)).text(), '<h1>Reports</h1>');
  assert.equal((await fetch(`${url}/%2e%2e%2fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${url}/leak.txt`)).status, 404);
  assert.equal((await fetch(`${url}/missing.js`)).status, 404);
});

test('job completion and notification wait for S3 upload acknowledgement', async t => {
  const storage = createFakeStorage();
  const originalUpload = storage.upload.bind(storage);
  let acknowledge;
  let uploaded;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const objectUploaded = new Promise(resolve => { uploaded = resolve; });
  storage.upload = async (...args) => {
    const result = await originalUpload(...args);
    uploaded();
    await acknowledgement;
    return result;
  };
  const service = await serviceFor(t, { storage });
  const job = await service.createJob(request());
  await service.tick();
  const completing = service.tick();
  await objectUploaded;
  assert.equal((await service.getJob(job.id)).status, 'running');
  assert.equal((await service.notifications()).unreadCount, 0);
  await assert.rejects(service.download(job.id), error => error.status === 409);
  acknowledge();
  await completing;
  assert.equal((await service.getJob(job.id)).status, 'completed');
  assert.equal((await service.notifications()).unreadCount, 1);
});

test('failed upload never exposes a completed result and cleans a remotely written object', async t => {
  const storage = createFakeStorage();
  const originalUpload = storage.upload.bind(storage);
  storage.upload = async (...args) => { await originalUpload(...args); throw new Error('S3 completion response failed'); };
  const service = await serviceFor(t, { storage });
  const job = await service.createJob(request());
  await service.tick();
  await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'failed');
  assert.equal((await service.getJob(job.id)).error.code, 'REPORT_STORAGE_FAILED');
  assert.equal((await service.getJob(job.id)).result, undefined);
  assert.equal(storage.objects.size, 0);
  assert.equal((await row(service, "SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='jobs' AND column_name='file'")).count, 0);
  await assert.rejects(service.download(job.id), error => error.status === 409);
  await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'failed');
});

test('expired-object deletion failures retain a durable cleanup intent and retry', async t => {
  const clock = makeClock();
  const storage = createFakeStorage();
  const service = await serviceFor(t, { storage, now: clock.now });
  const job = await service.createJob(request());
  await service.tick();
  await service.tick();
  clock.set((await service.getJob(job.id)).expiresAt);
  const originalDelete = storage.delete.bind(storage);
  storage.delete = async () => { throw new Error('S3 unavailable'); };
  await service.tick();
  assert.equal(storage.objects.size, 1);
  assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 1);
  assert.equal((await row(service, 'SELECT result_metadata FROM jobs WHERE id=$1', [job.id])).result_metadata.objectDeletedAt, undefined);
  await assert.rejects(service.download(job.id), error => error.status === 410);
  storage.delete = originalDelete;
  await service.tick();
  assert.equal(storage.objects.size, 0);
  assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 0);
});

test('failed metadata commit leaves cleanup durable across service restart', async t => {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  const storage = createFakeStorage();
  const originalDelete = storage.delete.bind(storage);
  storage.delete = async () => { throw new Error('temporary delete outage'); };
  service = await createService({ ...database, storage, seedDemo: false, processingDelayMs: 0 });
  const job = await service.createJob(request());
  await service.db.query(`
    CREATE FUNCTION reject_completed_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status='completed' THEN RAISE EXCEPTION 'test commit failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_completion BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION reject_completed_update();
  `);
  await service.tick();
  await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'failed');
  assert.equal(storage.objects.size, 1);
  assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 1);
  await service.close();
  storage.delete = originalDelete;
  service = await createService({ ...database, storage, seedDemo: false });
  assert.equal(storage.objects.size, 0);
  assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 0);
});

test('graceful shutdown cancels upload and preserves the job for restart', async t => {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  const storage = createFakeStorage();
  const originalUpload = storage.upload.bind(storage);
  let uploaded;
  const objectUploaded = new Promise(resolve => { uploaded = resolve; });
  storage.upload = async (key, producer, { signal } = {}) => {
    await originalUpload(key, producer, { signal });
    uploaded();
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  service = await createService({ ...database, storage, seedDemo: false, processingDelayMs: 0 });
  const job = await service.createJob(request());
  await service.tick();
  const active = service.tick();
  await objectUploaded;
  await service.close();
  await active;
  assert.equal(storage.objects.size, 0);
  storage.upload = originalUpload;
  service = await createService({ ...database, storage, seedDemo: false, processingDelayMs: 0 });
  assert.equal((await service.getJob(job.id)).status, 'queued');
  assert.equal((await service.notifications()).unreadCount, 0);
  await service.tick(); await service.tick();
  assert.equal((await service.getJob(job.id)).status, 'completed');
  assert.equal((await service.notifications()).unreadCount, 1);
});

test('isolated PostgreSQL schemas use distinct S3 namespaces even for equal job IDs', async t => {
  const storage = createFakeStorage();
  const first = await serviceFor(t, { storage });
  const second = await serviceFor(t, { storage });
  const a = await first.createJob(request());
  const b = await second.createJob(request());
  assert.equal(a.id, b.id);
  for (const service of [first, second]) { await service.tick(); await service.tick(); }
  assert.equal(storage.objects.size, 2);
  assert.ok((await readDownload(first, a.id)).file.length > 0);
  assert.ok((await readDownload(second, b.id)).file.length > 0);
});

test('S3 missing objects and temporary failures produce distinct download responses', async t => {
  const storage = createFakeStorage();
  const { app, url } = await appFor(t, { storage });
  const job = await app.service.createJob(request());
  await app.service.tick(); await app.service.tick();
  const originalGet = storage.get.bind(storage);
  storage.get = async () => { throw new Error('network failure'); };
  assert.equal((await fetch(`${url}/api/jobs/${job.id}/download`)).status, 503);
  storage.get = originalGet;
  storage.objects.clear();
  assert.equal((await fetch(`${url}/api/jobs/${job.id}/download`)).status, 410);
  storage.check = async () => { throw new Error('bucket offline'); };
  assert.equal((await fetch(`${url}/api/ready`)).status, 503);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('disconnecting a download cancels the S3 readable instead of draining the full object', async t => {
  const storage = createFakeStorage();
  const { app, url } = await appFor(t, { storage });
  const job = await app.service.createJob(request());
  await app.service.tick(); await app.service.tick();
  let chunks = 0;
  let source;
  let sourceReady;
  const ready = new Promise(resolve => { sourceReady = resolve; });
  storage.get = async () => {
    source = new Readable({
      read() { setImmediate(() => { if (!this.destroyed) { chunks++; this.push(Buffer.alloc(65536)); } }); },
    });
    sourceReady();
    return { body: source };
  };
  const responseStarted = new Promise((resolve, reject) => {
    const request = httpGet(`${url}/api/jobs/${job.id}/download`, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await ready;
  const closed = once(source, 'close').catch(error => { if (error.name !== 'AbortError') throw error; });
  await responseStarted;
  await closed;
  assert.equal(source.destroyed, true);
  assert.ok(chunks < 100, `read ${chunks} chunks after client disconnect`);
});


test('parallel requests receive unique PostgreSQL-generated IDs and persist all jobs', async t => {
  const service = await serviceFor(t);
  const jobs = await Promise.all(Array.from({ length: 40 }, () => service.createJob(request())));
  assert.equal(new Set(jobs.map(job => job.id)).size, 40);
  assert.ok(jobs.every(job => Number.isSafeInteger(job.id) && job.status === 'queued'));
  const listed = await service.listJobs(new URLSearchParams({ pageSize: '100' }));
  assert.equal(listed.allCount, 40);
  assert.equal(listed.total, 40);
  assert.deepEqual(new Set(listed.items.map(job => job.id)), new Set(jobs.map(job => job.id)));
});

test('transaction rollback is isolated from a concurrent committed request', async t => {
  const service = await serviceFor(t);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const transaction = service.db.transaction(async client => {
    await client.query("INSERT INTO settings(key,value) VALUES('must_rollback','temporary')");
    entered();
    await gate;
    throw new Error('intentional transaction rollback');
  });
  const rejected = assert.rejects(transaction, /intentional transaction rollback/);
  let job;
  try {
    await ready;
    job = await service.createJob(request());
  } finally { release(); }
  await rejected;
  assert.equal((await row(service, "SELECT COUNT(*)::int AS count FROM settings WHERE key='must_rollback'")).count, 0);
  assert.equal((await service.getJob(job.id)).status, 'queued');
});

test('one active service owns a PostgreSQL schema and a clean shutdown releases its advisory lock', async t => {
  let service;
  t.after(() => service?.close());
  const database = await postgresFixture(t);
  const options = { ...database, seedDemo: false, processingDelayMs: 0, storage: createFakeStorage() };
  service = await createService(options);
  const job = await service.createJob(request());
  await service.tick();
  await assert.rejects(createService(options), error => error.code === 'DATABASE_IN_USE');
  assert.equal((await service.getJob(job.id)).status, 'running', 'rejected second service must not requeue an active job');
  await service.close();
  service = await createService(options);
  assert.equal((await service.getJob(job.id)).status, 'queued');
});

for (const shuttingDown of [false, true]) {
  test(`lost completion COMMIT acknowledgement preserves the ready report${shuttingDown ? ' during shutdown' : ''}`, async t => {
    let service;
    t.after(() => service?.close());
    const database = await postgresFixture(t);
    const storage = createFakeStorage();
    const options = { ...database, storage, seedDemo: false, processingDelayMs: 0 };
    service = await createService(options);
    const job = await service.createJob(request());
    await service.tick();
    const transaction = service.db.transaction.bind(service.db);
    let interrupted = false;
    let closing;
    service.db.transaction = async callback => {
      const result = await transaction(callback);
      // PostgreSQL committed all changes, but the client lost its COMMIT reply.
      if (!interrupted && (await service.getJob(job.id)).status === 'completed') {
        interrupted = true;
        if (shuttingDown) closing = service.close();
        throw new Error('connection closed before COMMIT acknowledgement');
      }
      return result;
    };
    await service.tick();
    if (shuttingDown) {
      await closing;
      service = await createService(options);
    }
    assert.equal(interrupted, true, 'failure must occur after the completion transaction committed');
    const result = await service.getJob(job.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.error, undefined);
    const notifications = await service.notifications();
    assert.equal(notifications.items.length, 1);
    assert.match(notifications.items[0].title, /готов к скачиванию/);
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.deleted.length, 0);
    assert.equal((await row(service, 'SELECT COUNT(*)::int AS count FROM object_cleanup')).count, 0);
    assert.ok((await readDownload(service, job.id)).file.length > 0);
  });
}

test('a replacement worker keeps its S3 result when an old upload completes after PostgreSQL ownership is lost', async t => {
  let first;
  let replacement;
  let releaseOld;
  const delayedPut = new Promise(resolve => { releaseOld = resolve; });
  t.after(async () => {
    releaseOld();
    // Losing the dedicated PostgreSQL session intentionally rejects the old tick.
    await Promise.allSettled([first?.close(), replacement?.close()]);
  });
  const database = await postgresFixture(t);
  const storage = createFakeStorage();
  const originalUpload = storage.upload.bind(storage);
  let oldKey;
  let started;
  const oldPutStarted = new Promise(resolve => { started = resolve; });
  storage.upload = async (key, producer, { signal } = {}) => {
    if (!oldKey) {
      oldKey = key;
      started();
      // Simulate a request already sent to S3: a late PUT can still commit even
      // after its worker lost the DB lock and its AbortSignal was cancelled.
      await delayedPut;
      const result = await originalUpload(key, producer);
      if (signal.aborted) {
        await storage.delete(key);
        throw signal.reason;
      }
      return result;
    }
    return originalUpload(key, producer, { signal });
  };
  const options = { ...database, storage, seedDemo: false, processingDelayMs: 0 };
  first = await createService(options);
  const job = await first.createJob(request());
  await first.tick();
  const oldTickRejected = assert.rejects(first.tick(), error => error.code === '57P01');
  await oldPutStarted;
  const owners = await database.query(`SELECT pid FROM pg_locks
    WHERE locktype='advisory' AND granted AND objsubid=2
      AND classid=(hashtext(current_database())::bigint & 4294967295)::oid
      AND objid=(hashtext($1)::bigint & 4294967295)::oid`, [`report-serv-owner:${database.databaseSchema}`]);
  assert.equal(owners.rowCount, 1, 'terminate only this test schema\'s dedicated owner session');
  const lost = once(first.db.signal, 'abort');
  assert.equal((await database.query('SELECT pg_terminate_backend($1) AS stopped', [owners.rows[0].pid])).rows[0].stopped, true);
  await lost;
  replacement = await createService(options);
  assert.equal((await replacement.getJob(job.id)).status, 'queued');
  await replacement.tick();
  await replacement.tick();
  const completed = await replacement.getJob(job.id);
  assert.equal(completed.status, 'completed');
  const metadata = (await row(replacement, 'SELECT result_metadata FROM jobs WHERE id=$1', [job.id])).result_metadata;
  assert.notEqual(metadata.key, oldKey, 'each attempt requires its own S3 key');
  releaseOld();
  await oldTickRejected;
  assert.ok(storage.objects.has(metadata.key), 'late cleanup from the old worker must preserve the replacement result');
  assert.equal(storage.objects.has(oldKey), false);
  assert.equal(storage.objects.size, 1);
  assert.equal((await replacement.notifications()).items.length, 1);
  assert.ok((await readDownload(replacement, job.id)).file.length > 0);
});
