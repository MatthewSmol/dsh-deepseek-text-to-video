/**
 * RU: Планирование генерации: сколько сегментов нужно, какие у них
 *     длительности и промпты, хватит ли VRAM и сколько это займёт. План
 *     объясняет пользователю «что модель может» до запуска.
 * EN: Generation planning: how many segments are needed, their durations and
 *     prompts, whether VRAM fits and how long it takes. The plan explains
 *     "what the model can do" before the run.
 */
import type { GpuStatus, ModelEntry, Plan, PlannedSegment, PromptMode, RunnerId, SegmentMode, Settings } from './types.js'

/** RU: Вход планировщика. EN: Planner input. */
export interface PlanInput {
  settings: Settings
  model: ModelEntry
  runner: RunnerId | null
  gpu: GpuStatus
  prompt: string
  targetDurationSec?: number
  clipSec?: number
  promptMode?: PromptMode
  segmentMode?: SegmentMode
  width?: number
  height?: number
  fps?: number
  segments?: number
  imageInput?: boolean
  videoInput?: boolean
  transcodeEstimatedBytes?: number | null
  transcodeMode?: 'quality' | 'size' | null
}

/** RU: Оценка VRAM: веса + активации, линейно по числу пикселей и кадров.
 *  EN: VRAM estimate: weights + activations, linear in pixels and frames. */
export function estimateVramGB(model: ModelEntry, width: number, height: number, frames: number): number {
  const reference = 768 * 512 * 97
  const scale = Math.max(0.25, (width * height * frames) / reference)
  const weights = model.vramGB.min * 0.7
  const activations = model.vramGB.min * 0.3 * scale
  return Math.round((weights + activations) * 10) / 10
}

/** RU: Оценка времени (секунды) для одного клипа.
 *  EN: Time estimate (seconds) for one clip. */
export function estimateSeconds(model: ModelEntry, width: number, height: number, frames: number, steps: number): number {
  const stepsEffective = steps > 0 ? steps : model.id.includes('distilled') ? 7 : 30
  const pixels = (width * height) / (768 * 512)
  const framesScale = frames / 97
  return Math.round(15 + 0.22 * stepsEffective * pixels * framesScale * 4)
}

/** RU: Предельное число сегментов одного задания. EN: Maximum segments per job. */
export const MAX_SEGMENTS = 120

/** RU: Число сегментов и их длительности. fixed — клипы полной длины и короткий
 *      последний; even — прежнее равномерное деление. Сумма всегда равна цели.
 *  EN: Segment count and durations. fixed keeps full-length clips and a short
 *      last one; even is the previous uniform split. The sum always equals target. */
export function computeSegments(
  targetDurationSec: number,
  clipSec: number,
  maxClipSec: number,
  mode: SegmentMode = 'fixed',
): number[] {
  const target = Math.max(0.5, Number(targetDurationSec) || 0.5)
  const maxClip = Math.max(0.5, Number(maxClipSec) || 10.7)
  const clip = Math.min(Math.max(0.5, Number(clipSec) || 0.5), maxClip)
  if (mode === 'even') {
    const count = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(target / clip)))
    const base = target / count
    const durations = Array.from({ length: count }, () => Math.round(base * 100) / 100)
    const sum = durations.reduce((acc, value) => acc + value, 0)
    durations[count - 1] = Math.round(((durations[count - 1] ?? base) + (target - sum)) * 100) / 100
    return durations
  }
  let count = Math.max(1, Math.ceil(target / clip))
  let effective = clip
  if (count > MAX_SEGMENTS) {
    count = MAX_SEGMENTS
    effective = Math.max(clip, target / count)
  }
  const durations = Array.from({ length: count }, () => Math.round(effective * 100) / 100)
  let last = Math.round((target - effective * (count - 1)) * 100) / 100
  if (count > 1 && last < 0.5) {
    durations.pop()
    last = Math.round((effective + last) * 100) / 100
    durations[durations.length - 1] = last
  } else {
    durations[count - 1] = last
  }
  return durations
}

