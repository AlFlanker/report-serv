import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '3.9.16';
const cache = join(root, '.cache', 'maven');
const distribution = join(cache, `apache-maven-${version}`);
const executable = process.env.MAVEN_EXECUTABLE || join(distribution, 'bin', 'mvn');
await mkdir(cache, { recursive: true });

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function isJdk21(home) {
  if (!home || !existsSync(join(home, 'bin', 'javac')) || !existsSync(join(home, 'lib', 'ct.sym'))) return false;
  const result = spawnSync(join(home, 'bin', 'javac'), ['-version'], { encoding: 'utf8' });
  return result.status === 0 && /^javac 21(?:\.|\s)/.test(result.stdout.trim());
}
let javaHome = process.env.JAVA_HOME;
if (!isJdk21(javaHome)) {
  const candidate = spawnSync('sh', ['-c', 'command -v javac || command -v java'], { encoding: 'utf8' });
  if (candidate.status === 0 && candidate.stdout.trim()) {
    javaHome = dirname(dirname(await realpath(candidate.stdout.trim())));
  }
}
if (!isJdk21(javaHome)) {
  // The cloud machine can provide a Java 21 runtime without the compiler.
  // Reuse a digest-verified official Maven image as the JDK distribution.
  javaHome = join(cache, 'temurin-jdk-21.0.12.1');
  if (!isJdk21(javaHome)) {
    const image = 'maven@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320';
    const name = `report-serv-jdk-${process.pid}`;
    const temporary = `${javaHome}.${process.pid}`;
    checked('docker', ['pull', image]);
    try {
      checked('docker', ['create', '--name', name, image]);
      checked('docker', ['cp', `${name}:/opt/java/openjdk`, temporary]);
      if (!isJdk21(temporary)) throw new Error('The verified Java image did not contain a complete JDK 21');
      // Another concurrent build may have installed the same immutable JDK.
      if (!isJdk21(javaHome)) {
        try { await rename(temporary, javaHome); }
        catch (error) { if (!isJdk21(javaHome)) throw error; }
      }
      console.log('Installed verified Temurin JDK 21 in .cache/maven.');
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (!existsSync(executable)) {
  const archive = join(cache, `apache-maven-${version}-bin.tar.gz`);
  const temporary = `${archive}.${process.pid}.download`;
  const checksumFile = `${temporary}.sha512`;
  const url = `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${version}/apache-maven-${version}-bin.tar.gz`;
  try {
    checked('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', url, '--output', temporary]);
    checked('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', `${url}.sha512`, '--output', checksumFile]);
    const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash('sha512').update(await readFile(temporary)).digest('hex');
    if (!/^[a-f0-9]{128}$/.test(expected) || expected !== actual) throw new Error('Maven SHA-512 verification failed');
    await rename(temporary, archive);
    checked('tar', ['-xzf', archive, '-C', cache]);
    await chmod(executable, 0o755);
    console.log(`Installed verified Apache Maven ${version} in .cache/maven.`);
  } finally {
    await rm(temporary, { force: true });
    await rm(checksumFile, { force: true });
  }
}

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const settings = join(cache, `settings-${process.pid}.xml`);
let proxy = '';
if (proxyValue) {
  const url = new URL(proxyValue);
  const excluded = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(value => value.trim()).filter(Boolean)
    .map(value => value.startsWith('.') ? `*${value}` : value).join('|');
  proxy = `<proxies><proxy><id>environment-proxy</id><active>true</active><protocol>http</protocol><host>${xml(url.hostname)}</host><port>${url.port || '80'}</port>`
    + (url.username ? `<username>${xml(decodeURIComponent(url.username))}</username><password>${xml(decodeURIComponent(url.password))}</password>` : '')
    + `<nonProxyHosts>${xml(excluded)}</nonProxyHosts></proxy></proxies>`;
}
await writeFile(settings, `<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">${proxy}</settings>`, { mode: 0o600 });

let javaOptions = process.env.MAVEN_OPTS || '';
const certificate = process.env.BUILD_CA_CERT || process.env.CODEX_PROXY_CERT;
if (certificate) {
  const fingerprint = createHash('sha256').update(await readFile(certificate)).digest('hex').slice(0,16);
  const truststore = join(cache, `cacerts-${fingerprint}`);
  if (!existsSync(truststore)) {
    // Keep Java's default roots, adding only the configured corporate/cloud CA.
    const defaultTrust = join(javaHome, 'lib', 'security', 'cacerts');
    await copyFile(defaultTrust, truststore);
    checked('keytool', ['-importcert', '-noprompt', '-alias', `report-serv-proxy-${fingerprint}`, '-file', certificate, '-keystore', truststore, '-storepass', 'changeit']);
  }
  javaOptions += ` -Djavax.net.ssl.trustStore=${truststore} -Djavax.net.ssl.trustStorePassword=changeit`;
}

const child = spawn(executable, ['--batch-mode', '--no-transfer-progress', '-s', settings, `-Dmaven.repo.local=${join(cache, 'repository')}`, '-f', join(root, 'backend', 'pom.xml'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}:${process.env.PATH || ''}`, MAVEN_OPTS: javaOptions },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', async error => { console.error(error.message); await rm(settings, { force: true }); process.exitCode = 1; });
child.once('exit', async (code, signal) => { await rm(settings, { force: true }); process.exitCode = code ?? (signal ? 1 : 0); });
