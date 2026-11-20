/**
 * RU: Настройки GenVideo: значения по умолчанию, санитайзинг и атомарное
 *     сохранение в `GENVIDEO_HOME/settings.json`. Настройки — единственный
 *     источник пользовательских предпочтений; задания и логи живут отдельно.
 * EN: GenVideo settings: defaults, sanitizing and atomic persistence in
 *     `GENVIDEO_HOME/settings.json`. Settings are the only source of user
 *     preferences; jobs and logs live separately.
 */
import { join } from 'node:path';
import { defaultModelsDir, defaultVideosDir, readJsonFile, settingsFile, writeJsonAtomic } from './paths.js';
/** RU: Значения по умолчанию. EN: Default values. */
export const DEFAULT_SETTINGS = {
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
    upscale: 'ewa',
    upscaler: '2xNomosUni_span_multijpg.safetensors',
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
        comfyuiGpu: -1,
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
};
/** RU: Число в диапазоне. EN: Number within a range. */
function num(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
/** RU: Целое в диапазоне. EN: Integer within a range. */
function int(value, min, max, fallback) {
    return Math.round(num(value, min, max, fallback));
}
/** RU: Строка из допустимого набора. EN: One of an allowed set. */
function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}
/** RU: Логическое значение. EN: Boolean value. */
function bool(value, fallback = false) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    return fallback;
}
/** RU: Строка с обрезкой и лимитом. EN: Trimmed, length-capped string. */
function str(value, max, fallback = '') {
    if (typeof value !== 'string')
        return fallback;
    return value.slice(0, max);
}
/** RU: Приводит произвольный объект к валидным настройкам.
 *  EN: Coerces an arbitrary object into valid settings. */
/** RU: Принимает socks5://host:port, socks5h://... или host:port.
 *  EN: Accepts socks5://host:port, socks5h://... or host:port. */