/** RU: Делит промпт на части по предложениям/строкам, добивая якорями.
 *  EN: Splits a prompt into parts by sentences/lines, padding with anchors. */
export function splitPrompt(prompt: string, count: number): string[] {
  const text = String(prompt || '').trim()
  const parts = text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
  if (count <= 1) return [text]
  if (!parts.length) return Array.from({ length: count }, () => 'An empty scene')
  if (parts.length >= count) {
    // RU: Раскидываем предложения по сегментам, сохраняя порядок.
    // EN: Distribute sentences across segments while preserving order.
    return Array.from({ length: count }, (_, index) => {
      const from = Math.floor((index * parts.length) / count)
      const to = Math.max(from + 1, Math.floor(((index + 1) * parts.length) / count))
      return parts.slice(from, to).join(' ')
    })
  }
  const filled = [...parts]
  while (filled.length < count) {
    filled.push(`${parts[parts.length - 1]} (continues)`)
  }
  return filled
}

/** RU: Собирает промпт для каждого клипа. full — вся сцена в каждом клипе,
 *      split — прежнее деление по предложениям.
 *  EN: Builds the prompt for every clip. full repeats the whole scene in each
 *      clip, split keeps the previous sentence distribution. */
export function buildSegmentPrompts(
  prompt: string,
  count: number,
  mode: PromptMode,
  maxPromptChars: number,
): { prompts: string[]; fallback: boolean } {
  const text = String(prompt ?? '').trim()
  if (mode !== 'full') return { prompts: splitPrompt(text, count), fallback: false }
  const base = text || 'An empty scene'
  const suffix = (index: number) => `\n\nPart ${index + 1}/${count}. Continue the same scene seamlessly.`
  if (base.length > maxPromptChars) {
    return { prompts: splitPrompt(base, count), fallback: true }
  }
  const withSuffix = Array.from({ length: count }, (_, index) => `${base}${suffix(index)}`)
  if (withSuffix.every((value) => value.length <= maxPromptChars)) {
    return { prompts: withSuffix, fallback: false }
  }
  return { prompts: Array.from({ length: count }, () => base), fallback: false }
}

