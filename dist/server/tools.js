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
    promptMode: { type: 'string', enum: ['split', 'full'] },
    targetDurationSec: { type: 'number' },
    clipSec: { type: 'number' },
    platform: { type: 'string' },
    aspect: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    fps: { type: 'number' },
    inputImageId: { type: 'string' },
    inputVideoId: { type: 'string' },
    outputName: { type: 'string' },
    transcode: { type: 'object', additionalProperties: true },
};
/** RU: Регистрирует инструменты; возвращает функцию очистки. EN: Registers tools; returns a disposer. */
export function registerGenvideoTools(ctx, engine) {
    const definitions = [
        tool('genvideo_status', 'ComfyUI/ffmpeg/jobs status of GenVideo.', { type: 'object', properties: {}, additionalProperties: false }, async () => await engine.status()),
        tool('genvideo_plan', 'Plan segment split for a prompt. Generation runs through the configured ComfyUI workflow.', {
            type: 'object', properties: promptProps, required: ['prompt'], additionalProperties: false,
        }, async (args) => await engine.plan({ ...args, modelId: 'comfyui-workflow', runner: 'comfyui' })),
        tool('genvideo_generate', 'Generate a video through the configured ComfyUI workflow; long videos are split into clips and merged.', {
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
