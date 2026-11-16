import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

// Explicit, small-fixture-only test double. Runtime always uses the S3 adapter.
export function createFakeStorage() {
  const objects = new Map();
  const uploadChunkSizes = [];
  return {
    bucket: 'test-reports', prefix: 'tests/', objects, deleted: [], uploadChunkSizes,
    async check() {},
    async close() {},
    async upload(key, producer, { signal } = {}) {
      const chunks = [];
      const output = new Writable({
        highWaterMark: 1024,
        write(chunk, encoding, callback) { uploadChunkSizes.push(chunk.length); chunks.push(Buffer.from(chunk)); callback(); },
      });
      const completion = finished(output);
      const production = Promise.resolve().then(() => producer(output, signal));
      const abort = () => output.destroy(signal.reason ?? new Error('Upload aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const [metadata] = await Promise.all([production, completion]);
        const file = Buffer.concat(chunks);
        objects.set(key, file);
        return { key, bucket: this.bucket, sizeBytes: file.length, rowCount: metadata.rowCount, etag: 'test-etag' };
      } catch (error) {
        output.destroy(error);
        await Promise.allSettled([production, completion]);
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    },
    async get(key, { signal } = {}) {
      signal?.throwIfAborted();
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('Missing test object'), { name: 'NoSuchKey' });
      return { body: Readable.from([object]), contentLength: object.length, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', etag: 'test-etag' };
    },
    async delete(key) { this.deleted.push(key); objects.delete(key); },
  };
}

export async function readDownload(service, id) {
  const { body, ...metadata } = await service.download(id);
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return { ...metadata, file: Buffer.concat(chunks) };
}
