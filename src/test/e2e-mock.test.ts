/**
 * RU: End-to-end проверка движка с Mock-раннером: реальный ffmpeg, реальный
 *     файл в Videos/, лимит размера и склейка. Пропускается без ffmpeg.
 * EN: Engine end-to-end check with the Mock runner: real ffmpeg, a real file in
 *     Videos/, a size limit and concatenation. Skipped without ffmpeg.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { probeFile } from '../lib/media.js'
import type { Engine } from '../lib/engine.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
let engine: Engine | null = null
let home = ''

before(async () => {
  if (!hasFfmpeg) return
  home = await mkdtemp(join(tmpdir(), 'genvideo-e2e-'))
  process.env.GENVIDEO_HOME = home
  process.env.GENVIDEO_WORKDIR = home
  process.env.GENVIDEO_MODELS_DIR = join(home, 'models')
  process.env.GENVIDEO_ENDPOINT_FILE = join(home, 'endpoint.json')
  const module = await import('../lib/engine.js')
  engine = new module.Engine()
})

after(async () => {
  engine?.dispose()
  if (home) await rm(home, { recursive: true, force: true })
})

async function waitJob(id: string, timeoutMs = 90_000): Promise<any> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const job = engine?.jobs.get(id)
    if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')) return job
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`job ${id} did not finish in ${timeoutMs}ms`)
}

test('mock generation writes a real mp4 into Videos/', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  const request = {
    prompt: 'A test clip with a moving gradient',
    promptMode: 'shots' as const,
    segmentPrompts: ['A blue gradient moves left.', 'A green gradient moves right.', 'A warm gradient settles.'],
    modelId: 'comfyui-workflow',
    runner: 'mock' as const,
    platform: 'custom' as const,
    width: 320,
    height: 240,
    fps: 24,
    targetDurationSec: 4,
    // RU: Тесты проверяют сам mock-пайплайн, транскод включаем отдельно.
    // EN: These tests cover the mock pipeline; transcode is tested separately.
    transcode: { enabled: false },
  }
  const planned = await engine.plan(request)
  const { job, plan } = await engine.generate({ ...request, planId: planned.planId })
  assert.equal(plan.segments.length, 3)
  const done = await waitJob(job.id)
  assert.equal(done.status, 'done', done.error?.message)
  const output = done.outputs[0]
  assert.ok(output, 'a job must register an output')
  assert.ok(existsSync(output.path))
  assert.ok(done.percent === 100)
  const deps = await engine.deps()
  const info = await probeFile(deps.ffprobe.path, output.path)
  assert.equal(info.videoCodec, 'hevc')
  assert.equal(info.width, 320)
  assert.equal(info.height, 240)
  assert.ok(info.durationSec >= 9.5)
})

test('size-mode transcode respects the MB limit', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  const library = await engine.library()
  const source = library[0]
  assert.ok(source, 'the previous test must leave a clip')
  const job = await engine.transcode({
    name: source.name,
    transcode: { mode: 'size', targetSizeMB: 0.5, format: 'mp4' },
  })
  const done = await waitJob(job.id)
  assert.equal(done.status, 'done', done.error?.message)
  const output = done.outputs[0]
  assert.ok(output)
  assert.ok(output.bytes <= 0.5 * 1e6 * 1.05, `size ${output.bytes} exceeds the limit`)
})

test('merge concatenates two clips into a longer video', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  const library = await engine.library()
  const source = library[0]
  assert.ok(source)
  const job = await engine.merge({ names: [source.name, source.name], transcode: { enabled: false } })
  const done = await waitJob(job.id)
  assert.equal(done.status, 'done', done.error?.message)
  const output = done.outputs[0]
  assert.ok(output)
  const deps = await engine.deps()
  const info = await probeFile(deps.ffprobe.path, output.path)
  assert.ok(info.durationSec >= 9.5)
})

test('plan selects the ComfyUI workflow backend', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  const plan = await engine.plan({ prompt: 'A dragon', modelId: 'comfyui-workflow', targetDurationSec: 20 })
  assert.ok(plan.availableRunner === 'comfyui' || plan.availableRunner === null)
  assert.ok(plan.segments.length > 1)
})

test('generation requires a confirmed plan', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  await assert.rejects(
    engine.generate({
      prompt: 'unconfirmed fox',
      modelId: 'comfyui-workflow',
      runner: 'mock',
      targetDurationSec: 4,
      transcode: { enabled: false },
    }),
    (error: any) => error?.code === 'confirmation-required',
  )
})

test('a reference video plans one V2V clip', { skip: !hasFfmpeg }, async () => {
  assert.ok(engine)
  const plan = await engine.plan({
    prompt: 'restyle the fox',
    modelId: 'comfyui-workflow',
    runner: 'mock',
    inputVideoId: 'source.mp4',
    fps: 30,
    targetDurationSec: 60,
  })
  assert.equal(plan.mode, 'v2v')
  assert.equal(plan.segments.length, 1)
  assert.ok(plan.frames <= 257, `frames=${plan.frames}, clip=${plan.clipSec}, segments=${plan.segments.length}`)
  assert.ok(plan.denoise >= 0.3 && plan.denoise <= 0.8)
})
