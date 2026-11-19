/**
 * RU: Настройки GenVideo: значения по умолчанию, санитайзинг и атомарное
 *     сохранение в `GENVIDEO_HOME/settings.json`. Настройки — единственный
 *     источник пользовательских предпочтений; задания и логи живут отдельно.
 * EN: GenVideo settings: defaults, sanitizing and atomic persistence in
 *     `GENVIDEO_HOME/settings.json`. Settings are the only source of user
 *     preferences; jobs and logs live separately.
 */
import { join } from 'node:path'
import type { Settings } from './types.js'
import { defaultModelsDir, defaultVideosDir, readJsonFile, settingsFile, writeJsonAtomic } from './paths.js'

/** RU: Значения по умолчанию. EN: Default values. */
export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  outputDir: '',
  modelsDir: '',
  modelId: 'ltx-0.9.8-2b-distilled',
  variant: '',
  platform: 'youtube',
  aspect: '16:9',
  width: 1280,
  height: 720,
  fps: 30,
  clipSec: 9,
  targetDurationSec: 60,
  steps: 0,
  guidance: 0,
  negativePrompt: '',
  seed: -1,
  continuity: 'none',
  promptMode: 'full',
  orientation: 'landscape',
  denoise: 0.6,
  transcode: {
    enabled: true,
    mode: 'quality',
    quality: 'high',
    targetSizeMB: 25,
    format: 'mp4',
    codec: 'h265',
    encoder: 'nvenc',
    width: 0,
    height: 0,
    fps: 0,
    fit: 'contain',
  },
  gpu: {
    ids: [],
    strategy: 'single',
    vramBudgetGB: 0,
  },
  proxy: {
    enabled: false,
    url: '',
  },
  deps: {
    ffmpegPath: '',
    ffprobePath: '',
    pythonPath: '',
    candleBinary: '',
    candleArgs: [],
    comfyuiUrl: '',
    comfyuiAutoStart: false,
    comfyuiDir: '',
  },
  runners: {
    mockDelayMs: 120,
    allowCpu: false,
    keepIntermediate: false,
  },
  retention: {
    jobs: 200,
    logBytes: 2_000_000,
  },
  hf: {
    tokenEnv: 'HF_TOKEN',
  },
  customModels: [],
}

/** RU: Число в диапазоне. EN: Number within a range. */
function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** RU: Целое в диапазоне. EN: Integer within a range. */
function int(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(num(value, min, max, fallback))
}

/** RU: Строка из допустимого набора. EN: One of an allowed set. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** RU: Логическое значение. EN: Boolean value. */
function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** RU: Строка с обрезкой и лимитом. EN: Trimmed, length-capped string. */
function str(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, max)
}

/** RU: Приводит произвольный объект к валидным настройкам.
 *  EN: Coerces an arbitrary object into valid settings. */
/** RU: Принимает socks5://host:port, socks5h://... или host:port.
 *  EN: Accepts socks5://host:port, socks5h://... or host:port. */
export function sanitizeProxyUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') return ''
    if (!url.hostname || !url.port) return ''
    return candidate.slice(0, 300)
  } catch {
    return ''
  }
}

