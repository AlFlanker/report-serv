import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, ListMultipartUploadsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createS3Storage } from '../server/s3-storage.mjs';
import { writeWorkbook } from '../server/workbook.mjs';
import { createApp } from '../server/index.mjs';

async function fixture(t) {
  const bucket = process.env.S3_BUCKET || 'reports';
  const prefix = `${(process.env.S3_PREFIX || 'reports').replace(/\/+$/, '')}/integration-${randomUUID()}/`;
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    ...(process.env.S3_ACCESS_KEY_ID && { credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } }),
  });
  const commands = [];
  client.middlewareStack.add((next, context) => async args => {
    const result = await next(args);
    commands.push(context.commandName);
    return result;
  }, { step: 'initialize', name: 'recordSuccessfulS3Commands' });
  const storage = createS3Storage({ client, bucket, prefix, partSize: 5 * 1024 * 1024, queueSize: 2 });
  t.after(async () => {
    try {
      let continuation;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation }));
        if (page.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) } }));
        continuation = page.NextContinuationToken;
      } while (continuation);
    } finally { client.destroy(); }
  });
  await storage.check();
  return { client, storage, commands, bucket, prefix };
}

test('real S3: API creates XLSX, stores only metadata, downloads and deletes an expired object', { timeout: 30000 }, async t => {
  const { storage, client, bucket } = await fixture(t);
  let now = new Date('2026-11-16T10:00:00Z');
  const app = await createApp({ storage, dbPath: ':memory:', seedDemo: false, startWorker: false, processingDelayMs: 0, now: () => new Date(now) });
  t.after(() => app.close());
  const address = await app.listen(0);
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${url}/api/ready`)).status, 200);
  const job = app.service.createJob({ reportId: 'turnovers', parameters: {
    department: '6000', account: '03210001234', startDate: '2026-10-01', endDate: '2026-10-31',
  } });
  await app.service.tick();
  await app.service.tick();
  const ready = app.service.getJob(job.id);
  assert.equal(ready.status, 'completed');
  const record = app.service.db.prepare('SELECT file,result_metadata FROM jobs WHERE id=?').get(job.id);
  assert.equal(record.file, null);
  const metadata = JSON.parse(record.result_metadata);
  const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: metadata.key }));
  assert.equal(object.ContentLength, ready.result.sizeBytes);
  const response = await fetch(`${url}/api/jobs/${job.id}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml/);
  const workbook = new ExcelJS.Workbook();
  // Deliberately buffer this tiny fixture in a test, never in application code.
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  assert.equal(workbook.getWorksheet('Данные').actualRowCount, ready.result.rowCount + 1);
  assert.equal(workbook.getWorksheet('Параметры').getCell('B7').value, '03210001234');
  now = new Date(ready.expiresAt);
  assert.equal((await fetch(`${url}/api/jobs/${job.id}/download`)).status, 410);
  await app.service.tick();
  await assert.rejects(client.send(new HeadObjectCommand({ Bucket: bucket, Key: metadata.key })), error => error.$metadata?.httpStatusCode === 404);
});

test('real S3: a large lazy XLSX uses multiple upload parts and survives streaming readback', { timeout: 120000 }, async t => {
  const { storage, commands, prefix } = await fixture(t);
  const count = 50000;
  let first;
  let last;
  const source = {
    columns: [{ key: 'number', title: 'Номер' }, { key: 'value', title: 'Значение' }],
    rows: (async function* () {
      for (let i = 1; i <= count; i++) {
        const value = randomBytes(128).toString('hex');
        if (i === 1) first = value;
        last = value;
        yield { number: i, value };
      }
    })(),
  };
  const uploaded = await storage.upload(`${prefix}large.xlsx`, (output, signal) => writeWorkbook(
    { id: 'test', name: 'Проверка потока' }, { department: '6000' }, output, { signal, source },
  ));
  assert.equal(uploaded.rowCount, count);
  assert.ok(uploaded.sizeBytes > 5 * 1024 * 1024, 'real compressed XLSX must exceed one part');
  assert.ok(commands.includes('CreateMultipartUploadCommand'));
  assert.ok(commands.filter(command => command === 'UploadPartCommand').length >= 2);
  assert.ok(commands.includes('CompleteMultipartUploadCommand'));
  const object = await storage.get(uploaded.key);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(object.body);
  let rows = 0;
  for await (const sheet of reader) {
    for await (const row of sheet) {
      if (sheet.name !== 'Данные' || row.number === 1) continue;
      rows++;
      if (rows === 1) assert.equal(row.getCell(2).value, first);
      if (rows === count) assert.equal(row.getCell(2).value, last);
    }
  }
  assert.equal(rows, count);
});

test('real S3: cancelling after the first uploaded part leaves neither object nor multipart session', { timeout: 45000 }, async t => {
  const { storage, client, commands, prefix, bucket } = await fixture(t);
  const key = `${prefix}cancelled.xlsx`;
  const controller = new AbortController();
  const uploading = storage.upload(key, async (output, signal) => {
    const chunk = randomBytes(64 * 1024);
    while (true) {
      signal.throwIfAborted();
      if (!output.write(chunk)) await once(output, 'drain', { signal });
    }
  }, { signal: controller.signal });
  // Attach a rejection handler immediately while waiting for a real remote part.
  const rejected = assert.rejects(uploading, error => error.message === 'cancelled by integration test'
    || (error.name === 'AbortError' && error.cause?.message === 'cancelled by integration test'));
  try {
    for (let n = 0; n < 300 && !commands.includes('UploadPartCommand'); n++) await delay(50);
    assert.ok(commands.includes('UploadPartCommand'), 'cancellation must exercise an active multipart upload');
  } finally { controller.abort(new Error('cancelled by integration test')); }
  await rejected;
  const pending = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
  assert.equal(pending.Uploads?.length ?? 0, 0);
  await assert.rejects(client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })), error => error.$metadata?.httpStatusCode === 404);
});
