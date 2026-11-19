/**
 * RU: Реестр раннеров и выбор подходящего. Порядок предпочтения задаётся
 *     списком `model.runtimes`; явный выбор пользователя имеет приоритет.
 * EN: Runner registry and selection. Preference order comes from
 *     `model.runtimes`; an explicit user choice wins.
 */
import type { GpuStatus, ModelEntry, ModelVariant, RunnerId, Settings } from '../types.js'
import type { DepsStatus } from '../types.js'
import type { Runner, RunnerAvailability, RunnerAvailabilityInput } from './types.js'
import { mockRunner } from './mock.js'
import { candleRunner } from './candle.js'
import { commandRunner } from './command.js'
import { comfyuiRunner } from './comfyui.js'
import { diffusersRunner } from './diffusers.js'

/** RU: Все раннеры. EN: All runners. */
export const RUNNERS: Runner[] = [comfyuiRunner, candleRunner, diffusersRunner, commandRunner, mockRunner]

/** RU: Карта по id. EN: Map by id. */
const BY_ID = new Map<RunnerId, Runner>(RUNNERS.map((runner) => [runner.id, runner]))

/** RU: Раннер по id. EN: Runner by id. */
export function getRunner(id: RunnerId): Runner {
  return BY_ID.get(id) ?? mockRunner
}

/** RU: Контекст проверки. EN: Availability context. */
export function availabilityInput(input: {
  settings: Settings
  deps: DepsStatus
  gpu: GpuStatus
  model: ModelEntry
  variant: ModelVariant
}): RunnerAvailabilityInput {
  return input
}

/** RU: Проверяет конкретный раннер. EN: Checks a concrete runner. */
export function checkRunner(id: RunnerId, input: RunnerAvailabilityInput): RunnerAvailability {
  return getRunner(id).availability(input)
}

/** RU: Доступность всех раннеров для модели. EN: Availability of every runner for a model. */
export function allAvailability(input: RunnerAvailabilityInput): Array<{ id: RunnerId; available: boolean; reason: string | null; hint: string | null }> {
  return RUNNERS.map((runner) => ({ id: runner.id, ...runner.availability(input) }))
}

/** RU: Выбирает раннер: явный → порядок модели → mock (только если разрешён).
 *  EN: Picks a runner: explicit → model order → mock (only when allowed). */
export function pickRunner(input: {
  settings: Settings
  deps: DepsStatus
  gpu: GpuStatus
  model: ModelEntry
  variant: ModelVariant
  preferred?: RunnerId
}): { runner: Runner; availability: RunnerAvailability } | null {
  const context = availabilityInput(input)
  if (input.preferred) {
    const runner = getRunner(input.preferred)
    return { runner, availability: runner.availability(context) }
  }
  for (const id of input.model.runtimes) {
    const runner = getRunner(id)
    const availability = runner.availability(context)
    if (availability.available) return { runner, availability }
  }
  return null
}
