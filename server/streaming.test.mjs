import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { writeWorkbook } from './workbook.mjs';
import { createS3Storage } from './s3-storage.mjs';

const report = { id: 'obligations', name: 'Исполнение бюджетных обязательств' };
const parameters = { department: '6000', startDate: '2026-11-01', endDate: '2026-11-15' };
const mib = 1024 * 1024;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function clientWith(send) {
  return { config: { endpoint: async () => ({ protocol: 'http:', hostname: 'localhost' }), forcePathStyle: true, requestChecksumCalculation: async () => 'WHEN_REQUIRED' }, send };
}
function bytesProducer(bytes, onChunk = () => {}) {
  return async (output, signal) => {
    async function* chunks() {
      for (let offset = 0; offset < bytes; offset += 64 * 1024) {
        signal.throwIfAborted();
        onChunk();
        yield Buffer.alloc(Math.min(64 * 1024, bytes - offset), 97);
      }
    }
    await pipeline(Readable.from(chunks()), output, { signal });
    return { rowCount: 42 };
  };
}

test('streaming XLSX round-trips actual metadata, scalar cells and rows', async () => {
  const chunks = [];
  const output = new PassThrough();
  output.on('data', chunk => chunks.push(chunk));
  const { rowCount } = await writeWorkbook(report, parameters, output);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks)); // Read-back buffer is test-only.
  assert.equal(rowCount, 4);
  assert.equal(workbook.getWorksheet('Данные').actualRowCount, rowCount + 1);
  assert.equal(workbook.getWorksheet('Параметры').getCell('B3').value, '6000');
  assert.equal(workbook.getWorksheet('Параметры').getCell('B4').value, '2026-11-01');
  assert.equal(workbook.getWorksheet('Данные').getCell('A2').value, '2026-11-01');
});

test('blocked ZIP consumer stops the source iterator with bounded row read-ahead and abort closes it', { timeout: 5000 }, async () => {
  let produced = 0;
  let sourceClosed = false;
  async function* rows() {
    try {
      for (let index = 0; index < 100_000; index++) {
        produced++;
        yield { value: randomBytes(4096).toString('base64') };
      }
    } finally { sourceClosed = true; }
  }
  const controller = new AbortController();
  const output = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) { /* Deliberately stalled S3 socket. */ } });
  const writing = writeWorkbook(report, parameters, output, {
    signal: controller.signal,
    source: { columns: [{ key: 'value', title: 'Данные' }], rows: rows() },
  });
  const rejected = assert.rejects(writing, error => error.name === 'AbortError');
  await delay(100);
  assert.ok(produced > 0, 'test must exercise the source producer');
  assert.ok(produced < 1000, `source read ${produced} rows despite fully blocked output`);
  const before = produced;
  await delay(50);
  assert.equal(produced, before, 'read-ahead must stop, not just slow down');
  controller.abort();
  await rejected;
  assert.equal(sourceClosed, true);
  assert.equal(output.destroyed, true);
});

test('a source error rejects workbook generation and tears down output', { timeout: 3000 }, async () => {
  const output = new PassThrough();
  output.resume();
  async function* rows() { yield { value: 'first' }; throw new Error('source failed'); }
  await assert.rejects(writeWorkbook(report, parameters, output, { source: { columns: [{ key: 'value', title: 'Данные' }], rows: rows() } }), /source failed/);
  assert.equal(output.destroyed, true);
});

test('upload exposes metadata only after producer and remote commit both complete', async () => {
  const entered = deferred();
  const release = deferred();
  const client = clientWith(async command => {
    assert.equal(command.constructor.name, 'PutObjectCommand');
    assert.equal(command.input.Body.length, 12);
    entered.resolve();
    await release.promise;
    return { ETag: 'etag' };
  });
  const store = createS3Storage({ client });
  let settled = false;
  const uploading = store.upload('reports/test.xlsx', bytesProducer(12)).finally(() => { settled = true; });
  await entered.promise;
  assert.equal(settled, false);
  release.resolve();
  assert.deepEqual(await uploading, { key: 'reports/test.xlsx', bucket: 'reports', sizeBytes: 12, etag: 'etag', rowCount: 42 });
});

test('cancel waits for an in-flight PUT to settle and deletes after its late commit', { timeout: 3000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const events = [];
  const client = clientWith(async command => {
    if (command.constructor.name === 'PutObjectCommand') {
      events.push('put started'); entered.resolve(); await release.promise;
      events.push('put committed'); return { ETag: 'etag' };
    }
    assert.equal(command.constructor.name, 'DeleteObjectCommand');
    events.push('deleted');
    return {};
  });
  const controller = new AbortController();
  const store = createS3Storage({ client });
  let settled = false;
  const uploading = store.upload('reports/late.xlsx', bytesProducer(12), { signal: controller.signal }).finally(() => { settled = true; });
  const rejected = assert.rejects(uploading, error => error.name === 'AbortError');
  await entered.promise;
  controller.abort();
  await delay(20);
  assert.equal(settled, false);
  assert.deepEqual(events, ['put started']);
  release.resolve();
  await rejected;
  assert.deepEqual(events, ['put started', 'put committed', 'deleted']);
});

test('multipart failure stops producer and awaits AbortMultipartUpload acknowledgement', { timeout: 5000 }, async () => {
  const cleanupEntered = deferred();
  const cleanupRelease = deferred();
  let generatedChunks = 0;
  let settled = false;
  const client = clientWith(async command => {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-1' };
      case 'UploadPartCommand': throw new Error('S3 part failed');
      case 'AbortMultipartUploadCommand': cleanupEntered.resolve(); await cleanupRelease.promise; return {};
      default: throw new Error(`Unexpected ${command.constructor.name}`);
    }
  });
  const store = createS3Storage({ client, partSize: 5 * mib, queueSize: 2 });
  const uploading = store.upload('reports/fail.xlsx', bytesProducer(128 * mib, () => { generatedChunks++; })).finally(() => { settled = true; });
  const rejected = assert.rejects(uploading, /S3 part failed|aborted/i);
  await cleanupEntered.promise;
  assert.equal(settled, false);
  assert.ok(generatedChunks * 64 * 1024 < 20 * mib, 'producer must stop before reading the full source');
  cleanupRelease.resolve();
  await rejected;
});

test('multipart COMPLETE cancellation waits for remote commit before final object deletion', { timeout: 5000 }, async () => {
  const completing = deferred();
  const release = deferred();
  const events = [];
  const client = clientWith(async command => {
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': return { UploadId: 'upload-2' };
      case 'UploadPartCommand': return { ETag: `part-${command.input.PartNumber}` };
      case 'CompleteMultipartUploadCommand': events.push('complete started'); completing.resolve(); await release.promise; events.push('complete committed'); return { ETag: 'final' };
      case 'DeleteObjectCommand': events.push('deleted'); return {};
      default: throw new Error(`Unexpected ${command.constructor.name}`);
    }
  });
  const controller = new AbortController();
  const store = createS3Storage({ client, partSize: 5 * mib, queueSize: 2 });
  let settled = false;
  const uploading = store.upload('reports/late-complete.xlsx', bytesProducer(6 * mib), { signal: controller.signal }).finally(() => { settled = true; });
  const rejected = assert.rejects(uploading, error => error.name === 'AbortError');
  await completing.promise;
  controller.abort();
  await delay(20);
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.deepEqual(events, ['complete started', 'complete committed', 'deleted']);
});
