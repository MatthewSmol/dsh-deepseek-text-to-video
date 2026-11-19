/**
 * RU: Проверка внешних зависимостей: ffmpeg/ffprobe, Python + venv с torch/
 *     diffusers, cargo (для candle), ComfyUI и свободного места. Установка
 *     ffmpeg выполняется только с явного действия пользователя.
 * EN: External dependency checks: ffmpeg/ffprobe, Python + venv with torch/
 *     diffusers, cargo (for candle), ComfyUI and free disk space. ffmpeg is
 *     installed only on an explicit user action.
 */
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { genvideoHome, freeDiskGB, packageRoot, workdir } from './paths.js';
import { firstWorking, runCommand } from './proc.js';
/** RU: Python окружение, созданное плагином. EN: Python environment created by the plugin. */
export function venvDir() {
    return join(genvideoHome(), 'python', 'venv');
}
/** RU: Путь к python внутри venv. EN: Python path inside the venv. */
export function venvPython() {
    return join(venvDir(), 'bin', 'python');
}
/** RU: Каталог python-воркера в пакете. EN: Python worker directory inside the package. */
export function workerScriptPath() {
    return join(packageRoot(), 'python', 'genvideo_worker.py');
}
/** RU: Ищет исполняемый candle-video: настройка, env, PATH и типовые места.
 *  EN: Finds the candle-video executable: setting, env, PATH and common places. */
export function findCandleBinary(configured) {
    const candidates = [
        configured,
        process.env.CANDLE_VIDEO_BIN || '',
        ...(process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'candle-video')),
        '/usr/local/bin/candle-video',
        '/usr/bin/candle-video',
        join(homedir(), '.cargo', 'bin', 'candle-video'),
        join(workdir(), 'candle-video', 'target', 'release', 'examples', 'ltx-video'),
        join(workdir(), 'candle-video', 'target', 'release', 'candle-video'),
        join(workdir(), 'tools', 'candle-video'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            /* try the next candidate */
        }
    }
    return null;
}
// RU: Ищет nvcc из CUDA toolkit для сборки Candle.
// EN: Finds nvcc from the CUDA toolkit for building Candle.
export function findNvcc() {
    // RU: runfile-версии в /usr/local/cuda-* новее apt-пакета, поэтому сначала
    //     проверяем их, затем /usr/bin (apt) и PATH.
    // EN: runfile versions in /usr/local/cuda-* are newer than the apt package, so
    //     check them first, then /usr/bin (apt) and PATH.
    const runfile = existsSync('/usr/local')
        ? readdirSync('/usr/local')
            .filter((entry) => /^cuda-\d+(\.\d+)*$/.test(entry))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map((entry) => join('/usr/local', entry, 'bin', 'nvcc'))
        : [];
    const candidates = [
        process.env.CUDA_HOME ? join(process.env.CUDA_HOME, 'bin', 'nvcc') : '',
        process.env.CUDA_PATH ? join(process.env.CUDA_PATH, 'bin', 'nvcc') : '',
        '/usr/local/cuda/bin/nvcc',
        ...runfile,
        '/usr/bin/nvcc',
        '/usr/local/bin/nvcc',
        ...(process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'nvcc')),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            /* try the next candidate */
        }
    }
    return null;
}
// RU: Системные пакеты, нужные cargo для сборки Candle (openssl-sys).
// EN: System packages cargo needs to build Candle (openssl-sys).
export function buildToolsStatus() {
    const inPath = (name) => (process.env.PATH || '')
        .split(delimiter)
        .filter(Boolean)
        .some((dir) => existsSync(join(dir, name)));
    return {
        pkgConfig: inPath('pkg-config') || inPath('pkgconf') || existsSync('/usr/bin/pkg-config') || existsSync('/usr/bin/pkgconf'),
        openssl: existsSync('/usr/include/openssl/ssl.h') ||
            existsSync('/usr/local/include/openssl/ssl.h') ||
            existsSync('/usr/local/ssl/include/openssl/ssl.h'),
    };
}
/** RU: Кэш проверки ComfyUI, чтобы /state не сканировал порты постоянно.
 *  EN: ComfyUI probe cache so /state does not scan ports on every refresh. */
