import {
  S3Client, HeadBucketCommand, CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { setTimeout as delay } from 'node:timers/promises';

const bucket = process.env.S3_BUCKET;
if (!bucket) throw new Error('S3_BUCKET is required.');
const region = process.env.S3_REGION || 'us-east-1';
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error('Both S3 credential variables must be supplied together.');
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || undefined,
  region,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  ...(accessKeyId && { credentials: { accessKeyId, secretAccessKey } }),
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 2,
});
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      break;
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchBucket') {
        await client.send(new CreateBucketCommand({
          Bucket: bucket,
          ...(region !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: region } }),
        }));
        break;
      }
      if (attempt >= 29 || [401, 403].includes(error.$metadata?.httpStatusCode)) throw error;
      await delay(1000);
    }
  }
  let rules = [];
  try {
    rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))).Rules ?? [];
  } catch (error) {
    if (!['NoSuchLifecycleConfiguration', 'NoSuchConfiguration'].includes(error.name) && error.$metadata?.httpStatusCode !== 404) throw error;
  }
  const id = 'report-serv-abort-incomplete-multipart';
  const lifecycle = {
    ID: id, Status: 'Enabled', Filter: { Prefix: process.env.S3_PREFIX || 'reports/' },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  };
  await client.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: { Rules: [...rules.filter(rule => rule.ID !== id), lifecycle] },
  }));
  console.log('S3 bucket is ready; abandoned multipart uploads expire after one day.');
} finally {
  client.destroy();
}
