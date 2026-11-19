/** RU: Преобразует пользовательскую модель в запись реестра.
 *  EN: Converts a user model into a registry entry. */
export function customToEntry(custom) {
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
    };
}
/** RU: Встроенные модели. EN: Built-in models. */
export const BUILTIN_MODELS = [
    {
        id: 'sulphur-2-base',
        title: 'Sulphur 2 base',
        family: 'ltx-2',
        repo: 'SulphurAI/Sulphur-2-base',
        kind: 'ltx2-checkpoint',
        variants: [
            {
                id: 'fp8mixed',
                title: 'Dev fp8 mixed',
                files: ['sulphur_dev_fp8mixed.safetensors'],
                sizeGB: 29.16,
                precision: 'fp8',
            },
            {
                id: 'bf16',
                title: 'Dev bf16',
                files: ['sulphur_dev_bf16.safetensors'],
                sizeGB: 46.14,
                precision: 'bf16',
            },
            {
                id: 'distill-lora',
                title: 'Distill LoRA 1.1',
                files: ['distill_loras/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors'],
                sizeGB: 0.66,
                precision: 'lora',
            },
        ],
        runtimes: ['comfyui', 'command'],
        capabilities: { t2v: true, i2v: true, v2v: true, audio: true },
        durationSec: { min: 6, max: 20, recommended: 10 },
        fps: [24, 25, 48, 50],
        width: 1280,
        height: 720,
        vramGB: { min: 24, recommended: 40 },
        maxPromptChars: 4000,
        encoder: { name: 'LTX-2 Gemma', sizeGB: null, format: 'external', note: 'Gemma text encoder and LTX-2 pipelines are not bundled.' },
        releasedAt: '2026-05-03',
        license: 'LTX-2 Community License',
        notes: '22B DiT based on Lightricks/LTX-2.3. Needs the LTX-2 Gemma text encoder and LTX-2 pipelines or a ComfyUI workflow; diffusers support for LTX-2.3 is not released yet.',
        extraFiles: [],
        knownRevision: 'main',
    },
    {
        id: 'ltx-0.9.8-2b-distilled',
        title: 'LTX-Video 0.9.8 2B distilled',
        family: 'ltx-video',
        repo: 'oxide-lab/LTX-Video-0.9.8-2B-distilled',
        kind: 'candle-ltxv',
        variants: [
            {
                id: 'unified',
                title: 'Unified DiT + T5 Q5',
                files: [
                    'ltxv-2b-0.9.8-distilled.safetensors',
                    'text_encoder_gguf/t5-v1_1-xxl-encoder-Q5_K_M.gguf',
                    'text_encoder_gguf/tokenizer.json',
                ],
                sizeGB: 9.73,
                precision: 'bf16 + Q5',
            },
        ],
        runtimes: ['candle', 'command'],
        capabilities: { t2v: true, i2v: false, v2v: false, audio: false },
        durationSec: { min: 1, max: 10.7, recommended: 4 },
        fps: [24],
        width: 768,
        height: 512,
        vramGB: { min: 10, recommended: 12 },
        maxPromptChars: 2000,
        encoder: { name: 'T5-XXL', sizeGB: 3.4, format: 'GGUF Q5', note: 'Bundled in the 9.73 GB Candle weights.' },
        releasedAt: '2026-01-09',
        license: 'LTX-Video license (other)',
        notes: 'Rust/Candle implementation. 7 steps, CFG 1. Default size 512x768, 97 frames (8n+1 frames). Text-to-video only in this repository.',
        extraFiles: [],
        knownRevision: 'main',
    },
    {
        id: 'ltx-video-2b-0.9.8',
        title: 'LTX-Video 0.9.8 2B (diffusers, i2v)',
        family: 'ltx-video',
        repo: 'Lightricks/LTX-Video',
        kind: 'diffusers-ltxv',
        variants: [
            {
                id: 'distilled',
                title: '2B distilled 0.9.8',
                files: ['ltxv-2b-0.9.8-distilled.safetensors'],
                sizeGB: 6.34,
                precision: 'bf16',
            },
        ],
        runtimes: ['diffusers', 'command'],
        capabilities: { t2v: true, i2v: true, v2v: false, audio: false },
        durationSec: { min: 1, max: 10.7, recommended: 4 },
        fps: [24],
        width: 768,
        height: 512,
        vramGB: { min: 8, recommended: 12 },
        maxPromptChars: 2000,
        encoder: { name: 'T5-XXL', sizeGB: 9.5, format: 'bf16 (19 GB fp32 download)', note: 'Reference pipeline components are downloaded separately on first run.' },
        releasedAt: '2024-10-31',
        license: 'LTX-Video license (other)',
        notes: 'The official diffusers checkpoint is a single safetensors file: the worker loads the reference pipeline repository and swaps the transformer weights, which enables image-to-video.',
        extraFiles: [],
        fallbackRepo: 'Lightricks/LTX-Video',
        knownRevision: 'main',
    },
];
/** RU: Все модели: встроенные + пользовательские из настроек.
 *  EN: All models: built-ins plus custom ones from settings. */
export function allModels(custom = []) {
    const byId = new Map();
    for (const entry of BUILTIN_MODELS)
        byId.set(entry.id, entry);
    for (const entry of custom)
        byId.set(entry.id, customToEntry(entry));
    return Array.from(byId.values());
}
/** RU: Поиск модели по id. EN: Find a model by id. */
export function findModel(id, custom = []) {
    return allModels(custom).find((entry) => entry.id === id) ?? null;
}
/** RU: Вариант модели по id или вариант по умолчанию.
 *  EN: Model variant by id or the default variant. */
export function findVariant(entry, variantId) {
    if (!entry.variants.length)
        return null;
    if (!variantId)
        return entry.variants[0] ?? null;
    return entry.variants.find((variant) => variant.id === variantId) ?? null;
}
/** RU: Поддерживаемые разрешения для нативного кадра (кратны 32).
 *  EN: Supported native frame sizes (multiples of 32). */
export function isNativeSize(width, height) {
    return width % 32 === 0 && height % 32 === 0 && width >= 64 && height >= 64;
}
/** RU: Приводит число кадров к 8n+1. EN: Snaps a frame count to 8n+1. */
export function snapFrames(frames, min = 9, max = 257) {
    const clamped = Math.min(max, Math.max(min, Math.round(frames)));
    const remainder = (clamped - 1) % 8;
    const snapped = remainder === 0 ? clamped : clamped + (8 - remainder);
    return Math.min(max, snapped);
}
/** RU: Человекочитаемый размер. EN: Human-readable size. */
export function formatGB(gb) {
    if (!Number.isFinite(gb) || gb <= 0)
        return '0 GB';
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}
