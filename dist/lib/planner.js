/**
 * RU: Планирование генерации: сколько сегментов нужно, какие у них
 *     длительности и промпты, хватит ли VRAM и сколько это займёт. План
 *     объясняет пользователю «что модель может» до запуска.
 * EN: Generation planning: how many segments are needed, their durations and
 *     prompts, whether VRAM fits and how long it takes. The plan explains
 *     "what the model can do" before the run.
 */
import { GenVideoError } from './errors.js';
import { resolvePromptProfile, promptStats, promptSimilarity } from './prompt-profiles.js';
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
/** RU: Предельное число сегментов одного задания. EN: Maximum segments per job. */
export const MAX_SEGMENTS = 120;
/** RU: Число сегментов и их длительности. fixed — клипы полной длины и короткий
 *      последний; even — прежнее равномерное деление. Сумма всегда равна цели.
 *  EN: Segment count and durations. fixed keeps full-length clips and a short
 *      last one; even is the previous uniform split. The sum always equals target. */
export function computeSegments(targetDurationSec, clipSec, maxClipSec, mode = 'fixed') {
    const target = Math.max(0.5, Number(targetDurationSec) || 0.5);
    const maxClip = Math.max(0.5, Number(maxClipSec) || 10.7);
    const clip = Math.min(Math.max(0.5, Number(clipSec) || 0.5), maxClip);
    if (mode === 'even') {
        const count = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(target / clip)));
        const base = target / count;
        const durations = Array.from({ length: count }, () => Math.round(base * 100) / 100);
        const sum = durations.reduce((acc, value) => acc + value, 0);
        durations[count - 1] = Math.round(((durations[count - 1] ?? base) + (target - sum)) * 100) / 100;
        return durations;
    }
    let count = Math.max(1, Math.ceil(target / clip));
    let effective = clip;
    if (count > MAX_SEGMENTS) {
        count = MAX_SEGMENTS;
        effective = Math.max(clip, target / count);
    }
    const durations = Array.from({ length: count }, () => Math.round(effective * 100) / 100);
    let last = Math.round((target - effective * (count - 1)) * 100) / 100;
    if (count > 1 && last < 0.5) {
        durations.pop();
        last = Math.round((effective + last) * 100) / 100;
        durations[durations.length - 1] = last;
    }
    else {
        durations[count - 1] = last;
    }
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
/** RU: Собирает промпт для каждого клипа. Приоритет: явные segmentPrompts
 *      (LLM-раскадровка) → shots → full → split.
 *  EN: Builds the prompt for every clip. Priority: explicit segmentPrompts
 *      (LLM storyboard) → shots → full → split. */
