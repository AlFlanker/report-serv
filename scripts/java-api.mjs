import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { javaEnvironment, resolveJavaHome } from './java-home.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const jar = join(root, 'backend', 'target', 'report-serv.jar');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  child?.kill(signal);
});

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal && !stopping ? 1 : 0)));
  });
}

try {
  const javaHome = await resolveJavaHome();
  const env = javaEnvironment(javaHome);
  if (!process.argv.includes('--no-build')) {
    const status = await run(process.execPath, ['scripts/maven.mjs', '-DskipTests', 'package'], env);
    if (status !== 0) process.exitCode = status;
  }
  if (!stopping && !process.exitCode) {
    if (!existsSync(jar)) throw new Error('Backend JAR is missing; run npm run build:api first.');
    const assets = pathToFileURL(join(root, 'dist/report-serv/browser/')).href;
    process.exitCode = await run(join(javaHome, 'bin', 'java'), ['-jar', jar, `--spring.web.resources.static-locations=${assets},classpath:/static/`], env);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
