import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJdk25, javaEnvironment, JDK_DIRECTORY, resolveJavaHome } from './java-home.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'report-serv-java-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeJdk(home, { java = 25, javac = java, symbols = true } = {}) {
  await mkdir(join(home, 'bin'), { recursive: true });
  await mkdir(join(home, 'lib'), { recursive: true });
  await writeFile(join(home, 'bin', 'java'), `#!/bin/sh\nprintf '%s\\n' 'openjdk version "${java}.0.1"' >&2\n`, { mode: 0o755 });
  if (javac !== null) await writeFile(join(home, 'bin', 'javac'), `#!/bin/sh\nprintf '%s\\n' 'javac ${javac}.0.1'\n`, { mode: 0o755 });
  if (symbols) await writeFile(join(home, 'lib', 'ct.sym'), 'test compiler signatures');
  return home;
}

test('requires matching Java 25 runtime, compiler and release signatures', async t => {
  const root = await directory(t);
  assert.equal(isJdk25(await fakeJdk(join(root, 'valid'))), true);
  assert.equal(isJdk25(await fakeJdk(join(root, 'old'), { java: 21 })), false);
  assert.equal(isJdk25(await fakeJdk(join(root, 'mixed'), { java: 21, javac: 25 })), false);
  assert.equal(isJdk25(await fakeJdk(join(root, 'jre'), { javac: null, symbols: false })), false);
});

test('uses a complete JAVA_HOME 25 and exports it consistently for build and runtime', async t => {
  const root = await directory(t);
  const home = await fakeJdk(join(root, 'jdk25'));
  const env = { JAVA_HOME: home, PATH: '/usr/bin', CUSTOM_OPTION: 'preserved' };
  assert.equal(await resolveJavaHome({ env, install: () => assert.fail('Unexpected installation') }), home);
  const selected = javaEnvironment(home, env);
  assert.equal(selected.JAVA_HOME, home);
  assert.equal(selected.PATH, `${home}/bin:/usr/bin`);
  assert.equal(selected.CUSTOM_OPTION, 'preserved');
});

test('rejects JAVA_HOME 21 and finds the full JDK 25 further along PATH', async t => {
  const root = await directory(t);
  const old = await fakeJdk(join(root, 'jdk21'), { java: 21 });
  const current = await fakeJdk(join(root, 'jdk25'));
  const selected = await resolveJavaHome({
    env: { JAVA_HOME: old, PATH: `${old}/bin:${current}/bin` },
    install: () => assert.fail('Unexpected installation'),
  });
  assert.equal(selected, current);
});

test('host JRE 21 uses verified cached JDK 25 without falling back to the old runtime', async t => {
  const root = await directory(t);
  const host = await fakeJdk(join(root, 'host'), { java: 21, javac: null, symbols: false });
  const cache = join(root, 'cache');
  const home = await fakeJdk(join(cache, JDK_DIRECTORY));
  assert.equal(await resolveJavaHome({
    env: { JAVA_HOME: host, PATH: `${host}/bin` }, cacheDirectory: cache,
    install: () => assert.fail('The already verified cache must be reused'),
  }), home);
});

test('missing JDK invokes installation once and verifies the resulting Java major', async t => {
  const root = await directory(t);
  const cache = join(root, 'cache');
  let attempts = 0;
  const options = { env: { PATH: '' }, cacheDirectory: cache, install: async home => { attempts++; await fakeJdk(home); } };
  const home = await resolveJavaHome(options);
  assert.equal(await resolveJavaHome(options), home);
  assert.equal(attempts, 1);
  await assert.rejects(resolveJavaHome({
    env: { PATH: '' }, cacheDirectory: join(root, 'invalid-cache'), install: home => fakeJdk(home, { java: 21 }),
  }), /complete Java 25 JDK/);
});
