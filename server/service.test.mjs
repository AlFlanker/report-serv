import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { createService } from './service.mjs';
import { createApp } from './index.mjs';
import { inNightWindow, nextNightWindow } from './domain.mjs';

const request = (reportId = 'obligations', parameters = {}) => ({ reportId, parameters: { startDate: '2026-11-01', endDate: '2026-11-15', department: '6000', ...parameters } });
const makeClock = (initial = '2026-11-16T10:00:00Z') => {
  let value = new Date(initial);
  return { now: () => new Date(value), set: stamp => { value = new Date(stamp); }, advance: milliseconds => { value = new Date(value.getTime() + milliseconds); } };
};
async function serviceFor(t, options = {}) {
  const service = await createService({ dbPath: ':memory:', seedDemo: false, processingDelayMs: 0, ...options });
  t.after(() => service.close());
  return service;
}
async function appFor(t, options = {}) {
  const app = await createApp({ dbPath: ':memory:', seedDemo: false, processingDelayMs: 0, startWorker: false, ...options });
  const address = await app.listen(0);
  t.after(() => app.close());
  return { app, url: `http://127.0.0.1:${address.port}` };
}
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'report-serv-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('ordinary job persists state transitions and produces a readable XLSX with parameters and fixture rows', async t => {
  const clock = makeClock();
  const service = await serviceFor(t, { now: clock.now });
  const job = service.createJob(request());
  assert.equal(job.status, 'queued');
  assert.throws(() => service.download(job.id), error => error.status === 409);
  await service.tick();
  assert.equal(service.getJob(job.id).status, 'running');
  await service.tick();
  const result = service.getJob(job.id);
  assert.equal(result.status, 'completed');
  const { file, fileName } = service.download(job.id);
  assert.match(fileName, /^report-\d+-obligations\.xlsx$/);
  assert.equal(file.length, result.result.sizeBytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  assert.equal(workbook.getWorksheet('Данные').actualRowCount, result.result.rowCount + 1);
  assert.ok(result.result.rowCount > 0);
  assert.equal(workbook.getWorksheet('Параметры').getCell('B3').value, '6000');
  assert.equal(service.notifications().unreadCount, 1);
  await service.tick();
  assert.equal(service.notifications().unreadCount, 1, 'completion must not notify twice');
});

test('night-only jobs wait outside 00–06 MSK and do not block ordinary jobs', async t => {
  const clock = makeClock();
  const service = await serviceFor(t, { now: clock.now });
  const night = service.createJob(request('operations'));
  const ordinary = service.createJob(request('payments'));
  await service.tick();
  assert.equal(service.getJob(night.id).status, 'queued');
  assert.equal(service.getJob(ordinary.id).status, 'running');
  await service.tick();
  assert.equal(service.getJob(ordinary.id).status, 'completed');
  clock.set('2026-11-16T21:00:00Z');
  await service.tick();
  assert.equal(service.getJob(night.id).status, 'running');
  await service.tick();
  assert.equal(service.getJob(night.id).status, 'completed');
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
  assert.equal(service.createJob(request('obligations', { startDate: '2026-10-01', endDate: '2026-10-31' })).status, 'queued');
  for (const body of [
    request('obligations', { startDate: '2026-10-01', endDate: '2026-11-01' }),
    request('obligations', { startDate: '2026-11-16', endDate: '2026-11-15' }),
    request('obligations', { startDate: '2026-02-30' }),
    request('obligations', { startDate: '01.11.2026' }),
    request('obligations', { department: 'unknown' }),
    request('turnovers'),
    request('turnovers', { account: '03210001234x' }),
    { reportId: 'balances', parameters: { department: '6000', asOfDate: '2026-11-31' } },
  ]) assert.throws(() => service.createJob(body), error => error.status === 400 && error.code === 'INVALID_PARAMETERS');
  assert.throws(() => service.createJob(request('missing')), error => error.code === 'UNKNOWN_REPORT');
  assert.equal(service.createJob(request('turnovers', { account: '03210001234' })).parameters.account, '03210001234');
  assert.equal(service.createJob({ reportId: 'balances', parameters: { department: '6000', asOfDate: '2026-11-15' } }).status, 'queued');
});

test('configured limits are reflected in catalog and backend validation', async t => {
  const service = await serviceFor(t, { maxPeriodDays: 2, retentionDays: 1 });
  assert.equal(service.catalog().config.maxPeriodDays, 2);
  assert.equal(service.catalog().config.retentionDays, 1);
  assert.throws(() => service.createJob(request()), error => error.code === 'INVALID_PARAMETERS');
  assert.equal(service.createJob(request('payments', { endDate: '2026-11-02' })).status, 'queued');
});

test('download expires exactly at retention boundary and worker removes persisted file bytes', async t => {
  const clock = makeClock();
  const service = await serviceFor(t, { now: clock.now, retentionDays: 1 });
  const job = service.createJob(request());
  await service.tick();
  await service.tick();
  const expiresAt = service.getJob(job.id).expiresAt;
  clock.set(new Date(Date.parse(expiresAt) - 1));
  assert.ok(service.download(job.id).file.length > 0);
  clock.set(expiresAt);
  assert.throws(() => service.download(job.id), error => error.status === 410 && error.code === 'RESULT_EXPIRED');
  await service.tick();
  assert.equal(service.db.prepare('SELECT file FROM jobs WHERE id=?').get(job.id).file, null);
  assert.equal(service.getJob(job.id).status, 'completed');
});

