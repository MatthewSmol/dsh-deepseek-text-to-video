/**
 * RU: Тесты планировщика: сегменты, длительности, разбиение промпта и оценка VRAM.
 * EN: Planner tests: segments, durations, prompt splitting and the VRAM estimate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoClipSec, buildSegmentPrompts, computeSegments, fitPlanToBudget, splitPrompt, estimateVramGB, planGeneration } from '../lib/planner.js'
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


test('fixed clips follow the requested length and keep the exact total', () => {
  const minute = computeSegments(60, 9, 10.7)
  assert.equal(minute.length, 7)
  assert.deepEqual(minute.slice(0, 6), [9, 9, 9, 9, 9, 9])
  assert.equal(minute[6], 6)
  assert.ok(Math.abs(minute.reduce((a, b) => a + b, 0) - 60) < 0.01)

  const twoMinutes = computeSegments(120, 9, 10.7)
  assert.equal(twoMinutes.length, 14)
  assert.equal(twoMinutes[13], 3)
  assert.ok(Math.abs(twoMinutes.reduce((a, b) => a + b, 0) - 120) < 0.01)
})

test('full-scene mode repeats the whole prompt in every clip', () => {
  const full = buildSegmentPrompts('A woman dances in a dark hall.', 3, 'full', 2000)
  assert.equal(full.fallback, false)
  assert.equal(full.prompts.length, 3)
  assert.ok(full.prompts.every((value) => value.includes('A woman dances in a dark hall.')))
  assert.ok(full.prompts[0]?.includes('Part 1/3'))

  const split = buildSegmentPrompts('One. Two. Three.', 3, 'split', 2000)
  assert.deepEqual(split.prompts, splitPrompt('One. Two. Three.', 3))

  const tooLong = buildSegmentPrompts('x'.repeat(2500), 2, 'full', 2000)
  assert.equal(tooLong.fallback, true)
  assert.equal(tooLong.prompts.length, 2)
})

test('plan uses fixed 9s clips and full-scene prompts for a 60s video', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const plan = planGeneration({
    settings,
    model,
    runner: 'mock',
    gpu: { available: false, gpus: [], error: 'no gpu', hints: [], checkedAt: Date.now() },
    prompt: 'A full scene with a dancer and a pole.',
    targetDurationSec: 60,
    clipSec: 9,
    promptMode: 'full',
    segmentMode: 'fixed',
    width: 768,
    height: 512,
    fps: 24,
  })
  assert.equal(plan.segments.length, 7)
  assert.equal(plan.clipSec, 9)
  assert.equal(plan.promptMode, 'full')
  assert.equal(plan.totalSec, 60)
  assert.ok(plan.segments.every((segment) => segment.prompt.includes('A full scene')))
  assert.equal(plan.segments[6]?.durationSec, 6)
})


test('auto-fit finds a multiple-of-32 resolution and clip within the budget', () => {
  const fit = fitPlanToBudget({ model, budgetGB: 8, width: 1280, height: 720, clipSec: 9, targetDurationSec: 60, fps: 24 })
  assert.ok(fit)
  assert.equal(fit!.width % 32, 0)
  assert.equal(fit!.height % 32, 0)
  assert.ok(fit!.estimatedVramGB <= 8 * 0.95)
  assert.ok(fit!.clipSec <= 9)
})

test('explicit shot prompts drive every clip and add continuity', () => {
  const shots = ['She holds the pole.', 'She starts spinning.', 'She lands and smiles.']
  const built = buildSegmentPrompts('A dancer in a dark hall.', 3, 'shots', 2000, shots, 'last-frame')
  assert.equal(built.prompts.length, 3)
  assert.match(built.prompts[0] ?? '', /holds the pole/)
  assert.match(built.prompts[1] ?? '', /starts spinning/)
  assert.match(built.prompts[1] ?? '', /previous frame/)
  assert.match(built.prompts[2] ?? '', /lands and smiles/)
})

test('plan uses segment prompts and last-frame continuity', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const plan = planGeneration({
    settings,
    model,
    runner: 'comfyui',
    gpu: { available: false, gpus: [], error: 'no gpu', hints: [], checkedAt: Date.now() },
    prompt: 'A dancer in a dark hall.',
    targetDurationSec: 18,
    clipSec: 9,
    promptMode: 'shots',
    segmentPrompts: ['She holds the pole.', 'She spins and lands.'],
    continuity: 'last-frame',
    width: 768,
    height: 512,
    fps: 24,
  })
  assert.equal(plan.segments.length, 2)
  assert.equal(plan.continuity, 'last-frame')
  assert.match(plan.segments[0]?.prompt ?? '', /holds the pole/)
  assert.match(plan.segments[1]?.prompt ?? '', /previous frame/)
})

test('auto clip length follows VRAM and fps cap', () => {
  assert.equal(autoClipSec(8, 30), 4)
  assert.equal(autoClipSec(12, 30), 6)
  assert.equal(autoClipSec(24, 30), 8)
  assert.equal(autoClipSec(24, 60), 4)
  assert.equal(autoClipSec(8, 60), 4)
  assert.equal(autoClipSec(2, 30), 4)
})

test('auto clip and orientation drive plan sizes', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.gpu.vramBudgetGB = 8
  const plan = planGeneration({
    settings,
    model,
    runner: 'comfyui',
    gpu: { available: true, gpus: [{ index: 0, name: 'GPU', totalMB: 8192, usedMB: 0, driver: '', computeCap: '8.6' }], error: null, hints: [], checkedAt: Date.now() },
    prompt: 'A dancer.',
    targetDurationSec: 60,
    clipSec: 0,
    orientation: 'portrait',
    width: 720,
    height: 1280,
    fps: 30,
  })
  assert.equal(plan.autoClip, true)
  assert.equal(plan.clipSec, 4)
  assert.equal(plan.orientation, 'portrait')
  assert.equal(plan.baseWidth, 512)
  assert.equal(plan.baseHeight, 768)
  assert.equal(plan.frames, 121)
  assert.equal(plan.segments.length, 15)
})

test('LTX prompt profile flags short and repeated segment prompts', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const short = 'A fox in snow.'
  const plan = planGeneration({
    settings,
    model,
    runner: 'mock',
    gpu: { available: false, gpus: [], error: null, hints: [], checkedAt: Date.now() },
    prompt: short,
    targetDurationSec: 18,
    clipSec: 9,
    promptMode: 'shots',
    segmentPrompts: [short, short],
    width: 768,
    height: 512,
    fps: 24,
  })
  assert.equal(plan.segments.length, 2)
  assert.ok(plan.warnings.some((item) => item.code === 'prompt-too-short'))
  assert.ok(plan.warnings.some((item) => item.code === 'prompt-repeated'))
  assert.equal(plan.promptProfile.id, 'ltx-2b-distilled')
  assert.equal(plan.segments[0]?.wordCount, 4)
})

test('segment prompt count must match the clip count', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const plan = planGeneration({
    settings,
    model,
    runner: 'mock',
    gpu: { available: false, gpus: [], error: null, hints: [], checkedAt: Date.now() },
    prompt: 'A detailed scene.',
    targetDurationSec: 18,
    clipSec: 9,
    promptMode: 'shots',
    segmentPrompts: ['only one prompt'],
    width: 768,
    height: 512,
    fps: 24,
  })
  assert.ok(plan.warnings.some((item) => item.code === 'segment-prompts-count'))
})
