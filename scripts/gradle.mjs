import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { javaEnvironment, resolveJavaHome } from './java-home.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.cache', 'gradle');
await mkdir(cache, { recursive: true });
const javaHome = await resolveJavaHome();

// gradlew reads JAVA_OPTS for its bootstrap JVM before Gradle is downloaded.
// Unlike JAVA_TOOL_OPTIONS, JAVA_OPTS is not echoed by the JVM at startup.
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const properties = [];
const proxyKeys = [['http', process.env.HTTP_PROXY || process.env.http_proxy],
  ['https', process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy]];
for (const [protocol, value] of proxyKeys) {
  if (!value) continue;
  let proxy;
  try { proxy = new URL(value); }
  catch { throw new Error(`${protocol.toUpperCase()}_PROXY must be a valid HTTP(S) proxy URL`); }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error(`${protocol.toUpperCase()}_PROXY must use HTTP(S)`);
  properties.push(`-D${protocol}.proxyHost=${proxy.hostname}`, `-D${protocol}.proxyPort=${proxy.port || (proxy.protocol === 'https:' ? '443' : '80')}`);
  if (proxy.username) properties.push(`-D${protocol}.proxyUser=${decodeURIComponent(proxy.username)}`,
    `-D${protocol}.proxyPassword=${decodeURIComponent(proxy.password)}`);
}
const excluded = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(value => value.trim()).filter(Boolean)
  .flatMap(value => value.startsWith('.') ? [`*${value}`, value.slice(1)] : [value === '::1' ? '[::1]' : value]).join('|');
if (excluded) properties.push(`-Dhttp.nonProxyHosts=${excluded}`, `-Dhttps.nonProxyHosts=${excluded}`);

const certificate = process.env.BUILD_CA_CERT || process.env.CODEX_PROXY_CERT;
if (certificate) {
  const defaultTrust = join(javaHome, 'lib', 'security', 'cacerts');
  const fingerprint = createHash('sha256').update(await readFile(certificate))
    .update(await readFile(defaultTrust)).digest('hex').slice(0, 16);
  const truststore = join(cache, `cacerts-${fingerprint}`);
  if (!existsSync(truststore)) {
    const temporary = `${truststore}.${randomUUID()}`;
    try {
      await copyFile(defaultTrust, temporary);
      const imported = spawnSync(join(javaHome, 'bin', 'keytool'), ['-importcert', '-noprompt', '-alias', `report-serv-proxy-${fingerprint}`,
        '-file', certificate, '-keystore', temporary, '-storepass', 'changeit'], { stdio: 'inherit' });
      if (imported.status !== 0) throw new Error('Importing the configured proxy CA into the Java truststore failed');
      await rename(temporary, truststore);
    } finally { await rm(temporary, { force: true }); }
  }
  properties.push(`-Djavax.net.ssl.trustStore=${truststore}`, '-Djavax.net.ssl.trustStorePassword=changeit');
}

const env = { ...javaEnvironment(javaHome), GRADLE_USER_HOME: cache,
  JAVA_OPTS: `${process.env.JAVA_OPTS || ''} ${properties.map(quote).join(' ')}`.trim() };
const child = spawn(join(root, 'backend', 'gradlew'), [...process.argv.slice(2), '--no-daemon', '--console=plain'], {
  cwd: join(root, 'backend'), stdio: 'inherit', env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
