import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const databaseSchema = `e2e_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Browser tests require DATABASE_URL; run npm run db:up first.');
const s3Prefix = `${(process.env.S3_PREFIX || 'reports').replace(/\/+$/, '')}/e2e-${randomUUID()}/`;
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  globalTeardown: './e2e/global-teardown.mjs',
  metadata: { databaseSchema, s3Prefix },
  use: {
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1440, height: 960 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4310',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      API_PORT: '4311',
      WEB_PORT: '4310',
      DATABASE_URL: databaseUrl,
      DATABASE_SCHEMA: databaseSchema,
      SEED_DEMO: 'true',
      S3_PREFIX: s3Prefix,
    },
  },
});
