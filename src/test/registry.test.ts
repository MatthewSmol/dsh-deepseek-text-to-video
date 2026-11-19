/**
 * RU: Тесты реестра моделей и преобразования пользовательских моделей.
 * EN: Model registry and custom-model conversion tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNvidiaSmiCsv } from '../lib/gpu.js'
import { BUILTIN_MODELS, allModels, customToEntry, findModel, findVariant, isNativeSize, snapFrames } from '../lib/models.js'
import type { CustomModel } from '../lib/types.js'

test('built-in registry is coherent', () => {
  const ids = BUILTIN_MODELS.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const entry of BUILTIN_MODELS) {
    assert.ok(entry.repo.includes('/'))
    assert.ok(entry.variants.length > 0)
    assert.ok(entry.variants.every((variant) => variant.files.length > 0 && variant.sizeGB > 0))
    assert.ok(entry.vramGB.min > 0 && entry.vramGB.recommended >= entry.vramGB.min)
    assert.ok(entry.durationSec.max >= entry.durationSec.min)
    assert.ok(entry.runtimes.length > 0)
  }
})

test('the two requested models are present with the expected paths', () => {
  const sulphur = BUILTIN_MODELS.find((entry) => entry.id === 'sulphur-2-base')
  const candle = BUILTIN_MODELS.find((entry) => entry.id === 'ltx-0.9.8-2b-distilled')
  assert.ok(sulphur?.repo === 'SulphurAI/Sulphur-2-base')
  assert.ok(sulphur?.capabilities.i2v)
  assert.ok(candle?.repo === 'oxide-lab/LTX-Video-0.9.8-2B-distilled')
  assert.ok(candle?.runtimes.includes('candle'))
})

test('custom models become registry entries', () => {
  const custom: CustomModel = {
    id: 'mine',
    title: 'Mine',
    repo: 'me/model',
    runtime: 'command',
    vramGB: 16,
    sizeGB: 12,
    files: ['weights.safetensors'],
    durationSec: 8,
    fps: 24,
    width: 1024,
    height: 576,
    supportsImage: true,
    supportsVideo: false,
    commandTemplate: ['python', 'run.py', '--prompt', '{prompt}'],
  }
  const entry = customToEntry(custom)
  assert.equal(entry.id, 'mine')
  assert.equal(entry.capabilities.i2v, true)
  assert.equal(entry.capabilities.v2v, false)
  assert.equal(entry.durationSec.max, 8)
  assert.equal(allModels([custom]).length, BUILTIN_MODELS.length + 1)
  assert.ok(findModel('mine', [custom]))
  assert.equal(findVariant(entry)?.files[0], 'weights.safetensors')
})

test('frame helpers snap to 8n+1 and multiples of 32', () => {
  assert.equal(snapFrames(97), 97)
  assert.equal(snapFrames(94), 97)
  assert.equal(snapFrames(10), 17)
  assert.equal(snapFrames(5, 9, 257), 9)
  assert.equal(snapFrames(1000, 9, 257), 257)
  assert.equal(isNativeSize(768, 512), true)
  assert.equal(isNativeSize(770, 512), false)
})


/**
 * RU: Регрессия: nvidia-smi отдаёт 5 полей после индекса (name, total, used,
 *     driver, compute_cap), причём с CRLF. Раньше парсер требовал 6 и молча
 *     возвращал пустой список, из-за чего GPU «пропадали».
 * EN: Regression: nvidia-smi returns 5 fields after the index (name, total,
 *     used, driver, compute_cap) with CRLF. The parser used to require 6 and
 *     silently returned an empty list, so GPUs "disappeared".
 */
test('parses nvidia-smi CSV with two GPUs', () => {
  const csv = '0, NVIDIA GeForce RTX 3070, 8192, 2735, 621.14, 8.6\r\n1, NVIDIA GeForce RTX 3060 Ti, 8192, 78, 621.14, 8.6\r\n'
  const gpus = parseNvidiaSmiCsv(csv)
  assert.equal(gpus.length, 2)
  assert.deepEqual(gpus[0], { index: 0, name: 'NVIDIA GeForce RTX 3070', totalMB: 8192, usedMB: 2735, driver: '621.14', computeCap: '8.6' })
  assert.equal(gpus[1].name, 'NVIDIA GeForce RTX 3060 Ti')
})
