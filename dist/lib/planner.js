/** RU: Оценка VRAM: веса + активации, линейно по числу пикселей и кадров.
 *  EN: VRAM estimate: weights + activations, linear in pixels and frames. */
export function estimateVramGB(model, width, height, frames) {
    const reference = 768 * 512 * 97;
    const scale = Math.max(0.25, (width * height * frames) / reference);
    const weights = model.vramGB.min * 0.7;
    const activations = model.vramGB.min * 0.3 * scale;
    return Math.round((weights + activations) * 10) / 10;
}
/** RU: Оценка времени (секунды) для одного клипа.
 *  EN: Time estimate (seconds) for one clip. */
export function estimateSeconds(model, width, height, frames, steps) {
    const stepsEffective = steps > 0 ? steps : model.id.includes('distilled') ? 7 : 30;
    const pixels = (width * height) / (768 * 512);
    const framesScale = frames / 97;
    return Math.round(15 + 0.22 * stepsEffective * pixels * framesScale * 4);
}
/** RU: Число сегментов и их длительности. Каждый клип ≤ maxClip.
 *  EN: Segment count and durations. Every clip is ≤ maxClip. */
export function computeSegments(targetDurationSec, clipSec, maxClipSec) {
    const target = Math.max(0.5, Number(targetDurationSec) || 0.5);
    const clip = Math.min(Math.max(0.5, Number(clipSec) || 0.5), Math.max(0.5, maxClipSec));
    const count = Math.min(24, Math.max(1, Math.ceil(target / clip)));
    const base = target / count;
    const durations = Array.from({ length: count }, () => Math.round(base * 100) / 100);
    // RU: Остаток от округления добавляем последнему сегменту.
    // EN: Add the rounding remainder to the last segment.
    const sum = durations.reduce((acc, value) => acc + value, 0);
    const last = durations[count - 1] ?? base;
    durations[count - 1] = Math.round((last + (target - sum)) * 100) / 100;
    return durations;
}
/** RU: Делит промпт на части по предложениям/строкам, добивая якорями.
 *  EN: Splits a prompt into parts by sentences/lines, padding with anchors. */
export function splitPrompt(prompt, count) {
    const text = String(prompt || '').trim();
    const parts = text
        .split(/(?<=[.!?…])\s+|\n+/u)
        .map((part) => part.trim())
        .filter(Boolean);
    if (count <= 1)
        return [text];
    if (!parts.length)
        return Array.from({ length: count }, () => 'An empty scene');
    if (parts.length >= count) {
        // RU: Раскидываем предложения по сегментам, сохраняя порядок.
        // EN: Distribute sentences across segments while preserving order.
        return Array.from({ length: count }, (_, index) => {
            const from = Math.floor((index * parts.length) / count);
            const to = Math.max(from + 1, Math.floor(((index + 1) * parts.length) / count));
            return parts.slice(from, to).join(' ');
        });
    }
    const filled = [...parts];
    while (filled.length < count) {
        filled.push(`${parts[parts.length - 1]} (continues)`);
    }
    return filled;
}
/** RU: Собирает полный план. EN: Builds the full plan. */
export function planGeneration(input) {
    const { settings, model, gpu } = input;
    const warnings = [];
    const fps = input.fps && input.fps > 0 ? input.fps : model.fps[0] ?? 24;
    const width = input.width && input.width > 0 ? input.width : model.width;
    const height = input.height && input.height > 0 ? input.height : model.height;
    const target = Math.max(0.5, input.targetDurationSec ?? settings.targetDurationSec ?? model.durationSec.recommended);
    const clipRequested = input.clipSec ?? settings.clipSec ?? model.durationSec.recommended;
    const durations = computeSegments(target, clipRequested, model.durationSec.max);
    const parts = splitPrompt(input.prompt, durations.length);
    const segments = durations.map((durationSec, index) => ({
        index,
        durationSec,
        prompt: parts[index] ?? input.prompt,
    }));
    const totalSec = Math.round(segments.reduce((acc, segment) => acc + segment.durationSec, 0) * 100) / 100;
    const frames = Math.max(9, Math.round(segments[0]?.durationSec ?? 1) * fps + 1);
    const estimatedVramGB = estimateVramGB(model, width, height, frames);
    const selected = gpu.available ? gpu.gpus.filter((item) => !settings.gpu.ids.length || settings.gpu.ids.includes(item.index)) : [];
    const maxVram = selected.length
        ? Math.max(...selected.map((item) => item.totalMB / 1024))
        : 0;
    const budget = settings.gpu.vramBudgetGB > 0 ? settings.gpu.vramBudgetGB : maxVram;
    const vramFit = budget > 0 ? estimatedVramGB <= budget : false;
    if (!gpu.available) {
        warnings.push({ code: 'no-gpu', message: gpu.error || 'No CUDA GPU detected; only the Mock runner can produce output.' });
    }
    // RU: Карты видны из Windows, но CUDA в WSL не проброшена — реальный раннер
    //     почти наверняка упадёт, хотя VRAM для оценки известна.
    // EN: Cards are visible from Windows but CUDA is not passed through to WSL;
    //     the real runner will likely fail even though VRAM is known.
    if (gpu.available && gpu.source === 'windows') {
        warnings.push({ code: 'wsl-cuda-unavailable', message: 'GPUs were detected through the Windows driver, but WSL CUDA passthrough is unavailable. Real generation may fail until `wsl --shutdown` is run after a driver update.' });
    }
    if (!input.imageInput && model.capabilities.i2v) {
        warnings.push({ code: 'image-optional', message: 'This model also accepts a reference image (image-to-video).' });
    }
    if (!input.videoInput && model.capabilities.v2v) {
        warnings.push({ code: 'video-optional', message: 'This model can also be conditioned on an existing video clip.' });
    }
    if (width % 32 !== 0 || height % 32 !== 0) {
        warnings.push({ code: 'non-native-size', message: `Native ${model.title} sizes are multiples of 32; ${width}x${height} will be generated natively and fitted afterwards.` });
    }
    if (budget > 0 && !vramFit) {
        warnings.push({
            code: 'vram-exceeded',
            message: `Estimated ${estimatedVramGB} GB VRAM exceeds the ${Math.round(budget * 10) / 10} GB budget. Lower the resolution, the clip length, or enable an offload variant.`,
        });
    }
    if (target > model.durationSec.max) {
        warnings.push({
            code: 'segmented',
            message: `The model produces up to ${model.durationSec.max}s per clip; ${target}s will be generated as ${segments.length} segments and merged.`,
        });
    }
    return {
        modelId: model.id,
        modelTitle: model.title,
        capabilities: model.capabilities,
        runtimes: model.runtimes,
        availableRunner: input.runner,
        clipSec: segments[0]?.durationSec ?? target,
        segments,
        totalSec,
        width,
        height,
        fps,
        frames,
        estimatedVramGB,
        vramFit,
        gpuIds: selected.map((item) => item.index),
        estimatedSeconds: segments.reduce((acc, segment) => acc + estimateSeconds(model, width, height, Math.round(segment.durationSec * fps) + 1, settings.steps), 0),
        supportedDurationSec: { min: model.durationSec.min, max: model.durationSec.max },
        inputs: {
            image: model.capabilities.i2v,
            video: model.capabilities.v2v,
            audio: model.capabilities.audio,
        },
        transcode: {
            mode: (input.transcodeMode ?? input.settings.transcode?.mode ?? 'quality') === 'size' ? 'size' : 'quality',
            estimatedBytes: input.transcodeEstimatedBytes ?? null,
        },
        warnings,
    };
}
