import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const jar = join(root, 'backend', 'target', 'report-serv.jar');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  child?.kill(signal);
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal && !stopping ? 1 : 0)));
  });
}

try {
  if (!process.argv.includes('--no-build')) {
    const status = await run(process.execPath, ['scripts/maven.mjs', '-DskipTests', 'package']);
    if (status !== 0) process.exitCode = status;
  }
  if (!stopping && !process.exitCode) {
    if (!existsSync(jar)) throw new Error('Backend JAR is missing; run npm run build:api first.');
    const assets = pathToFileURL(join(root, 'dist/report-serv/browser/')).href;
    process.exitCode = await run('java', ['-jar', jar, `--spring.web.resources.static-locations=${assets},classpath:/static/`]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
