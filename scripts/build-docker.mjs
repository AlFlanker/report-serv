import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = ['build'];
// Trust a configured corporate/cloud CA only during dependency installation.
// BuildKit secret mounts keep certificate files out of image layers.
const certificate = process.env.BUILD_CA_CERT || process.env.CODEX_PROXY_CERT;
if (certificate) args.push('--secret', `id=proxy_ca,src=${certificate}`);
args.push('-t', 'report-serv:local', '.');
const result = spawnSync('docker', args, {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
