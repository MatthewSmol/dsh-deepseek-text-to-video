/**
 * RU: Контракт раннеров. Каждый раннер умеет честно сказать, доступен ли он
 *     сейчас (`availability`) и как запустить генерацию. Движок выбирает
 *     первый доступный раннер из `model.runtimes`, а ошибки доступа
 *     превращает в понятные подсказки для UI.
 * EN: Runner contract. Every runner honestly reports whether it is available
 *     (`availability`) and how to run generation. The engine picks the first
 *     available runner from `model.runtimes` and turns availability errors into
 *     actionable hints for the UI.
 */
import type { DepsStatus, GpuStatus, JobPhase, ModelEntry, ModelVariant, RunnerId, Settings } from '../types.js'

/** RU: Прогресс раннера. EN: Runner progress. */
export interface RunnerProgress {
  phase: JobPhase
  percent: number
  message?: string
  step?: number
  totalSteps?: number
}

/** RU: Вход раннера. EN: Runner input. */
export interface RunnerRunInput {
  settings: Settings
  model: ModelEntry
  variant: ModelVariant
  prompt: string
  negativePrompt: string
  width: number
  height: number
  fps: number
  frames: number
  durationSec: number
  seed: number
  steps: number
  guidance: number
  denoise?: number
  gpuIds: number[]
  imagePath: string | null
  videoPath: string | null
  outputPath: string
  signal: AbortSignal
  onProgress: (progress: RunnerProgress) => void
  log: (line: string) => void
}

/** RU: Результат раннера. EN: Runner result. */
export interface RunnerResult {
  outputPath: string
  width: number
  height: number
  fps: number
  durationSec: number
}

/** RU: Доступность раннера. EN: Runner availability. */
export interface RunnerAvailability {
  available: boolean
  reason: string | null
  hint: string | null
}

/** RU: Контекст проверки доступности. EN: Availability-check context. */
export interface RunnerAvailabilityInput {
  settings: Settings
  deps: DepsStatus
  gpu: GpuStatus
  model: ModelEntry
  variant: ModelVariant
}

/** RU: Раннер. EN: Runner. */
export interface Runner {
  id: RunnerId
  availability(input: RunnerAvailabilityInput): RunnerAvailability
  run(input: RunnerRunInput): Promise<RunnerResult>
}

/** RU: Успешная доступность. EN: Available result. */
export function available(): RunnerAvailability {
  return { available: true, reason: null, hint: null }
}

/** RU: Недоступность с подсказкой. EN: Unavailable with a hint. */
export function unavailable(reason: string, hint: string): RunnerAvailability {
  return { available: false, reason, hint }
}