export function sanitizeSettings(raw: unknown): Settings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const transcodeRaw = (source.transcode && typeof source.transcode === 'object' ? source.transcode : {}) as Record<string, unknown>
  const gpuRaw = (source.gpu && typeof source.gpu === 'object' ? source.gpu : {}) as Record<string, unknown>
  const proxyRaw = (source.proxy && typeof source.proxy === 'object' ? source.proxy : {}) as Record<string, unknown>
  const depsRaw = (source.deps && typeof source.deps === 'object' ? source.deps : {}) as Record<string, unknown>
  const runnersRaw = (source.runners && typeof source.runners === 'object' ? source.runners : {}) as Record<string, unknown>
  const retentionRaw = (source.retention && typeof source.retention === 'object' ? source.retention : {}) as Record<string, unknown>
  const hfRaw = (source.hf && typeof source.hf === 'object' ? source.hf : {}) as Record<string, unknown>

  const gpuIds = Array.isArray(gpuRaw.ids)
    ? Array.from(new Set(gpuRaw.ids.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id) && id >= 0))).slice(0, 16)
    : []

  const customModels = Array.isArray(source.customModels)
    ? source.customModels
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 50)
        .map((item, index) => ({
          id: str(item.id, 64, `custom-${index + 1}`) || `custom-${index + 1}`,
          title: str(item.title, 120, 'Custom model'),
          repo: str(item.repo, 200, ''),
          runtime: oneOf(item.runtime, ['mock', 'diffusers', 'candle', 'comfyui', 'command'] as const, 'command'),
          vramGB: num(item.vramGB, 0, 1024, 12),
          sizeGB: num(item.sizeGB, 0, 4096, 0),
          files: Array.isArray(item.files) ? item.files.map((file) => str(file, 300, '')).filter(Boolean).slice(0, 32) : [],
          durationSec: num(item.durationSec, 1, 120, 4),
          fps: int(item.fps, 1, 120, 24),
          width: int(item.width, 64, 4096, 768),
          height: int(item.height, 64, 4096, 512),
          supportsImage: bool(item.supportsImage, false),
          supportsVideo: bool(item.supportsVideo, false),
          commandTemplate: Array.isArray(item.commandTemplate)
            ? item.commandTemplate.map((token) => str(token, 500, '')).filter(Boolean).slice(0, 64)
            : [],
        }))
    : []

  return {
    language: oneOf(source.language, ['en', 'ru'] as const, 'en'),
    outputDir: str(source.outputDir, 1000, ''),
    modelsDir: str(source.modelsDir, 1000, ''),
    modelId: str(source.modelId, 120, DEFAULT_SETTINGS.modelId) || DEFAULT_SETTINGS.modelId,
    variant: str(source.variant, 120, ''),
    platform: oneOf(source.platform, ['reels', 'shorts', 'youtube', 'youtube4k', 'cinema', 'square', 'portrait45', 'custom'] as const, 'youtube'),
    aspect: oneOf(source.aspect, ['16:9', '9:16', '1:1', '4:5', '3:4', 'custom'] as const, '16:9'),
    width: int(source.width, 64, 4096, 1280),
    height: int(source.height, 64, 4096, 720),
    fps: int(source.fps, 1, 120, 30),
    clipSec: num(source.clipSec, 0.5, 120, 9),
    targetDurationSec: num(source.targetDurationSec, 0.5, 600, 60),
    steps: int(source.steps, 0, 200, 0),
    guidance: num(source.guidance, 0, 30, 0),
    negativePrompt: str(source.negativePrompt, 4000, ''),
    seed: int(source.seed, -1, 2_147_483_647, -1),
    continuity: oneOf(source.continuity, ['none', 'last-frame'] as const, 'none'),
    promptMode: oneOf(source.promptMode, ['split', 'full', 'shots'] as const, 'full'),
    orientation: oneOf(source.orientation, ['landscape', 'portrait'] as const, 'landscape'),
    denoise: Math.min(0.8, Math.max(0.3, Number(source.denoise) || 0.6)),
    transcode: {
      enabled: bool(transcodeRaw.enabled, true),
      mode: oneOf(transcodeRaw.mode, ['quality', 'size'] as const, 'quality'),
      quality: oneOf(transcodeRaw.quality, ['high', 'medium', 'compressed'] as const, 'high'),
      targetSizeMB: num(transcodeRaw.targetSizeMB, 0.1, 20_000, 25),
      format: oneOf(transcodeRaw.format, ['mp4', 'webm', 'gif'] as const, 'mp4'),
      codec: oneOf(transcodeRaw.codec, ['h264', 'h265'] as const, 'h265'),
      encoder: oneOf(transcodeRaw.encoder, ['auto', 'cpu', 'vulkan', 'nvenc'] as const, 'nvenc'),
      width: int(transcodeRaw.width, 0, 4096, 0),
      height: int(transcodeRaw.height, 0, 4096, 0),
      fps: int(transcodeRaw.fps, 0, 120, 0),
      fit: oneOf(transcodeRaw.fit, ['contain', 'cover'] as const, 'contain'),
    },
    proxy: {
      enabled: bool(proxyRaw.enabled, false),
      url: sanitizeProxyUrl(proxyRaw.url),
    },
    gpu: {
      ids: gpuIds,
      strategy: oneOf(gpuRaw.strategy, ['single', 'round-robin', 'tensor-parallel'] as const, 'single'),
      vramBudgetGB: num(gpuRaw.vramBudgetGB, 0, 1024, 0),
    },
    deps: {
      ffmpegPath: str(depsRaw.ffmpegPath, 1000, ''),
      ffprobePath: str(depsRaw.ffprobePath, 1000, ''),
      pythonPath: str(depsRaw.pythonPath, 1000, ''),
      candleBinary: str(depsRaw.candleBinary, 1000, ''),
      candleArgs: Array.isArray(depsRaw.candleArgs)
        ? depsRaw.candleArgs.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0).slice(0, 32).map((arg) => arg.slice(0, 500))
        : [],
      comfyuiUrl: str(depsRaw.comfyuiUrl, 1000, ''),
      comfyuiAutoStart: bool(depsRaw.comfyuiAutoStart, false),
      comfyuiDir: str(depsRaw.comfyuiDir, 1000, ''),
    },
    runners: {
      mockDelayMs: int(runnersRaw.mockDelayMs, 0, 10_000, 120),
      allowCpu: bool(runnersRaw.allowCpu, false),
      keepIntermediate: bool(runnersRaw.keepIntermediate, false),
    },
    retention: {
      jobs: int(retentionRaw.jobs, 10, 1000, 200),
      logBytes: int(retentionRaw.logBytes, 10_000, 50_000_000, 2_000_000),
    },
    hf: {
      tokenEnv: str(hfRaw.tokenEnv, 120, 'HF_TOKEN') || 'HF_TOKEN',
    },
    customModels,
  }
}

