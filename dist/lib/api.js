/**
 * RU: HTTP API MCP-сервиса для панели GenVideo. Сервер слушает только
 *     127.0.0.1 на случайном порту и требует заголовок X-GenVideo-Token.
 *     Host-плагин добавляет токен, поэтому браузер не видит его в URL.
 * EN: MCP service HTTP API for the GenVideo panel. The server binds only to
 *     127.0.0.1 on a random port and requires the X-GenVideo-Token header. The
 *     Host plugin adds the token, so the browser never sees it in a URL.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { VERSION } from './engine.js';
import { toApiError } from './errors.js';
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 64 * 1024 * 1024;
/** RU: Читает тело запроса с лимитом. EN: Reads a request body with a limit. */
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
            reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
            return;
        }
        let total = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy(Object.assign(new Error('body too large'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
/** RU: JSON-ответ. EN: JSON response. */
function json(res, status, body) {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
}
/** RU: Успешный ответ. EN: Success response. */
function ok(res, value, status = 200) {
    json(res, status, { ok: true, value });
}
/** RU: Ошибочный ответ. EN: Error response. */
function fail(res, error) {
    const apiError = toApiError(error);
    const status = error.status ?? (apiError.code === 'probe-failed' ? 404 : 400);
    json(res, status, { ok: false, error: apiError });
}
/** RU: Создаёт HTTP-обработчик. EN: Creates the HTTP handler. */
export function createApiHandler(engine, token) {
    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        try {
            if (path === '/health') {
                ok(res, { version: VERSION, startedAt: engine.startedAt, uptimeSec: Math.round((Date.now() - engine.startedAt) / 1000) });
                return;
            }
            if (req.headers['x-genvideo-token'] !== token) {
                json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid X-GenVideo-Token' } });
                return;
            }
            if (path === '/api/state' && req.method === 'GET') {
                ok(res, await engine.status());
                return;
            }
            if (path === '/api/events' && req.method === 'GET') {
                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                });
                const send = (event) => {
                    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
                };
                send({ seq: 0, kind: 'state', revision: 0 });
                const unsubscribe = engine.subscribe(send);
                const heartbeat = setInterval(() => {
                    res.write(`: heartbeat ${Date.now()}\n\n`);
                }, 15_000);
                const cleanup = () => {
                    clearInterval(heartbeat);
                    unsubscribe();
                };
                req.on('close', cleanup);
                req.on('error', cleanup);
                return;
            }
            if (path === '/api/gpus' && req.method === 'GET') {
                ok(res, await engine.gpu());
                return;
            }
            if (path === '/api/gpus/refresh' && req.method === 'POST') {
                await engine.refresh(true);
                ok(res, await engine.gpu());
                return;
            }
            if (path === '/api/deps' && req.method === 'GET') {
                ok(res, await engine.deps());
                return;
            }
            if (path === '/api/deps/refresh' && req.method === 'POST') {
                ok(res, await engine.recheck());
                return;
            }
            if (path === '/api/deps/install' && req.method === 'POST') {
                ok(res, await engine.installFfmpeg());
                return;
            }
            if (path === '/api/models' && req.method === 'GET') {
                ok(res, await engine.modelStates());
                return;
            }
            if (path === '/api/models/explore' && req.method === 'GET') {
                ok(res, await engine.exploreModels(Number(url.searchParams.get('page') ?? '1')));
                return;
            }
            if (path === '/api/models/refresh' && req.method === 'POST') {
                await engine.refresh(true);
                ok(res, await engine.modelStates());
                return;
            }
            if (path === '/api/models/install' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.installModel({ modelId: String(body.modelId ?? ''), variant: body.variant }));
                return;
            }
            if (path === '/api/models/delete' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.deleteModel(String(body.modelId ?? '')));
                return;
            }
            if (path === '/api/models/check-updates' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.checkUpdates(body.modelId));
                return;
            }
            if (path === '/api/plan' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.plan(body));
                return;
            }
            if (path === '/api/generate' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.generate(body));
                return;
            }
            if (path === '/api/jobs' && req.method === 'GET') {
                ok(res, engine.jobs.list(Number(url.searchParams.get('limit') ?? 30)));
                return;
            }
            const cancelMatch = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
            if (cancelMatch && req.method === 'POST') {
                ok(res, { cancelled: engine.jobs.cancel(decodeURIComponent(cancelMatch[1] ?? '')) });
                return;
            }
            const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
            if (jobMatch && req.method === 'GET') {
                const job = engine.jobs.get(decodeURIComponent(jobMatch[1] ?? ''));
                if (!job)
                    throw Object.assign(new Error('Job not found'), { status: 404 });
                ok(res, job);
                return;
            }
            if (path === '/api/merge' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.merge({ names: body.names ?? [], outputName: body.outputName, transcode: body.transcode }));
                return;
            }
            if (path === '/api/transcode' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.transcode({ name: String(body.name ?? ''), outputName: body.outputName, transcode: body.transcode }));
                return;
            }
            if (path === '/api/library' && req.method === 'GET') {
                ok(res, await engine.library());
                return;
            }
            const mediaMatch = path.match(/^\/api\/media\/([^/]+)$/);
            if (mediaMatch && req.method === 'GET') {
                const file = engine.resolveMedia(decodeURIComponent(mediaMatch[1] ?? ''));
                const info = await stat(file);
                const type = extname(file) === '.webm' ? 'video/webm' : extname(file) === '.gif' ? 'image/gif' : 'video/mp4';
                const range = req.headers.range;
                if (range) {
                    const match = range.match(/bytes=(\d*)-(\d*)/);
                    const start = Number(match?.[1] ?? 0) || 0;
                    const end = Math.min(info.size - 1, Number(match?.[2] ?? info.size - 1) || info.size - 1);
                    res.writeHead(206, {
                        'content-type': type,
                        'accept-ranges': 'bytes',
                        'content-range': `bytes ${start}-${end}/${info.size}`,
                        'content-length': String(end - start + 1),
                    });
                    createReadStream(file, { start, end }).pipe(res);
                    return;
                }
                res.writeHead(200, { 'content-type': type, 'content-length': String(info.size), 'accept-ranges': 'bytes' });
                createReadStream(file).pipe(res);
                return;
            }
            if (path === '/api/inputs' && req.method === 'POST') {
                const data = await readBody(req, MAX_UPLOAD);
                const name = String(req.headers['x-file-name'] ?? 'input').slice(0, 200);
                const mime = String(req.headers['content-type'] ?? 'application/octet-stream');
                ok(res, await engine.saveInput({ data, name, mime }));
                return;
            }
            if (path === '/api/settings' && req.method === 'GET') {
                ok(res, engine.settings);
                return;
            }
            if (path === '/api/settings' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
                ok(res, await engine.updateSettings(body));
                return;
            }
            if (path === '/api/settings/reset' && req.method === 'POST') {
                ok(res, await engine.resetSettings());
                return;
            }
            if (path === '/api/runners' && req.method === 'GET') {
                ok(res, await engine.runnerMatrix(url.searchParams.get('modelId') ?? undefined));
                return;
            }
            if (path === '/api/engine/install' && req.method === 'POST') {
                ok(res, await engine.installPythonEngine());
                return;
            }
            if (path === '/api/engine/install-candle' && req.method === 'POST') {
                ok(res, await engine.installCandleEngine());
                return;
            }
            json(res, 404, { ok: false, error: { code: 'not-found', message: `No route ${req.method} ${path}` } });
        }
        catch (error) {
            if (!res.headersSent)
                fail(res, error);
            else
                res.end();
        }
    };
}