export function sanitizeProxyUrl(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text)
        return '';
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`;
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:')
            return '';
        if (!url.hostname || !url.port)
            return '';
        return candidate.slice(0, 300);
    }
    catch {
        return '';
    }
}
export function sanitizeSettings(raw) {
    const source = (raw && typeof raw === 'object' ? raw : {});
    const transcodeRaw = (source.transcode && typeof source.transcode === 'object' ? source.transcode : {});
    const gpuRaw = (source.gpu && typeof source.gpu === 'object' ? source.gpu : {});
    const proxyRaw = (source.proxy && typeof source.proxy === 'object' ? source.proxy : {});
    const depsRaw = (source.deps && typeof source.deps === 'object' ? source.deps : {});
    const runnersRaw = (source.runners && typeof source.runners === 'object' ? source.runners : {});
    const retentionRaw = (source.retention && typeof source.retention === 'object' ? source.retention : {});
    const hfRaw = (source.hf && typeof source.hf === 'object' ? source.hf : {});
    const gpuIds = Array.isArray(gpuRaw.ids)
        ? Array.from(new Set(gpuRaw.ids.map((id) => Math.trunc(Number(id))).filter((id) => Number.isFinite(id) && id >= 0))).slice(0, 16)
        : [];
    const customModels = Array.isArray(source.customModels)
        ? source.customModels
            .filter((item) => Boolean(item) && typeof item === 'object')
            .slice(0, 50)
            .map((item, index) => ({
            id: str(item.id, 64, `custom-${index + 1}`) || `custom-${index + 1}`,
            title: str(item.title, 120, 'Custom model'),
            repo: str(item.repo, 200, ''),
            runtime: oneOf(item.runtime, ['mock', 'diffusers', 'candle', 'comfyui', 'command'], 'command'),
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
        : [];
    return {
        language: oneOf(source.language, ['en', 'ru'], 'en'),
        outputDir: str(source.outputDir, 1000, ''),
        modelsDir: str(source.modelsDir, 1000, ''),
        modelId: str(source.modelId, 120, DEFAULT_SETTINGS.modelId) || DEFAULT_SETTINGS.modelId,
        variant: str(source.variant, 120, ''),
        platform: oneOf(source.platform, ['reels', 'shorts', 'youtube', 'youtube4k', 'cinema', 'square', 'portrait45', 'custom'], 'youtube'),
        aspect: oneOf(source.aspect, ['16:9', '9:16', '1:1', '4:5', '3:4', 'custom'], '16:9'),
        width: int(source.width, 64, 4096, 1280),
        height: int(source.height, 64, 4096, 720),
        fps: int(source.fps, 1, 120, 30),
        clipSec: num(source.clipSec, 0.5, 120, 9),
        targetDurationSec: num(source.targetDurationSec, 0.5, 600, 60),
        steps: int(source.steps, 0, 200, 0),
        guidance: num(source.guidance, 0, 30, 0),
        negativePrompt: str(source.negativePrompt, 4000, ''),
        seed: int(source.seed, -1, 2_147_483_647, -1),
        continuity: oneOf(source.continuity, ['none', 'last-frame'], 'none'),
        promptMode: oneOf(source.promptMode, ['split', 'full', 'shots'], 'shots'),
        orientation: oneOf(source.orientation, ['landscape', 'portrait'], 'landscape'),
        denoise: Math.min(0.8, Math.max(0.3, Number(source.denoise) || 0.6)),
        upscale: oneOf(source.upscale, ['ewa', 'off'], 'ewa'),
        upscaler: str(source.upscaler, 500, '2xNomosUni_span_multijpg.safetensors'),
        transcode: {
            enabled: bool(transcodeRaw.enabled, true),
            mode: oneOf(transcodeRaw.mode, ['quality', 'size'], 'quality'),
            quality: oneOf(transcodeRaw.quality, ['high', 'medium', 'compressed'], 'high'),
            targetSizeMB: num(transcodeRaw.targetSizeMB, 0.1, 20_000, 25),
            format: oneOf(transcodeRaw.format, ['mp4', 'webm', 'gif'], 'mp4'),
            codec: oneOf(transcodeRaw.codec, ['h264', 'h265'], 'h265'),
            encoder: oneOf(transcodeRaw.encoder, ['auto', 'cpu', 'vulkan', 'nvenc'], 'nvenc'),
            width: int(transcodeRaw.width, 0, 4096, 0),
            height: int(transcodeRaw.height, 0, 4096, 0),
            fps: int(transcodeRaw.fps, 0, 120, 0),
            fit: oneOf(transcodeRaw.fit, ['contain', 'cover'], 'contain'),
        },
        proxy: {
            enabled: bool(proxyRaw.enabled, false),
            url: sanitizeProxyUrl(proxyRaw.url),
        },
        gpu: {
            ids: gpuIds,
            strategy: oneOf(gpuRaw.strategy, ['single', 'round-robin', 'tensor-parallel'], 'single'),
            vramBudgetGB: num(gpuRaw.vramBudgetGB, 0, 1024, 0),
        },
        deps: {
            ffmpegPath: str(depsRaw.ffmpegPath, 1000, ''),
            ffprobePath: str(depsRaw.ffprobePath, 1000, ''),
            pythonPath: str(depsRaw.pythonPath, 1000, ''),
            candleBinary: str(depsRaw.candleBinary, 1000, ''),
            candleArgs: Array.isArray(depsRaw.candleArgs)
                ? depsRaw.candleArgs.filter((arg) => typeof arg === 'string' && arg.length > 0).slice(0, 32).map((arg) => arg.slice(0, 500))
                : [],
            comfyuiUrl: str(depsRaw.comfyuiUrl, 1000, ''),
            comfyuiAutoStart: bool(depsRaw.comfyuiAutoStart, false),
            comfyuiDir: str(depsRaw.comfyuiDir, 1000, ''),
            comfyuiGpu: int(depsRaw.comfyuiGpu, -1, 15, -1),
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
    };
}
/** RU: Разрешённые пути моделей и видео. EN: Resolved models and videos paths. */
export function resolveDirs(settings) {
    return {
        modelsDir: settings.modelsDir ? settings.modelsDir : defaultModelsDir(),
        videosDir: settings.outputDir ? settings.outputDir : defaultVideosDir(),
    };
}
/** RU: Хранилище настроек процесса. EN: Process-level settings store. */
export class SettingsStore {
    state;
    chain = Promise.resolve();
    file;
    constructor(file = settingsFile()) {
        this.file = file;
        this.state = sanitizeSettings(readJsonFile(this.file, {}));
    }
    /** RU: Копия текущих настроек. EN: Copy of current settings. */
    get() {
        return structuredClone(this.state);
    }
    /** RU: Глубокое слияние с последующим санитайзингом и записью.
     *  EN: Deep merge followed by sanitizing and persistence. */
    async update(patch) {
        const merged = { ...this.state };
        for (const [key, value] of Object.entries(patch || {})) {
            if (value === undefined)
                continue;
            if (value && typeof value === 'object' && !Array.isArray(value) && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
                merged[key] = { ...merged[key], ...value };
            }
            else {
                merged[key] = value;
            }
        }
        this.state = sanitizeSettings(merged);
        const snapshot = this.state;
        this.chain = this.chain.then(() => writeJsonAtomic(this.file, snapshot)).catch(() => undefined);
        await this.chain;
        return this.get();
    }
    /** RU: Сбрасывает настройки к значениям по умолчанию. EN: Resets to defaults. */
    async reset() {
        this.state = structuredClone(DEFAULT_SETTINGS);
        await writeJsonAtomic(this.file, this.state);
        return this.get();
    }
}
/** RU: Путь к файлу настроек (для диагностики). EN: Settings file path for diagnostics. */
export function settingsPath() {
    return settingsFile();
}
/** RU: Каталог моделей по настройкам. EN: Models directory from settings. */
export function modelsDirOf(settings) {
    return resolveDirs(settings).modelsDir;
}
/** RU: Каталог видео по настройкам. EN: Videos directory from settings. */
export function videosDirOf(settings) {
    return resolveDirs(settings).videosDir;
}
/** RU: Склеивает путь модели. EN: Joins a model path. */
export function modelPath(modelsDir, modelId, file) {
    return join(modelsDir, modelId, file);
}