/** RU: Собирает полный план. EN: Builds the full plan. */
export function planGeneration(input: PlanInput): Plan {
  const { settings, model, gpu } = input
  const warnings: Plan['warnings'] = []
  const fps = input.fps && input.fps > 0 ? input.fps : model.fps[0] ?? 24
  const width = input.width && input.width > 0 ? input.width : model.width
  const height = input.height && input.height > 0 ? input.height : model.height
  const target = Math.max(0.5, input.targetDurationSec ?? settings.targetDurationSec ?? model.durationSec.recommended)
  const clipRequested = Math.min(input.clipSec ?? settings.clipSec ?? model.durationSec.recommended, model.durationSec.max)
  const promptMode: PromptMode = input.promptMode ?? 'full'
  const segmentMode: SegmentMode = input.segmentMode ?? 'fixed'
  const requestedSegments = Math.ceil(target / Math.max(0.5, clipRequested))
  if (requestedSegments > 30) {
    warnings.push({
      code: 'many-segments',
      message: `${requestedSegments} clips will be generated sequentially; this can take a long time.`,
    })
  }
  if (requestedSegments > MAX_SEGMENTS) {
    warnings.push({
      code: 'too-many-segments',
      message: `A ${target}s video with ${clipRequested}s clips needs ${requestedSegments} segments; the limit is ${MAX_SEGMENTS}. Increase the clip length or shorten the video.`,
    })
  }
  const durations = computeSegments(target, clipRequested, model.durationSec.max, segmentMode)
  const built = buildSegmentPrompts(input.prompt, durations.length, promptMode, model.maxPromptChars)
  if (built.fallback) {
    warnings.push({
      code: 'prompt-too-long',
      message: `The full scene is longer than the model limit (${model.maxPromptChars} chars); prompts are split by sentences instead.`,
    })
  }
  const segments: PlannedSegment[] = durations.map((durationSec, index) => ({
    index,
    durationSec,
    prompt: built.prompts[index] ?? input.prompt,
  }))
  const totalSec = Math.round(segments.reduce((acc, segment) => acc + segment.durationSec, 0) * 100) / 100
  const frames = Math.max(9, Math.round(segments[0]?.durationSec ?? 1) * fps + 1)
  const estimatedVramGB = estimateVramGB(model, width, height, frames)

  const selected = gpu.available ? gpu.gpus.filter((item) => !settings.gpu.ids.length || settings.gpu.ids.includes(item.index)) : []
  const maxVram = selected.length
    ? Math.max(...selected.map((item) => item.totalMB / 1024))
    : 0
  const budget = settings.gpu.vramBudgetGB > 0 ? settings.gpu.vramBudgetGB : maxVram
  const vramFit = budget > 0 ? estimatedVramGB <= budget : false

  if (!gpu.available) {
    warnings.push({ code: 'no-gpu', message: gpu.error || 'No CUDA GPU detected; only the Mock runner can produce output.' })
  }
  // RU: Карты видны из Windows, но CUDA в WSL не проброшена — реальный раннер
  //     почти наверняка упадёт, хотя VRAM для оценки известна.
  // EN: Cards are visible from Windows but CUDA is not passed through to WSL;
  //     the real runner will likely fail even though VRAM is known.
  if (gpu.available && gpu.source === 'windows') {
    warnings.push({ code: 'wsl-cuda-unavailable', message: 'GPUs were detected through the Windows driver, but WSL CUDA passthrough is unavailable. Real generation may fail until `wsl --shutdown` is run after a driver update.' })
  }
  if (!input.imageInput && model.capabilities.i2v) {
    warnings.push({ code: 'image-optional', message: 'This model also accepts a reference image (image-to-video).' })
  }
  if (!input.videoInput && model.capabilities.v2v) {
    warnings.push({ code: 'video-optional', message: 'This model can also be conditioned on an existing video clip.' })
  }
  if (width % 32 !== 0 || height % 32 !== 0) {
    warnings.push({ code: 'non-native-size', message: `Native ${model.title} sizes are multiples of 32; ${width}x${height} will be generated natively and fitted afterwards.` })
  }
  if (budget > 0 && !vramFit) {
    warnings.push({
      code: 'vram-exceeded',
      message: `Estimated ${estimatedVramGB} GB VRAM exceeds the ${Math.round(budget * 10) / 10} GB budget. Lower the resolution, the clip length, or enable an offload variant.`,
    })
  }
  if (target > model.durationSec.max) {
    warnings.push({
      code: 'segmented',
      message: `The model produces up to ${model.durationSec.max}s per clip; ${target}s will be generated as ${segments.length} segments and merged.`,
    })
  }

  return {
    modelId: model.id,
    modelTitle: model.title,
    capabilities: model.capabilities,
    runtimes: model.runtimes,
    availableRunner: input.runner,
    clipSec: segments[0]?.durationSec ?? target,
    promptMode,
    segments,
    totalSec,
    width,
    height,
    fps,
    frames,
    estimatedVramGB,
    vramFit,
    gpuIds: selected.map((item) => item.index),
    estimatedSeconds: segments.reduce(
      (acc, segment) => acc + estimateSeconds(model, width, height, Math.round(segment.durationSec * fps) + 1, settings.steps),
      0,
    ),
    supportedDurationSec: { min: model.durationSec.min, max: model.durationSec.max },
    inputs: {
      image: model.capabilities.i2v,
      video: model.capabilities.v2v,
      audio: model.capabilities.audio,
    },
    transcode: {
      mode: (input.transcodeMode ?? input.settings.transcode?.mode ?? 'quality') === 'size' ? 'size' : 'quality',
      estimatedBytes: input.transcodeEstimatedBytes ?? null,
    },
    warnings,
  }
}