let comfyCache = null;
/** RU: Ищет запущенный ComfyUI: явный URL или типовые локальные порты.
 *  EN: Finds a running ComfyUI: explicit URL or common local ports. */
export async function detectComfyUi(configured) {
    const key = configured.trim();
    if (comfyCache && comfyCache.key === key && Date.now() - comfyCache.at < 5000)
        return comfyCache.value;
    const probes = key ? [key] : ['http://127.0.0.1:8188', 'http://127.0.0.1:8189', 'http://127.0.0.1:8000'];
    for (const probe of probes) {
        const result = await comfyuiStatus(probe);
        if (result.ok) {
            comfyCache = { at: Date.now(), key, value: result };
            return result;
        }
    }
    const value = {
        ok: false,
        url: key,
        error: key
            ? `ComfyUI is not reachable at ${key}`
            : 'ComfyUI is not running (auto-probed 127.0.0.1:8188, 8189 and 8000)',
    };
    comfyCache = { at: Date.now(), key, value };
    return value;
}
/** RU: Кандидаты ffmpeg/ffprobe. EN: ffmpeg/ffprobe candidates. */
function ffmpegCandidates(settings, tool) {
    const configured = tool === 'ffmpeg' ? settings.deps.ffmpegPath : settings.deps.ffprobePath;
    const env = tool === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
    return [configured, env || '', `/usr/bin/${tool}`, `/usr/local/bin/${tool}`, tool].filter(Boolean);
}
/** RU: Проверяет, что ffmpeg умеет нужные кодеки. EN: Checks that ffmpeg has the required codecs. */
async function ffmpegEncoders(path) {
    try {
        const result = await runCommand(path, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 });
        const names = new Set();
        for (const line of result.stdout.split(/\r?\n/)) {
            const match = line.match(/^\s*[VAS]\S{0,6}\s+(\S+)/);
            if (match?.[1] && match[1] !== '=')
                names.add(match[1]);
        }
        return Array.from(names);
    }
    catch {
        return [];
    }
}
/** RU: Состояние ComfyUI по HTTP. EN: ComfyUI state over HTTP. */
async function comfyuiStatus(url, timeoutMs = 1200) {
    const base = url.trim().replace(/\/+$/, '');
    if (!base)
        return { ok: false, url: '', error: 'ComfyUI URL is not configured' };
    try {
        const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok)
            return { ok: false, url: base, error: `HTTP ${response.status}` };
        return { ok: true, url: base, error: null };
    }
    catch (error) {
        return { ok: false, url: base, error: error instanceof Error ? error.message : String(error) };
    }
}
/** RU: Полная проверка зависимостей. EN: Full dependency check. */
export async function detectDeps(settings) {
    const checkedAt = Date.now();
    const ffmpeg = await firstWorking(ffmpegCandidates(settings, 'ffmpeg'), ['-version']);
    const ffprobe = await firstWorking(ffmpegCandidates(settings, 'ffprobe'), ['-version']);
    const encoders = ffmpeg ? await ffmpegEncoders(ffmpeg.path) : [];
    const pythonCandidates = [settings.deps.pythonPath, venvPython(), process.env.PYTHON_PATH || '', 'python3', 'python'].filter(Boolean);
    const python = await firstWorking(pythonCandidates, ['--version']);
    let venv = { ok: false, path: venvDir(), torch: null, diffusers: null, cuda: false };
    if (existsSync(venvPython())) {
        try {
            const probe = await runCommand(venvPython(), ['-c', 'import torch, diffusers; print(torch.__version__, diffusers.__version__, torch.cuda.is_available())'], { timeoutMs: 25_000 });
            if (probe.code === 0) {
                const [torchVersion, diffusersVersion, cudaFlag] = probe.stdout.trim().split(/\s+/);
                venv = {
                    ok: true,
                    path: venvDir(),
                    torch: torchVersion ?? null,
                    diffusers: diffusersVersion ?? null,
                    cuda: cudaFlag === 'True',
                };
            }
        }
        catch {
            /* venv is reported as not ready */
        }
    }
    const candlePath = findCandleBinary(settings.deps.candleBinary);
    const nvccPath = findNvcc();
    let cudaVersion = null;
    if (nvccPath) {
        const nvccInfo = await runCommand(nvccPath, ['--version'], { timeoutMs: 5000 }).catch(() => null);
        const match = nvccInfo ? /release\s+(\d+\.\d+)/i.exec(`${nvccInfo.stdout}\n${nvccInfo.stderr}`) : null;
        cudaVersion = match?.[1] ?? null;
    }
    const buildTools = buildToolsStatus();
    const cargo = await firstWorking(['cargo'], ['--version']);
    const comfy = await detectComfyUi(settings.deps.comfyuiUrl);
    const disk = await freeDiskGB(genvideoHome());
    return {
        ffmpeg: { ok: Boolean(ffmpeg), path: ffmpeg?.path ?? '', version: ffmpeg?.version ?? null, encoders },
        ffprobe: { ok: Boolean(ffprobe), path: ffprobe?.path ?? '', version: ffprobe?.version ?? null },
        python: { ok: Boolean(python), path: python?.path ?? '', version: python?.version ?? null },
        venv,
        cargo: { ok: Boolean(cargo), path: 'cargo', version: cargo?.version ?? null },
        cuda: { nvcc: Boolean(nvccPath), path: nvccPath ?? '', version: cudaVersion },
        build: buildTools,
        candle: { ok: Boolean(candlePath), path: candlePath ?? '' },
        comfyui: comfy,
        disk,
        checkedAt,
    };
}
/** RU: Пытается установить ffmpeg через apt с неинтерактивным sudo.
 *  EN: Tries to install ffmpeg via apt with non-interactive sudo. */
