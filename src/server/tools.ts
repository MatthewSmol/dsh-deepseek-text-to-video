/**
 * RU: Нативные DSH-инструменты GenVideo. Они работают с тем же движком, что и
 *     панель, и не требуют MCP-сервера. ComfyUI — единственный бэкенд.
 * EN: GenVideo native DSH tools. They use the same engine as the panel and do
 *     not need an MCP server. ComfyUI is the only backend.
 */
import type { JobRecord } from '../lib/types.js'

type JsonSchema = Record<string, unknown>

/** RU: Общая схема ответа инструмента. EN: Shared tool result schema. */
const RESULT_SCHEMA = { type: 'object', additionalProperties: true } as const

function render(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function tool(name: string, description: string, parameters: JsonSchema, execute: (args: any) => Promise<unknown>): any {
  return {
    name,
    description,
    parameters,
    output: { schema: RESULT_SCHEMA, render: (_args: unknown, value: unknown) => render(value) },
    async execute(args: any) {
      return await execute(args ?? {})
    },
  }
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
  fps: { type: 'number', enum: [15, 24, 30, 60] },
  orientation: { type: 'string', enum: ['landscape', 'portrait'] },
  denoise: { type: 'number', minimum: 0.3, maximum: 0.8, description: 'V2V strength: 0.35–0.5 gentle, 0.55–0.75 strong.' },
  inputImageId: { type: 'string' },
  inputVideoId: { type: 'string' },
  outputName: { type: 'string' },
  planId: { type: 'string', description: 'planId returned by genvideo_plan after the user confirmed the preview.' },
  transcode: { type: 'object', additionalProperties: true },
}

/** RU: Регистрирует инструменты; возвращает функцию очистки. EN: Registers tools; returns a disposer. */
export function registerGenvideoTools(ctx: any, engine: any): () => void {
  const definitions = [
    tool('genvideo_status', 'ComfyUI/ffmpeg/jobs status of GenVideo.', { type: 'object', properties: {}, additionalProperties: false },
      async () => await engine.status()),
    tool('genvideo_plan', 'Plan segment split for a prompt. Returns the clip count N, promptProfile and required facets. For N>1 write exactly N detailed segmentPrompts (subject, setting, light, camera, action, continuity) and pass them to genvideo_generate.', {
      type: 'object', properties: promptProps, required: ['prompt'], additionalProperties: false,
    }, async (args) => await engine.plan({ ...args, modelId: 'comfyui-workflow', runner: 'comfyui' })),
    tool('genvideo_generate', 'Generate a video through the configured ComfyUI workflow. First call genvideo_plan, show the preview to the user and wait for confirmation, then call again with planId. Generation without planId returns confirmation-required.', {
      type: 'object', properties: promptProps, required: ['prompt'], additionalProperties: false,
    }, async (args) => {
      const result = await engine.generate({ ...args, modelId: 'comfyui-workflow', runner: 'comfyui' })
      return { jobId: result.job.id, plan: result.plan }
    }),
    tool('genvideo_jobs', 'List recent GenVideo jobs.', {
      type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false,
    }, async (args) => engine.jobs.list(Number(args.limit ?? 30))),
    tool('genvideo_job', 'Read one GenVideo job with progress and log tail.', {
      type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false,
    }, async (args) => engine.jobs.get(String(args.jobId)) as JobRecord),
    tool('genvideo_cancel', 'Cancel a running GenVideo job.', {
      type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false,
    }, async (args) => ({ cancelled: engine.jobs.cancel(String(args.jobId)) })),
    tool('genvideo_merge', 'Merge existing videos from the gallery.', {
      type: 'object', properties: { names: { type: 'array', items: { type: 'string' } }, outputName: { type: 'string' } }, required: ['names'], additionalProperties: false,
    }, async (args) => await engine.merge({ names: args.names, outputName: args.outputName })),
    tool('genvideo_transcode', 'Transcode an existing video with the current transcode settings.', {
      type: 'object', properties: { name: { type: 'string' }, outputName: { type: 'string' }, transcode: { type: 'object', additionalProperties: true } }, required: ['name'], additionalProperties: false,
    }, async (args) => await engine.transcode({ name: args.name, outputName: args.outputName, transcode: args.transcode })),
  ] as Array<{ name: string }>
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* ignore */ }
    }
  }
}
