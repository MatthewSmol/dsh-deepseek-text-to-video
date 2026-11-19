/**
 * RU: Тесты путей и настроек: jail, санитайз имён, дефолты и ограничения.
 * EN: Path and settings tests: jail, name sanitizing, defaults and clamps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertInside, safeBaseName, slugify, outputFileName } from '../lib/paths.js'
import { sanitizeSettings, sanitizeProxyUrl, DEFAULT_SETTINGS } from '../lib/store.js'
import { proxyUrlFor } from '../lib/downloads.js'

test('assertInside accepts a child and rejects traversal', () => {
  const inside = assertInside('/tmp/videos', '/tmp/videos/clip.mp4')
  assert.equal(inside, '/tmp/videos/clip.mp4')
  assert.throws(() => assertInside('/tmp/videos', '/tmp/videos/../secret'), /escapes/)
  assert.throws(() => assertInside('/tmp/videos', '/etc/passwd'), /escapes/)
})

test('safeBaseName strips separators and leading dots', () => {
  assert.equal(safeBaseName('../../etc/passwd'), 'passwd')
  const cleaned = safeBaseName('..hidden file?.mp4')
  assert.ok(!cleaned.startsWith('.'))
  assert.ok(!cleaned.includes('/'))
})

test('slugify keeps ASCII words and falls back', () => {
  assert.equal(slugify('A Neon City at Night!'), 'a-neon-city-at-night')
  assert.equal(slugify('Привет'), 'video')
})

test('outputFileName has a timestamp, platform, slug and extension', () => {
  const name = outputFileName({ platform: 'reels', prompt: 'Hello world', seed: 7, ext: 'mp4' })
  assert.match(name, /^\d{8}-\d{6}_reels_hello-world_7\.mp4$/)
})

test('sanitizeSettings clamps and normalizes every field', () => {
  const settings = sanitizeSettings({
    language: 'de',
    platform: 'nope',
    width: 10_000,
    fps: 0,
    seed: -5,
    gpu: { ids: [1, 1, 2, -3], strategy: 'wat', vramBudgetGB: -4 },
    transcode: { mode: 'size', quality: 'ultra', targetSizeMB: 0, format: 'avi', fit: 'x' },
    customModels: [{ id: 'mine', runtime: 'bogus', files: ['a'] }],
  })
  assert.equal(settings.language, 'en')
  assert.equal(settings.platform, 'youtube')
  assert.equal(settings.width, 4096)
  assert.equal(settings.fps, 1)
  assert.equal(settings.seed, -1)
  assert.deepEqual(settings.gpu.ids, [1, 2])
  assert.equal(settings.gpu.strategy, 'single')
  assert.equal(settings.gpu.vramBudgetGB, 0)
  assert.equal(settings.transcode.mode, 'size')
  assert.equal(settings.transcode.quality, 'high')
  assert.equal(settings.transcode.targetSizeMB, 0.1)
  assert.equal(settings.transcode.format, 'mp4')
  assert.equal(settings.transcode.fit, 'contain')
  assert.equal(settings.customModels[0]?.runtime, 'command')
  assert.equal(settings.customModels[0]?.id, 'mine')
})

test('defaults are stable', () => {
  const settings = sanitizeSettings({})
  assert.equal(settings.outputDir, '')
  assert.equal(settings.modelsDir, '')
  assert.equal(settings.runners.mockDelayMs, DEFAULT_SETTINGS.runners.mockDelayMs)
  assert.equal(settings.hf.tokenEnv, 'HF_TOKEN')
})


test('proxy URL is validated and resolved', () => {
  assert.equal(sanitizeProxyUrl('127.0.0.1:9050'), 'socks5://127.0.0.1:9050')
  assert.equal(sanitizeProxyUrl('socks5h://127.0.0.1:9050'), 'socks5h://127.0.0.1:9050')
  assert.equal(sanitizeProxyUrl('http://127.0.0.1:8080'), '')
  assert.equal(sanitizeProxyUrl(''), '')
  assert.equal(proxyUrlFor({ enabled: true, url: '' }), 'socks5://127.0.0.1:1080')
  assert.equal(proxyUrlFor({ enabled: false, url: 'socks5://127.0.0.1:9050' }), '')
})
