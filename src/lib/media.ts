/**
 * RU: Медиа-слой: ffprobe, перекодирование, лимит размера, склейка, извлечение
 *     последнего кадра. Все функции принимают AbortSignal и отдают прогресс
 *     в процентах, чтобы UI показывал реальную фазу, а не бегунок.
 * EN: Media layer: ffprobe, transcoding, size limits, concatenation, last-frame
 *     extraction. Every function accepts an AbortSignal and reports percentage
 *     progress so the UI shows a real phase instead of an indeterminate spinner.
 */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FitMode, OutputFormat, QualityTier, TranscodeOptions, VideoCodec, VideoEncoder } from './types.js'
import { GenVideoError } from './errors.js'
import { runCommand, runStreaming } from './proc.js'

/** RU: Нормализованные метаданные видео. EN: Normalized video metadata. */
export interface MediaInfo {
  path: string
  bytes: number
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  formatName: string
}

/** RU: Нормализованные настройки транскода. EN: Normalized transcode settings. */
export interface NormalizedTranscode {
  mode: 'quality' | 'size'
  quality: QualityTier
  targetSizeMB: number
  format: OutputFormat
  width: number
  height: number
  fps: number
  fit: FitMode
  /** RU: Кодек MP4. EN: MP4 codec. */
  codec: VideoCodec
  /** RU: Выбранный энкодер. EN: Selected encoder. */
  encoder: VideoEncoder
  /** RU: Видео-битрейт для режима size. EN: Video bitrate for size mode. */
  videoKbps: number | null
}

/** RU: Пресеты качества. EN: Quality presets. */
export const QUALITY_PRESETS: Record<QualityTier, { crf: number; preset: string }> = {
  high: { crf: 18, preset: 'slow' },
  medium: { crf: 23, preset: 'medium' },
  compressed: { crf: 28, preset: 'veryfast' },
}

/** RU: Битрейты для Vulkan Video (он не умеет CRF).
 *  EN: Bitrates for Vulkan Video (it does not support CRF). */
const VULKAN_BITRATES: Record<QualityTier, string> = {
  high: '12M',
  medium: '6M',
  compressed: '2M',
}

/** RU: Какой кодек использовать для формата и энкодера.
 *  EN: Which codec to use for a format and encoder. */
export function videoCodecFor(format: OutputFormat, encoder: VideoEncoder, codec: VideoCodec = 'h264'): { codec: string; hardware: boolean } {
  if (format === 'webm') return { codec: 'libvpx-vp9', hardware: false }
  if (format === 'gif') return { codec: 'libx264', hardware: false }
  if (codec === 'h265') {
    if (encoder === 'vulkan') return { codec: 'hevc_vulkan', hardware: true }
    if (encoder === 'nvenc') return { codec: 'hevc_nvenc', hardware: true }
    return { codec: 'libx265', hardware: false }
  }
  if (encoder === 'vulkan') return { codec: 'h264_vulkan', hardware: true }
  if (encoder === 'nvenc') return { codec: 'h264_nvenc', hardware: true }
  return { codec: 'libx264', hardware: false }
}

