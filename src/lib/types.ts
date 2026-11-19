/**
 * RU: Общие типы GenVideo. Один словарь для движка, HTTP API, MCP-инструментов
 *     и клиентской панели. Все поля, попадающие в SSE/JSON, сериализуемы.
 * EN: Shared GenVideo types. One vocabulary for the engine, HTTP API, MCP tools
 *     and the client panel. Every field that crosses SSE/JSON is serializable.
 */

/** RU: Режим транскодирования — качество ИЛИ лимит размера.
 *  EN: Transcode mode — quality OR size limit. */
export type TranscodeMode = 'quality'

/** RU: Уровни качества перекодирования. EN: Transcode quality tiers. */
export type QualityTier = 'high' | 'medium' | 'compressed'

/** RU: Форматы вывода. EN: Output containers. */
export type OutputFormat = 'mp4' | 'webm' | 'gif'

/** RU: Как вписывать картинку в кадр. EN: How to fit the picture into the frame. */
export type FitMode = 'contain' | 'cover'

/** RU: Платформенные пресеты. EN: Platform presets. */
export type PlatformPreset =
  | 'reels'
  | 'shorts'
  | 'youtube'
  | 'youtube4k'
  | 'cinema'
  | 'square'
  | 'portrait45'
  | 'custom'

/** RU: Аспект кадра. EN: Frame aspect. */
export type Aspect = '16:9' | '9:16' | '1:1' | '4:5' | '3:4' | 'custom'

/** RU: Стратегия использования нескольких GPU. EN: Multi-GPU strategy. */
export type GpuStrategy = 'single' | 'round-robin' | 'tensor-parallel'

/** RU: Фаза выполнения задания. EN: Job execution phase. */
export type JobPhase =
  | 'queued'
  | 'resolving'
  | 'checking'
  | 'downloading'
  | 'loading_model'
  | 'encoding_prompt'
  | 'sampling'
  | 'decoding'
  | 'muxing'
  | 'segment_done'
  | 'concatenating'
  | 'transcoding_pass1'
  | 'transcoding_pass2'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

/** RU: Статус задания. EN: Job status. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** RU: Вид задания. EN: Job kind. */
export type JobKind = 'generate' | 'download' | 'merge' | 'transcode' | 'install'

/** RU: Режим транскодирования: `quality` (три уровня) или `size` (лимит МБ).
 *  EN: Transcode mode: `quality` (three tiers) or `size` (MB limit). */
export type TranscodeKind = 'quality' | 'size'

/** RU: Настройки перекодирования. EN: Transcode settings. */
export interface TranscodeOptions {
  enabled: boolean
  mode: TranscodeKind
  quality: QualityTier
  targetSizeMB: number
  format: OutputFormat
  /** RU: Пусто = исходное разрешение. EN: Empty = source resolution. */
  width: number
  height: number
  fps: number
  fit: FitMode
}

/** RU: Настройки GPU. EN: GPU settings. */
export interface GpuSettings {
  ids: number[]
  strategy: GpuStrategy
  /** RU: 0 = без ограничения. EN: 0 = no budget. */
  vramBudgetGB: number
}

/** RU: Пути к внешним инструментам. EN: External tool paths. */
export interface DepsSettings {
  ffmpegPath: string
  ffprobePath: string
  pythonPath: string
  candleBinary: string
  comfyuiUrl: string
}

/** RU: Поведение раннеров. EN: Runner behaviour. */
export interface RunnerSettings {
  mockDelayMs: number
  allowCpu: boolean
  keepIntermediate: boolean
}

/** RU: Пользовательская модель, добавленная через UI/настройки.
 *  EN: User model added through the UI/settings. */
export interface CustomModel {
  id: string
  title: string
  repo: string
  runtime: RunnerId
  vramGB: number
  sizeGB: number
  files: string[]
  durationSec: number
  fps: number
  width: number
  height: number
  supportsImage: boolean
  supportsVideo: boolean
  commandTemplate: string[]
}

/** RU: Полные настройки плагина (persist в GENVIDEO_HOME/settings.json).
 *  EN: Full plugin settings (persisted to GENVIDEO_HOME/settings.json). */
export interface Settings {
  language: 'en' | 'ru'
  /** RU: Пусто = <workdir>/Videos. EN: Empty = <workdir>/Videos. */
  outputDir: string
  /** RU: Пусто = <workdir>/models. EN: Empty = <workdir>/models. */
  modelsDir: string
  modelId: string
  variant: string
  platform: PlatformPreset
  aspect: Aspect
  width: number
  height: number
  fps: number
  clipSec: number
  targetDurationSec: number
  steps: number
  guidance: number
  negativePrompt: string
  seed: number
  continuity: 'none' | 'last-frame'
  transcode: TranscodeOptions
  gpu: GpuSettings
  deps: DepsSettings
  runners: RunnerSettings
  retention: { jobs: number; logBytes: number }
  hf: { tokenEnv: string }
  customModels: CustomModel[]
}

/** RU: Идентификатор раннера. EN: Runner id. */
export type RunnerId = 'mock' | 'diffusers' | 'candle' | 'comfyui' | 'command'

/** RU: Вариант весов модели. EN: Model weight variant. */
export interface ModelVariant {
  id: string
  title: string
  files: string[]
  sizeGB: number
  precision: string
}

