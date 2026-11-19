/**
 * RU: Движок GenVideo: единая точка для операций генерации, склейки,
 *     транскодирования, установки моделей и состояния окружения. HTTP API и
 *     MCP-инструменты вызывают одни и те же методы, поэтому агент и UI видят
 *     одинаковый результат.
 * EN: GenVideo engine: the single entry point for generation, merge, transcode,
 *     model installs and environment state. HTTP API and MCP tools call the same
 *     methods, so the agent and the UI see identical results.
 */
import { access, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ApiResult,
  DepsStatus,
  GenerateRequest,
  GpuStatus,
  JobRecord,
  ModelEntry,
  ModelState,
  ModelVariant,
  OutputArtifact,
  Plan,
  RunnerId,
  ServerEvent,
  Settings,
  TranscodeOptions,
} from './types.js'
import { GenVideoError, toApiError } from './errors.js'
import { SettingsStore, resolveDirs } from './store.js'
import { JobManager, type JobContext } from './jobs.js'
import { detectGpus, selectGpus } from './gpu.js'
import { buildToolsStatus, detectDeps, findNvcc } from './deps.js'
import { allModels, findModel, findVariant, formatGB, snapFrames } from './models.js'
import { estimateOutputBytes, normalizeTranscode, probeFile, transcodeFile, concatFiles, extractLastFrame, formatBytes } from './media.js'
import { planGeneration } from './planner.js'
import { defaultModelsDir, defaultVideosDir, genvideoHome, inputsDir, safeBaseName, scratchDir, assertInside, outputFileName, slugify, ensureDirSync } from './paths.js'
import { allAvailability, pickRunner } from './runners/index.js'
import { downloadModelFiles, checkRemoteRevision, findNewerCandidates } from './downloads.js'
import { fetchExploreModels, type ExplorePage } from './explore.js'
import { venvDir } from './deps.js'

/** RU: Версия сервиса. EN: Service version. */
export const VERSION = '1.0.0'

/** RU: Состояние сервиса для UI. EN: Service state for the UI. */
export interface EngineStatus {
  version: string
  startedAt: number
  settings: Settings
  gpu: GpuStatus
  deps: DepsStatus
  models: ModelState[]
  jobs: JobRecord[]
  paths: { videosDir: string; modelsDir: string; genvideoHome: string }
  revision: number
}

/** RU: Платформенные пресеты кадра. EN: Frame platform presets. */
export const PLATFORM_PRESETS: Record<string, { aspect: string; width: number; height: number; fps: number; label: string }> = {
  reels: { aspect: '9:16', width: 1080, height: 1920, fps: 30, label: 'Instagram Reels' },
  shorts: { aspect: '9:16', width: 1080, height: 1920, fps: 30, label: 'YouTube Shorts' },
  youtube: { aspect: '16:9', width: 1920, height: 1080, fps: 30, label: 'YouTube 1080p' },
  youtube4k: { aspect: '16:9', width: 3840, height: 2160, fps: 30, label: 'YouTube 4K' },
  cinema: { aspect: '16:9', width: 1920, height: 1080, fps: 24, label: 'Cinema 16:9' },
  square: { aspect: '1:1', width: 1080, height: 1080, fps: 30, label: 'Square 1:1' },
  portrait45: { aspect: '4:5', width: 1080, height: 1350, fps: 30, label: 'Portrait 4:5' },
  custom: { aspect: 'custom', width: 1280, height: 720, fps: 24, label: 'Custom' },
}

/** RU: Проверяет наличие файла. EN: Checks that a file exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** RU: Расширение по формату. EN: Extension by format. */
function extensionFor(format: string): string {
  return format === 'webm' ? 'webm' : format === 'gif' ? 'gif' : 'mp4'
}

/** RU: Манифест установленной модели. EN: Installed model manifest. */
interface ModelManifest {
  repo: string
  sha: string
  variant: string
  files: string[]
  bytes: number
  installedAt: number
}

export class Engine {
  readonly startedAt = Date.now()
  private revision = 0
  private gpuStatus: GpuStatus | null = null
  private depsStatus: DepsStatus | null = null
  private readonly listeners = new Set<(event: ServerEvent) => void>()

  constructor(
    readonly settingsStore = new SettingsStore(),
    readonly jobs = new JobManager(),
  ) {
    ensureDirSync(genvideoHome())
    this.jobs.subscribe((event) => this.broadcast(event))
    const dirs = resolveDirs(this.settingsStore.get())
    ensureDirSync(dirs.modelsDir)
    ensureDirSync(dirs.videosDir)
    void this.refresh(true)
  }

  /** RU: Свежие настройки. EN: Current settings. */
  get settings(): Settings {
    return this.settingsStore.get()
  }

  /** RU: Пути моделей и видео. EN: Models and videos paths. */
  private dirs(): { modelsDir: string; videosDir: string } {
    return resolveDirs(this.settings)
  }