/** RU: Человекочитаемый размер. EN: Human-readable size. */
export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`
  return `${Math.round(value)} B`
}

/** RU: Разбор дроби fps ("24000/1001"). EN: Parse an fps fraction ("24000/1001"). */
export function parseFps(value: unknown, fallback = 24): number {
  const text = String(value ?? '').trim()
  if (!text || text === '0/0') return fallback
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number)
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return Math.round((num / den) * 1000) / 1000
    return fallback
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** RU: Разбор JSON ffprobe в MediaInfo. EN: Parse ffprobe JSON into MediaInfo. */
export function parseProbe(json: unknown, path = '', bytes = 0): MediaInfo {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const streams = Array.isArray(root.streams) ? (root.streams as Array<Record<string, unknown>>) : []
  const format = (root.format && typeof root.format === 'object' ? root.format : {}) as Record<string, unknown>
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const duration = Number(format.duration ?? video?.duration ?? audio?.duration ?? 0)
  return {
    path,
    bytes: bytes || Number(format.size ?? 0),
    durationSec: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    width: Number(video?.width ?? 0) || 0,
    height: Number(video?.height ?? 0) || 0,
    fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
    videoCodec: String(video?.codec_name ?? ''),
    audioCodec: audio ? String(audio.codec_name ?? 'audio') : null,
    formatName: String(format.format_name ?? ''),
  }
}

/** RU: ffprobe файла. EN: ffprobe a file. */
export async function probeFile(ffprobe: string, file: string): Promise<MediaInfo> {
  const result = await runCommand(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 30_000 },
  )
  if (result.code !== 0) {
    throw new GenVideoError('probe-failed', result.stderr.trim() || `ffprobe exited ${result.code}`)
  }
  let json: unknown = {}
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new GenVideoError('probe-failed', 'ffprobe returned invalid JSON')
  }
  const bytes = await stat(file).then((info) => info.size).catch(() => 0)
  return parseProbe(json, file, bytes)
}

/** RU: Битрейт видео под лимит размера. EN: Video bitrate for a size limit. */
export function bitrateForSize(targetMB: number, durationSec: number, audioKbps: number): number {
  const seconds = Math.max(0.5, durationSec)
  const totalKbps = (targetMB * 8 * 1024 * 0.95) / seconds
  return Math.max(0, Math.round(totalKbps - audioKbps))
}

/** RU: Минимально достижимый размер при текущей длительности.
 *  EN: Smallest achievable size for the duration. */
export function minSizeMB(durationSec: number): number {
  const seconds = Math.max(0.5, durationSec)
  const minKbps = 120 + 128
  return Math.ceil(((minKbps * seconds) / (8 * 1024)) * 100) / 100
}

/** RU: Проверяет и нормализует настройки транскода. Режим "quality" ИЛИ
 *     режим "size" — взаимоисключающие.
 *  EN: Validates and normalizes transcode settings. "quality" OR "size" mode —
 *     mutually exclusive. */
export function normalizeTranscode(raw: Partial<TranscodeOptions> | undefined, durationSec: number): NormalizedTranscode {
  const source = raw ?? {}
  const mode = source.mode === 'size' ? 'size' : 'quality'
  const format: OutputFormat = source.format === 'webm' || source.format === 'gif' ? source.format : 'mp4'
  const quality: QualityTier = source.quality === 'high' || source.quality === 'compressed' ? source.quality : 'medium'
  const targetSizeMB = Math.max(0.1, Number(source.targetSizeMB) || 0)
  const width = Math.max(0, Math.round(Number(source.width) || 0))
  const height = Math.max(0, Math.round(Number(source.height) || 0))
  const fps = Math.max(0, Math.round(Number(source.fps) || 0))
  const fit: FitMode = source.fit === 'cover' ? 'cover' : 'contain'
  const encoder: VideoEncoder = source.encoder === 'vulkan' || source.encoder === 'nvenc' ? source.encoder : source.encoder === 'cpu' ? 'cpu' : 'auto'
  const codec: VideoCodec = source.codec === 'h265' ? 'h265' : 'h264'

  if ((width > 0) !== (height > 0)) {
    throw new GenVideoError('bad-resolution', 'Width and height must be set together, or both left empty')
  }
  if (mode === 'size' && format === 'gif') {
    throw new GenVideoError('unsupported-mode', 'A size limit is not supported for GIF; use the quality mode')
  }

  let videoKbps: number | null = null
  if (mode === 'size') {
    const audioKbps = format === 'webm' ? 96 : 128
    if (targetSizeMB < minSizeMB(durationSec)) {
      throw new GenVideoError(
        'size-too-small',
        `A ${targetSizeMB} MB limit is below the minimum ${minSizeMB(durationSec)} MB for ${durationSec.toFixed(1)}s`,
        { details: { minimumMB: minSizeMB(durationSec) } },
      )
    }
    videoKbps = bitrateForSize(targetSizeMB, durationSec, audioKbps)
  }

  return { mode, quality, targetSizeMB, format, width, height, fps, fit, codec, encoder, videoKbps }
}

/** RU: Видео-фильтры масштабирования и частоты кадров.
 *  EN: Scale/pad/crop and frame-rate video filters. */
export function buildVideoFilters(options: { width: number; height: number; fps: number; fit: FitMode }): string[] {
  const filters: string[] = []
  if (options.fps > 0) filters.push(`fps=${options.fps}`)
  if (options.width > 0 && options.height > 0) {
    if (options.fit === 'cover') {
      filters.push(`scale=${options.width}:${options.height}:force_original_aspect_ratio=increase:force_divisible_by=2`)
      filters.push(`crop=${options.width}:${options.height}`)
    } else {
      filters.push(`scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`)
      filters.push(`pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:color=black`)
    }
  }
  return filters
}

/** RU: Апскейл видео: GPU (scale_cuda + NVENC) или CPU Lanczos.
 *  EN: Video upscale: GPU (scale_cuda + NVENC) or CPU Lanczos. */
export async function upscaleFile(input: {
  ffmpeg: string
  ffprobe: string
  source: string
  target: string
  width: number
  height: number
  mode: 'ewa' | 'cpu'
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<MediaInfo> {
  const info = await probeFile(input.ffprobe, input.source)
  const cpuFilter = `scale=${input.width}:${input.height}:flags=lanczos,unsharp=5:5:0.8:3:3:0.4`
  if (input.mode === 'ewa') {
    const ewaFilter = `libplacebo=w=${input.width}:h=${input.height}:upscaler=ewa_lanczos:downscaler=ewa_lanczos`
    try {
      await runFfmpeg(input.ffmpeg, [
        '-i', input.source,
        '-vf', ewaFilter,
        '-c:v', 'libx265', '-preset', 'medium', '-crf', '19', '-tag:v', 'hvc1',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', input.target,
      ], { durationSec: info.durationSec, signal: input.signal, onProgress: input.onProgress })
      return await probeFile(input.ffprobe, input.target)
    } catch (error) {
      if (input.signal?.aborted) throw error
    }
  }
  await runFfmpeg(input.ffmpeg, [
    '-i', input.source,
    '-vf', cpuFilter,
    '-c:v', 'libx265', '-preset', 'medium', '-crf', '19', '-tag:v', 'hvc1',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', input.target,
  ], { durationSec: info.durationSec, signal: input.signal, onProgress: input.onProgress })
  return await probeFile(input.ffprobe, input.target)
}

/** RU: Аргументы ffmpeg для прохода качества. EN: ffmpeg arguments for a quality pass. */
export function qualityArgs(options: NormalizedTranscode): string[] {
  const filters = buildVideoFilters(options)
  if (options.format === 'gif') {
    const chain = [...filters, 'fps=15', 'scale=720:-1:flags=lanczos', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer'].join(',')
    return ['-an', '-vf', chain, '-loop', '0']
  }
  const vf = filters.length ? ['-vf', filters.join(',')] : []
  if (options.format === 'webm') {
    return [...vf, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '96k']
  }
  const { codec, hardware } = videoCodecFor(options.format, options.encoder, options.codec)
  // RU: Аппаратные энкодеры требуют yuv420p; добавляем format в цепочку фильтров.
  // EN: Hardware encoders require yuv420p; append format to the filter chain.
  const hwFilters = hardware ? [...filters, 'format=yuv420p'] : filters
  const hwVf = hwFilters.length ? ['-vf', hwFilters.join(',')] : []
  const preset = QUALITY_PRESETS[options.quality]
  // RU: Apple/Safari ожидают hvc1 для HEVC в MP4. EN: Apple/Safari expect hvc1 for HEVC in MP4.
  const tag = options.codec === 'h265' ? ['-tag:v', 'hvc1'] : []
  if (codec === 'hevc_vulkan') {
    return [
      ...hwVf,
      '-c:v', 'hevc_vulkan',
      '-b:v', VULKAN_BITRATES[options.quality],
      '-pix_fmt', 'yuv420p',
      ...tag,
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
    ]
  }
  if (codec === 'hevc_nvenc') {
    return [
      ...hwVf,
      '-c:v', 'hevc_nvenc',
      '-preset', 'p5',
      '-cq', String(preset.crf),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      ...tag,
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
    ]
  }
  if (codec === 'libx265') {
    return [
      ...vf,
      '-c:v', 'libx265',
      '-preset', preset.preset,
      '-crf', String(preset.crf),
      '-pix_fmt', 'yuv420p',
      ...tag,
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
    ]
  }
  if (codec === 'h264_vulkan') {
    return [
      ...hwVf,
      '-c:v', 'h264_vulkan',
      '-b:v', VULKAN_BITRATES[options.quality],
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
    ]
  }
  if (codec === 'h264_nvenc') {
    return [
      ...hwVf,
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-cq', String(preset.crf),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k',
    ]
  }
  return [
    ...vf,
    '-c:v', 'libx264',
    '-preset', preset.preset,
    '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
  ]
}

/** RU: Аргументы 1-го/2-го прохода под лимит размера.
 *  EN: Arguments for pass 1/2 under a size limit. */
export function sizeArgs(options: NormalizedTranscode, pass: 1 | 2, passlog: string): string[] {
  const filters = buildVideoFilters(options)
  const vf = filters.length ? ['-vf', filters.join(',')] : []
  const bitrate = `${Math.max(80, options.videoKbps ?? 800)}k`
  if (options.format === 'webm') {
    const base = ['-c:v', 'libvpx-vp9', '-b:v', bitrate, '-row-mt', '1', '-pass', String(pass), '-passlogfile', passlog]
    return pass === 1 ? [...vf, ...base, '-an', '-f', 'null'] : [...vf, ...base, '-c:a', 'libopus', '-b:a', '96k']
  }
  const hevcTag = options.codec === 'h265' ? ['-tag:v', 'hvc1'] : []
  const base = [
    '-c:v', options.codec === 'h265' ? 'libx265' : 'libx264',
    '-preset', 'medium',
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', `${Math.max(160, (options.videoKbps ?? 800) * 2)}k`,
    '-pass', String(pass),
    '-passlogfile', passlog,
  ]
  return pass === 1 ? [...vf, ...base, '-an', '-f', 'null'] : [...vf, ...base, ...hevcTag, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
}

/** RU: Оценка размера результата. EN: Estimated output size. */
export function estimateOutputBytes(options: NormalizedTranscode, durationSec: number): number {
  if (options.mode === 'size') return Math.round(options.targetSizeMB * 1e6)
  const audio = options.format === 'gif' ? 0 : 128
  const crfKbps = options.format === 'webm' ? 700 : options.quality === 'high' ? 6000 : options.quality === 'medium' ? 3000 : 1200
  return Math.round(((crfKbps + audio) * 1000 * Math.max(0.5, durationSec)) / 8)
}

/** RU: Запускает ffmpeg и парсит `-progress pipe:1`.
 *  EN: Runs ffmpeg and parses `-progress pipe:1`. */
export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  options: { durationSec: number; signal?: AbortSignal; onProgress?: (percent: number) => void },
): Promise<void> {
  const duration = Math.max(0.1, options.durationSec)
  const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args]
  let lastEmitted = -1
  const result = await runStreaming(ffmpeg, fullArgs, {
    timeoutMs: 0,
    signal: options.signal,
    onLine: (line) => {
      const match = line.match(/^out_time_(?:us|ms)=(\d+)$/)
      if (!match) return
      const seconds = Number(match[1]) / 1e6
      const percent = Math.max(0, Math.min(99, Math.round((seconds / duration) * 100)))
      if (percent !== lastEmitted) {
        lastEmitted = percent
        options.onProgress?.(percent)
      }
    },
  })
  if (result.code !== 0) {
    const tail = result.stderrTail.trim().split('\n').slice(-3).join(' ')
    throw new GenVideoError('ffmpeg-failed', tail || `ffmpeg exited ${result.code}`)
  }
  options.onProgress?.(100)
}

/** RU: Перекодирует файл: режим качества или режим размера (2 прохода).
 *  EN: Transcodes a file: quality mode or size mode (two passes). */
export async function transcodeFile(input: {
  ffmpeg: string
  ffprobe: string
  source: string
  target: string
  transcode: Partial<TranscodeOptions> | undefined
  signal?: AbortSignal
  onProgress?: (percent: number, phase: 'transcoding_pass1' | 'transcoding_pass2') => void
}): Promise<MediaInfo> {
  const info = await probeFile(input.ffprobe, input.source)
  const options = normalizeTranscode(input.transcode, info.durationSec)
  await mkdir(dirname(input.target), { recursive: true })

  if (options.mode === 'quality' || options.format === 'gif') {
    const run = async (transcodeOptions: NormalizedTranscode) => {
      await runFfmpeg(input.ffmpeg, ['-i', input.source, ...qualityArgs(transcodeOptions), input.target], {
        durationSec: info.durationSec,
        signal: input.signal,
        onProgress: (percent) => input.onProgress?.(percent, 'transcoding_pass2'),
      })
    }
    try {
      await run(options)
    } catch (error) {
      // RU: Vulkan/NVENC может быть объявлен, но не работать (нет ICD/драйвера).
      //     Повторяем на libx264, чтобы транскод не падал целиком.
      // EN: Vulkan/NVENC may be advertised but unusable (no ICD/driver). Retry
      //     with libx264 so the transcode does not fail completely.
      if (!(options.format === 'mp4' && (options.encoder === 'vulkan' || options.encoder === 'nvenc'))) throw error
      input.onProgress?.(0, 'transcoding_pass2')
      await run({ ...options, encoder: 'cpu' })
    }
    return probeFile(input.ffprobe, input.target)
  }

  const passlog = join(dirname(input.target), `.pass-${randomUUID().slice(0, 8)}`)
  let factor = 1
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptOptions: NormalizedTranscode = {
      ...options,
      targetSizeMB: options.targetSizeMB * factor,
      videoKbps: Math.max(80, Math.round((options.videoKbps ?? 800) * factor)),
    }
    await runFfmpeg(input.ffmpeg, ['-i', input.source, ...sizeArgs(attemptOptions, 1, passlog), '/dev/null'], {
      durationSec: info.durationSec,
      signal: input.signal,
      onProgress: (percent) => input.onProgress?.(Math.round(percent * 0.1), 'transcoding_pass1'),
    })
    await runFfmpeg(input.ffmpeg, ['-i', input.source, ...sizeArgs(attemptOptions, 2, passlog), input.target], {
      durationSec: info.durationSec,
      signal: input.signal,
      onProgress: (percent) => input.onProgress?.(10 + Math.round(percent * 0.9), 'transcoding_pass2'),
    })
    const size = await stat(input.target).then((item) => item.size).catch(() => 0)
    if (size <= options.targetSizeMB * 1e6 * 1.02) break
    factor *= 0.88
  }
  // RU: ffmpeg оставляет несколько passlog-файлов (.log, .log.mbtree) —
  //     удаляем всё с этим префиксом, чтобы не мусорить в Videos/.
  // EN: ffmpeg leaves several passlog files (.log, .log.mbtree) — remove every
  //     file with that prefix so Videos/ stays clean.
  const passBase = basename(passlog)
  const passDir = dirname(passlog)
  const leftovers = await readdir(passDir).catch(() => [] as string[])
  for (const entry of leftovers) {
    if (entry.startsWith(passBase)) await unlink(join(passDir, entry)).catch(() => undefined)
  }
  return probeFile(input.ffprobe, input.target)
}

/** RU: Можно ли склеить файлы без перекодирования. EN: Whether direct concat is safe. */
export function canConcatDirectly(items: MediaInfo[]): boolean {
  if (items.length < 2) return false
  const first = items[0]
  if (!first) return false
  return items.every(
    (item) =>
      item.width === first.width &&
      item.height === first.height &&
      Math.abs(item.fps - first.fps) < 0.01 &&
      item.videoCodec === first.videoCodec &&
      (item.audioCodec ? 'audio' : 'none') === (first.audioCodec ? 'audio' : 'none'),
  )
}

/** RU: Строка concat-файла ffmpeg. EN: ffmpeg concat-file line. */
function concatLine(file: string): string {
  return `file '${file.replace(/'/g, "'\\''")}'`
}

