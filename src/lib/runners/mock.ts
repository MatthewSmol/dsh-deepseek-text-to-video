/**
 * RU: Mock-раннер: генерирует синтетический клип через ffmpeg. Нужен, чтобы
 *     проверить весь пайплайн (сегменты, прогресс, склейку, транскод) без
 *     модели и GPU. Всегда помечается как демо-режим в UI.
 * EN: Mock runner: generates a synthetic clip through ffmpeg. It exists to test
 *     the whole pipeline (segments, progress, merge, transcode) without a model
 *     or GPU. The UI always labels it as demo mode.
 */
import { stat } from 'node:fs/promises'
import { synthesizeClip } from '../media.js'
import type { Runner, RunnerAvailabilityInput, RunnerResult, RunnerRunInput } from './types.js'
import { available, unavailable } from './types.js'

export const mockRunner: Runner = {
  id: 'mock',
  availability(input: RunnerAvailabilityInput) {
    if (!input.deps.ffmpeg.ok) return unavailable('ffmpeg is not available', 'Install ffmpeg from Settings → Tools')
    return available()
  },
  async run(input: RunnerRunInput): Promise<RunnerResult> {
    const delay = Math.max(0, input.settings.runners.mockDelayMs)
    const steps = 8
    for (let step = 1; step <= steps; step += 1) {
      if (input.signal.aborted) throw new Error('aborted')
      input.onProgress({
        phase: step < 3 ? 'loading_model' : 'sampling',
        percent: Math.round((step / steps) * 45),
        step,
        totalSteps: steps,
        message: 'Mock runner: rendering a synthetic clip',
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    input.onProgress({ phase: 'muxing', percent: 55, message: 'Encoding the synthetic clip' })
    await synthesizeClip({
      ffmpeg: input.settings.deps.ffmpegPath || 'ffmpeg',
      target: input.outputPath,
      width: input.width,
      height: input.height,
      fps: input.fps,
      durationSec: input.durationSec,
      seed: input.seed,
      signal: input.signal,
      onProgress: (percent) => input.onProgress({ phase: 'sampling', percent: 55 + Math.round(percent * 0.4) }),
    })
    const bytes = await stat(input.outputPath).then((info) => info.size).catch(() => 0)
    input.log(`mock: wrote ${bytes} bytes to ${input.outputPath}`)
    return {
      outputPath: input.outputPath,
      width: input.width,
      height: input.height,
      fps: input.fps,
      durationSec: input.durationSec,
    }
  },
}
