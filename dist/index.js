import { createApiHandler } from './lib/api.js';
import { Engine } from './lib/engine.js';
import { ensureServiceDirs } from './lib/paths.js';
import { registerGenvideoTools } from './server/tools.js';
import { installBundledWorkflows } from './lib/workflows.js';
/** RU: Имя плагина для логов. EN: Plugin name for logs. */
export const name = '@local/dsh-genvideo';
/** RU: Зависимости Host-плагина. EN: Host plugin dependencies. */
export const inject = ['webServer', 'tools'];
/** RU: Регистрирует HTTP-роут и нативные инструменты. EN: Registers the HTTP route and native tools. */
export function apply(ctx) {
    ensureServiceDirs();
    const workflows = installBundledWorkflows();
    const engine = new Engine();
    const handler = createApiHandler(engine, '');
    const disposers = [];
    disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/genvideo',
        handler: async (req, res) => {
            const remote = req.socket.remoteAddress ?? '';
            const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
            if (!loopback) {
                res.statusCode = 403;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'loopback only' } }));
                return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            req.url = `${url.pathname.replace(/^\/genvideo/, '') || '/'}${url.search}`;
            await handler(req, res);
        },
    }));
    disposers.push(registerGenvideoTools(ctx, engine));
    if (workflows.installed.length)
        ctx.logger?.info?.(`genvideo: installed workflows: ${workflows.installed.join(', ')}`);
    ctx.logger?.info?.('genvideo: engine ready, native tools registered');
    ctx.effect?.(() => () => {
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            }
            catch { /* ignore */ }
        }
        engine.dispose();
    }, 'genvideo: engine and tools');
}
