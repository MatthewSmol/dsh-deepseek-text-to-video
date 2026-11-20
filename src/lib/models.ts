/**
 * RU: Реестр моделей. Встроенные модели описывают возможности, размеры,
 *     требования к VRAM и способ запуска; пользователь может добавить свою.
 *     Проверка ревизий и загрузка весов — в downloads.ts.
 * EN: Model registry. Built-in entries describe capabilities, sizes, VRAM
 *     requirements and how to run; the user may add custom entries. Revision
 *     checks and weight downloads live in downloads.ts.
 */
import type { CustomModel, ModelEntry } from './types.js'

/** RU: Преобразует пользовательскую модель в запись реестра.
 *  EN: Converts a user model into a registry entry. */
export function customToEntry(custom: CustomModel): ModelEntry {
  return {
    id: custom.id,
    title: custom.title || custom.id,
    family: 'custom',
    repo: custom.repo,
    kind: 'custom',
    variants: [
      {
        id: 'custom',
        title: 'Custom weights',
        files: custom.files,
        sizeGB: custom.sizeGB,
        precision: 'custom',
      },
    ],
    runtimes: [custom.runtime],
    capabilities: { t2v: true, i2v: custom.supportsImage, v2v: custom.supportsVideo, audio: false },
    durationSec: { min: 1, max: Math.max(1, custom.durationSec), recommended: Math.max(1, custom.durationSec) },
    fps: [custom.fps],
    width: custom.width,
    height: custom.height,
    vramGB: { min: custom.vramGB, recommended: custom.vramGB },
    maxPromptChars: 4000,
    license: 'custom',
    notes: 'User-defined model. The command template and runner are configured in the plugin settings.',
    extraFiles: [],
  }
}

/** RU: Встроенные модели. EN: Built-in models. */
export const BUILTIN_MODELS: ModelEntry[] = [
  {
    id: 'comfyui-workflow',
    title: 'Wan 2.2 TI2V-5B Q4_K_M',
    family: 'wan-video',
    repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF',
    kind: 'comfyui-workflow',
    variants: [{
      id: 'q4',
      title: 'Q4_K_M + UMT5 + Wan VAE',
      files: [
        'diffusion_models/Wan2.2-TI2V-5B-Q4_K_M.gguf',
        'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        'vae/wan2.2_vae.safetensors',
      ],
      sizeGB: 11.57,
      precision: 'Q4_K_M',
    }],
    runtimes: ['comfyui'],
    capabilities: { t2v: true, i2v: true, v2v: true, audio: false },
    durationSec: { min: 4, max: 4, recommended: 4 },
    fps: [24],
    width: 864,
    height: 480,
    vramGB: { min: 8, recommended: 8 },
    maxPromptChars: 4000,
    license: 'Apache-2.0 (Wan 2.2)',
    notes: 'Single local model. Native 480p, 4s, 97 frames at 24fps. V2V is keyframe-guided I2V only.',
    encoder: { name: 'Wan 2.2 TI2V-5B', sizeGB: 11.57, format: 'GGUF Q4_K_M' },
    extraFiles: [],
  },
]

/** RU: Все модели: встроенные + пользовательские из настроек.
 *  EN: All models: built-ins plus custom ones from settings. */
export function allModels(custom: CustomModel[] = []): ModelEntry[] {
  const byId = new Map<string, ModelEntry>()
  for (const entry of BUILTIN_MODELS) byId.set(entry.id, entry)
  for (const entry of custom) byId.set(entry.id, customToEntry(entry))
  return Array.from(byId.values())
}

/** RU: Поиск модели по id. EN: Find a model by id. */
export function findModel(id: string, custom: CustomModel[] = []): ModelEntry | null {
  return allModels(custom).find((entry) => entry.id === id) ?? null
}

/** RU: Вариант модели по id или вариант по умолчанию.
 *  EN: Model variant by id or the default variant. */
export function findVariant(entry: ModelEntry, variantId?: string): ModelEntry['variants'][number] | null {
  if (!entry.variants.length) return null
  if (!variantId) return entry.variants[0] ?? null
  return entry.variants.find((variant) => variant.id === variantId) ?? null
}

/** RU: Поддерживаемые разрешения для нативного кадра (кратны 32).
 *  EN: Supported native frame sizes (multiples of 32). */
export function isNativeSize(width: number, height: number): boolean {
  return width % 32 === 0 && height % 32 === 0 && width >= 64 && height >= 64
}

/** RU: Приводит число кадров к 8n+1. EN: Snaps a frame count to 8n+1. */
export function snapFrames(frames: number, min = 9, max = 257): number {
  const clamped = Math.min(max, Math.max(min, Math.round(frames)))
  const remainder = (clamped - 1) % 8
  const snapped = remainder === 0 ? clamped : clamped + (8 - remainder)
  return Math.min(max, snapped)
}

/** RU: Человекочитаемый размер. EN: Human-readable size. */
export function formatGB(gb: number): string {
  if (!Number.isFinite(gb) || gb <= 0) return '0 GB'
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}