/** RU: Разрешённые пути моделей и видео. EN: Resolved models and videos paths. */
export function resolveDirs(settings: Settings): { modelsDir: string; videosDir: string } {
  return {
    modelsDir: settings.modelsDir ? settings.modelsDir : defaultModelsDir(),
    videosDir: settings.outputDir ? settings.outputDir : defaultVideosDir(),
  }
}

/** RU: Хранилище настроек процесса. EN: Process-level settings store. */
export class SettingsStore {
  private state: Settings
  private chain: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(file = settingsFile()) {
    this.file = file
    this.state = sanitizeSettings(readJsonFile<Record<string, unknown>>(this.file, {}))
  }

  /** RU: Копия текущих настроек. EN: Copy of current settings. */
  get(): Settings {
    return structuredClone(this.state)
  }

  /** RU: Глубокое слияние с последующим санитайзингом и записью.
   *  EN: Deep merge followed by sanitizing and persistence. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const merged: Record<string, unknown> = { ...this.state }
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) }
      } else {
        merged[key] = value
      }
    }
    this.state = sanitizeSettings(merged)
    const snapshot = this.state
    this.chain = this.chain.then(() => writeJsonAtomic(this.file, snapshot)).catch(() => undefined)
    await this.chain
    return this.get()
  }

  /** RU: Сбрасывает настройки к значениям по умолчанию. EN: Resets to defaults. */
  async reset(): Promise<Settings> {
    this.state = structuredClone(DEFAULT_SETTINGS)
    await writeJsonAtomic(this.file, this.state)
    return this.get()
  }
}

/** RU: Путь к файлу настроек (для диагностики). EN: Settings file path for diagnostics. */
export function settingsPath(): string {
  return settingsFile()
}

/** RU: Каталог моделей по настройкам. EN: Models directory from settings. */
export function modelsDirOf(settings: Settings): string {
  return resolveDirs(settings).modelsDir
}

/** RU: Каталог видео по настройкам. EN: Videos directory from settings. */
export function videosDirOf(settings: Settings): string {
  return resolveDirs(settings).videosDir
}

/** RU: Склеивает путь модели. EN: Joins a model path. */
export function modelPath(modelsDir: string, modelId: string, file: string): string {
  return join(modelsDir, modelId, file)
}
