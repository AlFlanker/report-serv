import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
let existing = '';
try { existing = await readFile(envPath, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const configuration = parseEnv(existing);
const localUrl = configuration.DATABASE_URL ? parseLocalUrl(configuration.DATABASE_URL) : undefined;
const user = configuration.POSTGRES_USER || (localUrl && decodeURIComponent(localUrl.username)) || 'reports';
const database = configuration.POSTGRES_DB || (localUrl && decodeURIComponent(localUrl.pathname.slice(1))) || 'reports';
const password = configuration.POSTGRES_PASSWORD || (localUrl && decodeURIComponent(localUrl.password)) || randomBytes(32).toString('hex');
for (const [name, value] of [['POSTGRES_USER', user], ['POSTGRES_DB', database]]) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new Error(`${name} must be a PostgreSQL identifier of at most 63 characters for local setup.`);
}
if (/[\r\n\0]/.test(password)) throw new Error('POSTGRES_PASSWORD cannot contain control characters in local configuration.');
const encode = value => encodeURIComponent(value).replace(/'/g, '%27');
const address = `postgresql://${encode(user)}:${encode(password)}@`;
const local = `${address}127.0.0.1:5432/${encode(database)}`;
const docker = `${address}postgres:5432/${encode(database)}`;
if (localUrl && (decodeURIComponent(localUrl.username) !== user || decodeURIComponent(localUrl.password) !== password || decodeURIComponent(localUrl.pathname.slice(1)) !== database)) {
  throw new Error('Existing DATABASE_URL and POSTGRES_* credentials differ and were preserved. Reconcile them before configuring local PostgreSQL.');
}
if (configuration.DOCKER_DATABASE_URL && configuration.DOCKER_DATABASE_URL !== docker) {
  throw new Error('Existing DOCKER_DATABASE_URL differs from local PostgreSQL configuration and was preserved.');
}
const additions = Object.entries({ POSTGRES_USER: user, POSTGRES_DB: database, POSTGRES_PASSWORD: password,
  DATABASE_URL: local, DOCKER_DATABASE_URL: docker, DATABASE_SCHEMA: 'public' })
  .filter(([key]) => configuration[key] === undefined);
// Append only: existing S3 credentials, comments and unrelated variables survive.
// Empty placeholders are preserved too; report them instead of silently replacing.
for (const key of ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'DOCKER_DATABASE_URL']) {
  if (configuration[key] === '') throw new Error(`Existing .env is preserved; remove the empty ${key} placeholder or configure it before local setup.`);
}
if (additions.length) {
  // Both Node's dotenv parser and Compose preserve single-quoted values literally.
  // Do not guess an escaping convention when deriving a password from an URL.
  for (const [key, value] of additions) {
    if (value.includes("'")) throw new Error(`Configure ${key} explicitly in .env; its derived value cannot be safely appended by local setup.`);
  }
  const content = `${existing && !existing.endsWith('\n') ? '\n' : ''}${additions.map(([key, value]) => `${key}='${value}'`).join('\n')}\n`;
  await appendFile(envPath, content, { mode: 0o600 });
}
console.log('Local PostgreSQL configuration is ready; existing values were preserved and credentials were not printed.');

function parseLocalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Existing DATABASE_URL is invalid and was preserved.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || (url.port && url.port !== '5432') || url.search || url.hash || !url.username || !url.password || url.pathname.length < 2) {
    throw new Error('Existing DATABASE_URL targets another configuration and was preserved. Local Docker setup requires PostgreSQL on 127.0.0.1:5432 with explicit credentials.');
  }
  return url;
}
