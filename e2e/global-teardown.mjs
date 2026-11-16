import { Pool } from 'pg';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

export default async function teardown(config) {
  const { s3Prefix, databaseSchema } = config.metadata;
  // Only objects inside this run's random namespace can be removed.
  if (!/\/e2e-[a-f0-9-]+\/$/.test(s3Prefix)) throw new Error('Invalid isolated E2E S3 prefix');
  if (!/^e2e_[a-f0-9]{32}$/.test(databaseSchema)) throw new Error('Invalid isolated E2E PostgreSQL schema');
  const database = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL });
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    ...(process.env.S3_ACCESS_KEY_ID && { credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } }),
  });
  try {
    let continuation;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET || 'reports', Prefix: s3Prefix, ContinuationToken: continuation }));
      if (page.Contents?.length) await client.send(new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET || 'reports', Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
      }));
      continuation = page.NextContinuationToken;
    } while (continuation);
  } finally {
    client.destroy();
    try { await database.query(`DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`); }
    finally { await database.end(); }
  }
}
