import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createService } from './service.mjs';
import { HttpError } from './domain.mjs';

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON_REQUIRED', 'Ожидается JSON.');
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', chunk => {
      length += chunk.length;
      if (length > 65536) reject(new HttpError(413, 'REQUEST_TOO_LARGE', 'Слишком большой запрос.'));
      else chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (length > 65536) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'INVALID_JSON', 'Некорректный JSON.')); }
    });
  });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };

export async function createApp(options = {}) {
  const service = await createService(options);
  const staticRoot = resolve(options.staticRoot ?? 'dist/report-serv/browser');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && path === '/api/ready') {
        try { return json(response, 200, await service.readiness()); }
        catch { throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'База данных или хранилище отчетов временно недоступны.'); }
      }
      if (request.method === 'GET' && path === '/api/catalog') return json(response, 200, service.catalog());
      if (request.method === 'GET' && path === '/api/jobs') return json(response, 200, await service.listJobs(url.searchParams));
      if (request.method === 'POST' && path === '/api/jobs') return json(response, 201, await service.createJob(await body(request)));
      if (request.method === 'GET' && path === '/api/notifications') return json(response, 200, await service.notifications());
      if (request.method === 'POST' && path === '/api/notifications/read') return json(response, 200, await service.markNotifications(await body(request)));
      const jobRoute = /^\/api\/jobs\/([1-9]\d*)(\/download)?$/.exec(path);
      if (request.method === 'GET' && jobRoute) {
        const id = Number(jobRoute[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'INVALID_JOB_ID', 'Некорректный номер задания.');
        if (!jobRoute[2]) return json(response, 200, await service.getJob(id));
        const controller = new AbortController();
        const stop = () => { if (!response.writableFinished) controller.abort(); };
        request.once('aborted', stop);
        response.once('close', stop);
        try {
          const { body: objectBody, fileName, contentLength } = await service.download(id, { signal: controller.signal });
          response.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            ...(Number.isSafeInteger(contentLength) && contentLength >= 0 && { 'Content-Length': contentLength }),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          await pipeline(objectBody, response, { signal: controller.signal });
          return;
        } catch (error) {
          if (controller.signal.aborted && response.destroyed) return;
          throw error;
        } finally {
          request.off('aborted', stop);
          response.off('close', stop);
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'Ресурс не найден.');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, 'INVALID_PATH', 'Некорректный путь.'); }
      let filename = resolve(staticRoot, `.${decoded}`);
      if (!filename.startsWith(`${staticRoot}${sep}`) && filename !== staticRoot) throw new HttpError(404, 'NOT_FOUND', 'Ресурс не найден.');
      if (decoded.endsWith('/') || !extname(decoded)) filename = resolve(staticRoot, 'index.html');
      try {
        const actual = await realpath(filename);
        if (!actual.startsWith(`${staticRoot}${sep}`)) throw new HttpError(404, 'NOT_FOUND', 'Ресурс не найден.');
        if (!(await stat(actual)).isFile()) throw new HttpError(404, 'NOT_FOUND', 'Ресурс не найден.');
        const content = await readFile(actual);
        response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : content);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, 'NOT_FOUND', 'Ресурс не найден. Выполните npm run build для сборки интерфейса.');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('API request failed:', error.message);
      json(response, status, { error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR', message: error instanceof HttpError ? error.message : 'Внутренняя ошибка сервиса.', ...(error.fields && { fields: error.fields }) } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    service,
    async listen(port = 3001, host = '127.0.0.1') {
      await new Promise((resolveListening, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolveListening(); });
      });
      if (options.startWorker !== false) service.startWorker();
      return server.address();
    },
    async close() {
      if (server.listening) await new Promise((resolveClosed, reject) => {
        server.close(error => error ? reject(error) : resolveClosed());
        server.closeAllConnections();
      });
      await service.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env['PORT'] ?? process.env['API_PORT'] ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be from 1 to 65535');
  await app.listen(port, process.env['HOST'] ?? '127.0.0.1');
  console.log(`Report API listening on port ${port}`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await app.close(); }
    catch {
      process.exitCode = 1;
      console.error('Report API shutdown completed with an interrupted database operation');
    }
  };
  const onDatabaseLost = () => {
    // The session lock is gone; keep this process from running indefinitely
    // without ownership. Compose can restart it and recover queued jobs.
    process.exitCode = 1;
    console.error('PostgreSQL owner connection lost; stopping report API for recovery');
    void stop();
  };
  if (app.service.db.signal.aborted) onDatabaseLost();
  else app.service.db.signal.addEventListener('abort', onDatabaseLost, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