test('queued/running jobs survive restart and completed file remains identical after reopening', async t => {
  const directory = await temp(t);
  const dbPath = join(directory, 'reports.sqlite');
  const clock = makeClock();
  let service = await createService({ dbPath, seedDemo: false, now: clock.now, processingDelayMs: 0 });
  const job = service.createJob(request());
  await service.tick();
  assert.equal(service.getJob(job.id).status, 'running');
  await service.close();
  service = await createService({ dbPath, seedDemo: true, now: clock.now, processingDelayMs: 0 });
  assert.equal(service.listJobs(new URLSearchParams()).allCount, 1, 'existing empty-mode database must not be reseeded');
  assert.equal(service.getJob(job.id).status, 'queued');
  await service.tick();
  await service.tick();
  const before = service.download(job.id).file;
  await service.close();
  service = await createService({ dbPath, seedDemo: false, now: clock.now });
  assert.deepEqual(service.download(job.id).file, before);
  assert.equal(service.notifications().unreadCount, 1);
  await service.close();
});

test('six demo tasks include a terminal failure, real files and relative creation timestamps', async t => {
  const clock = makeClock('2030-05-08T10:00:00Z');
  const service = await serviceFor(t, { seedDemo: true, now: clock.now });
  const jobs = service.listJobs(new URLSearchParams({ createdFrom: '2030-05-01', createdTo: '2030-05-08' }));
  assert.equal(jobs.total, 6);
  assert.deepEqual(jobs.items.map(job => job.id), [1048, 1047, 1046, 1045, 1044, 1043]);
  assert.equal(service.getJob(1045).error.code, 'REPORT_FORMAT_MISMATCH');
  assert.throws(() => service.download(1045), error => error.status === 409);
  await service.tick();
  await service.tick();
  assert.equal(service.getJob(1045).status, 'failed');
  assert.ok(service.download(1046).file.length > 0);
});

test('demo seed inserts and initialized marker roll back together if insertion fails', async t => {
  const directory = await temp(t);
  const dbPath = join(directory, 'reports.sqlite');
  const service = await createService({ dbPath, seedDemo: false });
  service.db.exec("DELETE FROM settings; CREATE TRIGGER reject_demo BEFORE INSERT ON jobs WHEN NEW.id=1045 BEGIN SELECT RAISE(ABORT, 'test interruption'); END;");
  await service.close();
  await assert.rejects(createService({ dbPath, seedDemo: true }), /test interruption/);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settings').get().count, 0);
  db.exec('DROP TRIGGER reject_demo');
  db.close();
  const recovered = await createService({ dbPath, seedDemo: true });
  assert.equal(recovered.listJobs(new URLSearchParams()).total, 6);
  await recovered.close();
});

test('list supports search, status, Moscow creation date, ordering and pagination without exposing file bytes', async t => {
  const clock = makeClock('2026-11-15T22:00:00Z');
  const service = await serviceFor(t, { now: clock.now });
  const first = service.createJob(request('payments'));
  clock.advance(1000);
  const second = service.createJob(request('obligations'));
  assert.equal(service.listJobs(new URLSearchParams({ createdFrom: '2026-11-16', createdTo: '2026-11-16' })).total, 2);
  assert.equal(service.listJobs(new URLSearchParams({ createdTo: '2026-11-15' })).total, 0);
  assert.deepEqual(service.listJobs(new URLSearchParams({ pageSize: '1' })).items.map(job => job.id), [second.id]);
  assert.deepEqual(service.listJobs(new URLSearchParams({ pageSize: '1', page: '2' })).items.map(job => job.id), [first.id]);
  assert.deepEqual(service.listJobs(new URLSearchParams({ sort: 'asc' })).items.map(job => job.id), [first.id, second.id]);
  assert.equal(service.listJobs(new URLSearchParams({ search: 'ПЛАТЕЖНЫХ' })).total, 1);
  assert.equal(service.listJobs(new URLSearchParams({ search: `№ ${second.id}` })).items[0].id, second.id);
  assert.equal(service.listJobs(new URLSearchParams({ status: 'completed' })).total, 0);
  for (const query of [{ page: '-1' }, { pageSize: '1000' }, { status: 'other' }, { createdFrom: '2026-02-30' }, { sort: 'DROP TABLE' }]) assert.throws(() => service.listJobs(new URLSearchParams(query)), error => error.status === 400);
  assert.equal('file' in service.getJob(first.id), false);
});

test('older unread notifications remain reachable beyond first page and marking read is durable', async t => {
  const service = await serviceFor(t);
  const insert = service.db.prepare('INSERT INTO notifications(job_id,title,created_at) VALUES(?,?,?)');
  for (let i = 0; i < 105; i++) insert.run(1, `Report ${i}`, new Date().toISOString());
  const page = service.notifications();
  assert.equal(page.items.length, 100);
  assert.equal(page.unreadCount, 105);
  service.markNotifications({ ids: page.items.map(item => item.id) });
  const remainder = service.notifications();
  assert.equal(remainder.unreadCount, 5);
  assert.equal(remainder.items.filter(item => !item.read).length, 5);
  service.markNotifications({ ids: remainder.items.filter(item => !item.read).map(item => item.id) });
  assert.equal(service.notifications().unreadCount, 0);
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
