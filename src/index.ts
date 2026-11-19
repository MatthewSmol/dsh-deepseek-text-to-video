/**
 * RU: Host-половина GenVideo. Движок работает в процессе Host-плагина:
 *     он обслуживает HTTP-роут панели и регистрирует нативные DSH-инструменты
 *     для агента. Отдельного MCP-сервера и stdio больше нет — бэкенд один,
 *     ComfyUI, а плагин лишь вызывает его API.
 * EN: GenVideo host half. The engine runs inside the host plugin: it serves the
 *     panel HTTP route and registers native DSH tools for the agent. There is no
 *     separate MCP server or stdio anymore — ComfyUI is the only backend and the
 *     plugin just calls its API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiHandler } from './lib/api.js'
import { Engine } from './lib/engine.js'
import { ensureServiceDirs } from './lib/paths.js'
import { registerGenvideoTools } from './server/tools.js'

/** RU: Имя плагина для логов. EN: Plugin name for logs. */
export const name = '@local/dsh-genvideo'

/** RU: Зависимости Host-плагина. EN: Host plugin dependencies. */
export const inject = ['webServer', 'tools']

/** RU: Регистрирует HTTP-роут и нативные инструменты. EN: Registers the HTTP route and native tools. */
export function apply(ctx: any): void {
  ensureServiceDirs()
  const engine = new Engine()
  const handler = createApiHandler(engine, '')

  const disposers: Array<() => void> = []
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: '/genvideo',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const remote = req.socket.remoteAddress ?? ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''
      if (!loopback) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'loopback only' } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      req.url = `${url.pathname.replace(/^\/genvideo/, '') || '/'}${url.search}`
      await handler(req, res)
    },
  }))
  disposers.push(registerGenvideoTools(ctx, engine))
  ctx.logger?.info?.('genvideo: engine ready, native tools registered')
  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
    engine.dispose()
  }, 'genvideo: engine and tools')
}