export async function installFfmpeg() {
    const command = 'sudo apt-get update && sudo apt-get install -y ffmpeg';
    try {
        const sudo = await runCommand('sudo', ['-n', 'true'], { timeoutMs: 5000 });
        if (sudo.code !== 0) {
            return {
                ok: false,
                message: 'Passwordless sudo is unavailable. Run the command in a terminal.',
                command,
            };
        }
        const update = await runCommand('sudo', ['-n', 'apt-get', 'update'], { timeoutMs: 180_000 });
        if (update.code !== 0) {
            return { ok: false, message: update.stderr.trim() || 'apt-get update failed', command };
        }
        const install = await runCommand('sudo', ['-n', 'apt-get', 'install', '-y', 'ffmpeg'], { timeoutMs: 600_000 });
        if (install.code !== 0) {
            return { ok: false, message: install.stderr.trim() || 'apt-get install failed', command };
        }
        return { ok: true, message: 'ffmpeg installed', command };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error), command };
    }
}
/** RU: Команда установки Python-движка (torch/diffusers) в venv.
 *  EN: Command that installs the Python engine (torch/diffusers) into the venv. */
export function pythonEngineCommand(settings, cuda) {
    const index = 'https://download.pytorch.org/whl/cpu';
    return [
        settings.deps.pythonPath || 'python3', '-m', 'venv', venvDir(),
        '&&', venvPython(), '-m', 'pip', 'install', '--upgrade', 'pip',
        '&&', venvPython(), '-m', 'pip', 'install', ...(cuda ? ['torch'] : ['--index-url', index, 'torch']),
        '&&', venvPython(), '-m', 'pip', 'install', 'diffusers', 'transformers', 'accelerate', 'safetensors', 'sentencepiece', 'imageio', 'imageio-ffmpeg',
    ];
}
