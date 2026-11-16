import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Transform } from 'node:stream';

const MIB = 1024 * 1024;
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function integer(value, fallback, name, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return result;
}
function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/** SDK v3 managed multipart upload with a fixed, configurable memory budget. */
export function createS3Storage(options = {}) {
  const endpoint = options.endpoint ?? process.env.S3_ENDPOINT;
  const bucket = options.bucket ?? process.env.S3_BUCKET ?? 'reports';
  const prefix = options.prefix ?? process.env.S3_PREFIX ?? 'reports/';
  const region = options.region ?? process.env.S3_REGION ?? 'us-east-1';
  const envPartSize = process.env.S3_PART_SIZE_MIB === undefined ? undefined : Number(process.env.S3_PART_SIZE_MIB) * MIB;
  const partSize = integer(options.partSize ?? envPartSize, 8 * MIB, 'S3 part size (bytes)', 5 * MIB, 64 * MIB);
  const queueSize = integer(options.queueSize ?? process.env.S3_UPLOAD_CONCURRENCY, 2, 'S3_UPLOAD_CONCURRENCY', 1, 8);
  const accessKeyId = options.accessKeyId ?? process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = options.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error('Both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together');
  if (!bucket || typeof bucket !== 'string') throw new Error('S3_BUCKET is required');
  if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix.includes('..')) throw new Error('S3_PREFIX must be a relative object prefix without ..');
  if (endpoint && !/^https?:\/\//.test(endpoint)) throw new Error('S3_ENDPOINT must be an HTTP(S) URL');
  const client = options.client ?? new S3Client({
    ...(endpoint && { endpoint }), region,
    forcePathStyle: boolean(options.forcePathStyle ?? process.env.S3_FORCE_PATH_STYLE, Boolean(endpoint), 'S3_FORCE_PATH_STYLE'),
    ...(accessKeyId && { credentials: { accessKeyId, secretAccessKey } }),
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000, socketTimeout: 120_000 },
    maxAttempts: 3,
  });
  const uploadFactory = options.uploadFactory ?? (configuration => new Upload(configuration));
  return {
    bucket, prefix,
    async check() {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
      catch (error) {
        const failure = new Error(`S3 bucket '${bucket}' is unavailable; check endpoint, bucket and credentials (${error.name ?? 'S3 error'})`, { cause: error });
        failure.code = 'S3_UNAVAILABLE';
        throw failure;
      }
    },
    async upload(key, producer, { signal } = {}) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let sizeBytes = 0;
      const output = new Transform({
        highWaterMark: 64 * 1024,
        transform(chunk, encoding, callback) { sizeBytes += chunk.length; callback(null, chunk); },
      });
      output.on('error', () => {});
      // Upload.done() races its own abort controller and can reject before its
      // workers/AbortMultipartUpload finish. Keep that controller untouched:
      // stop new writes and destroy the input stream, then await done's full
      // worker/cleanup path. In-flight writes settle before deleting the object;
      // aborting their socket could race a late remote commit.
      const uploadClient = {
        config: client.config,
        async send(command, settings) {
          const cleanup = command.constructor.name === 'AbortMultipartUploadCommand';
          if (!cleanup) controller.signal.throwIfAborted();
          try { return await client.send(command, settings); }
          catch (error) {
            if (!cleanup) controller.abort(error);
            throw error;
          }
        },
      };
      const uploader = uploadFactory({
        client: uploadClient, params: { Bucket: bucket, Key: key, Body: output, ContentType: CONTENT_TYPE },
        partSize, queueSize, leavePartsOnError: false,
      });
      const onInternalAbort = () => output.destroy(controller.signal.reason ?? new DOMException('Upload cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      let committed = false;
      const uploaded = uploader.done().then(result => { committed = true; return result; });
      const generated = Promise.resolve().then(() => producer(output, controller.signal));
      try {
        const [metadata, remote] = await Promise.all([generated, uploaded]);
        controller.signal.throwIfAborted();
        return { key, bucket, sizeBytes, etag: remote.ETag, rowCount: metadata.rowCount };
      } catch (error) {
        controller.abort(error);
        output.destroy(error);
        await Promise.allSettled([generated, uploaded]);
        if (committed) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(cleanupError => {
          error.cleanupError = cleanupError;
        });
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', onInternalAbort);
      }
    },
    async get(key, { signal } = {}) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
      return { body: response.Body, contentLength: response.ContentLength, contentType: response.ContentType ?? CONTENT_TYPE, etag: response.ETag };
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
    close() { if (!options.client) client.destroy(); },
  };
}
