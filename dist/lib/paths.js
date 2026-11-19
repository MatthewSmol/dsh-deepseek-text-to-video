/**
 * RU: Пути GenVideo. Рабочая папка проекта задаётся GENVIDEO_WORKDIR (DSH
 *     запускает сервис с cwd проекта), модели лежат в `<workdir>/models`,
 *     результаты — в `<workdir>/Videos`. Служебные данные (настройки, задания,
 *     логи, endpoint) — в `GENVIDEO_HOME`.
 * EN: GenVideo paths. The project working directory comes from GENVIDEO_WORKDIR
 *     (DSH starts the service with the project cwd), models live in
 *     `<workdir>/models`, results in `<workdir>/Videos`. Service data
 *     (settings, jobs, logs, endpoint) lives in `GENVIDEO_HOME`.
 */
import { mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { mkdir, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GenVideoError } from './errors.js';
/** RU: Домашняя папка DSH. EN: DSH home directory. */
export function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
/** RU: Корень пакета плагина. Вычисляется из расположения dist/lib, поэтому
 *     не зависит от cwd процесса, запущенного DSH.
 *  EN: Plugin package root. Derived from the dist/lib location, so it does not
 *     depend on the cwd of the process DSH spawned. */
export function packageRoot() {
    try {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    }
    catch {
        return process.cwd();
    }
}
/** RU: Рабочая папка проекта (модели и Videos лежат здесь). По умолчанию —
 *     корень пакета, а не случайный cwd.
 *  EN: Project working directory (models and Videos live here). Defaults to the
 *     package root instead of an arbitrary cwd. */
export function workdir() {
    return process.env.GENVIDEO_WORKDIR || packageRoot();
}
/** RU: Служебная папка сервиса. EN: Service data directory. */
export function genvideoHome() {
    return process.env.GENVIDEO_HOME || join(dshHome(), 'genvideo');
}
/** RU: Папка моделей по умолчанию. EN: Default models directory. */
export function defaultModelsDir() {
    return process.env.GENVIDEO_MODELS_DIR || join(workdir(), 'models');
}
/** RU: Папка видео по умолчанию. EN: Default videos directory. */
export function defaultVideosDir() {
    return join(workdir(), 'Videos');
}
/** RU: Пользовательские загрузки (картинки/видео для i2v/v2v). EN: User uploads. */
export function inputsDir() {
    return join(genvideoHome(), 'inputs');
}
/** RU: Промежуточные файлы заданий. EN: Job scratch space. */
export function scratchDir() {
    return join(genvideoHome(), 'work');
}
/** RU: Логи заданий. EN: Job logs. */
export function logsDir() {
    return join(genvideoHome(), 'logs');
}
/** RU: Файл с портом/токеном MCP-сервиса. EN: MCP service endpoint file. */
export function endpointFile() {
    return process.env.GENVIDEO_ENDPOINT_FILE || join(genvideoHome(), 'endpoint.json');
}
/** RU: Файл настроек. EN: Settings file. */
export function settingsFile() {
    return join(genvideoHome(), 'settings.json');
}
/** RU: Файл истории заданий. EN: Job history file. */
export function jobsFile() {
    return join(genvideoHome(), 'jobs.json');
}
/** RU: Создаёт папку синхронно (для старта сервиса). EN: Creates a directory synchronously. */
export function ensureDirSync(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/** RU: Создаёт все служебные папки. EN: Creates every service directory. */
export function ensureServiceDirs(modelsDirPath = defaultModelsDir(), videosDirPath = defaultVideosDir()) {
    for (const dir of [genvideoHome(), inputsDir(), scratchDir(), logsDir(), modelsDirPath, videosDirPath]) {
        ensureDirSync(dir);
    }
}
/** RU: Проверяет, что путь находится внутри корня (защита от `..`).
 *  EN: Ensures a path stays inside a root directory (traversal guard). */
export function assertInside(root, candidate) {
    const rootAbs = resolve(root);
    const pathAbs = resolve(candidate);
    const rel = relative(rootAbs, pathAbs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new GenVideoError('path-escape', `Path escapes ${basename(rootAbs)}`, { status: 403 });
    }
    return pathAbs;
}
/** RU: Безопасное имя файла: только буквы, цифры, точка, дефис, подчёркивание.
 *  EN: Safe file name: letters, digits, dot, dash, underscore only. */
export function safeBaseName(name) {
    // RU: Сначала берём только последний сегмент пути, затем чистим символы —
    //     так `../../etc/passwd` не может выйти за пределы папки.
    // EN: Take only the last path segment first, then sanitize — this way
    //     `../../etc/passwd` can never escape the target folder.
    const base = String(name || '').split(/[\\/]/).pop() ?? '';
    const cleaned = base
        .normalize('NFKD')
        .replace(/[^\w.\-]+/g, '_')
        .replace(/^\.+/, '')
        .replace(/\.{2,}/g, '.')
        .slice(0, 120);
    return cleaned || 'file';
}
/** RU: Короткий ASCII-слаг из промпта. EN: Short ASCII slug from a prompt. */
export function slugify(text, fallback = 'video') {
    const slug = String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return slug || fallback;
}
/** RU: Метка времени для имени файла: 20261119-091530.
 *  EN: File-name timestamp: 20261119-091530. */
export function stamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/** RU: Имя итогового ролика. EN: Final video name. */
export function outputFileName(options) {
    const ext = String(options.ext || 'mp4').replace(/^\./, '').toLowerCase();
    return `${stamp(options.date)}_${safeBaseName(options.platform || 'custom')}_${slugify(options.prompt)}_${options.seed >= 0 ? options.seed : 'rand'}.${ext}`;
}
/** RU: Читает JSON-файл, возвращая fallback при любой ошибке.
 *  EN: Reads a JSON file, returning the fallback on any error. */
export function readJsonFile(file, fallback) {
    try {
        if (!existsSync(file))
            return fallback;
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
/** RU: Атомарная запись JSON (0600). EN: Atomic JSON write (0600). */
export async function writeJsonAtomic(file, value) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, file);
    }
    catch (error) {
        try {
            await unlink(tmp);
        }
        catch { /* best effort */ }
        throw error;
    }
}
/** RU: Свободное место на диске в ГБ. EN: Free disk space in GB. */
export async function freeDiskGB(path = genvideoHome()) {
    try {
        const stats = statSync(path);
        void stats;
    }
    catch {
        /* directory may not exist yet */
    }
    try {
        const { statfs } = await import('node:fs/promises');
        const info = await statfs(path);
        const block = Number(info.bsize);
        return {
            freeGB: (Number(info.bavail) * block) / 1e9,
            totalGB: (Number(info.blocks) * block) / 1e9,
        };
    }
    catch {
        return { freeGB: 0, totalGB: 0 };
    }
}
/** RU: Нормализует путь относительно workdir для отображения.
 *  EN: Normalizes a path relative to workdir for display. */
export function displayPath(path) {
    return normalize(path.split(sep).join('/'));
}
