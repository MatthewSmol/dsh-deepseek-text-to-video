/**
 * RU: Host-половина плагина GenVideo — тонкий прокси между браузером и
 *     MCP-сервисом. Плагин ничего не хранит: он читает endpoint.json
 *     (порт/токен/pid), проверяет живость процесса и пробрасывает
 *     `/genvideo/*` на `http://127.0.0.1:<port>/*`, добавляя токен.
 * EN: GenVideo Host half — a thin proxy between the browser and the MCP
 *     service. The plugin stores nothing: it reads endpoint.json
 *     (port/token/pid), checks that the process is alive, and forwards
 *     `/genvideo/*` to `http://127.0.0.1:<port>/*` adding the token.
 */
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { endpointFile } from './lib/paths.js';
/** RU: Имя плагина для логов. EN: Plugin name for logs. */
export const name = '@local/dsh-genvideo';
/** RU: Зависимость от Web-сервера DSH. EN: Dependency on the DSH web server. */
export const inject = ['webServer'];
let cache = null;
/** RU: Читает endpoint.json с кэшем по mtime (2 c). EN: Reads endpoint.json with a 2s mtime cache. */
async function readEndpoint() {
    const file = endpointFile();
    try {
        const info = await stat(file);
        if (cache && cache.mtime === info.mtimeMs)
            return cache.endpoint;
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (!parsed.port || !parsed.token || !parsed.pid)
            return null;
        cache = { endpoint: parsed, mtime: info.mtimeMs };
        return parsed;
    }
    catch {
        return null;
    }
}
/** RU: Проверяет, что процесс сервиса жив. EN: Checks that the service process is alive. */
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/** RU: JSON-ответ об ошибке. EN: JSON error response. */
function unavailable(res, message) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: false, error: { code: 'mcp-unavailable', message } }));
}
/** RU: Копирует заголовки ответа сервиса. EN: Copies the service response headers. */
function copyHeaders(source, res) {
    const allowed = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'x-accel-buffering'];
    for (const header of allowed) {
        const value = source.get(header);
        if (value !== null)
            res.setHeader(header, value);
    }
}
/** RU: Проксирует один запрос. EN: Proxies one request. */
async function proxy(req, res, path) {
    const endpoint = await readEndpoint();
    if (!endpoint || !alive(endpoint.pid)) {
        unavailable(res, 'The GenVideo MCP service is not running. Enable the genvideo-mcp row (or restart DSH) and refresh this page.');
        return;
    }
    const target = `http://127.0.0.1:${endpoint.port}${path || '/'}`;
    const headers = { 'x-genvideo-token': endpoint.token };
    for (const header of ['range', 'content-type', 'x-file-name', 'accept']) {
        const value = req.headers[header];
        if (typeof value === 'string')
            headers[header] = value;
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const controller = new AbortController();
    // RU: Нельзя вешать abort на req 'close': для POST он срабатывает сразу после
    //     отправки тела и обрывает запрос к сервису (кнопки установки/сохранения
    //     «не работали»). Отменяем fetch только если ответ оборвался, не успев
    //     завершиться, то есть клиент действительно ушёл.
    // EN: Do not abort on req 'close': for POST it fires right after the body is
    //     sent and kills the upstream request (install/save buttons "did nothing").
    //     Abort the fetch only when the response closes before finishing, i.e. the
    //     client really disconnected.
    res.on('close', () => {
        if (!res.writableFinished)
            controller.abort();
    });
    try {
        const response = await fetch(target, {
            method,
            headers,
            body: hasBody ? req : undefined,
            duplex: hasBody ? 'half' : undefined,
            signal: controller.signal,
        });
        res.statusCode = response.status;
        copyHeaders(response.headers, res);
        res.flushHeaders?.();
        if (!response.body) {
            res.end();
            return;
        }
        const stream = Readable.fromWeb(response.body);
        stream.on('error', () => res.end());
        stream.pipe(res);
        res.on('close', () => stream.destroy());
    }
    catch (error) {
        if (!res.headersSent) {
            unavailable(res, error instanceof Error ? error.message : String(error));
        }
        else {
            res.end();
        }
    }
}
/** RU: Регистрирует prefix-route `/genvideo`. EN: Registers the `/genvideo` prefix route. */
export function apply(ctx) {
    ctx.effect?.(() => {
        const dispose = ctx.webServer.register({
            kind: 'prefix',
            path: '/genvideo',
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                const path = url.pathname.replace(/^\/genvideo/, '') || '/';
                // RU: Проверяем loopback, чтобы маршрут не было смысла атаковать снаружи.
                // EN: Require loopback so the route is not reachable from outside.
                const remote = req.socket.remoteAddress ?? '';
                const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
                if (!isLoopback) {
                    res.statusCode = 403;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'loopback only' } }));
                    return;
                }
                await proxy(req, res, path);
            },
        });
        ctx.logger?.info?.('genvideo: proxy registered on /genvideo');
        return dispose;
    }, 'genvideo: proxy route');
}
