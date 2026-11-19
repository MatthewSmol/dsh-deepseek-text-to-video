/**
 * RU: Проверка собранного клиентского бандла: классический скрипт, встроенный
 *     встроенный CSS и метаданные сборки.
 * EN: Built client bundle check: classic script, embedded scoped CSS, and build
 *     metadata.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../client.js', import.meta.url))
const metaPath = fileURLToPath(new URL('../client.meta.json', import.meta.url))

test('client bundle is a classic script with embedded CSS', async () => {
  const bundle = await readFile(bundlePath, 'utf8')
  assert.ok(bundle.includes('__ModuleLoader__'))
  assert.ok(bundle.includes('gv-card{'), 'the plain CSS must be inlined by the ?inline import')
  assert.ok(!/^\s*(?:import|export)\s/m.test(bundle), 'bundle must not contain import/export')
  assert.ok(bundle.includes('(function()'), 'Vite must emit an IIFE')
  assert.ok(bundle.length > 10_000)
  assert.ok(bundle.length < 200_000, 'the minified bundle must stay small')
})

test('build metadata is present', async () => {
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { bytes: number; jsBytes: number; hash: string }
  assert.ok(meta.bytes > 0)
  assert.ok(meta.jsBytes > 0)
  assert.match(meta.hash, /^[a-f0-9]{16}$/)
})
