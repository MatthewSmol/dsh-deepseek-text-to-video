/**
 * RU: Загрузка весов с Hugging Face и проверка новых версий. Используется
 *     только HTTP API HF: без python-зависимостей, с Range-докачкой и
 *     проверкой размера. Токен берётся из переменной окружения (например,
 *     HF_TOKEN), чтобы не хранить секреты в настройках.
 * EN: Hugging Face weight downloads and update checks. Uses only the HF HTTP
 *     API: no Python dependencies, with Range resume and size verification. The
 *     token comes from an environment variable (for example HF_TOKEN) so secrets
 *     are not stored in settings.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GenVideoError } from './errors.js';
const HF = 'https://huggingface.co';
function authHeaders(token) {
    return token ? { authorization: `Bearer ${token}` } : {};
}
/** RU: Читает метаданные репозитория через API HF. EN: Reads repository metadata through the HF API. */
export async function fetchRemoteModel(repo, token) {
    const response = await fetch(`${HF}/api/models/${repo}?blobs=true`, {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new GenVideoError('hf-model-failed', `Hugging Face returned HTTP ${response.status} for ${repo}`, { status: 502 });
    }
    const json = (await response.json());
    const siblings = Array.isArray(json.siblings) ? json.siblings : [];
    return {
        repo,
        sha: String(json.sha ?? ''),
        lastModified: String(json.lastModified ?? ''),
        files: siblings.map((item) => ({
            path: String(item.rfilename ?? ''),
            size: Number(item.size ?? item.lfs?.size ?? 0) || 0,
        })),
    };
}
/** RU: Скачивает один файл с докачкой. EN: Downloads one file with resume. */
export async function downloadFile(input) {
    await mkdir(dirname(input.target), { recursive: true });
    const part = `${input.target}.part`;
    let start = 0;
    try {
        start = (await stat(part)).size;
    }
    catch {
        start = 0;
    }
    try {
        const existing = await stat(input.target);
        if (existing.size > 0)
            return existing.size;
    }
    catch {
        /* not downloaded yet */
    }
    const headers = { ...authHeaders(input.token) };
    if (start > 0)
        headers.range = `bytes=${start}-`;
    const url = `${HF}/${input.repo}/resolve/main/${input.file}?download=true`;
    const response = await fetch(url, { headers, signal: input.signal, redirect: 'follow' });
    if (!response.ok && response.status !== 206) {
        throw new GenVideoError('hf-download-failed', `HTTP ${response.status} for ${input.file}`, { status: 502 });
    }
    if (!response.body)
        throw new GenVideoError('hf-download-failed', `Empty response for ${input.file}`, { status: 502 });
    const totalHeader = Number(response.headers.get('content-length') ?? 0);
    const total = start + (Number.isFinite(totalHeader) ? totalHeader : 0);
    let received = start;
    let lastEmit = 0;
    const source = Readable.fromWeb(response.body);
    const sink = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    source.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 250) {
            lastEmit = now;
            input.onProgress?.({
                file: input.file,
                bytes: received,
                totalBytes: total,
                percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
            });
        }
    });
    await pipeline(source, sink);
    await rename(part, input.target);
    input.onProgress?.({ file: input.file, bytes: received, totalBytes: total, percent: 100 });
    return received;
}
/** RU: Скачивает набор файлов модели. EN: Downloads a model's file set. */
export async function downloadModelFiles(input) {
    let total = 0;
    const saved = [];
    for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index] ?? '';
        if (!file)
            continue;
        const target = join(input.targetDir, file);
        // RU: Проверяем уже скачанный файл по размеру из API.
        // EN: Skip a file that is already downloaded at the expected size.
        const remote = await fetchRemoteModel(input.repo, input.token).catch(() => null);
        const expected = remote?.files.find((item) => item.path === file)?.size ?? 0;
        const existing = await stat(target).then((item) => item.size).catch(() => 0);
        if (existing > 0 && (expected === 0 || existing === expected)) {
            total += existing;
            saved.push(target);
            input.onProgress?.({ file, bytes: existing, totalBytes: existing, percent: 100, index, count: input.files.length });
            continue;
        }
        const bytes = await downloadFile({
            repo: input.repo,
            file,
            target,
            token: input.token,
            signal: input.signal,
            onProgress: (progress) => input.onProgress?.({ ...progress, index, count: input.files.length }),
        });
        total += bytes;
        saved.push(target);
    }
    return { bytes: total, files: saved };
}
/** RU: Сравнивает локальную ревизию с удалённой. EN: Compares the local revision with the remote one. */
export async function checkRemoteRevision(repo, token) {
    const remote = await fetchRemoteModel(repo, token);
    return { sha: remote.sha, lastModified: remote.lastModified };
}
/** RU: Ищет модели того же семейства, обновлённые позже известной.
 *  EN: Finds models in the same family updated after the known revision. */
export async function findNewerCandidates(input) {
    const limit = input.limit ?? 8;
    const response = await fetch(`${HF}/api/models?search=${encodeURIComponent(input.query)}&sort=lastModified&direction=-1&limit=30`, { headers: authHeaders(input.token), signal: AbortSignal.timeout(15_000) });
    if (!response.ok)
        return [];
    const json = (await response.json());
    const known = input.knownRevision ? Date.parse(input.knownRevision) : 0;
    // RU: Отсеиваем случайные репозитории: оставляем проверенных авторов или
    //     популярные модели, иначе подсказка «новая версия» превращается в шум.
    // EN: Filter out random repos: keep trusted authors or popular models,
    //     otherwise the "newer version" hint becomes noise.
    const trustedAuthors = ['lightricks', 'sulphurai', 'oxide-lab'];
    return json
        .filter((item) => String(item.id ?? '') !== input.currentRepo)
        .filter((item) => Array.isArray(item.tags) && item.tags.some((tag) => /ltx|sulphur/i.test(tag)))
        .filter((item) => {
        const id = String(item.id ?? '');
        const author = id.split('/')[0]?.toLowerCase() ?? '';
        const downloads = Number(item.downloads ?? 0);
        return trustedAuthors.includes(author) || downloads >= 500;
    })
        .sort((a, b) => Number(b.downloads ?? 0) - Number(a.downloads ?? 0))
        .slice(0, limit)
        .map((item) => ({
        repo: String(item.id ?? ''),
        reason: `Updated ${String(item.lastModified ?? '')}${Number.isFinite(known) && known > 0 ? ' (newer than the known revision)' : ''}`,
        sizeGB: 0,
    }));
}
/** RU: Удаляет частично скачанный файл. EN: Removes a partially downloaded file. */
export async function removePartial(target) {
    await unlink(`${target}.part`).catch(() => undefined);
}
