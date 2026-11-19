/**
 * RU: Candle-раннер для oxide-lab/LTX-Video-0.9.8-2B-distilled. Это
 *     официальный Rust-путь модели: собранный бинарь `candle-video`
 *     (examples/ltx-video) запускается с локальными весами. Бинарь можно
 *     собрать из Settings → Tools; путь сохраняется автоматически.
 * EN: Candle runner for oxide-lab/LTX-Video-0.9.8-2B-distilled. It is the
 *     model's official Rust path: the compiled `candle-video` binary
 *     (examples/ltx-video) runs with local weights. The binary can be built
 *     from Settings → Tools and its path is saved automatically.
 */
import { access, constants, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Runner, RunnerAvailabilityInput, RunnerResult, RunnerRunInput } from './types.js'
import { available, unavailable } from './types.js'
import { runStreaming } from '../proc.js'
import { GenVideoError } from '../errors.js'
import { modelsDirOf } from '../store.js'
import { findCandleBinary } from '../deps.js'

const VIDEO_EXT = /\.(mp4|webm|mkv|mov)$/i

/** RU: Ищет самый новый видеофайл в папке. EN: Finds the newest video file in a folder. */
async function newestVideo(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && VIDEO_EXT.test(entry.name))
      .map(async (entry) => {
        const path = join(dir, entry.name)
        const info = await stat(path).catch(() => null)
        return info ? { path, mtime: info.mtimeMs } : null
      }),
  )
  return files.filter((item): item is { path: string; mtime: number } => Boolean(item)).sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
}

async function executable(path: string): Promise<boolean> {
  if (!path) return false
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const candleRunner: Runner = {
  id: 'candle',
  availability(input: RunnerAvailabilityInput) {
    if (!input.model.runtimes.includes('candle')) return unavailable('This model has no Candle path', 'Use the Command runner with a custom template')
    if (!input.deps.ffmpeg.ok) return unavailable('ffmpeg is not available', 'Install ffmpeg from Settings → Tools')
    if (!findCandleBinary(input.settings.deps.candleBinary)) {
      return unavailable(
        'candle-video was not found',
        'Open Settings → Tools → Candle and press Build; the binary path is saved automatically.',
      )
    }
    return available()
  },
  async run(input: RunnerRunInput): Promise<RunnerResult> {
    const binary = findCandleBinary(input.settings.deps.candleBinary) ?? input.settings.deps.candleBinary
    if (!(await executable(binary))) {
      throw new GenVideoError('candle-missing', `candle-video binary is not executable: ${binary}`)
    }
    const modelDir = join(modelsDirOf(input.settings), input.model.id)
    const variant = input.model.variants[0]
    const missing: string[] = []
    for (const file of variant?.files ?? []) {
      const exists = await stat(join(modelDir, file)).then(() => true).catch(() => false)
      if (!exists) missing.push(file)
    }
    if (missing.length) {
      throw new GenVideoError(
        'candle-weights-missing',
        `Candle weights are not installed: ${missing.join(', ')}. Open Models → ${input.model.title} → Install model, or choose the diffusers model for the weights you already downloaded.`,
        { status: 409, details: { modelId: input.model.id, missing } },
      )
    }
    const unified = join(modelDir, variant?.files[0] ?? 'ltxv-2b-0.9.8-distilled.safetensors')
    const outputDir = join(input.outputPath, '..')
    await mkdir(outputDir, { recursive: true })

    const args = [
      '--local-weights', modelDir,
      '--unified-weights', unified,
      '--ltxv-version', '0.9.8-2b-distilled',
      '--prompt', input.prompt,
      '--height', String(input.height),
      '--width', String(input.width),
      '--num-frames', String(input.frames),
      '--seed', String(Math.max(0, input.seed)),
      '--output-dir', outputDir,
      '--vae-tiling',
    ]
    if (input.negativePrompt) args.push('--negative-prompt', input.negativePrompt)
    if (input.steps > 0) args.push('--steps', String(input.steps))
    // RU: Пользовательские аргументы (например, --device vulkan для своей сборки).
    // EN: User-provided arguments (for example, --device vulkan for a custom build).
    if (input.settings.deps.candleArgs.length) args.push(...input.settings.deps.candleArgs)
    if (!input.gpuIds.length) args.push('--cpu')

    input.onProgress({ phase: 'loading_model', percent: 5, message: 'Loading Candle weights' })
    const started = Date.now()
    const estimateMs = Math.max(20_000, (input.durationSec / 4) * 45_000)
    let lastPercent = 5
    const timer = setInterval(() => {
      const elapsed = Date.now() - started
      const percent = Math.min(88, 5 + Math.round((elapsed / estimateMs) * 83))
      if (percent > lastPercent) {
        lastPercent = percent
        input.onProgress({ phase: 'sampling', percent, message: 'Candle diffusion' })
      }
    }, 1000)

    try {
      const result = await runStreaming(binary, args, {
        signal: input.signal,
        env: { ...process.env, ...(input.gpuIds.length ? { CUDA_VISIBLE_DEVICES: input.gpuIds.join(',') } : {}) },
        onLine: (line) => {
          if (!line.trim()) return
          input.log(line)
          const match = line.match(/(?:step|Step)\s+(\d+)\s*\/\s*(\d+)/)
          if (match) {
            const step = Number(match[1])
            const total = Number(match[2]) || 1
            input.onProgress({ phase: 'sampling', percent: 5 + Math.round((step / total) * 80), step, totalSteps: total })
          }
        },
      })
      if (result.code !== 0) {
        throw new GenVideoError('candle-failed', result.stderrTail.trim().split('\n').slice(-4).join(' ') || `candle-video exited ${result.code}`)
      }
    } finally {
      clearInterval(timer)
    }

    input.onProgress({ phase: 'muxing', percent: 92, message: 'Collecting output' })
    const produced = await newestVideo(outputDir)
    if (!produced) throw new GenVideoError('candle-no-output', 'candle-video finished without a video file')
    if (produced !== input.outputPath) await rename(produced, input.outputPath)
    return {
      outputPath: input.outputPath,
      width: input.width,
      height: input.height,
      fps: input.fps,
      durationSec: input.durationSec,
    }
  },
}
