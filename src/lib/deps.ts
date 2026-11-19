/**
 * RU: Проверка внешних зависимостей: ffmpeg/ffprobe, Python + venv с torch/
 *     diffusers, cargo (для candle), ComfyUI и свободного места. Установка
 *     ffmpeg выполняется только с явного действия пользователя.
 * EN: External dependency checks: ffmpeg/ffprobe, Python + venv with torch/
 *     diffusers, cargo (for candle), ComfyUI and free disk space. ffmpeg is
 *     installed only on an explicit user action.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DepsStatus, Settings } from './types.js'
import { genvideoHome, freeDiskGB } from './paths.js'
import { firstWorking, runCommand } from './proc.js'

/** RU: Python окружение, созданное плагином. EN: Python environment created by the plugin. */
export function venvDir(): string {
  return join(genvideoHome(), 'python', 'venv')
}

/** RU: Путь к python внутри venv. EN: Python path inside the venv. */
export function venvPython(): string {
  return join(venvDir(), 'bin', 'python')
}

/** RU: Каталог python-воркера в пакете. EN: Python worker directory inside the package. */
export function workerScriptPath(): string {
  return join(genvideoHome(), '..', '..', 'TextToVideo', 'python', 'genvideo_worker.py')
}

/** RU: Кандидаты ffmpeg/ffprobe. EN: ffmpeg/ffprobe candidates. */
function ffmpegCandidates(settings: Settings, tool: 'ffmpeg' | 'ffprobe'): string[] {
  const configured = tool === 'ffmpeg' ? settings.deps.ffmpegPath : settings.deps.ffprobePath
  const env = tool === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH
  return [configured, env || '', `/usr/bin/${tool}`, `/usr/local/bin/${tool}`, tool].filter(Boolean)
}

/** RU: Проверяет, что ffmpeg умеет нужные кодеки. EN: Checks that ffmpeg has the required codecs. */
async function ffmpegEncoders(path: string): Promise<string[]> {
  try {
    const result = await runCommand(path, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 })
    const names = new Set<string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*[VAS]\S{0,6}\s+(\S+)/)
      if (match?.[1] && match[1] !== '=') names.add(match[1])
    }
    return Array.from(names)
  } catch {
    return []
  }
}

/** RU: Состояние ComfyUI по HTTP. EN: ComfyUI state over HTTP. */
async function comfyuiStatus(url: string): Promise<{ ok: boolean; url: string; error: string | null }> {
  const base = url.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, url: '', error: 'ComfyUI URL is not configured' }
  try {
    const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return { ok: false, url: base, error: `HTTP ${response.status}` }
    return { ok: true, url: base, error: null }
  } catch (error) {
    return { ok: false, url: base, error: error instanceof Error ? error.message : String(error) }
  }
}

/** RU: Полная проверка зависимостей. EN: Full dependency check. */
export async function detectDeps(settings: Settings): Promise<DepsStatus> {
  const checkedAt = Date.now()
  const ffmpeg = await firstWorking(ffmpegCandidates(settings, 'ffmpeg'), ['-version'])
  const ffprobe = await firstWorking(ffmpegCandidates(settings, 'ffprobe'), ['-version'])
  const encoders = ffmpeg ? await ffmpegEncoders(ffmpeg.path) : []

  const pythonCandidates = [settings.deps.pythonPath, venvPython(), process.env.PYTHON_PATH || '', 'python3', 'python'].filter(Boolean)
  const python = await firstWorking(pythonCandidates, ['--version'])

  let venv = { ok: false, path: venvDir(), torch: null as string | null, diffusers: null as string | null, cuda: false }
  if (existsSync(venvPython())) {
    try {
      const probe = await runCommand(
        venvPython(),
        ['-c', 'import torch, diffusers; print(torch.__version__, diffusers.__version__, torch.cuda.is_available())'],
        { timeoutMs: 25_000 },
      )
      if (probe.code === 0) {
        const [torchVersion, diffusersVersion, cudaFlag] = probe.stdout.trim().split(/\s+/)
        venv = {
          ok: true,
          path: venvDir(),
          torch: torchVersion ?? null,
          diffusers: diffusersVersion ?? null,
          cuda: cudaFlag === 'True',
        }
      }
    } catch {
      /* venv is reported as not ready */
    }
  }

  const cargo = await firstWorking([settings.deps.candleBinary ? 'cargo' : 'cargo'], ['--version'])
  const comfy = await comfyuiStatus(settings.deps.comfyuiUrl)
  const disk = await freeDiskGB(genvideoHome())

  return {
    ffmpeg: { ok: Boolean(ffmpeg), path: ffmpeg?.path ?? '', version: ffmpeg?.version ?? null, encoders },
    ffprobe: { ok: Boolean(ffprobe), path: ffprobe?.path ?? '', version: ffprobe?.version ?? null },
    python: { ok: Boolean(python), path: python?.path ?? '', version: python?.version ?? null },
    venv,
    cargo: { ok: Boolean(cargo), path: 'cargo', version: cargo?.version ?? null },
    comfyui: comfy,
    disk,
    checkedAt,
  }
}

/** RU: Пытается установить ffmpeg через apt с неинтерактивным sudo.
 *  EN: Tries to install ffmpeg via apt with non-interactive sudo. */
export async function installFfmpeg(): Promise<{ ok: boolean; message: string; command: string }> {
  const command = 'sudo apt-get update && sudo apt-get install -y ffmpeg'
  try {
    const sudo = await runCommand('sudo', ['-n', 'true'], { timeoutMs: 5000 })
    if (sudo.code !== 0) {
      return {
        ok: false,
        message: 'Passwordless sudo is unavailable. Run the command in a terminal.',
        command,
      }
    }
    const update = await runCommand('sudo', ['-n', 'apt-get', 'update'], { timeoutMs: 180_000 })
    if (update.code !== 0) {
      return { ok: false, message: update.stderr.trim() || 'apt-get update failed', command }
    }
    const install = await runCommand('sudo', ['-n', 'apt-get', 'install', '-y', 'ffmpeg'], { timeoutMs: 600_000 })
    if (install.code !== 0) {
      return { ok: false, message: install.stderr.trim() || 'apt-get install failed', command }
    }
    return { ok: true, message: 'ffmpeg installed', command }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), command }
  }
}

/** RU: Команда установки Python-движка (torch/diffusers) в venv.
 *  EN: Command that installs the Python engine (torch/diffusers) into the venv. */
export function pythonEngineCommand(settings: Settings, cuda: boolean): string[] {
  const index = cuda ? 'https://download.pytorch.org/whl/cu124' : 'https://download.pytorch.org/whl/cpu'
  return [
    'python3', '-m', 'venv', venvDir(),
    '&&', venvPython(), '-m', 'pip', 'install', '--upgrade', 'pip',
    '&&', venvPython(), '-m', 'pip', 'install', '--index-url', index, 'torch',
    '&&', venvPython(), '-m', 'pip', 'install', 'diffusers', 'transformers', 'accelerate', 'safetensors', 'sentencepiece', 'imageio', 'imageio-ffmpeg',
  ]
}
