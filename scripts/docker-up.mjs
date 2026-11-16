import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const [command, args] of [
  [process.execPath, ['scripts/setup-local-s3.mjs']],
  [process.execPath, ['scripts/setup-local-postgres.mjs']],
  [process.execPath, ['scripts/build-docker.mjs']],
  ['docker', ['compose', '--profile', 'app', 'up', '-d', '--wait', '--no-build']],
]) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