export function buildSegmentPrompts(prompt, count, mode, maxPromptChars, segmentPrompts, continuity = 'none') {
    const text = String(prompt ?? '').trim();
    const continuation = continuity === 'last-frame'
        ? 'Continue seamlessly from the previous frame. Same character, wardrobe, location, light and lens. Show a NEW action; do not repeat the previous action.'
        : '';
    const finish = (values) => values.map((value, index) => {
        let out = value.trim();
        if (index > 0 && continuation && !/previous frame/i.test(out))
            out += `\n\n${continuation}`;
        if (out.length > maxPromptChars)
            out = out.slice(0, maxPromptChars);
        return out;
    });
    const explicit = (segmentPrompts ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
    if (explicit.length) {
        const values = Array.from({ length: count }, (_, index) => explicit[index] ?? explicit[explicit.length - 1] ?? text);
        return { prompts: finish(values), fallback: explicit.length < count };
    }
    if (mode === 'shots') {
        const shots = text.split(/\n\s*---\s*\n|\n{2,}/u).map((value) => value.trim()).filter(Boolean);
        if (shots.length) {
            const values = Array.from({ length: count }, (_, index) => shots[index] ?? shots[shots.length - 1] ?? text);
            return { prompts: finish(values), fallback: shots.length < count };
        }
    }
    if (mode !== 'full')
        return { prompts: finish(splitPrompt(text, count)), fallback: false };
    const base = text || 'An empty scene';
    const suffix = (index) => `\n\nPart ${index + 1}/${count}.${continuation ? ` ${continuation}` : ' Continue the same scene seamlessly.'}`;
    if (base.length > maxPromptChars) {
        return { prompts: finish(splitPrompt(base, count)), fallback: true };
    }
    const withSuffix = Array.from({ length: count }, (_, index) => `${base}${suffix(index)}`);
    if (withSuffix.every((value) => value.length <= maxPromptChars)) {
        return { prompts: withSuffix, fallback: false };
    }
    return { prompts: finish(Array.from({ length: count }, () => base)), fallback: false };
}
/** RU: Максимальное разрешение и клип, укладывающиеся в бюджет VRAM.
 *      Используется авто-режимом MCP, когда тонкие настройки недоступны.
 *  EN: Maximum resolution and clip that fit the VRAM budget. Used by the MCP
 *      auto mode when fine-grained settings are unavailable. */
export function fitPlanToBudget(input) {
    const budget = input.budgetGB * 0.95;
    if (budget <= 0)
        return null;
    const ratio = input.width / Math.max(1, input.height);
    const snap = (value) => Math.max(64, Math.round(value / 32) * 32);
    const heights = [input.height, 768, 704, 640, 576, 512, 448, 384, 320, 256, 224, 192]
        .map((value) => snap(value))
        .filter((value, index, list) => list.indexOf(value) === index)
        .sort((a, b) => b - a);
    const clips = Array.from(new Set([Math.min(input.clipSec, input.targetDurationSec), 8, 7, 6, 5, 4, 3, 2, 1]))
        .filter((value) => value > 0 && value <= input.model.durationSec.max)
        .sort((a, b) => b - a);
    for (const clip of clips) {
        const frames = Math.max(9, Math.round(clip * input.fps) + 1);
        for (const height of heights) {
            const width = snap(height * ratio);
            const estimated = estimateVramGB(input.model, width, height, frames);
            if (estimated <= budget) {
                return { width, height, clipSec: clip, estimatedVramGB: estimated };
            }
        }
    }
    return null;
}
/** RU: Авто-длина клипа по VRAM. EN: Auto clip length by VRAM. */
export function autoClipSec(vramGB, fps) {
    if (!(vramGB > 0))
        return 4;
    const base = vramGB >= 16 ? 8 : vramGB >= 10 ? 6 : 4;
    const frames = Math.round(base * fps + 1);
    if (frames <= 257)
        return Math.max(4, base);
    return Math.max(4, Math.floor((257 - 1) / fps));
}
/** RU: Собирает полный план. EN: Builds the full plan. */
export function planGeneration(input) {
    const { settings, model, gpu } = input;
    const warnings = [];
    const fps = model.family === 'wan-video' ? 24 : (input.fps && input.fps > 0 ? input.fps : model.fps[0] ?? 24);
    const width = input.width && input.width > 0 ? input.width : model.width;
    const height = input.height && input.height > 0 ? input.height : model.height;
    const requestedTarget = Math.max(0.5, input.targetDurationSec ?? settings.targetDurationSec ?? model.durationSec.recommended);
    const target = input.videoInput ? Math.min(requestedTarget, 4) : 10;
    if (requestedTarget < 4)
        throw new GenVideoError('segment-too-short', 'A segment must be at least 4 seconds; increase the target duration.');
    const selectedGpu = gpu.available ? gpu.gpus.filter((item) => !settings.gpu.ids.length || settings.gpu.ids.includes(item.index)) : [];
    const totalVram = selectedGpu.length
        ? Math.max(...selectedGpu.map((item) => item.totalMB / 1024))
        : 0;
    const comfyGpu = Number(settings.deps?.comfyuiGpu ?? -1);
    const autoGpu = comfyGpu >= 0 && selectedGpu.some((item) => item.index === comfyGpu)
        ? selectedGpu.filter((item) => item.index === comfyGpu)
        : selectedGpu;
    const freeVram = autoGpu.length
        ? Math.min(...autoGpu.map((item) => (item.totalMB - item.usedMB) / 1024))
        : 0;
    const vram = settings.gpu.vramBudgetGB > 0 ? settings.gpu.vramBudgetGB : totalVram;
    const autoBudget = freeVram > 0 ? Math.min(vram || freeVram, freeVram) : vram;
    const autoClip = !input.clipSec || input.clipSec <= 0;
    const clipRequested = 4;
    if (autoClip) {
        warnings.push({
            code: 'auto-clip',
            message: `Auto clip ${clipRequested}s: ${autoBudget.toFixed(1)} GB usable VRAM (${freeVram.toFixed(1)} GB free), max 257 frames.`,
        });
    }
    const promptMode = input.promptMode ?? 'shots';
    const mode = input.videoInput ? 'v2v' : input.imageInput ? 'i2v' : 't2v';
    const promptProfile = resolvePromptProfile(model, mode);
    const segmentMode = input.segmentMode ?? 'fixed';
    const requestedSegments = Math.ceil(target / Math.max(0.5, clipRequested));
    if (requestedSegments > 30) {
        warnings.push({
            code: 'many-segments',
            message: `${requestedSegments} clips will be generated sequentially; this can take a long time.`,
        });
    }
    if (requestedSegments > MAX_SEGMENTS) {
        warnings.push({
            code: 'too-many-segments',
            message: `A ${target}s video with ${clipRequested}s clips needs ${requestedSegments} segments; the limit is ${MAX_SEGMENTS}. Increase the clip length or shorten the video.`,
        });
    }
    const durations = input.videoInput ? [4] : [4, 4, 4];
    const overlaps = durations.length > 1 ? [1, 1] : [];
    const continuity = input.continuity ?? (durations.length > 1 ? 'last-frame' : 'none');
    const built = buildSegmentPrompts(input.prompt, durations.length, promptMode, model.maxPromptChars, input.segmentPrompts, continuity);
    if (built.fallback) {
        warnings.push({
            code: 'prompt-too-long',
            message: `The full scene is longer than the model limit (${model.maxPromptChars} chars); prompts are split by sentences instead.`,
        });
    }
    const explicit = (input.segmentPrompts ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
    if (explicit.length && explicit.length !== durations.length) {
        warnings.push({
            code: 'segment-prompts-count',
            message: `Received ${explicit.length} segment prompts for ${durations.length} clips. Pass exactly one prompt per clip.`,
        });
    }
    const segments = durations.map((durationSec, index) => {
        const prompt = built.prompts[index] ?? input.prompt;
        const stats = promptStats(prompt);
        const segmentWarnings = [];
        if (stats.words < promptProfile.minWords)
            segmentWarnings.push('prompt-too-short');
        if (stats.chars > promptProfile.maxChars)
            segmentWarnings.push('prompt-too-long');
        const withoutContinuity = (value) => value.replace(/Continue seamlessly from the previous frame\.[\s\S]*$/i, '').trim();
        if (index > 0 && promptSimilarity(withoutContinuity(prompt), withoutContinuity(built.prompts[index - 1] ?? '')) > 0.85)
            segmentWarnings.push('prompt-repeated');
        if (segmentWarnings.includes('prompt-too-short')) {
            warnings.push({ code: 'prompt-too-short', message: `Clip ${index + 1} has ${stats.words} words; ${promptProfile.id} expects at least ${promptProfile.minWords}. Add subject, setting, light, camera, action and continuity details.` });
        }
        if (segmentWarnings.includes('prompt-repeated')) {
            warnings.push({ code: 'prompt-repeated', message: `Clip ${index + 1} repeats the previous action; write a new beat instead of repeating it.` });
        }
        return { index, durationSec, prompt, wordCount: stats.words, warnings: segmentWarnings };
    });
    const totalSec = input.videoInput ? 4 : 10;
    const frames = Math.max(9, Math.round((segments[0]?.durationSec ?? 1) * fps) + 1);
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
        autoClip,
        mode,
        denoise: Math.min(0.8, Math.max(0.3, Number(input.denoise ?? 0.6))),
        upscaleBatch: autoBudget >= 16 ? 32 : autoBudget >= 10 ? 16 : 8,
        segmentBriefs: segments.map((segment, index) => ({
            index,
            beat: index === 0 ? 'establishing shot, action begins'
                : index === segments.length - 1 ? 'finish the action and hold the final composition'
                    : 'continuous camera move, new action, same scene',
            mustNotRepeat: index === 0 ? 'no previous segment' : `do not repeat clip ${index}'s action`,
        })),
        promptProfile,
        orientation: input.orientation ?? (width >= height ? 'landscape' : 'portrait'),
        baseWidth: width >= height ? 864 : 480,
        baseHeight: width >= height ? 480 : 864,
        promptMode,
        continuity,
        segments,
        overlaps,
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
