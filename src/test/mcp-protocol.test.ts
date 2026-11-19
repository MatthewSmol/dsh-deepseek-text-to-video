/**
 * RU: Проверка MCP-протокола: рукопожатие, список инструментов, вызов и ошибки.
 * EN: MCP protocol check: handshake, tool list, call and errors.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('../server/genvideo-mcp.js', import.meta.url))

let child: ChildProcessWithoutNullStreams | null = null
let home = ''
const pending = new Map<string, (message: any) => void>()
let nextId = 1

function rpc(method: string, params?: unknown, timeoutMs = 20_000): Promise<any> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id))
      reject(new Error(`timed out waiting for ${method}`))
    }, timeoutMs)
    pending.set(String(id), (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'genvideo-mcp-'))
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      GENVIDEO_HOME: home,
      GENVIDEO_WORKDIR: home,
      GENVIDEO_MODELS_DIR: join(home, 'models'),
      GENVIDEO_ENDPOINT_FILE: join(home, 'endpoint.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    if (!line.trim()) return
    try {
      const message = JSON.parse(line)
      if (message.id !== undefined && message.id !== null) pending.get(String(message.id))?.(message)
    } catch {
      /* protocol noise is a failure elsewhere */
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
})

after(async () => {
  child?.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (home) await rm(home, { recursive: true, force: true })
})

test('initialize negotiates a protocol version and server info', async () => {
  const response = await rpc('initialize', { protocolVersion: '2025-06-18' })
  assert.equal(response.result.protocolVersion, '2025-06-18')
  assert.equal(response.result.serverInfo.name, 'genvideo')
  assert.ok(response.result.capabilities.tools)
})

test('tools/list exposes the GenVideo operations', async () => {
  const response = await rpc('tools/list')
  const names = response.result.tools.map((tool: any) => tool.name)
  for (const expected of ['status', 'models', 'plan', 'generate', 'job', 'cancel', 'merge', 'transcode', 'settings']) {
    assert.ok(names.includes(expected), `missing ${expected}`)
  }
  const generate = response.result.tools.find((tool: any) => tool.name === 'generate')
  assert.ok(generate.inputSchema.properties.prompt)
})

test('unknown methods return JSON-RPC -32601', async () => {
  const response = await rpc('tools/nope')
  assert.equal(response.error.code, -32601)
})

test('tools/call returns content and structuredContent', async () => {
  const response = await rpc('tools/call', { name: 'status', arguments: {} })
  assert.equal(response.result.isError, false)
  assert.ok(Array.isArray(response.result.content))
  assert.equal(response.result.structuredContent.version, '1.0.0')
  assert.ok(Array.isArray(response.result.structuredContent.models))
})

test('array tool results are wrapped into an object', async () => {
  const response = await rpc('tools/call', { name: 'models', arguments: {} })
  assert.equal(response.result.isError, false)
  assert.ok(Array.isArray(response.result.structuredContent.items))
  assert.ok(response.result.structuredContent.items.length >= 3)
})

test('argument validation produces an MCP error', async () => {
  const response = await rpc('tools/call', { name: 'generate', arguments: {} })
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.code, 'empty-prompt')
})
