/**
 * RU: Определение GPU и её памяти. Используется nvidia-smi (NVIDIA), а при
 *     ошибке NVML — понятная диагностика для WSL/драйвера. Оценка «хватит ли
 *     VRAM» живёт в planner.ts.
 * EN: GPU and VRAM detection. Uses nvidia-smi (NVIDIA); on NVML failure it
 *     produces actionable WSL/driver diagnostics. The "does VRAM fit" estimate
 *     lives in planner.ts.
 */
import { existsSync } from 'node:fs';
import { runCommand } from './proc.js';
const QUERY = 'index,name,memory.total,memory.used,driver_version,compute_cap';
/** RU: Парсит CSV-ответ nvidia-smi. EN: Parses the nvidia-smi CSV answer. */
export function parseNvidiaSmiCsv(text) {
    const gpus = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // RU: name может содержать запятые, поэтому режем по первой и последним пяти полям.
        // EN: name may contain commas, so split on the first and the last five fields.
        const firstComma = trimmed.indexOf(',');
        if (firstComma < 0)
            continue;
        const index = Number(trimmed.slice(0, firstComma));
        const rest = trimmed.slice(firstComma + 1);
        const tail = rest.split(',');
        if (tail.length < 6)
            continue;
        const computeCap = tail[tail.length - 1].trim();
        const driver = tail[tail.length - 2].trim();
        const used = Number(tail[tail.length - 3]);
        const total = Number(tail[tail.length - 4]);
        const name = tail.slice(0, tail.length - 5).join(',').trim();
        if (!Number.isFinite(index))
            continue;
        gpus.push({
            index,
            name: name || 'NVIDIA GPU',
            totalMB: Number.isFinite(total) ? total : 0,
            usedMB: Number.isFinite(used) ? used : 0,
            driver,
            computeCap,
        });
    }
    return gpus;
}
/** RU: Подсказки для WSL/драйвера. EN: WSL/driver hints. */
function hintsFor(error) {
    const hints = [];
    const message = error.toLowerCase();
    if (message.includes('nvml') || message.includes('initialize')) {
        hints.push('Update the Windows NVIDIA driver (not inside WSL) and run `nvidia-smi` in this WSL shell.');
        hints.push('Check that /usr/lib/wsl/lib/libcuda.so.1 exists and that CUDA passthrough is enabled in .wslconfig.');
    }
    if (existsSync('/usr/lib/wsl/lib/libcuda.so.1')) {
        hints.push('WSL CUDA libraries exist but the device is not exposed; a driver update or WSL restart is usually required.');
    }
    hints.push('The plugin stays usable with the Mock runner and ffmpeg-only operations.');
    return hints;
}
/** RU: Опрашивает nvidia-smi и возвращает состояние GPU.
 *  EN: Queries nvidia-smi and returns the GPU state. */
export async function detectGpus() {
    const checkedAt = Date.now();
    try {
        const result = await runCommand('nvidia-smi', [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits'], { timeoutMs: 8000 });
        if (result.code !== 0) {
            const error = (result.stderr || result.stdout || `nvidia-smi exited ${result.code}`).trim();
            return { available: false, gpus: [], error, hints: hintsFor(error), checkedAt };
        }
        const gpus = parseNvidiaSmiCsv(result.stdout);
        if (!gpus.length) {
            const error = 'nvidia-smi returned no GPUs';
            return { available: false, gpus: [], error, hints: hintsFor(error), checkedAt };
        }
        return { available: true, gpus, error: null, hints: [], checkedAt };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { available: false, gpus: [], error: message, hints: hintsFor(message), checkedAt };
    }
}
/** RU: Выбирает GPU по настройкам; пустой список = первая доступная.
 *  EN: Picks GPUs from settings; an empty list means the first available one. */
export function selectGpus(status, ids) {
    if (!status.available)
        return [];
    if (!ids.length)
        return status.gpus.slice(0, 1);
    return status.gpus.filter((gpu) => ids.includes(gpu.index));
}
