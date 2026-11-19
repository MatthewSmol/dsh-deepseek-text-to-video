/**
 * RU: Diffusers-раннер: запускает python-воркер в venv, который
 *     использует официальный LTX-Video checkpoint из Lightricks/LTX-Video и
 *     поддерживает text-to-video и image-to-video. Воркер печатает
 *     прогресс строками `GENVIDEO {json}`.
 * EN: Diffusers runner: starts the python worker in the venv, which uses the
 *     official LTX-Video checkpoint from Lightricks/LTX-Video and supports
 *     text-to-video and image-to-video. The worker prints progress as
 *     `GENVIDEO {json}` lines.
 */
import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { available, unavailable } from './types.js';
import { runStreaming } from '../proc.js';
import { GenVideoError } from '../errors.js';
import { modelsDirOf } from '../store.js';
import { venvPython } from '../deps.js';
/** RU: Корень пакета (dist/lib/runners → пакет). EN: Package root (dist/lib/runners → package). */
function packageRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
/** RU: Путь к python-воркеру. EN: Python worker path. */
export function workerScript() {
    return join(packageRoot(), 'python', 'genvideo_worker.py');
}
async function executable(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export const diffusersRunner = {
    id: 'diffusers',
    availability(input) {
        if (!input.model.runtimes.includes('diffusers') && !input.model.fallbackRepo) {
            return unavailable('This model has no diffusers path', 'Use ComfyUI or a command template');
        }
        if (!input.deps.ffmpeg.ok)
            return unavailable('ffmpeg is not available', 'Install ffmpeg from Settings → Tools');
        if (!input.deps.venv.ok) {
            return unavailable('The Python environment with torch/diffusers is not installed', 'Open Settings → Python & engines and run "Install Python engine" (about 3–8 GB)');
        }
        if (!input.deps.venv.cuda && !input.settings.runners.allowCpu) {
            return unavailable('CUDA is not available inside the venv', 'Enable "Allow CPU generation (very slow)" in Settings → GPU, or fix the NVIDIA driver; the Candle runner is the other option');
        }
        return available();
    },
    async run(input) {
        const python = venvPython();
        if (!(await executable(python)))
            throw new GenVideoError('diffusers-missing', 'The venv python is missing');
        const worker = workerScript();
        const modelDir = join(modelsDirOf(input.settings), input.model.id);
        const request = {
            modelId: input.model.id,
            repo: input.model.repo,
            baseRepo: input.model.fallbackRepo || 'Lightricks/LTX-Video',
            weights: input.model.variants[0]?.files ?? [],
            prompt: input.prompt,
            negativePrompt: input.negativePrompt,
            width: input.width,
            height: input.height,
            frames: input.frames,
            fps: input.fps,
            steps: input.steps,
            guidance: input.guidance,
            seed: Math.max(0, input.seed),
            image: input.imagePath,
            output: input.outputPath,
        };
        await mkdir(dirname(input.outputPath), { recursive: true });
        const requestFile = join(dirname(input.outputPath), `request-${Math.abs(input.seed)}.json`);
        await writeFile(requestFile, JSON.stringify({ ...request, modelDir }), 'utf8');
        input.onProgress({ phase: 'loading_model', percent: 3, message: 'Starting the diffusers worker' });
        const result = await runStreaming(python, [worker, '--request', requestFile], {
            signal: input.signal,
            env: { ...process.env, ...(input.gpuIds.length ? { CUDA_VISIBLE_DEVICES: input.gpuIds.join(',') } : {}) },
            onLine: (line) => {
                if (!line.startsWith('GENVIDEO ')) {
                    input.log(line);
                    return;
                }
                try {
                    const payload = JSON.parse(line.slice('GENVIDEO '.length));
                    input.onProgress({
                        phase: (payload.phase ?? 'sampling'),
                        percent: Math.max(0, Math.min(99, Number(payload.percent) || 0)),
                        step: payload.step,
                        totalSteps: payload.total,
                        message: payload.message,
                    });
                }
                catch {
                    input.log(line);
                }
            },
        });
        if (result.code !== 0) {
            throw new GenVideoError('diffusers-failed', result.stderrTail.trim().split('\n').slice(-5).join(' ') || `Worker exited ${result.code}`);
        }
        return {
            outputPath: input.outputPath,
            width: input.width,
            height: input.height,
            fps: input.fps,
            durationSec: input.durationSec,
        };
    },
};
