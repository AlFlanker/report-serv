import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiPort = process.env.API_PORT || process.env.PORT || '3001';
const webPort = process.env.WEB_PORT || '4200';
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 30000).unref();
  process.exitCode = code;
}

for (const args of [
  ['scripts/java-api.mjs'],
  ['node_modules/@angular/cli/bin/ng.js', 'serve', '--host', '0.0.0.0', '--port', webPort, '--proxy-config', 'proxy.conf.cjs', '--poll', '1000'],
]) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: args[0] === 'scripts/java-api.mjs' ? apiPort : webPort, API_PORT: apiPort },
  });
  children.push(child);
  child.on('error', error => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', code => {
    if (!stopping) stop(code || 1);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
