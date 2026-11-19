/**
 * RU: Тесты планировщика: сегменты, длительности, разбиение промпта и оценка VRAM.
 * EN: Planner tests: segments, durations, prompt splitting and the VRAM estimate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSegments, splitPrompt, estimateVramGB, planGeneration } from '../lib/planner.js'
import { DEFAULT_SETTINGS } from '../lib/store.js'
import type { ModelEntry } from '../lib/types.js'

const model: ModelEntry = {
  id: 'test-model',
  title: 'Test model',
  family: 'ltx-video',
  repo: 'example/test',
  kind: 'test',
  variants: [{ id: 'v1', title: 'v1', files: ['a.safetensors'], sizeGB: 1, precision: 'bf16' }],
  runtimes: ['mock'],
  capabilities: { t2v: true, i2v: true, v2v: false, audio: false },
  durationSec: { min: 1, max: 10, recommended: 4 },
  fps: [24],
  width: 768,
  height: 512,
  vramGB: { min: 8, recommended: 12 },
  maxPromptChars: 2000,
  license: 'test',
  notes: '',
  extraFiles: [],
}

test('computeSegments splits and clamps to the clip limit', () => {
  assert.deepEqual(computeSegments(4, 4, 10), [4])
  const six = computeSegments(6, 4, 10)
  assert.equal(six.length, 2)
  assert.ok(six.every((value) => value <= 10))
  assert.ok(Math.abs(six.reduce((a, b) => a + b, 0) - 6) < 0.01)
  const long = computeSegments(30, 4, 10)
  assert.ok(long.length <= 24)
  assert.ok(long.every((value) => value <= 10.01))
})

test('splitPrompt keeps order and pads with anchors', () => {
  const parts = splitPrompt('One. Two. Three.', 2)
  assert.equal(parts.length, 2)
  assert.match(parts[0] ?? '', /One/)
  const padded = splitPrompt('Only sentence.', 3)
  assert.equal(padded.length, 3)
  assert.match(padded[1] ?? '', /continues/)
})

test('estimateVramGB grows with resolution and frames', () => {
  const small = estimateVramGB(model, 768, 512, 97)
  const big = estimateVramGB(model, 1920, 1080, 97)
  assert.ok(big > small)
  assert.ok(small >= 8)
})

test('planGeneration explains limits and segments', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.clipSec = 4
  const plan = planGeneration({
    settings,
    model,
    runner: 'mock',
    gpu: { available: false, gpus: [], error: 'no gpu', hints: [], checkedAt: Date.now() },
    prompt: 'A city. A river. A bridge.',
    targetDurationSec: 12,
    width: 768,
    height: 512,
    fps: 24,
  })
  assert.equal(plan.segments.length, 3)
  assert.equal(plan.totalSec, 12)
  assert.equal(plan.availableRunner, 'mock')
  assert.ok(plan.warnings.some((warning) => warning.code === 'no-gpu'))
  assert.ok(plan.estimatedSeconds > 0)
})

test('plan reports the requested size transcode mode', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const plan = planGeneration({
    settings,
    model,
    runner: 'mock',
    gpu: { available: false, gpus: [], error: 'no gpu', hints: [], checkedAt: Date.now() },
    prompt: 'A city',
    targetDurationSec: 4,
    width: 768,
    height: 512,
    fps: 24,
    transcodeMode: 'size',
    transcodeEstimatedBytes: 2_000_000,
  })
  assert.equal(plan.transcode.mode, 'size')
  assert.equal(plan.transcode.estimatedBytes, 2_000_000)
})
