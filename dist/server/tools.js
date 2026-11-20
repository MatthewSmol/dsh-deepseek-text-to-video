/**
 * RU: Нативные DSH-инструменты GenVideo. Они работают с тем же движком, что и
 *     панель, и не требуют MCP-сервера. ComfyUI — единственный бэкенд.
 * EN: GenVideo native DSH tools. They use the same engine as the panel and do
 *     not need an MCP server. ComfyUI is the only backend.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
/** RU: Общая схема ответа инструмента. EN: Shared tool result schema. */
const RESULT_SCHEMA = { type: 'object', additionalProperties: true };
function render(value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
function tool(name, description, parameters, execute) {
    return {
        name,
        description,
        parameters,
        output: { schema: RESULT_SCHEMA, render: (_args, value) => render(value) },
        async execute(args) {
            return await execute(args ?? {});
        },
    };
}
const promptProps = {
    prompt: { type: 'string', description: 'Prompt describing the shot.' },
    negativePrompt: { type: 'string', description: 'What to avoid.' },
    promptMode: { type: 'string', enum: ['split', 'full', 'shots'] },
    segmentPrompts: { type: 'array', items: { type: 'string' }, description: 'One prompt per clip. For multi-clip videos write N different prompts that advance the scene and continue from the previous frame.' },
    continuity: { type: 'string', enum: ['none', 'last-frame'] },
    targetDurationSec: { type: 'number' },
    clipSec: { type: 'number' },
    platform: { type: 'string' },
    aspect: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    fps: { type: 'number', enum: [24], description: 'Wan output is fixed at 24 fps.' },
    orientation: { type: 'string', enum: ['landscape', 'portrait'] },
    denoise: { type: 'number', minimum: 0.3, maximum: 0.8, description: 'Legacy field; Wan keyframe V2V uses denoise=1 with the start-image mask.' },
    upscale: { type: 'string', enum: ['ewa', 'off'], description: 'Post-merge EWA Lanczos upscale from 480p to 720p, or off.' },
    inputImageId: { type: 'string' },
    inputVideoId: { type: 'string' },
    outputName: { type: 'string' },
    audioPath: { type: 'string', description: 'Absolute path to a local audio track to mux into the final 10s video.' },
    planId: { type: 'string', description: 'planId returned by genvideo_plan after the user confirmed the preview.' },
    transcode: { type: 'object', additionalProperties: true },
};
/** RU: Регистрирует инструменты; возвращает функцию очистки. EN: Registers tools; returns a disposer. */
export function registerGenvideoTools(ctx, engine) {
    const definitions = [
        tool('genvideo_upload', 'Copy a local image or video into the GenVideo input store and return its inputId. Use this instead of copying files into ~/.dsh/genvideo or the ComfyUI input folder.', {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to an image or video on this machine.' },
                name: { type: 'string', description: 'Optional stored filename.' },
            },
            required: ['path'], additionalProperties: false,
        }, async (args) => {
            const path = String(args.path ?? '');
            const info = await stat(path).catch(() => null);
            if (!info?.isFile())
                throw new Error(`File not found: ${path}`);
            if (info.size > 200 * 1024 * 1024)
                throw new Error('Input is larger than 200 MB');
            const ext = extname(path).toLowerCase();
            const mime = ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg'
                : ext === '.png' ? 'image/png'
                    : ext === '.webp' ? 'image/webp'
                        : ['.mp4', '.webm', '.mov', '.mkv'].includes(ext) ? (ext === '.webm' ? 'video/webm' : 'video/mp4')
                            : 'application/octet-stream';
            const data = await readFile(path);
            const name = String(args.name ?? basename(path)).slice(0, 200);
            return await engine.saveInput({ data, name, mime });
        }),
        tool('genvideo_status', 'ComfyUI/ffmpeg/jobs status of GenVideo.', { type: 'object', properties: {}, additionalProperties: false }, async () => await engine.status()),
        tool('genvideo_plan', 'Plan segment split for a prompt. Returns the clip count N, promptProfile and required facets. For N>1 write exactly N different segmentPrompts: each must show a NEW action, not repeat the previous clip. Use segmentBriefs from the plan. Adjacent identical prompts are rejected.', {
            type: 'object', properties: promptProps, required: ['prompt'], additionalProperties: false,
        }, async (args) => await engine.plan({ ...args, modelId: 'comfyui-workflow', runner: 'comfyui' })),
        tool('genvideo_generate', 'Generate a video through the configured ComfyUI workflow. First call genvideo_plan, show the preview to the user and wait for confirmation, then call again with planId. Generation without planId returns confirmation-required. Adjacent repeated segment prompts return segment-prompts-repeated.', {
            type: 'object', properties: promptProps, required: ['prompt'], additionalProperties: false,
        }, async (args) => {
            const result = await engine.generate({ ...args, modelId: 'comfyui-workflow', runner: 'comfyui' });
            return { jobId: result.job.id, plan: result.plan };
        }),
        tool('genvideo_jobs', 'List recent GenVideo jobs.', {
            type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false,
        }, async (args) => engine.jobs.list(Number(args.limit ?? 30))),
        tool('genvideo_job', 'Read one GenVideo job with progress and log tail.', {
            type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false,
        }, async (args) => engine.jobs.get(String(args.jobId))),
        tool('genvideo_cancel', 'Cancel a running GenVideo job.', {
            type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false,
        }, async (args) => ({ cancelled: engine.jobs.cancel(String(args.jobId)) })),
        tool('genvideo_merge', 'Merge existing videos from the gallery.', {
            type: 'object', properties: { names: { type: 'array', items: { type: 'string' } }, outputName: { type: 'string' } }, required: ['names'], additionalProperties: false,
        }, async (args) => await engine.merge({ names: args.names, outputName: args.outputName })),
        tool('genvideo_transcode', 'Transcode an existing video with the current transcode settings.', {
            type: 'object', properties: { name: { type: 'string' }, outputName: { type: 'string' }, transcode: { type: 'object', additionalProperties: true } }, required: ['name'], additionalProperties: false,
        }, async (args) => await engine.transcode({ name: args.name, outputName: args.outputName, transcode: args.transcode })),
    ];
    const disposers = definitions.map((definition) => ctx.tools.register(definition));
    return () => {
        for (const dispose of disposers) {
            try {
                dispose?.();
            }
            catch { /* ignore */ }
        }
    };
}
