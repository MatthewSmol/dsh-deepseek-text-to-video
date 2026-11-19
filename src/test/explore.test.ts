/**
 * RU: Тесты эвристик обзора HF: параметры, VRAM, сортировка и признаки качества.
 * EN: HF overview heuristic tests: parameters, VRAM, sorting and quality signals.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateVramGB, fitsVram, parseParamsB, qualityReasons, sortByVram, toExploreModel, bytesPerParam } from '../lib/explore.js'
import type { ExploreModel } from '../lib/explore.js'

test('parameter count is parsed from repository names', () => {
  assert.equal(parseParamsB('Wan-AI/Wan2.1-T2V-1.3B-Diffusers'), 1.3)
  assert.equal(parseParamsB('Wan-AI/Wan2.2-T2V-A14B'), 14)
  assert.equal(parseParamsB('Lightricks/LTX-Video'), null)
})

test('VRAM estimate accounts for quantisation', () => {
  assert.equal(estimateVramGB(1.3, 2), 3.3)
  assert.equal(estimateVramGB(14, 0.55), 9.6)
  assert.equal(estimateVramGB(null, 2), null)
  assert.equal(bytesPerParam('QuantStack/Wan2.2-TI2V-5B-GGUF', ['gguf']), 0.55)
  assert.equal(bytesPerParam('some/fp8-model', ['fp8']), 1)
})

test('quality reasons describe popularity and size', () => {
  const reasons = qualityReasons({ id: 'Wan-AI/Wan2.2-T2V-A14B', tags: ['gguf', 'text-to-video'], downloads: 200_000, paramsB: 14 })
  assert.ok(reasons.includes('official'))
  assert.ok(reasons.includes('popular'))
  assert.ok(reasons.includes('quantized'))
  assert.ok(reasons.includes('large'))
})

test('overview sorts known VRAM ascending and pushes unknown last', () => {
  const make = (id: string, vramGB: number | null, downloads: number): ExploreModel => ({
    id, author: id.split('/')[0] ?? '', downloads, likes: 0, lastModified: '', library: null, tags: [], paramsB: null, vramGB, reasons: [],
  })
  const sorted = sortByVram([make('b/big', 12, 10), make('a/small', 2, 5), make('c/unknown', null, 100), make('d/mid', 6, 1)])
  assert.deepEqual(sorted.map((item) => item.id), ['a/small', 'd/mid', 'b/big', 'c/unknown'])
})

test('HF API rows map into overview rows', () => {
  const model = toExploreModel({ id: 'Wan-AI/Wan2.1-T2V-1.3B', downloads: 1234, likes: 7, tags: ['diffusers', 'text-to-video'] })
  assert.equal(model.paramsB, 1.3)
  assert.equal(model.vramGB, 3.3)
  assert.equal(model.library, null)
  assert.ok(model.reasons.includes('official'))
})


test('VRAM fit respects the target limit', () => {
  assert.equal(fitsVram(3.3, 8), true)
  assert.equal(fitsVram(9.6, 8), false)
  assert.equal(fitsVram(9.6, 24), true)
  assert.equal(fitsVram(null, 24), false)
})
