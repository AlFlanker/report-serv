import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';

export const JAVA_MAJOR = 25;
export const JDK_IMAGE = 'maven@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976';
export const JDK_DIRECTORY = 'temurin-jdk-25-93b8a14ea2f4';
const root = fileURLToPath(new URL('../', import.meta.url));
const defaultCache = join(root, '.cache', 'maven');

/** Require both a Java 25 runtime and the complete matching compiler. */
export function isJdk25(home) {
  if (!home || !['bin/java', 'bin/javac', 'lib/ct.sym'].every(path => existsSync(join(home, path)))) return false;
  const java = spawnSync(join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
  const compiler = spawnSync(join(home, 'bin', 'javac'), ['-version'], { encoding: 'utf8' });
  return java.status === 0 && /\bversion\s+"25(?:\.|"|\+)/.test(`${java.stdout}\n${java.stderr}`)
    && compiler.status === 0 && /^javac 25(?:\.|\s|\+|$)/m.test(`${compiler.stdout}\n${compiler.stderr}`);
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

/** Extract only from the pinned official image, then publish the complete JDK atomically. */
async function installPinnedJdk(home) {
  await mkdir(dirname(home), { recursive: true });
  const temporary = await mkdtemp(join(dirname(home), '.jdk25-install-'));
  const extracted = join(temporary, 'jdk');
  const container = `report-serv-jdk25-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    checked('docker', ['pull', JDK_IMAGE]);
    checked('docker', ['create', '--name', container, JDK_IMAGE], { stdio: ['ignore', 'pipe', 'inherit'] });
    checked('docker', ['cp', `${container}:/opt/java/openjdk`, extracted]);
    if (!isJdk25(extracted)) throw new Error('The pinned Java image did not contain a complete JDK 25');
    try { await rename(extracted, home); }
    catch (error) {
      // A concurrent build may have published the same immutable JDK first.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !isJdk25(home)) throw error;
    }
    console.log('Installed verified Temurin JDK 25 in .cache/maven.');
  } finally {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Shared by Maven and the local API so their Java major versions cannot diverge. */
export async function resolveJavaHome({ env = process.env, cacheDirectory = defaultCache, install = installPinnedJdk } = {}) {
  if (isJdk25(env.JAVA_HOME)) return realpath(env.JAVA_HOME);
  const seen = new Set();
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const command of ['javac', 'java']) {
      let candidate;
      try { candidate = dirname(dirname(await realpath(join(directory, command)))); }
      catch { continue; }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (isJdk25(candidate)) return candidate;
    }
  }
  const home = join(cacheDirectory, JDK_DIRECTORY);
  if (!isJdk25(home)) await install(home);
  if (!isJdk25(home)) throw new Error('A complete Java 25 JDK is required for the build and local API');
  return home;
}

export function javaEnvironment(home, env = process.env) {
  return { ...env, JAVA_HOME: home, PATH: `${join(home, 'bin')}${delimiter}${env.PATH || ''}` };
}
