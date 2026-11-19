/**
 * RU: Отдельный ComfyUI-проход для нейросетевого 2× апскейла готового видео.
 *     Генерация уже завершена, модели выгружены через /free, поэтому в VRAM
 *     остаётся только апскейлер и несколько кадров.
 * EN: Separate ComfyUI pass for neural 2x upscaling of a finished video.
 *     Generation is done and models are unloaded via /free, so VRAM only holds
 *     the upscaler and a few frames.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { genvideoHome } from '../paths.js';
import { detectComfyUi } from '../deps.js';
import { GenVideoError } from '../errors.js';
async function exists(path) {
    return await access(path).then(() => true).catch(() => false);
}
export async function upscaleWithComfyUI(input) {
    const detected = await detectComfyUi(input.settings.deps.comfyuiUrl);
    const base = (input.settings.deps.comfyuiUrl || detected.url || '').replace(/\/+$/, '');
    if (!base)
        throw new GenVideoError('comfyui-missing', 'ComfyUI URL is not configured');
    const data = await readFile(input.source);
    const form = new FormData();
    form.append('image', new Blob([data]), basename(input.source));
    form.append('type', 'input');
    const uploaded = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: input.signal }).catch((error) => {
        throw new GenVideoError('comfyui-unreachable', `Could not upload the upscale source: ${error instanceof Error ? error.message : String(error)}`, { status: 503 });
    });
    if (!uploaded.ok)
        throw new GenVideoError('comfyui-upload-failed', `ComfyUI rejected the upscale source: HTTP ${uploaded.status}`);
    const file = (await uploaded.json());
    if (!file.name)
        throw new GenVideoError('comfyui-upload-failed', 'ComfyUI did not return an uploaded video name');
    const videoName = file.subfolder ? `${file.subfolder}/${file.name}` : file.name;
    await fetch(`${base}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: input.signal,
    }).catch(() => undefined);
    const templatePath = join(genvideoHome(), 'workflow-upscale.json');
    if (!(await exists(templatePath)))
        throw new GenVideoError('comfyui-workflow-missing', `Upscale workflow not found at ${templatePath}`);
    const template = await readFile(templatePath, 'utf8');
    const values = {
        video: videoName,
        upscaler: input.upscaler,
        perBatch: String(input.perBatch),
        outWidth: String(input.width),
        outHeight: String(input.height),
        fps: String(input.fps),
    };
    const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
    let workflow;
    try {
        workflow = JSON.parse(text);
    }
    catch {
        throw new GenVideoError('comfyui-workflow-invalid', 'Upscale workflow is invalid after substitution');
    }
    input.log?.(`ComfyUI upscale: ${input.width}×${input.height}, batch ${input.perBatch}`);
    const response = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: `genvideo-upscale-${Date.now()}` }),
        signal: input.signal,
    }).catch((error) => {
        throw new GenVideoError('comfyui-unreachable', `ComfyUI is unreachable: ${error instanceof Error ? error.message : String(error)}`, { status: 503 });
    });
    if (!response.ok)
        throw new GenVideoError('comfyui-rejected', `ComfyUI rejected the upscale workflow: HTTP ${response.status}`);
    const submitted = (await response.json());
    if (!submitted.prompt_id)
        throw new GenVideoError('comfyui-rejected', 'ComfyUI did not return an upscale prompt id');
    const started = Date.now();
    let outputs = null;
    while (!outputs) {
        if (input.signal?.aborted)
            throw new Error('aborted');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        input.onProgress?.(Math.min(90, 10 + Math.round(((Date.now() - started) / 60_000) * 80)));
        const history = await fetch(`${base}/history/${submitted.prompt_id}`, { signal: input.signal });
        if (!history.ok)
            continue;
        const payload = (await history.json());
        const entry = payload[submitted.prompt_id];
        if (entry?.outputs)
            outputs = entry.outputs;
        if (entry?.status?.status_str === 'error')
            throw new GenVideoError('upscale-failed', 'ComfyUI upscale workflow failed; see ComfyUI logs');
    }
    let output = null;
    for (const node of Object.values(outputs)) {
        const candidates = [...(node.videos ?? []), ...(node.gifs ?? []), ...(node.images ?? [])];
        output = candidates.find((item) => item.type === 'output') ?? null;
        if (output?.filename)
            break;
    }
    if (!output?.filename)
        throw new GenVideoError('upscale-no-output', 'Upscale workflow finished without a video output');
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' });
    const download = await fetch(`${base}/view?${query.toString()}`, { signal: input.signal });
    if (!download.ok || !download.body)
        throw new GenVideoError('upscale-no-output', `Could not download the upscaled video: HTTP ${download.status}`);
    await mkdir(dirname(input.target), { recursive: true });
    await writeFile(input.target, Buffer.from(await download.arrayBuffer()));
    input.onProgress?.(100);
}