/** RU: Склеивает клипы, при необходимости нормализуя параметры.
 *  EN: Concatenates clips, normalizing parameters when needed. */
export async function concatFiles(input: {
  ffmpeg: string
  ffprobe: string
  sources: string[]
  target: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  forceNormalize?: boolean
}): Promise<MediaInfo> {
  if (!input.sources.length) throw new GenVideoError('no-inputs', 'No clips to merge')
  await mkdir(dirname(input.target), { recursive: true })
  if (input.sources.length === 1) {
    await writeFile(input.target, await readFile(input.sources[0] ?? ''))
    return probeFile(input.ffprobe, input.target)
  }

  const infos = await Promise.all(input.sources.map((source) => probeFile(input.ffprobe, source)))
  const direct = !input.forceNormalize && canConcatDirectly(infos)
  const workDir = join(dirname(input.target), `.concat-${randomUUID().slice(0, 8)}`)
  await mkdir(workDir, { recursive: true })
  const reference = infos[0]
  const anyAudio = infos.some((item) => Boolean(item.audioCodec))
  const normalized: string[] = []

  for (let index = 0; index < input.sources.length; index += 1) {
    const source = input.sources[index] ?? ''
    const info = infos[index]
    if (!info) continue
    if (direct) {
      normalized.push(source)
      continue
    }
    const out = join(workDir, `norm-${index}.mp4`)
    const args = ['-i', source]
    if (anyAudio && !info.audioCodec) {
      // RU: Выравниваем наличие аудио, добавляя тишину. EN: Equalize audio presence with silence.
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
    }
    const filters = [
      `scale=${reference?.width ?? info.width}:${reference?.height ?? info.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${reference?.width ?? info.width}:${reference?.height ?? info.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${reference?.fps ?? info.fps}`,
    ].join(',')
    args.push('-vf', filters, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p')
    if (anyAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
    args.push(out)
    await runFfmpeg(input.ffmpeg, args, {
      durationSec: info.durationSec,
      signal: input.signal,
      onProgress: (percent) => input.onProgress?.(Math.round(((index + percent / 100) / input.sources.length) * 80)),
    })
    normalized.push(out)
  }

  const listFile = join(workDir, 'list.txt')
  await writeFile(listFile, `${normalized.map(concatLine).join('\n')}\n`, 'utf8')
  await runFfmpeg(
    input.ffmpeg,
    ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', input.target],
    {
      durationSec: infos.reduce((acc, item) => acc + item.durationSec, 0),
      signal: input.signal,
      onProgress: (percent) => input.onProgress?.(80 + Math.round(percent * 0.2)),
    },
  )
  return probeFile(input.ffprobe, input.target)
}

/** RU: Склейка трёх сегментов с crossfade 1с, EWA Lanczos и H.265 в одном проходе.
 *  EN: Three-segment crossfade, EWA Lanczos and H.265 in one pass. */
export async function crossfadeUpscaleEncode(input: {
  ffmpeg: string
  ffprobe: string
  sources: string[]
  target: string
  width: number
  height: number
  fps: number
  overlapSec?: number
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<MediaInfo> {
  if (input.sources.length !== 3) throw new GenVideoError('crossfade-needs-three', 'Crossfade assembly expects exactly three segments')
  const infos = await Promise.all(input.sources.map((source) => probeFile(input.ffprobe, source)))
  for (const info of infos) {
    if (Math.abs(info.durationSec - 4) > 0.25) throw new GenVideoError('segment-invalid', `Segment duration ${info.durationSec.toFixed(2)}s is not 4s`)
  }
  const overlap = Math.max(0.1, Math.min(1, input.overlapSec ?? 1))
  const offset1 = 4 - overlap
  const offset2 = 8 - overlap * 2
  const total = 12 - overlap * 2
  const run = async (edgeFilter: string): Promise<MediaInfo> => {
    const filters = [
      '[0:v]fps=' + input.fps + ',settb=AVTB,setpts=PTS-STARTPTS[v0]',
      '[1:v]fps=' + input.fps + ',settb=AVTB,setpts=PTS-STARTPTS[v1]',
      '[2:v]fps=' + input.fps + ',settb=AVTB,setpts=PTS-STARTPTS[v2]',
      `[v0][v1]xfade=transition=fade:duration=${overlap}:offset=${offset1}[x1]`,
      `[x1][v2]xfade=transition=fade:duration=${overlap}:offset=${offset2}[x2]`,
      `[x2]${edgeFilter},trim=0:${total},setpts=PTS-STARTPTS,format=yuv420p[v]`,
    ].join(';')
    await runFfmpeg(input.ffmpeg, [
      '-i', input.sources[0]!, '-i', input.sources[1]!, '-i', input.sources[2]!,
      '-filter_complex', filters, '-map', '[v]', '-an',
      '-c:v', 'libx265', '-crf', '19', '-preset', 'medium',
      '-tag:v', 'hvc1', '-movflags', '+faststart', input.target,
    ], { durationSec: total, signal: input.signal, onProgress: input.onProgress })
    return await probeFile(input.ffprobe, input.target)
  }
  try {
    return await run(`libplacebo=w=${input.width}:h=${input.height}:upscaler=ewa_lanczos:downscaler=ewa_lanczos`)
  } catch (error) {
    if (input.signal?.aborted) throw error
    return await run(`scale=${input.width}:${input.height}:flags=lanczos`)
  }
}

/** RU: Добавляет аудиодорожку к готовому видео без перекодирования видео.
 *  EN: Muxes an audio track without re-encoding video. */
export async function muxAudio(input: {
  ffmpeg: string
  ffprobe: string
  video: string
  audio?: string
  target: string
  durationSec: number
  signal?: AbortSignal
}): Promise<MediaInfo> {
  const args = ['-i', input.video]
  if (input.audio) args.push('-i', input.audio)
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  args.push(
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'apad',
    '-t', String(input.durationSec), '-movflags', '+faststart', input.target,
  )
  await runFfmpeg(input.ffmpeg, args, { durationSec: input.durationSec, signal: input.signal })
  return await probeFile(input.ffprobe, input.target)
}

/** RU: Извлекает последний кадр для continuity в i2v. EN: Extracts the last frame for i2v continuity. */
export async function extractLastFrame(ffmpeg: string, ffprobe: string, source: string, target: string): Promise<void> {
  const info = await probeFile(ffprobe, source)
  const last = Math.max(0, Math.round(info.durationSec * info.fps) - 1)
  const result = await runCommand(
    ffmpeg,
    ['-hide_banner', '-y', '-i', source, '-vf', `select=eq(n\\,${last})`, '-frames:v', '1', '-q:v', '2', target],
    { timeoutMs: 60_000 },
  )
  if (result.code !== 0) {
    throw new GenVideoError('frame-extract-failed', result.stderr.trim().split('\n').slice(-2).join(' '))
  }
}

/** RU: Генерирует синтетический клип для Mock-раннера и тестов.
 *  EN: Generates a synthetic clip for the Mock runner and tests. */
export async function synthesizeClip(input: {
  ffmpeg: string
  target: string
  width: number
  height: number
  fps: number
  durationSec: number
  seed: number
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<void> {
  const palette = ['0x1f6feb', '0x2ea043', '0xd29922', '0xdb6d28', '0x8957e5', '0xcf222e']
  const color = palette[Math.abs(input.seed) % palette.length] ?? palette[0]
  await mkdir(dirname(input.target), { recursive: true })
  await runFfmpeg(
    input.ffmpeg,
    [
      '-f', 'lavfi',
      '-i', `color=c=${color}:s=${input.width}x${input.height}:r=${input.fps}:d=${input.durationSec}`,
      '-f', 'lavfi',
      '-i', `testsrc2=s=${input.width}x${input.height}:r=${input.fps}:d=${input.durationSec}`,
      '-filter_complex', '[0:v][1:v]blend=all_mode=overlay:all_opacity=0.18,vignette=PI/5[v]',
      '-map', '[v]',
      '-t', String(input.durationSec),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      input.target,
    ],
    { durationSec: input.durationSec, signal: input.signal, onProgress: input.onProgress },
  )
}