  /** RU: Подписка на события (для HTTP SSE). EN: Event subscription (HTTP SSE). */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** RU: Рассылка события всем подписчикам. EN: Broadcast to every subscriber. */
  private broadcast(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* best effort */
      }
    }
  }

  /** RU: Уведомляет об изменении состояния. EN: Notifies about a state change. */
  private bump(): void {
    this.revision += 1
    this.broadcast({ seq: this.revision, kind: 'state', revision: this.revision })
  }

  /** RU: Обновляет кэш GPU/зависимостей. EN: Refreshes the GPU/dependency cache. */
  async refresh(force = false): Promise<void> {
    const now = Date.now()
    const stale = force || !this.gpuStatus || !this.depsStatus || now - this.depsStatus.checkedAt > 30_000
    if (!stale) return
    const [gpu, deps] = await Promise.all([detectGpus(), detectDeps(this.settings)])
    this.gpuStatus = gpu
    this.depsStatus = deps
    this.bump()
  }

  /** RU: Текущее состояние. EN: Current state. */
  async status(): Promise<EngineStatus> {
    if (!this.gpuStatus || !this.depsStatus) await this.refresh(true)
    const settings = this.settings
    const dirs = this.dirs()
    return {
      version: VERSION,
      startedAt: this.startedAt,
      settings,
      gpu: this.gpuStatus ?? { available: false, gpus: [], error: 'Not checked yet', hints: [], checkedAt: Date.now() },
      deps: this.depsStatus ?? (await detectDeps(settings)),
      models: await this.modelStates(),
      jobs: this.jobs.list(30),
      paths: { videosDir: dirs.videosDir, modelsDir: dirs.modelsDir, genvideoHome: genvideoHome() },
      revision: this.revision,
    }
  }

  /** RU: Состояние GPU. EN: GPU state. */
  async gpu(): Promise<GpuStatus> {
    if (!this.gpuStatus) await this.refresh(true)
    return this.gpuStatus ?? (await detectGpus())
  }

  /** RU: Состояние зависимостей. EN: Dependency state. */
  async deps(): Promise<DepsStatus> {
    if (!this.depsStatus) await this.refresh(true)
    return this.depsStatus ?? (await detectDeps(this.settings))
  }

  /** RU: Все модели с состоянием установки. EN: Every model with install state. */
  async modelStates(): Promise<ModelState[]> {
    const models = allModels(this.settings.customModels)
    const dirs = this.dirs()
    return Promise.all(models.map((entry) => this.modelState(entry, dirs.modelsDir)))
  }

  /** RU: Состояние одной модели. EN: One model's state. */
  private async modelState(entry: ModelEntry, modelsDir: string): Promise<ModelState> {
    const variant = entry.variants[0] ?? null
    const required = variant?.files ?? []
    const missingFiles: string[] = []
    let installedBytes = 0
    for (const file of required) {
      const info = await stat(join(modelsDir, entry.id, file)).catch(() => null)
      if (!info) missingFiles.push(file)
      else installedBytes += info.size
    }
    const manifest = await this.readManifest(entry.id, modelsDir)
    return {
      entry,
      installed: required.length > 0 && missingFiles.length === 0,
      installedBytes,
      requiredBytes: Math.round((variant?.sizeGB ?? entry.variants[0]?.sizeGB ?? 0) * 1e9),
      variant: manifest?.variant ?? variant?.id ?? null,
      missingFiles,
      updateAvailable: false,
      checkedAt: manifest?.installedAt ?? null,
      remoteRevision: manifest?.sha ?? null,
      newerCandidates: [],
    }
  }

  /** RU: Читает манифест модели. EN: Reads a model manifest. */
  private async readManifest(modelId: string, modelsDir: string): Promise<ModelManifest | null> {
    try {
      const text = await (await import('node:fs/promises')).readFile(join(modelsDir, modelId, 'manifest.json'), 'utf8')
      return JSON.parse(text) as ModelManifest
    } catch {
      return null
    }
  }

  /** RU: Разрешает модель/вариант и раннер для запроса. EN: Resolves the model/variant and runner. */
  private async resolveModel(request: GenerateRequest): Promise<{
    model: ModelEntry
    variant: ModelVariant
    runner: ReturnType<typeof pickRunner>
  }> {
    const settings = this.settings
    const model = findModel(request.modelId ?? settings.modelId, settings.customModels)
    if (!model) throw new GenVideoError('model-not-found', `Unknown model: ${request.modelId ?? settings.modelId}`, { status: 404 })
    const variant = findVariant(model, request.variant ?? settings.variant)
    if (!variant) throw new GenVideoError('variant-not-found', `Unknown variant for ${model.id}`)
    const deps = await this.deps()
    const gpu = await this.gpu()
    const runner = pickRunner({ settings, deps, gpu, model, variant, preferred: request.runner })
    return { model, variant, runner }
  }

  /** RU: Размеры кадра из запроса и пресета. EN: Frame size from the request and preset. */
  private frameSize(request: GenerateRequest, model: ModelEntry, settings: Settings): { width: number; height: number; fps: number } {
    const preset = request.platform && request.platform !== 'custom' ? PLATFORM_PRESETS[request.platform] : null
    const width = Math.max(64, Math.round(request.width ?? preset?.width ?? settings.width ?? model.width))
    const height = Math.max(64, Math.round(request.height ?? preset?.height ?? settings.height ?? model.height))
    const fps = Math.max(1, Math.round(request.fps ?? preset?.fps ?? settings.fps ?? model.fps[0] ?? 24))
    return { width, height, fps }
  }

  /** RU: Транскод-настройки запроса (surface size включает enabled). EN: Request transcode settings. */
  private transcodeOptions(request: GenerateRequest): TranscodeOptions {
    const merged: TranscodeOptions = { ...this.settings.transcode, ...(request.transcode ?? {}) }
    // RU: Режим size невозможен без перекодирования. EN: Size mode implies transcoding.
    if (merged.mode === 'size') merged.enabled = true
    return merged
  }

  /** RU: Строит план и объясняет ограничения модели. EN: Builds the plan and explains model limits. */
  async plan(request: GenerateRequest): Promise<Plan> {
    const settings = this.settings
    const { model, variant, runner } = await this.resolveModel(request)
    const deps = await this.deps()
    const gpu = await this.gpu()
    const { width, height, fps } = this.frameSize(request, model, settings)
    const target = Math.max(0.5, request.targetDurationSec ?? settings.targetDurationSec ?? model.durationSec.recommended)
    const transcode = this.transcodeOptions(request)
    let estimatedBytes: number | null = null
    if (transcode.enabled) {
      try {
        estimatedBytes = estimateOutputBytes(normalizeTranscode(transcode, target), target)
      } catch {
        estimatedBytes = null
      }
    }
    const plan = planGeneration({
      settings,
      model,
      runner: runner?.availability.available ? runner.runner.id : null,
      gpu,
      prompt: request.prompt,
      targetDurationSec: target,
      clipSec: request.clipSec ?? settings.clipSec,
      width,
      height,
      fps,
      segments: request.segments,
      imageInput: Boolean(request.inputImageId) || model.capabilities.i2v,
      videoInput: Boolean(request.inputVideoId) || model.capabilities.v2v,
      transcodeEstimatedBytes: estimatedBytes,
      transcodeMode: transcode.enabled ? transcode.mode : null,
    })
    plan.warnings.push(...this.runtimeWarnings(model, variant, runner, deps, gpu, settings))
    return plan
  }

  /** RU: Предупреждения о доступности инструментов и памяти. EN: Toolchain and memory warnings. */
  private runtimeWarnings(
    model: ModelEntry,
    _variant: ModelVariant,
    runner: ReturnType<typeof pickRunner>,
    deps: DepsStatus,
    gpu: GpuStatus,
    settings: Settings,
  ): Array<{ code: string; message: string }> {
    const warnings: Array<{ code: string; message: string }> = []
    if (!runner) {
      warnings.push({
        code: 'no-runner',
        message: `No runner for ${model.title} is available. Mock can produce a synthetic clip; install the real toolchain to use the model.`,
      })
    } else if (!runner.availability.available) {
      warnings.push({ code: 'runner-unavailable', message: runner.availability.reason ?? 'Runner is unavailable', ...(runner.availability.hint ? { hint: runner.availability.hint } : {}) } as never)
    }
    if (!deps.ffmpeg.ok) warnings.push({ code: 'no-ffmpeg', message: 'ffmpeg is required for every output; install it from Settings → Tools.' })
    if (deps.ffmpeg.ok && (!deps.ffmpeg.encoders.includes('libx264') || !deps.ffmpeg.encoders.includes('aac'))) {
      warnings.push({ code: 'ffmpeg-codecs', message: 'ffmpeg is missing libx264 or aac; MP4 output may fail.' })
    }
    const selected = selectGpus(gpu, settings.gpu.ids)
    const budget = settings.gpu.vramBudgetGB > 0 ? settings.gpu.vramBudgetGB : selected[0]?.totalMB ? selected[0].totalMB / 1024 : 0
    if (budget > 0 && model.vramGB.min > budget) {
      warnings.push({
        code: 'model-vram',
        message: `${model.title} needs at least ${formatGB(model.vramGB.min)} VRAM but the current budget is ${formatGB(budget)}. Use a smaller variant or a lighter model.`,
      })
    }
    if (!gpu.available && (runner?.runner.id === 'candle' || runner?.runner.id === 'diffusers')) {
      warnings.push({ code: 'no-gpu', message: 'This runner needs a CUDA GPU; CPU generation is possible only for diffusers with "Allow CPU" enabled.' })
    }
    return warnings
  }

  /** RU: Запускает генерацию и возвращает задание. EN: Starts generation and returns the job. */
  async generate(request: GenerateRequest): Promise<{ job: JobRecord; plan: Plan }> {
    const prompt = String(request.prompt ?? '').trim()
    if (!prompt) throw new GenVideoError('empty-prompt', 'A prompt is required')
    if (prompt.length > 8000) throw new GenVideoError('prompt-too-long', 'The prompt is longer than 8000 characters')
    const { model, variant, runner } = await this.resolveModel(request)
    if (!runner) {
      throw new GenVideoError('no-runner', `No runner is available for ${model.title}. Enable Mock or install the toolchain.`, {
        details: { runtimes: model.runtimes },
      })
    }
    if (!runner.availability.available) {
      throw new GenVideoError('runner-unavailable', runner.availability.reason ?? 'Runner is unavailable', {
        details: { hint: runner.availability.hint, runner: runner.runner.id },
      })
    }
    const plan = await this.plan(request)
    const settings = this.settings
    const transcode = this.transcodeOptions(request)
    const totalDuration = plan.totalSec
    if (transcode.enabled) normalizeTranscode(transcode, totalDuration)
    const jobParams: Record<string, unknown> = {
      prompt,
      modelId: model.id,
      variant: variant.id,
      runner: runner.runner.id,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      targetDurationSec: plan.totalSec,
      segments: plan.segments.length,
      transcode,
      seed: request.seed ?? settings.seed,
      outputName: request.outputName ?? null,
      inputImageId: request.inputImageId ?? null,
      inputVideoId: request.inputVideoId ?? null,
    }
    const job = this.jobs.create('generate', jobParams)
    this.jobs.start(job, (ctx) => this.runGenerate(ctx, { request, plan, model, variant, runner, transcode }))
    return { job, plan }
  }

  /** RU: Исполнитель генерации: сегменты → склейка → транскод → результат.
   *  EN: Generation executor: segments → merge → transcode → result. */
  private async runGenerate(
    ctx: JobContext,
    input: {
      request: GenerateRequest
      plan: Plan
      model: ModelEntry
      variant: ModelVariant
      runner: NonNullable<ReturnType<typeof pickRunner>>
      transcode: TranscodeOptions
    },
  ): Promise<void> {
    const settings = this.settings
    const deps = await this.deps()
    if (!deps.ffmpeg.ok) throw new GenVideoError('no-ffmpeg', 'ffmpeg is required for generation')
    const ffmpeg = deps.ffmpeg.path || 'ffmpeg'
    const ffprobe = deps.ffprobe.path || 'ffprobe'
    const dirs = this.dirs()
    ensureDirSync(dirs.videosDir)
    const scratch = join(scratchDir(), ctx.job.id)
    ensureDirSync(scratch)
    const segments = input.plan.segments
    ctx.segments(segments.length)
    ctx.phase('checking', `Preparing ${input.model.title}`)
    ctx.progress({ percent: 1, message: input.runner.runner.id === 'mock' ? 'Mock runner (demo)' : `Runner: ${input.runner.runner.id}` })

    const imageInput = input.request.inputImageId ? await this.resolveInput(input.request.inputImageId) : null
    const videoInput = input.request.inputVideoId ? await this.resolveInput(input.request.inputVideoId) : null
    const baseSeed = input.request.seed ?? settings.seed
    const segmentFiles: string[] = []
    let previousImage: string | null = imageInput?.path ?? null

    for (let index = 0; index < segments.length; index += 1) {
      if (ctx.signal.aborted) throw new Error('aborted')
      const segment = segments[index]
      if (!segment) continue
      const outputPath = join(scratch, `seg-${String(index + 1).padStart(3, '0')}.mp4`)
      const segmentStart = Math.round((index / segments.length) * 80)
      const segmentSpan = 80 / segments.length
      const fps = input.plan.fps
      const frames = input.model.family === 'ltx-video' || input.model.family === 'ltx-2' ? snapFrames(segment.durationSec * fps + 1) : Math.max(1, Math.round(segment.durationSec * fps))
      ctx.segment(index, 'running', 0)
      ctx.phase('sampling', `Segment ${index + 1}/${segments.length}`)

      await input.runner.runner.run({
        settings,
        model: input.model,
        variant: input.variant,
        prompt: segment.prompt,
        negativePrompt: input.request.negativePrompt ?? settings.negativePrompt,
        width: input.plan.width,
        height: input.plan.height,
        fps,
        frames,
        durationSec: segment.durationSec,
        seed: baseSeed >= 0 ? baseSeed + index : -1,
        steps: input.request.steps ?? settings.steps,
        guidance: input.request.guidance ?? settings.guidance,
        gpuIds: input.plan.gpuIds,
        imagePath: previousImage,
        videoPath: videoInput?.path ?? null,
        outputPath,
        signal: ctx.signal,
        log: (line) => ctx.log(line),
        onProgress: (progress) => {
          const overall = segmentStart + (progress.percent / 100) * segmentSpan
          ctx.progress({
            percent: overall,
            step: progress.step,
            totalSteps: progress.totalSteps,
            message: progress.message ?? `Segment ${index + 1}/${segments.length}`,
          })
          ctx.segment(index, 'running', progress.percent)
        },
      })
      ctx.segment(index, 'done', 100)
      ctx.phase('segment_done', `Segment ${index + 1}/${segments.length} ready`)
      segmentFiles.push(outputPath)

      // RU: Continuity: последний кадр становится картинкой-условием для i2v.
      // EN: Continuity: the last frame becomes the image condition for i2v.
      if (settings.continuity === 'last-frame' && index < segments.length - 1 && input.model.capabilities.i2v) {
        const framePath = join(scratch, `frame-${index + 1}.jpg`)
        try {
          await extractLastFrame(ffmpeg, outputPath, framePath)
          previousImage = framePath
        } catch (error) {
          ctx.log(`continuity: could not extract a frame: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    ctx.phase('concatenating', 'Merging segments')
    const merged = join(scratch, 'merged.mp4')
    if (segmentFiles.length === 1) {
      await copyFile(segmentFiles[0] ?? '', merged)
    } else {
      await concatFiles({
        ffmpeg,
        ffprobe,
        sources: segmentFiles,
        target: merged,
        signal: ctx.signal,
        onProgress: (percent) => ctx.progress({ percent: 80 + Math.round(percent * 0.08), message: 'Merging segments' }),
      })
    }

    const format = input.transcode.enabled ? input.transcode.format : 'mp4'
    const seed = baseSeed >= 0 ? baseSeed : 0
    const name = input.request.outputName
      ? safeBaseName(input.request.outputName)
      : outputFileName({ platform: input.request.platform ?? settings.platform, prompt: input.request.prompt, seed, ext: extensionFor(format) })
    const finalName = name.includes('.') ? name : `${name}.${extensionFor(format)}`
    const finalPath = assertInside(dirs.videosDir, join(dirs.videosDir, finalName))

    if (input.transcode.enabled) {
      ctx.phase('transcoding_pass1', 'Transcoding to the requested quality/size')
      await transcodeFile({
        ffmpeg,
        ffprobe,
        source: merged,
        target: finalPath,
        transcode: input.transcode,
        signal: ctx.signal,
        onProgress: (percent, phase) => {
          ctx.phase(phase, phase === 'transcoding_pass1' ? 'Transcode pass 1/2' : 'Transcode pass 2/2')
          ctx.progress({ percent: 88 + Math.round(percent * 0.1), message: phase === 'transcoding_pass1' ? 'Two-pass analysis' : 'Encoding' })
        },
      })
    } else {
      ctx.phase('muxing', 'Finalizing the file')
      await copyFile(merged, finalPath)
    }

    ctx.phase('verifying', 'Verifying the output')
    const info = await probeFile(ffprobe, finalPath)
    const bytes = await stat(finalPath).then((item) => item.size).catch(() => info.bytes)
    const artifact: OutputArtifact = {
      id: finalName,
      name: finalName,
      path: finalPath,
      bytes,
      width: info.width,
      height: info.height,
      fps: info.fps,
      durationSec: info.durationSec,
      format: extname(finalName).replace('.', '') || 'mp4',
      createdAt: Date.now(),
    }
    ctx.output(artifact)
    ctx.progress({ percent: 100, message: `${formatBytes(bytes)} · ${info.width}x${info.height} · ${info.durationSec.toFixed(1)}s` })
    if (!settings.runners.keepIntermediate) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** RU: Склеивает готовые ролики. EN: Merges finished clips. */
  async merge(request: { names: string[]; outputName?: string; transcode?: Partial<TranscodeOptions> }): Promise<JobRecord> {
    const names = (request.names ?? []).map((name) => safeBaseName(name)).filter(Boolean)
    if (names.length < 2) throw new GenVideoError('merge-needs-two', 'Select at least two clips to merge')
    const dirs = this.dirs()
    const sources = names.map((name) => assertInside(dirs.videosDir, join(dirs.videosDir, name)))
    for (const source of sources) {
      if (!(await exists(source))) throw new GenVideoError('merge-missing', `Clip not found: ${safeBaseName(source)}`, { status: 404 })
    }
    const settings = this.settings
    const transcode: TranscodeOptions = { ...settings.transcode, ...(request.transcode ?? {}) }
    if (transcode.mode === 'size') transcode.enabled = true
    const job = this.jobs.create('merge', { names, outputName: request.outputName ?? null, transcode })
    this.jobs.start(job, async (ctx) => {
      const deps = await this.deps()
      if (!deps.ffmpeg.ok) throw new GenVideoError('no-ffmpeg', 'ffmpeg is required to merge clips')
      const ffmpeg = deps.ffmpeg.path || 'ffmpeg'
      const ffprobe = deps.ffprobe.path || 'ffprobe'
      const scratch = join(scratchDir(), ctx.job.id)
      ensureDirSync(scratch)
      ctx.phase('concatenating', 'Merging clips')
      const merged = join(scratch, 'merged.mp4')
      await concatFiles({
        ffmpeg,
        ffprobe,
        sources,
        target: merged,
        signal: ctx.signal,
        onProgress: (percent) => ctx.progress({ percent: Math.round(percent * 0.8), message: 'Merging clips' }),
      })
      const format = transcode.enabled ? transcode.format : 'mp4'
      const name = request.outputName
        ? safeBaseName(request.outputName)
        : `merged_${names.length}_clips_${Date.now()}.${extensionFor(format)}`
      const finalName = name.includes('.') ? name : `${name}.${extensionFor(format)}`
      const finalPath = assertInside(dirs.videosDir, join(dirs.videosDir, finalName))
      if (transcode.enabled) {
        await transcodeFile({
          ffmpeg,
          ffprobe,
          source: merged,
          target: finalPath,
          transcode,
          signal: ctx.signal,
          onProgress: (percent, phase) => {
            ctx.phase(phase)
            ctx.progress({ percent: 80 + Math.round(percent * 0.18), message: 'Transcoding the merged clip' })
          },
        })
      } else {
        await copyFile(merged, finalPath)
      }
      const info = await probeFile(ffprobe, finalPath)
      ctx.output({
        id: finalName,
        name: finalName,
        path: finalPath,
        bytes: info.bytes,
        width: info.width,
        height: info.height,
        fps: info.fps,
        durationSec: info.durationSec,
        format: extname(finalName).replace('.', '') || 'mp4',
        createdAt: Date.now(),
      })
      if (!this.settings.runners.keepIntermediate) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    })
    return job
  }

  /** RU: Перекодирует готовый ролик. EN: Transcodes a finished clip. */
  async transcode(request: { name: string; transcode?: Partial<TranscodeOptions>; outputName?: string }): Promise<JobRecord> {
    const name = safeBaseName(request.name)
    const dirs = this.dirs()
    const source = assertInside(dirs.videosDir, join(dirs.videosDir, name))
    if (!(await exists(source))) throw new GenVideoError('clip-missing', `Clip not found: ${name}`, { status: 404 })
    const settings = this.settings
    const transcode: TranscodeOptions = { ...settings.transcode, ...(request.transcode ?? {}) }
    if (transcode.mode === 'size') transcode.enabled = true
    transcode.enabled = true
    const job = this.jobs.create('transcode', { name, transcode, outputName: request.outputName ?? null })
    this.jobs.start(job, async (ctx) => {
      const deps = await this.deps()
      if (!deps.ffmpeg.ok) throw new GenVideoError('no-ffmpeg', 'ffmpeg is required to transcode')
      const ffmpeg = deps.ffmpeg.path || 'ffmpeg'
      const ffprobe = deps.ffprobe.path || 'ffprobe'
      const format = transcode.format
      const base = request.outputName ? slugify(request.outputName) : name.replace(/\.[^.]+$/, '')
      const finalName = `${base}_${transcode.mode}-${transcode.mode === 'size' ? `${transcode.targetSizeMB.toFixed(1)}mb` : transcode.quality}.${extensionFor(format)}`
      const finalPath = assertInside(dirs.videosDir, join(dirs.videosDir, finalName))
      ctx.phase('transcoding_pass1', 'Transcoding')
      await transcodeFile({
        ffmpeg,
        ffprobe,
        source,
        target: finalPath,
        transcode,
        signal: ctx.signal,
        onProgress: (percent, phase) => {
          ctx.phase(phase)
          ctx.progress({ percent, message: phase === 'transcoding_pass1' ? 'Pass 1/2' : 'Encoding' })
        },
      })
      const info = await probeFile(ffprobe, finalPath)
      ctx.output({
        id: finalName,
        name: finalName,
        path: finalPath,
        bytes: info.bytes,
        width: info.width,
        height: info.height,
        fps: info.fps,
        durationSec: info.durationSec,
        format: extname(finalName).replace('.', '') || 'mp4',
        createdAt: Date.now(),
      })
    })
    return job
  }

  /** RU: Скачивает модель из HF. EN: Downloads a model from HF. */
  async installModel(request: { modelId: string; variant?: string }): Promise<JobRecord> {
    const settings = this.settings
    const model = findModel(request.modelId, settings.customModels)
    if (!model) throw new GenVideoError('model-not-found', `Unknown model: ${request.modelId}`, { status: 404 })
    const variant = findVariant(model, request.variant)
    if (!variant) throw new GenVideoError('variant-not-found', `Unknown variant for ${model.id}`)
    if (!model.repo) throw new GenVideoError('repo-missing', 'This model has no Hugging Face repository')
    const dirs = this.dirs()
    const token = process.env[settings.hf.tokenEnv] || process.env.HF_TOKEN || ''
    const job = this.jobs.create('download', { modelId: model.id, variant: variant.id, repo: model.repo })
    this.jobs.start(job, async (ctx) => {
      ctx.phase('downloading', `Downloading ${model.title}`)
      const result = await downloadModelFiles({
        repo: model.repo,
        files: variant.files,
        targetDir: join(dirs.modelsDir, model.id),
        token,
        proxy: settings.proxy,
        signal: ctx.signal,
        onProgress: (progress) => {
          ctx.progress({
            percent: Math.round(((progress.index + progress.percent / 100) / Math.max(1, progress.count)) * 100),
            bytes: progress.bytes,
            totalBytes: progress.totalBytes,
            message: `Downloading ${progress.file}`,
          })
        },
      })
      const remote = await checkRemoteRevision(model.repo, token, settings.proxy).catch(() => ({ sha: '', lastModified: '' }))
      const manifest: ModelManifest = {
        repo: model.repo,
        sha: remote.sha,
        variant: variant.id,
        files: result.files,
        bytes: result.bytes,
        installedAt: Date.now(),
      }
      await writeFile(join(dirs.modelsDir, model.id, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
      ctx.log(`model ${model.id} installed (${formatBytes(result.bytes)})`)
      ctx.progress({ percent: 100, message: `Installed ${formatBytes(result.bytes)}` })
    })
    return job
  }

  /** RU: Проверяет обновления модели и соседей по семейству.
   *  EN: Checks model updates and same-family candidates. */
  async checkUpdates(modelId?: string): Promise<Array<{ modelId: string; updateAvailable: boolean; remoteRevision: string | null; checkedAt: number; newerCandidates: Array<{ repo: string; reason: string; sizeGB: number }>; error: string | null }>> {
    const settings = this.settings
    const models = allModels(settings.customModels).filter((entry) => !modelId || entry.id === modelId)
    const dirs = this.dirs()
    const token = process.env[settings.hf.tokenEnv] || process.env.HF_TOKEN || ''
    const results = []
    for (const model of models) {
      const manifest = await this.readManifest(model.id, dirs.modelsDir)
      try {
        const remote = await checkRemoteRevision(model.repo, token, settings.proxy)
        const candidates = await findNewerCandidates({
          query: model.family === 'ltx-2' ? 'ltx-2' : 'ltx-video',
          currentRepo: model.repo,
          knownRevision: remote.lastModified,
          token,
          proxy: settings.proxy,
        }).catch(() => [])
        results.push({
          modelId: model.id,
          updateAvailable: Boolean(manifest?.sha && remote.sha && manifest.sha !== remote.sha),
          remoteRevision: remote.sha,
          checkedAt: Date.now(),
          newerCandidates: candidates,
          error: null,
        })
      } catch (error) {
        results.push({
          modelId: model.id,
          updateAvailable: false,
          remoteRevision: null,
          checkedAt: Date.now(),
          newerCandidates: [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return results
  }

  /** RU: Библиотека готовых роликов. EN: Library of finished clips. */
  async library(): Promise<OutputArtifact[]> {
    const dirs = this.dirs()
    const entries = await readdir(dirs.videosDir, { withFileTypes: true }).catch(() => [])
    const artifacts: OutputArtifact[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.(mp4|webm|gif|mov|mkv)$/i.test(entry.name)) continue
      const path = join(dirs.videosDir, entry.name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      artifacts.push({
        id: entry.name,
        name: entry.name,
        path,
        bytes: info.size,
        width: 0,
        height: 0,
        fps: 0,
        durationSec: 0,
        format: extname(entry.name).replace('.', '').toLowerCase(),
        createdAt: info.mtimeMs,
      })
    }
    return artifacts.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** RU: Разрешает имя ролика в безопасный путь для отдачи/плеера.
   *  EN: Resolves a clip name into a safe path for serving/playback. */
  resolveMedia(name: string): string {
    const dirs = this.dirs()
    const safe = safeBaseName(name)
    return assertInside(dirs.videosDir, join(dirs.videosDir, safe))
  }

  /** RU: Ищет загруженный input по id. EN: Resolves an uploaded input by id. */
  private async resolveInput(id: string): Promise<{ id: string; path: string }> {
    const safe = safeBaseName(id)
    const path = join(inputsDir(), safe)
    if (!(await exists(path))) throw new GenVideoError('input-missing', `Uploaded input not found: ${safe}`, { status: 404 })
    return { id: safe, path }
  }

  /** RU: Сохраняет загруженный файл (картинка/видео) во временное хранилище.
   *  EN: Stores an uploaded file (image/video) in the input storage. */
  async saveInput(input: { data: Buffer; name: string; mime: string }): Promise<{ id: string; name: string; bytes: number; path: string }> {
    const ext = extname(input.name).replace('.', '').toLowerCase() || (input.mime.includes('video') ? 'mp4' : 'png')
    const id = `${randomUUID()}.${safeBaseName(ext)}`
    await mkdir(inputsDir(), { recursive: true })
    const path = join(inputsDir(), id)
    await writeFile(path, input.data)
    return { id, name: safeBaseName(input.name), bytes: input.data.length, path }
  }

  /** RU: Обновляет настройки. EN: Updates settings. */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const settings = await this.settingsStore.update(patch)
    const dirs = resolveDirs(settings)
    ensureDirSync(dirs.modelsDir)
    ensureDirSync(dirs.videosDir)
    await this.refresh(true)
    this.bump()
    return settings
  }

  /** RU: Сбрасывает настройки. EN: Resets settings. */
  async resetSettings(): Promise<Settings> {
    const settings = await this.settingsStore.reset()
    this.bump()
    return settings
  }

  /** RU: Полная проверка окружения по требованию. EN: Full environment check on demand. */
  async recheck(): Promise<DepsStatus> {
    await this.refresh(true)
    return this.deps()
  }

  /** RU: Установка ffmpeg (только по явному действию). EN: ffmpeg install on explicit action. */
  async installFfmpeg(): Promise<{ ok: boolean; message: string; command: string }> {
    const { installFfmpeg: install } = await import('./deps.js')
    const result = await install()
    await this.refresh(true)
    return result
  }

  /** RU: Создаёт venv и ставит torch/diffusers (по явному действию).
   *  EN: Creates the venv and installs torch/diffusers (explicit action). */
  async installPythonEngine(): Promise<JobRecord> {
    const job = this.jobs.create('install', { target: 'python' })
    this.jobs.start(job, async (ctx) => {
      const deps = await this.deps()
      if (!deps.python.ok) throw new GenVideoError('no-python', 'python3 is not available on this host')
      const { runStreaming } = await import('./proc.js')
      const { join: joinPath } = await import('node:path')
      const python = deps.python.path || 'python3'
      const venv = venvDir()
      const cuda = (await this.gpu()).available
      const pip = joinPath(venv, 'bin', 'python')
      // RU: CUDA-колёса ставим с PyPI: они несут CUDA-библиотеки и есть под
      //     новые Python; CPU-вариант берём из индекса PyTorch.
      // EN: CUDA wheels come from PyPI: they bundle CUDA libraries and exist for
      //     new Python versions; the CPU variant uses the PyTorch index.
      const index = 'https://download.pytorch.org/whl/cpu'
      const steps: Array<{ label: string; command: string; args: string[] }> = [
        { label: 'Creating the virtual environment', command: python, args: ['-m', 'venv', venv] },
        { label: 'Upgrading pip', command: pip, args: ['-m', 'pip', 'install', '--upgrade', 'pip'] },
        { label: cuda ? 'Installing torch (CUDA)' : 'Installing torch (CPU)', command: pip, args: cuda ? ['-m', 'pip', 'install', 'torch'] : ['-m', 'pip', 'install', '--index-url', index, 'torch'] },
        {
          label: 'Installing diffusers and helpers',
          command: pip,
          args: ['-m', 'pip', 'install', 'diffusers', 'transformers', 'accelerate', 'safetensors', 'sentencepiece', 'imageio', 'imageio-ffmpeg'],
        },
      ]
      for (let indexStep = 0; indexStep < steps.length; indexStep += 1) {
        const step = steps[indexStep]
        if (!step) continue
        ctx.phase('downloading', step.label)
        ctx.progress({ percent: Math.round((indexStep / steps.length) * 100), message: step.label })
        await runStreaming(step.command, step.args, {
          signal: ctx.signal,
          onLine: (line) => ctx.log(line),
        })
      }
      ctx.phase('verifying', 'Checking the Python environment')
      await this.refresh(true)
      ctx.progress({ percent: 100, message: 'Python engine installed' })
    })
    return job
  }


  /** RU: Собирает candle-video из исходников (Rust + CUDA). Rust ставится
   *      автоматически, но CUDA toolkit (nvcc) должен уже быть в системе:
   *      без root сервис не может установить его сам.
   *  EN: Builds candle-video from source (Rust + CUDA). Rust is installed
   *      automatically, but the CUDA toolkit (nvcc) must already be present:
   *      the service has no root to install it by itself. */
  async installCandleEngine(): Promise<JobRecord> {
    const job = this.jobs.create('install', { target: 'candle' })
    this.jobs.start(job, async (ctx) => {
      const { runStreaming, firstWorking, runCommand } = await import('./proc.js')
      ctx.phase('checking', 'Checking the CUDA toolkit')
      const nvcc = findNvcc()
      if (!nvcc) {
        throw new GenVideoError(
          'cuda-missing',
          'CUDA toolkit (nvcc) not found. Install it once in Ubuntu with "sudo apt-get install -y nvidia-cuda-toolkit", then press Build again.',
          { status: 409, details: { command: 'sudo apt-get install -y nvidia-cuda-toolkit' } },
        )
      }
      const tools = buildToolsStatus()
      if (!tools.pkgConfig || !tools.openssl) {
        throw new GenVideoError(
          'build-deps-missing',
          'Candle needs pkg-config and OpenSSL headers. Install them once: sudo apt-get install -y pkg-config libssl-dev, then press Build again.',
          { status: 409, details: { command: 'sudo apt-get install -y pkg-config libssl-dev' } },
        )
      }
      const git = await firstWorking(['git'], ['--version'])
      if (!git) throw new GenVideoError('git-missing', 'git is not installed; install it with "sudo apt-get install -y git"', { status: 409 })

      const home = homedir()
      let cargo = await firstWorking([join(home, '.cargo', 'bin', 'cargo'), 'cargo'], ['--version'])
      if (!cargo) {
        ctx.phase('downloading', 'Installing the Rust toolchain')
        ctx.progress({ percent: 5, message: 'Installing Rust (rustup)' })
        const install = await runStreaming(
          'bash',
          ['-lc', 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'],
          { signal: ctx.signal, onLine: (line) => ctx.log(line) },
        )
        if (install.code !== 0) throw new GenVideoError('rustup-failed', 'rustup installation failed', { status: 500 })
        cargo = await firstWorking([join(home, '.cargo', 'bin', 'cargo'), 'cargo'], ['--version'])
      }
      if (!cargo) throw new GenVideoError('cargo-missing', 'cargo is still unavailable after rustup', { status: 500 })

      const enginesDir = join(genvideoHome(), 'engines')
      const repoDir = join(enginesDir, 'candle-video')
      await mkdir(enginesDir, { recursive: true })
      if (!existsSync(join(repoDir, 'Cargo.toml'))) {
        ctx.phase('downloading', 'Cloning candle-video')
        ctx.progress({ percent: 15, message: 'Cloning FerrisMind/candle-video' })
        const clone = await runStreaming(
          'git',
          ['clone', '--depth', '1', 'https://github.com/FerrisMind/candle-video', repoDir],
          { signal: ctx.signal, onLine: (line) => ctx.log(line) },
        )
        if (clone.code !== 0) throw new GenVideoError('clone-failed', clone.stderrTail.trim().split('\n').slice(-3).join(' ') || 'git clone failed', { status: 500 })
      }

      ctx.phase('building', 'Building candle-video with CUDA (10–20 minutes)')
      ctx.progress({ percent: 25, message: 'cargo build --release --example ltx-video --features cuda' })
      // RU: apt-обёртка лежит в /usr/bin, а реальный toolkit — в /usr/local/cuda;
      //     для nvcc нужен корректный CUDA_HOME, иначе сборка не найдёт библиотеки.
      // EN: the apt wrapper lives in /usr/bin while the real toolkit is in
      //     /usr/local/cuda; nvcc needs a correct CUDA_HOME or the build misses libs.
      const cudaHome = nvcc.startsWith('/usr/bin/')
        ? (existsSync('/usr/local/cuda') ? '/usr/local/cuda' : '/usr')
        : dirname(dirname(nvcc))
      // RU: CUDA 12.x не поддерживает GCC 14/15; берём gcc-13, если он есть,
      //     и разрешаем nvcc работать с неподдерживаемым компилятором как fallback.
      // EN: CUDA 12.x rejects GCC 14/15; use gcc-13 when available and let nvcc
      //     accept an unsupported compiler as a fallback.
      const gcc13 = existsSync('/usr/bin/gcc-13') ? '/usr/bin/gcc-13' : ''
      const gxx13 = existsSync('/usr/bin/g++-13') ? '/usr/bin/g++-13' : ''
      // RU: cudarc 0.19.10 знает CUDA только до 13.4; для 13.5 сообщаем ему
      //     13.4, библиотеки всё равно берутся из CUDA_HOME (13.5).
      // EN: cudarc 0.19.10 only knows CUDA up to 13.4; tell it 13.4 for 13.5,
      //     while libraries still come from CUDA_HOME (13.5).
      const nvccInfo = await runCommand(nvcc, ['--version'], { timeoutMs: 5000 }).catch(() => null)
      const versionMatch = nvccInfo ? /release\s+(\d+)\.(\d+)/i.exec(`${nvccInfo.stdout}\n${nvccInfo.stderr}`) : null
      let cudarcVersion = ''
      if (versionMatch) {
        let major = Number(versionMatch[1])
        let minor = Number(versionMatch[2])
        if (major > 13 || (major === 13 && minor > 4)) {
          major = 13
          minor = 4
        }
        cudarcVersion = `${major}0${minor}0`
      }
      const nvccFlags = [process.env.NVCC_PREPEND_FLAGS, '-allow-unsupported-compiler'].filter(Boolean).join(' ')
      const env = {
        PATH: `${join(cudaHome, 'bin')}:${dirname(nvcc)}:${process.env.PATH ?? ''}`,
        CUDA_HOME: cudaHome,
        CUDA_PATH: cudaHome,
        NVCC_PREPEND_FLAGS: nvccFlags,
        ...(cudarcVersion ? { CUDARC_CUDA_VERSION: cudarcVersion } : {}),
        ...(gcc13 ? { CC: gcc13 } : {}),
        ...(gxx13 ? { CXX: gxx13, NVCC_CCBIN: gxx13 } : {}),
      }
      const build = await runStreaming(
        cargo.path,
        ['build', '--release', '--example', 'ltx-video', '--features', 'cuda'],
        { cwd: repoDir, signal: ctx.signal, env, onLine: (line) => ctx.log(line) },
      )
      if (build.code !== 0) {
        const tail = build.stderrTail.trim().split('\n').slice(-5).join(' ') || 'cargo build failed'
        const hint = /unsupported GNU version|unsupported host compiler/i.test(build.stderrTail)
          ? ' Install gcc-13/g++-13 once: sudo apt-get install -y gcc-13 g++-13, then retry.'
          : /exception specification is incompatible/i.test(build.stderrTail)
            ? ' CUDA 12.6 is incompatible with glibc 2.43. Install CUDA 13.x once: sudo apt-get install -y cuda-toolkit-13-5, then press Build again.'
            : ''
        throw new GenVideoError('candle-build-failed', `${tail}${hint}`, { status: 500 })
      }

      ctx.phase('verifying', 'Checking the built binary')
      const binary = join(repoDir, 'target', 'release', 'examples', 'ltx-video')
      if (!existsSync(binary)) throw new GenVideoError('candle-binary-missing', `Build finished but ${binary} is missing`, { status: 500 })
      await this.updateSettings({ deps: { ...this.settings.deps, candleBinary: binary } })
      ctx.progress({ percent: 100, message: `candle-video built at ${binary}` })
    })
    return job
  }


  /** RU: Обзор популярных text-to-video моделей Hugging Face (по 10 на страницу,
   *      сортировка по оценке VRAM). EN: Overview of popular Hugging Face
   *      text-to-video models (10 per page, sorted by estimated VRAM). */
  async exploreModels(page = 1): Promise<ExplorePage> {
    const token = process.env[this.settings.hf.tokenEnv] || process.env.HF_TOKEN || ''
    return fetchExploreModels({ page, pageSize: 10, token, proxy: this.settings.proxy })
  }

  /** RU: Доступность раннеров для выбранной модели. EN: Runner availability for the selected model. */
  async runnerMatrix(modelId?: string): Promise<Array<{ id: RunnerId; available: boolean; reason: string | null; hint: string | null }>> {
    const settings = this.settings
    const model = findModel(modelId ?? settings.modelId, settings.customModels)
    if (!model) return []
    const variant = model.variants[0]
    if (!variant) return []
    return allAvailability({ settings, deps: await this.deps(), gpu: await this.gpu(), model, variant })
  }

  /** RU: Освобождает ресурсы. EN: Releases resources. */
  dispose(): void {
    this.jobs.dispose()
    this.listeners.clear()
  }
}

/** RU: Обёртка операций в ApiResult. EN: Wraps operations into ApiResult. */
export async function apiCall<T>(operation: () => Promise<T> | T): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: toApiError(error) }
  }
}

/** RU: Пресеты по умолчанию (для UI). EN: Default user directories (for UI). */
export function defaultDirs(): { models: string; videos: string } {
  return { models: defaultModelsDir(), videos: defaultVideosDir() }
}

/** RU: Путь к venv (для UI). EN: Venv path (for UI). */
export function venvPathForUi(): string {
  return venvDir()
}