/** RU: Описание модели в реестре. EN: Model registry entry. */
export interface ModelEntry {
  id: string
  title: string
  family: string
  repo: string
  kind: string
  variants: ModelVariant[]
  runtimes: RunnerId[]
  capabilities: { t2v: boolean; i2v: boolean; v2v: boolean; audio: boolean }
  durationSec: { min: number; max: number; recommended: number }
  fps: number[]
  width: number
  height: number
  /** RU: Оценка VRAM в ГБ. EN: VRAM estimate in GB. */
  vramGB: { min: number; recommended: number }
  maxPromptChars: number
  license: string
  notes: string
  /** RU: Дополнительные файлы (текст-энкодер, LoRA), нужные для запуска.
   *  EN: Extra files (text encoder, LoRA) required to run. */
  extraFiles: string[]
  /** RU: Резервный источник для fallback-раннера. EN: Fallback source for the fallback runner. */
  fallbackRepo?: string
  /** RU: Ожидаемая ревизия/дата для проверки апдейтов. EN: Expected revision for update checks. */
  knownRevision?: string
}

/** RU: Публичное состояние модели для UI. EN: Public model state for the UI. */
export interface ModelState {
  entry: ModelEntry
  installed: boolean
  installedBytes: number
  requiredBytes: number
  variant: string | null
  missingFiles: string[]
  updateAvailable: boolean
  checkedAt: number | null
  remoteRevision: string | null
  newerCandidates: Array<{ repo: string; reason: string; sizeGB: number }>
}

/** RU: Информация о GPU. EN: GPU information. */
export interface GpuInfo {
  index: number
  name: string
  totalMB: number
  usedMB: number
  driver: string
  computeCap: string
}

/** RU: Состояние GPU-подсистемы. EN: GPU subsystem state. */
export interface GpuStatus {
  available: boolean
  gpus: GpuInfo[]
  error: string | null
  hints: string[]
  checkedAt: number
  /** RU: linux = NVML в WSL, windows = fallback через Windows-драйвер.
   *  EN: linux = NVML inside WSL, windows = fallback through the Windows driver. */
  source?: 'linux' | 'windows'
}

/** RU: Состояние внешних зависимостей. EN: External dependency state. */
export interface DepsStatus {
  ffmpeg: { ok: boolean; path: string; version: string | null; encoders: string[] }
  ffprobe: { ok: boolean; path: string; version: string | null }
  python: { ok: boolean; path: string; version: string | null }
  venv: { ok: boolean; path: string; torch: string | null; diffusers: string | null; cuda: boolean }
  cargo: { ok: boolean; path: string; version: string | null }
  comfyui: { ok: boolean; url: string; error: string | null }
  disk: { freeGB: number; totalGB: number }
  checkedAt: number
}

/** RU: Артефакт на диске. EN: On-disk artifact. */
export interface OutputArtifact {
  id: string
  name: string
  path: string
  bytes: number
  width: number
  height: number
  fps: number
  durationSec: number
  format: string
  createdAt: number
}

/** RU: Сегмент длинного ролика. EN: Long-video segment. */
export interface PlannedSegment {
  index: number
  durationSec: number
  prompt: string
}

/** RU: План генерации, который показывает «что модель может».
 *  EN: Generation plan that explains "what the model can do". */
export interface Plan {
  modelId: string
  modelTitle: string
  capabilities: ModelEntry['capabilities']
  runtimes: RunnerId[]
  availableRunner: RunnerId | null
  clipSec: number
  segments: PlannedSegment[]
  totalSec: number
  width: number
  height: number
  fps: number
  frames: number
  estimatedVramGB: number
  vramFit: boolean
  gpuIds: number[]
  estimatedSeconds: number
  supportedDurationSec: { min: number; max: number }
  inputs: { image: boolean; video: boolean; audio: boolean }
  transcode: { mode: TranscodeKind; estimatedBytes: number | null }
  warnings: Array<{ code: string; message: string }>
}

/** RU: Запрос генерации (общая форма для UI и MCP). EN: Generation request shared by UI and MCP. */
export interface GenerateRequest {
  prompt: string
  negativePrompt?: string
  modelId?: string
  variant?: string
  /** RU: Принудительный раннер (по умолчанию — первый доступный).
   *  EN: Forced runner (the first available one by default). */
  runner?: RunnerId
  platform?: PlatformPreset
  aspect?: Aspect
  width?: number
  height?: number
  fps?: number
  targetDurationSec?: number
  clipSec?: number
  segments?: number
  seed?: number
  steps?: number
  guidance?: number
  continuity?: 'none' | 'last-frame'
  inputImageId?: string
  inputVideoId?: string
  outputName?: string
  requestId?: string
  transcode?: Partial<TranscodeOptions>
}

/** RU: Запись задания. EN: Job record. */
export interface JobRecord {
  id: string
  kind: JobKind
  status: JobStatus
  phase: JobPhase
  percent: number
  message: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  params: Record<string, unknown>
  progress: {
    segmentIndex: number
    segmentCount: number
    step: number
    totalSteps: number
    etaMs: number | null
    bytes: number | null
    totalBytes: number | null
  }
  segments: Array<{ index: number; status: JobStatus; percent: number }>
  outputs: OutputArtifact[]
  error: { code: string; message: string; details?: unknown } | null
  logTail: string[]
}

/** RU: Событие SSE. EN: SSE event. */
export type ServerEvent =
  | { seq: number; kind: 'job'; job: JobRecord }
  | { seq: number; kind: 'log'; jobId: string; line: string }
  | { seq: number; kind: 'state'; revision: number }

/** RU: Результат операции с ошибкой. EN: Operation result with an error code. */
export interface ApiError {
  code: string
  message: string
  details?: unknown
}

/** RU: Универсальный ответ API. EN: Generic API envelope. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }
