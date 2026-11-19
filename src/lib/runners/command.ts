/**
 * RU: Универсальный командный раннер. Пользователь задаёт шаблон команды в
 *     настройках модели; плагин подставляет плейсхолдеры и запускает процесс.
 *     Это путь для ComfyUI-CLI, ltx_pipelines и любых сторонних скриптов.
 * EN: Generic command runner. The user supplies a command template in the model
 *     settings; the plugin substitutes placeholders and spawns the process. It is
 *     the path for ComfyUI CLI, ltx_pipelines and any third-party script.
 */
import { access, constants, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Runner, RunnerAvailabilityInput, RunnerResult, RunnerRunInput } from './types.js'
import { available, unavailable } from './types.js'
import { runStreaming } from '../proc.js'
import { GenVideoError } from '../errors.js'

const VIDEO_EXT = /\.(mp4|webm|mkv|mov)$/i

/** RU: Подстановка плейсхолдеров. EN: Placeholder substitution. */
export function expandTemplate(template: string[], values: Record<string, string>): string[] {
  return template.map((token) => token.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ''))
}

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
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const commandRunner: Runner = {
  id: 'command',
  availability(input: RunnerAvailabilityInput) {
    if (!input.model.runtimes.includes('command')) return unavailable('This model has no command template', 'Add a command template in the model settings')
    if (!input.settings.customModels.find((item) => item.id === input.model.id)?.commandTemplate.length) {
      return unavailable('No command template is configured for this model', 'Open Models → Custom model and add argv tokens with placeholders')
    }
    return available()
  },
  async run(input: RunnerRunInput): Promise<RunnerResult> {
    const custom = input.settings.customModels.find((item) => item.id === input.model.id)
    const template = custom?.commandTemplate ?? []
    if (!template.length) throw new GenVideoError('command-missing', 'No command template configured')

    const values: Record<string, string> = {
      prompt: input.prompt,
      negative: input.negativePrompt,
      width: String(input.width),
      height: String(input.height),
      frames: String(input.frames),
      fps: String(input.fps),
      duration: String(input.durationSec),
      seed: String(Math.max(0, input.seed)),
      steps: String(Math.max(0, input.steps)),
      guidance: String(Math.max(0, input.guidance)),
      output: input.outputPath,
      image: input.imagePath ?? '',
      video: input.videoPath ?? '',
      model: input.model.repo,
      model_dir: join(dirname(input.outputPath), '..', '..', 'models', input.model.id),
      gpu: input.gpuIds.join(','),
    }
    const argv = expandTemplate(template, values)
    const [command, ...args] = argv
    if (!command) throw new GenVideoError('command-missing', 'The command template is empty')
    if (command.includes('/') && !(await executable(command))) {
      throw new GenVideoError('command-missing', `Command is not executable: ${command}`)
    }
    await mkdir(dirname(input.outputPath), { recursive: true })
    const started = Date.now()
    const estimateMs = Math.max(20_000, input.durationSec * 12_000)
    let last = 3
    const timer = setInterval(() => {
      const percent = Math.min(90, 3 + Math.round(((Date.now() - started) / estimateMs) * 87))
      if (percent > last) {
        last = percent
        input.onProgress({ phase: 'sampling', percent, message: 'Command runner' })
      }
    }, 1000)

    try {
      input.onProgress({ phase: 'loading_model', percent: 3, message: 'Starting the command runner' })
      const result = await runStreaming(command, args, {
        signal: input.signal,
        env: { ...process.env, ...(input.gpuIds.length ? { CUDA_VISIBLE_DEVICES: input.gpuIds.join(',') } : {}) },
        onLine: (line) => {
          if (!line.trim()) return
          input.log(line)
          const match = line.match(/(\d{1,3})\s*%/)
          if (match) {
            const percent = Math.min(90, Math.max(last, Number(match[1])))
            if (percent > last) {
              last = percent
              input.onProgress({ phase: 'sampling', percent })
            }
          }
        },
      })
      if (result.code !== 0) {
        throw new GenVideoError('command-failed', result.stderrTail.trim().split('\n').slice(-4).join(' ') || `Command exited ${result.code}`)
      }
    } finally {
      clearInterval(timer)
    }

    input.onProgress({ phase: 'muxing', percent: 92, message: 'Collecting output' })
    if (await stat(input.outputPath).then(() => true).catch(() => false)) {
      return { outputPath: input.outputPath, width: input.width, height: input.height, fps: input.fps, durationSec: input.durationSec }
    }
    const produced = await newestVideo(dirname(input.outputPath))
    if (!produced) throw new GenVideoError('command-no-output', 'The command finished without a video file')
    await rename(produced, input.outputPath)
    return { outputPath: input.outputPath, width: input.width, height: input.height, fps: input.fps, durationSec: input.durationSec }
  },
}
