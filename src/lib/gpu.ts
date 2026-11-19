/**
 * RU: Определение GPU и её памяти. Используется nvidia-smi (NVIDIA), а при
 *     ошибке NVML — понятная диагностика для WSL/драйвера. Оценка «хватит ли
 *     VRAM» живёт в planner.ts.
 * EN: GPU and VRAM detection. Uses nvidia-smi (NVIDIA); on NVML failure it
 *     produces actionable WSL/driver diagnostics. The "does VRAM fit" estimate
 *     lives in planner.ts.
 */
import { existsSync } from 'node:fs'
import type { GpuInfo, GpuStatus } from './types.js'
import { runCommand } from './proc.js'

const QUERY = 'index,name,memory.total,memory.used,driver_version,compute_cap'
const WINDOWS_SMI = '/mnt/c/Windows/System32/nvidia-smi.exe'

/** RU: Парсит CSV-ответ nvidia-smi. EN: Parses the nvidia-smi CSV answer. */
export function parseNvidiaSmiCsv(text: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // RU: name может содержать запятые, поэтому режем по первой и последним пяти полям.
    // EN: name may contain commas, so split on the first and the last five fields.
    const firstComma = trimmed.indexOf(',')
    if (firstComma < 0) continue
    const index = Number(trimmed.slice(0, firstComma))
    const rest = trimmed.slice(firstComma + 1)
    const tail = rest.split(',')
    // RU: после index идут 5 полей: name, total, used, driver, compute_cap.
    //     name может содержать запятые, поэтому отделяем его по остатку.
    // EN: index is followed by 5 fields: name, total, used, driver, compute_cap.
    //     name may contain commas, so keep everything before the last four.
    if (tail.length < 5) continue
    const computeCap = tail[tail.length - 1].trim()
    const driver = tail[tail.length - 2].trim()
    const used = Number(tail[tail.length - 3])
    const total = Number(tail[tail.length - 4])
    const name = tail.slice(0, tail.length - 4).join(',').trim()
    if (!Number.isFinite(index)) continue
    gpus.push({
      index,
      name: name || 'NVIDIA GPU',
      totalMB: Number.isFinite(total) ? total : 0,
      usedMB: Number.isFinite(used) ? used : 0,
      driver,
      computeCap,
    })
  }
  return gpus
}

/** RU: Подсказки для WSL/драйвера. EN: WSL/driver hints. */
function hintsFor(error: string): string[] {
  const hints: string[] = []
  const message = error.toLowerCase()
  if (message.includes('nvml') || message.includes('initialize')) {
    hints.push('Update the Windows NVIDIA driver (not inside WSL) and run `nvidia-smi` in this WSL shell.')
    hints.push('Check that /usr/lib/wsl/lib/libcuda.so.1 exists and that CUDA passthrough is enabled in .wslconfig.')
  }
  if (existsSync('/usr/lib/wsl/lib/libcuda.so.1')) {
    hints.push('WSL CUDA libraries exist but the device is not exposed; a driver update or WSL restart is usually required.')
  }
  hints.push('The plugin stays usable with the Mock runner and ffmpeg-only operations.')
  return hints
}

/** RU: Один запрос к указанному nvidia-smi. EN: One query to a given nvidia-smi. */
async function queryNvidiaSmi(command: string): Promise<{ ok: true; gpus: GpuInfo[] } | { ok: false; error: string }> {
  const result = await runCommand(
    command,
    [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits'],
    { timeoutMs: 12_000 },
  )
  if (result.code !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `nvidia-smi exited ${result.code}`).trim() }
  }
  const gpus = parseNvidiaSmiCsv(result.stdout)
  if (!gpus.length) return { ok: false, error: 'nvidia-smi returned no GPUs' }
  return { ok: true, gpus }
}

/** RU: Подсказки, когда карты видны из Windows, но не проброшены в WSL.
 *  EN: Hints for "GPUs visible from Windows but not passed through to WSL". */
function windowsHints(): string[] {
  return [
    'The GPUs are visible through the Windows driver, but /dev/nvidia* is missing inside WSL.',
    'Update the Windows NVIDIA driver, then run `wsl --shutdown` in PowerShell and reopen WSL.',
    'Real CUDA generation will fail until passthrough is restored; the Mock runner still works.',
  ]
}

/** RU: Опрашивает nvidia-smi и возвращает состояние GPU. Если NVML в WSL
 *      сломан, но Windows-драйвер карты видит, показывает их с предупреждением.
 *  EN: Queries nvidia-smi and returns the GPU state. If WSL NVML is broken but
 *      the Windows driver sees the cards, it lists them with a warning. */
export async function detectGpus(): Promise<GpuStatus> {
  const checkedAt = Date.now()
  const errors: string[] = []

  for (const command of ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']) {
    try {
      const attempt = await queryNvidiaSmi(command)
      if (attempt.ok) {
        return { available: true, gpus: attempt.gpus, error: null, hints: [], checkedAt, source: 'linux' }
      }
      errors.push(attempt.error)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const nativeError = errors[0] ?? 'nvidia-smi is unavailable'

  // RU: WSL часто теряет /dev/nvidia* после обновления драйвера, но
  //     nvidia-smi.exe из Windows продолжает видеть карты. Показываем их,
  //     чтобы настройки GPU и объём памяти оставались осмысленными.
  // EN: WSL often loses /dev/nvidia* after a driver update, while the Windows
  //     nvidia-smi.exe still sees the cards. Show them so GPU settings and
  //     VRAM numbers stay meaningful.
  if (existsSync(WINDOWS_SMI)) {
    try {
      const attempt = await queryNvidiaSmi(WINDOWS_SMI)
      if (attempt.ok) {
        return {
          available: true,
          gpus: attempt.gpus,
          error: `GPUs detected through the Windows driver, but WSL CUDA passthrough is unavailable (${nativeError})`,
          hints: windowsHints(),
          checkedAt,
          source: 'windows',
        }
      }
    } catch {
      /* ignore the fallback failure; the native error is more useful */
    }
  }

  return { available: false, gpus: [], error: nativeError, hints: hintsFor(nativeError), checkedAt }
}

/** RU: Выбирает GPU по настройкам; пустой список = первая доступная.
 *  EN: Picks GPUs from settings; an empty list means the first available one. */
export function selectGpus(status: GpuStatus, ids: number[]): GpuInfo[] {
  if (!status.available) return []
  if (!ids.length) return status.gpus.slice(0, 1)
  return status.gpus.filter((gpu) => ids.includes(gpu.index))
}
