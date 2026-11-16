import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseArgs = ['build'];
// Trust a configured corporate/cloud CA only during dependency installation.
// BuildKit secret mounts keep certificate files out of image layers.
const certificate = process.env.BUILD_CA_CERT || process.env.CODEX_PROXY_CERT;
if (certificate) baseArgs.push('--secret', `id=proxy_ca,src=${certificate}`);
for (const [target, tag] of [['s3-init', 'report-serv-init:local'], ['runtime', 'report-serv:local']]) {
  const result = spawnSync('docker', [...baseArgs, '--target', target, '-t', tag, '.'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
