/**
 * RU: MCP-сервис GenVideo. Один процесс владеет движком и одновременно:
 *     1) говорит по stdio JSON-RPC с DSH (инструменты `mcp__genvideo__*`);
 *     2) поднимает HTTP sidecar на 127.0.0.1 для панели UI.
 *     Порт и токен публикуются в `$DSH_HOME/genvideo/endpoint.json`; Host-plagin
 *     читает этот файл и проксирует `/genvideo/*`.
 * EN: GenVideo MCP service. One process owns the engine and simultaneously:
 *     1) speaks stdio JSON-RPC with DSH (tools `mcp__genvideo__*`);
 *     2) runs an HTTP sidecar on 127.0.0.1 for the UI panel.
 *     The port and token are published in `$DSH_HOME/genvideo/endpoint.json`; the
 *     Host plugin reads that file and proxies `/genvideo/*`.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { unlink } from 'node:fs/promises';
import { Engine, VERSION } from '../lib/engine.js';
import { createApiHandler } from '../lib/api.js';
import { endpointFile, ensureServiceDirs, writeJsonAtomic, readJsonFile } from '../lib/paths.js';
import { probeFile } from '../lib/media.js';
import { GenVideoError, toApiError } from '../lib/errors.js';
const tool = (definition) => definition;
const readOnly = { readOnlyHint: true };
/** RU: Схемы инструментов. EN: Tool schemas. */
const TOOLS = [
    tool({
        name: 'status',
        description: 'Report GenVideo environment: GPUs and VRAM, ffmpeg, Python venv, cargo, ComfyUI, installed models, active jobs and paths.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: readOnly,
    }),
    tool({
        name: 'models',
        description: 'List the model registry with capabilities (t2v/i2v/v2v/audio), sizes, VRAM requirements, duration limits, runtimes and install state.',
        inputSchema: {
            type: 'object',
            properties: { modelId: { type: 'string' }, refresh: { type: 'boolean' } },
            additionalProperties: false,
        },
        annotations: readOnly,
    }),
    tool({
        name: 'explore_models',
        description: 'Browse popular Hugging Face text-to-video models, 10 per page, sorted by estimated VRAM ascending. Heuristic quality notes; not a benchmark.',
        inputSchema: {
            type: 'object',
            properties: { page: { type: 'number' } },
            additionalProperties: false,
        },
        annotations: readOnly,
    }),
    tool({
        name: 'install_model',
        description: 'Start downloading a model variant from Hugging Face into the project models/ folder. Returns a job id; poll it with the job tool.',
        inputSchema: {
            type: 'object',
            properties: { modelId: { type: 'string' }, variant: { type: 'string' } },
            required: ['modelId'],
            additionalProperties: false,
        },
    }),
    tool({
        name: 'check_updates',
        description: 'Compare installed model revisions with Hugging Face and suggest newer models in the same family.',
        inputSchema: { type: 'object', properties: { modelId: { type: 'string' } }, additionalProperties: false },
        annotations: readOnly,
    }),
    tool({
        name: 'plan',
        description: 'Explain what the selected model can do for a prompt: duration limits, segment split for long videos, VRAM fit, estimated time and size, image/video input support, warnings.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                modelId: { type: 'string' },
                variant: { type: 'string' },
                runner: { type: 'string', enum: ['mock', 'diffusers', 'candle', 'comfyui', 'command'] },
                platform: { type: 'string', enum: ['reels', 'shorts', 'youtube', 'youtube4k', 'cinema', 'square', 'portrait45', 'custom'] },
                aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:5', '3:4', 'custom'] },
                width: { type: 'number' },
                height: { type: 'number' },
                fps: { type: 'number' },
                targetDurationSec: { type: 'number' },
                clipSec: { type: 'number' },
                inputImageId: { type: 'string' },
                inputVideoId: { type: 'string' },
                transcode: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        mode: { type: 'string', enum: ['quality', 'size'] },
                        quality: { type: 'string', enum: ['high', 'medium', 'compressed'] },
                        targetSizeMB: { type: 'number' },
                        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
                        codec: { type: 'string', enum: ['h264', 'h265'] },
                        encoder: { type: 'string', enum: ['auto', 'cpu', 'vulkan', 'nvenc'] },
                        fit: { type: 'string', enum: ['contain', 'cover'] },
                        width: { type: 'number' },
                        height: { type: 'number' },
                        fps: { type: 'number' },
                    },
                    additionalProperties: false,
                },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
        annotations: readOnly,
    }),
    tool({
        name: 'generate',
        description: 'Start a text-to-video job (long videos are split into segments and merged). Returns a job id and the plan; poll job for detailed progress. Set transcode.enabled=false to disable, or transcode.mode to quality/size with codec h264|h265 and encoder auto|cpu|vulkan|nvenc.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                negativePrompt: { type: 'string' },
                modelId: { type: 'string' },
                variant: { type: 'string' },
                runner: { type: 'string', enum: ['mock', 'diffusers', 'candle', 'comfyui', 'command'] },
                platform: { type: 'string', enum: ['reels', 'shorts', 'youtube', 'youtube4k', 'cinema', 'square', 'portrait45', 'custom'] },
                aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:5', '3:4', 'custom'] },
                width: { type: 'number' },
                height: { type: 'number' },
                fps: { type: 'number' },
                targetDurationSec: { type: 'number' },
                clipSec: { type: 'number' },
                segments: { type: 'number' },
                seed: { type: 'number' },
                steps: { type: 'number' },
                guidance: { type: 'number' },
                continuity: { type: 'string', enum: ['none', 'last-frame'] },
                inputImageId: { type: 'string' },
                inputVideoId: { type: 'string' },
                outputName: { type: 'string' },
                transcode: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        mode: { type: 'string', enum: ['quality', 'size'] },
                        quality: { type: 'string', enum: ['high', 'medium', 'compressed'] },
                        targetSizeMB: { type: 'number' },
                        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
                        codec: { type: 'string', enum: ['h264', 'h265'] },
                        encoder: { type: 'string', enum: ['auto', 'cpu', 'vulkan', 'nvenc'] },
                        fit: { type: 'string', enum: ['contain', 'cover'] },
                        width: { type: 'number' },
                        height: { type: 'number' },
                        fps: { type: 'number' },
                    },
                    additionalProperties: false,
                },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
    }),
    tool({
        name: 'jobs',
        description: 'List recent jobs with status, phase, percent, segment progress, outputs and errors.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number' },
                status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
            },
            additionalProperties: false,
        },
        annotations: readOnly,
    }),
    tool({
        name: 'job',
        description: 'Get one job with the detailed progress, segment states, outputs and the last log lines.',
        inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false },
        annotations: readOnly,
    }),
    tool({
        name: 'cancel',
        description: 'Cancel a queued or running job.',
        inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false },
    }),
    tool({
        name: 'merge',
        description: 'Concatenate two or more clips from Videos/ into one long video. Optionally transcode the result.',
        inputSchema: {
            type: 'object',
            properties: {
                names: { type: 'array', items: { type: 'string' } },
                outputName: { type: 'string' },
                transcode: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        mode: { type: 'string', enum: ['quality', 'size'] },
                        quality: { type: 'string', enum: ['high', 'medium', 'compressed'] },
                        targetSizeMB: { type: 'number' },
                        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
                        codec: { type: 'string', enum: ['h264', 'h265'] },
                        encoder: { type: 'string', enum: ['auto', 'cpu', 'vulkan', 'nvenc'] },
                        fit: { type: 'string', enum: ['contain', 'cover'] },
                        width: { type: 'number' },
                        height: { type: 'number' },
                        fps: { type: 'number' },
                    },
                    additionalProperties: false,
                },
            },
            required: ['names'],
            additionalProperties: false,
        },
    }),
    tool({
        name: 'transcode',
        description: 'Transcode a clip to another format, resolution or size limit. Use mode=quality with a tier, or mode=size with targetSizeMB.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                outputName: { type: 'string' },
                transcode: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['quality', 'size'] },
                        quality: { type: 'string', enum: ['high', 'medium', 'compressed'] },
                        targetSizeMB: { type: 'number' },
                        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
                        codec: { type: 'string', enum: ['h264', 'h265'] },
                        encoder: { type: 'string', enum: ['auto', 'cpu', 'vulkan', 'nvenc'] },
                        width: { type: 'number' },
                        height: { type: 'number' },
                        fps: { type: 'number' },
                        fit: { type: 'string', enum: ['contain', 'cover'] },
                    },
                    additionalProperties: false,
                },
            },
            required: ['name'],
            additionalProperties: false,
        },
    }),
    tool({
        name: 'probe',
        description: 'Read ffprobe metadata for a clip in Videos/.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        annotations: readOnly,
    }),
    tool({
        name: 'settings',
        description: 'Read or update plugin settings (GPU selection, VRAM budget, output folder, models folder, language, transcode defaults, tool paths).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['get', 'set'] },
                values: { type: 'object' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    }),
    tool({
        name: 'engine_install',
        description: 'Install a toolchain: python (venv with torch/diffusers, several GB), ffmpeg, or candle (builds candle-video from source; the CUDA toolkit must already be installed).',
        inputSchema: {
            type: 'object',
            properties: { target: { type: 'string', enum: ['python', 'ffmpeg', 'candle'] } },
            required: ['target'],
            additionalProperties: false,
        },
    }),
];
/** RU: Проверка обязательных полей. EN: Required-argument validation. */
function requireArgs(args, names) {
    for (const name of names) {
        if (args[name] === undefined || args[name] === null || args[name] === '') {
            throw new GenVideoError('bad-arguments', `Missing required argument: ${name}`, { status: 400 });
        }
    }
}
/** RU: Вызов инструмента. EN: Tool dispatch. */
async function callTool(engine, name, args) {
    switch (name) {
        case 'status': {
            const status = await engine.status();
            return {
                version: status.version,
                startedAt: status.startedAt,
                gpu: status.gpu,
                deps: status.deps,
                models: status.models.map((model) => ({
                    id: model.entry.id,
                    title: model.entry.title,
                    installed: model.installed,
                    installedBytes: model.installedBytes,
                    requiredBytes: model.requiredBytes,
                    capabilities: model.entry.capabilities,
                    vramGB: model.entry.vramGB,
                    runtimes: model.entry.runtimes,
                })),
                activeJobs: status.jobs.filter((job) => job.status === 'running' || job.status === 'queued').map((job) => job.id),
                paths: status.paths,
            };
        }
        case 'models': {
            if (args.refresh === true)
                await engine.refresh(true);
            return await engine.modelStates();
        }
        case 'explore_models': {
            return await engine.exploreModels(Number(args.page ?? 1));
        }
        case 'install_model': {
            requireArgs(args, ['modelId']);
            const job = await engine.installModel({ modelId: String(args.modelId), variant: args.variant ? String(args.variant) : undefined });
            return { jobId: job.id, status: job.status };
        }
        case 'check_updates':
            return await engine.checkUpdates(args.modelId ? String(args.modelId) : undefined);
        case 'plan':
            return await engine.plan(args);
        case 'generate': {
            const result = await engine.generate(args);
            return { jobId: result.job.id, plan: result.plan };
        }
        case 'jobs': {
            const limit = Number(args.limit ?? 30);
            const list = engine.jobs.list(limit);
            const status = args.status ? String(args.status) : null;
            return status ? list.filter((job) => job.status === status) : list;
        }
        case 'job': {
            requireArgs(args, ['jobId']);
            const job = engine.jobs.get(String(args.jobId));
            if (!job)
                throw new GenVideoError('job-not-found', `Unknown job: ${String(args.jobId)}`, { status: 404 });
            return job;
        }
        case 'cancel': {
            requireArgs(args, ['jobId']);
            return { cancelled: engine.jobs.cancel(String(args.jobId)) };
        }
        case 'merge': {
            const names = Array.isArray(args.names) ? args.names.map(String) : [];
            const job = await engine.merge({
                names,
                outputName: args.outputName ? String(args.outputName) : undefined,
                transcode: args.transcode,
            });
            return { jobId: job.id, status: job.status };
        }
        case 'transcode': {
            requireArgs(args, ['name']);
            const job = await engine.transcode({
                name: String(args.name),
                outputName: args.outputName ? String(args.outputName) : undefined,
                transcode: args.transcode,
            });
            return { jobId: job.id, status: job.status };
        }
        case 'probe': {
            requireArgs(args, ['name']);
            const deps = await engine.deps();
            if (!deps.ffprobe.ok)
                throw new GenVideoError('no-ffprobe', 'ffprobe is not available');
            return await probeFile(deps.ffprobe.path || 'ffprobe', engine.resolveMedia(String(args.name)));
        }
        case 'settings': {
            const action = String(args.action);
            if (action === 'get')
                return engine.settings;
            if (action === 'set') {
                const values = (args.values && typeof args.values === 'object' ? args.values : {});
                return await engine.updateSettings(values);
            }
            throw new GenVideoError('bad-arguments', 'action must be get or set');
        }
        case 'engine_install': {
            const target = String(args.target);
            if (target === 'python') {
                const job = await engine.installPythonEngine();
                return { jobId: job.id, status: job.status };
            }
            if (target === 'ffmpeg')
                return await engine.installFfmpeg();
            if (target === 'candle') {
                const job = await engine.installCandleEngine();
                return { jobId: job.id, status: job.status };
            }
            throw new GenVideoError('bad-arguments', `Unknown engine target: ${target}`, { status: 400 });
        }
        default:
            throw new GenVideoError('unknown-tool', `Unknown tool: ${name}`, { status: 404 });
    }
}
/** RU: Запуск сервиса. EN: Service bootstrap. */
async function main() {
    ensureServiceDirs();
    const engine = new Engine();
    const token = randomBytes(24).toString('hex');
    const server = createServer(createApiHandler(engine, token));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    await writeJsonAtomic(endpointFile(), {
        port: address.port,
        token,
        pid: process.pid,
        startedAt: Date.now(),
        version: VERSION,
    });
    process.stderr.write(`[genvideo] MCP service v${VERSION} on http://127.0.0.1:${address.port}, pid ${process.pid}\n`);
    let closed = false;
    const shutdown = async (code = 0) => {
        if (closed)
            return;
        closed = true;
        engine.dispose();
        await new Promise((resolve) => server.close(() => resolve()));
        const endpoint = readJsonFile(endpointFile(), {});
        if (endpoint.pid === process.pid)
            await unlink(endpointFile()).catch(() => undefined);
        process.exit(code);
    };
    process.on('SIGTERM', () => void shutdown(0));
    process.on('SIGINT', () => void shutdown(0));
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const write = (payload) => {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    };
    const respond = (id, result) => write({ jsonrpc: '2.0', id: id ?? null, result });
    const respondError = (id, code, message) => write({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    let queue = Promise.resolve();
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text)
            return;
        queue = queue.then(async () => {
            let request;
            try {
                request = JSON.parse(text);
            }
            catch {
                respondError(null, -32700, 'Parse error');
                return;
            }
            const id = request.id;
            const method = String(request.method ?? '');
            try {
                if (method === 'initialize') {
                    respond(id, {
                        protocolVersion: String(request.params?.protocolVersion ?? '2025-06-18'),
                        capabilities: { tools: {} },
                        serverInfo: { name: 'genvideo', version: VERSION },
                        instructions: 'Local text-to-video service. Use plan first to see model limits, VRAM fit and segment split; generate returns a job id, then poll job for progress.',
                    });
                    return;
                }
                if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method === 'notifications/roots/list_changed')
                    return;
                if (method === 'ping') {
                    respond(id, {});
                    return;
                }
                if (method === 'tools/list') {
                    respond(id, { tools: TOOLS });
                    return;
                }
                if (method === 'tools/call') {
                    const name = String(request.params?.name ?? '');
                    const args = (request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {});
                    try {
                        const result = await callTool(engine, name, args);
                        // RU: MCP требует structuredContent-объект; массивы оборачиваем.
                        // EN: MCP requires structuredContent to be an object; arrays are wrapped.
                        const structured = result && typeof result === 'object' && !Array.isArray(result)
                            ? result
                            : { items: result };
                        respond(id, {
                            content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
                            structuredContent: structured,
                            isError: false,
                        });
                    }
                    catch (error) {
                        const apiError = toApiError(error);
                        respond(id, {
                            content: [{ type: 'text', text: JSON.stringify(apiError) }],
                            structuredContent: apiError,
                            isError: true,
                        });
                    }
                    return;
                }
                if (method === 'resources/list') {
                    respond(id, { resources: [] });
                    return;
                }
                if (method === 'prompts/list') {
                    respond(id, { prompts: [] });
                    return;
                }
                if (method === 'logging/setLevel') {
                    respond(id, {});
                    return;
                }
                respondError(id, -32601, `Method not found: ${method}`);
            }
            catch (error) {
                respondError(id, -32603, error instanceof Error ? error.message : String(error));
            }
        });
    });
    rl.on('close', () => void shutdown(0));
}
void main().catch((error) => {
    process.stderr.write(`[genvideo] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
