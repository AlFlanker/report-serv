import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(root, '.env');
let configuration;
try {
  configuration = parseEnv(await readFile(envPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  configuration = {
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'reports',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: `reports-${randomBytes(10).toString('hex')}`,
    S3_SECRET_ACCESS_KEY: randomBytes(32).toString('hex'),
  };
  await writeFile(envPath, Object.entries(configuration).map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 });
  console.log('Created ignored .env with random local S3 credentials.');
}

for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET']) {
  if (!configuration[key]) throw new Error(`Existing .env is preserved; set ${key} before configuring local S3.`);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost):9000\/?$/.test(configuration.S3_ENDPOINT ?? '')) {
  throw new Error('Existing .env targets another endpoint and was preserved. Local Docker setup requires S3_ENDPOINT=http://127.0.0.1:9000.');
}
await mkdir(resolve(root, '.data'), { recursive: true, mode: 0o700 });
const iamPath = resolve(root, '.data/s3-iam.json');
const iam = {
  identities: [{
    name: 'report-service-local',
    credentials: [{ accessKey: configuration.S3_ACCESS_KEY_ID, secretKey: configuration.S3_SECRET_ACCESS_KEY }],
    actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
  }],
};
try {
  const existing = JSON.parse(await readFile(iamPath, 'utf8'));
  if (JSON.stringify(existing) !== JSON.stringify(iam)) throw new Error('Existing .data/s3-iam.json differs from .env and was preserved. Reconcile local credentials before starting Docker.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(iamPath, `${JSON.stringify(iam, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
console.log('Local S3 configuration is ready; credentials were not printed.');
