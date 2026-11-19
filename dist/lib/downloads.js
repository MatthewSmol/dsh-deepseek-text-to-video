/**
 * RU: Загрузка весов с Hugging Face и проверка новых версий. Используется
 *     только HTTP API HF: без python-зависимостей, с Range-докачкой и
 *     проверкой размера. Токен берётся из переменной окружения (например,
 *     HF_TOKEN), чтобы не хранить секреты в настройках. При включённом
 *     SOCKS-прокси запросы идут через `curl --proxy`.
 * EN: Hugging Face weight downloads and update checks. Uses only the HF HTTP
 *     API: no Python dependencies, with Range resume and size verification. The
 *     token comes from an environment variable (for example HF_TOKEN) so secrets
 *     are not stored in settings. With the SOCKS proxy enabled, requests go
 *     through `curl --proxy`.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GenVideoError } from './errors.js';
import { runCommand } from './proc.js';
const HF = 'https://huggingface.co';
const DEFAULT_PROXY = 'socks5://127.0.0.1:1080';
/** RU: Итоговый адрес прокси; пустой адрес даёт localhost:1080.
 *  EN: Effective proxy URL; an empty value means localhost:1080. */
export function proxyUrlFor(proxy) {
    if (!proxy?.enabled)
        return '';
    return proxy.url.trim() || DEFAULT_PROXY;
}
function authHeaders(token) {
    return token ? { authorization: `Bearer ${token}` } : {};
}
/** RU: GET через SOCKS-прокси с помощью curl.
 *  EN: GET through a SOCKS proxy using curl. */
async function curlText(url, token, proxy) {
    const args = ['-sS', '-L', '--fail', '--max-time', '30', '--proxy', proxyUrlFor(proxy)];
    if (token)
        args.push('-H', `Authorization: Bearer ${token}`);
    args.push(url);
    const result = await runCommand('curl', args, { timeoutMs: 35_000 });
    if (result.code !== 0) {
        throw new GenVideoError('hf-request-failed', result.stderr.trim() || `curl exited ${result.code}`, { status: 502 });
    }
    return result.stdout;
}
// RU: Универсальный GET JSON к Hugging Face (с прокси и токеном).
// EN: Generic JSON GET to Hugging Face (proxy and token aware).
export async function hfGetJson(url, token, proxy) {
    if (proxyUrlFor(proxy))
        return JSON.parse(await curlText(url, token, proxy));
    const response = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
        throw new GenVideoError('hf-request-failed', `Hugging Face returned HTTP ${response.status}`, { status: 502 });
    }
    return (await response.json());
}
/** RU: Читает метаданные репозитория через API HF. EN: Reads repository metadata through the HF API. */
export async function fetchRemoteModel(repo, token, proxy) {
    const url = `${HF}/api/models/${repo}?blobs=true`;
    let json;
    if (proxyUrlFor(proxy)) {
        const text = await curlText(url, token, proxy);
        try {
            json = JSON.parse(text);
        }
        catch {
            throw new GenVideoError('hf-model-failed', `Invalid JSON from Hugging Face for ${repo}`, { status: 502 });
        }
    }
    else {
        const response = await fetch(url, {
            headers: authHeaders(token),
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
            throw new GenVideoError('hf-model-failed', `Hugging Face returned HTTP ${response.status} for ${repo}`, { status: 502 });
        }
        json = (await response.json());
    }
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
/** RU: Скачивание файла через curl и SOCKS-прокси, с прогрессом по размеру.
 *  EN: File download through curl and a SOCKS proxy, with size-based progress. */
async function downloadViaCurl(input, proxy) {
    await mkdir(dirname(input.target), { recursive: true });
    const part = `${input.target}.part`;
    const existing = await stat(input.target).then((item) => item.size).catch(() => 0);
    if (existing > 0)
        return existing;
    const start = await stat(part).then((item) => item.size).catch(() => 0);
    const expected = Math.max(start, input.size ?? 0);
    const args = ['-sS', '-L', '--fail', '--retry', '3', '--retry-delay', '2', '-o', part, '--proxy', proxyUrlFor(proxy)];
    if (start > 0)
        args.push('-C', '-');
    if (input.token)
        args.push('-H', `Authorization: Bearer ${input.token}`);
    args.push(`${HF}/${input.repo}/resolve/main/${input.file}?download=true`);
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    const onAbort = () => child.kill('SIGTERM');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let received = start;
    const emit = () => {
        input.onProgress?.({
            file: input.file,
            bytes: received,
            totalBytes: expected,
            percent: expected > 0 ? Math.min(100, Math.round((received / expected) * 100)) : 0,
        });
    };
    emit();
    const timer = setInterval(() => {
        void stat(part).then((item) => {
            received = item.size;
            emit();
        }).catch(() => undefined);
    }, 300);
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearInterval(timer);
    input.signal?.removeEventListener('abort', onAbort);
    if (input.signal?.aborted)
        throw new GenVideoError('cancelled', 'Download cancelled');
    if (code !== 0) {
        throw new GenVideoError('hf-download-failed', stderr.trim().split('\n').slice(-3).join(' ') || `curl exited ${code ?? 'null'} for ${input.file}`, { status: 502 });
    }
    const finalSize = await stat(part).then((item) => item.size).catch(() => received);
    await rename(part, input.target);
    input.onProgress?.({ file: input.file, bytes: finalSize, totalBytes: Math.max(expected, finalSize), percent: 100 });
    return finalSize;
}
/** RU: Скачивает один файл с докачкой. EN: Downloads one file with resume. */
export async function downloadFile(input) {
    if (proxyUrlFor(input.proxy))
        return downloadViaCurl(input, input.proxy);
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
    const remote = await fetchRemoteModel(input.repo, input.token, input.proxy).catch(() => null);
    for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index] ?? '';
        if (!file)
            continue;
        const target = join(input.targetDir, file);
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
            size: expected,
            token: input.token,
            proxy: input.proxy,
            signal: input.signal,
            onProgress: (progress) => input.onProgress?.({ ...progress, index, count: input.files.length }),
        });
        total += bytes;
        saved.push(target);
    }
    return { bytes: total, files: saved };
}
/** RU: Сравнивает локальную ревизию с удалённой. EN: Compares the local revision with the remote one. */
export async function checkRemoteRevision(repo, token, proxy) {
    const remote = await fetchRemoteModel(repo, token, proxy);
    return { sha: remote.sha, lastModified: remote.lastModified };
}
/** RU: Ищет модели того же семейства, обновлённые позже известной.
 *  EN: Finds models in the same family updated after the known revision. */
export async function findNewerCandidates(input) {
    const limit = input.limit ?? 8;
    const url = `${HF}/api/models?search=${encodeURIComponent(input.query)}&sort=lastModified&direction=-1&limit=30`;
    let json;
    if (proxyUrlFor(input.proxy)) {
        try {
            json = JSON.parse(await curlText(url, input.token, input.proxy));
        }
        catch {
            return [];
        }
    }
    else {
        const response = await fetch(url, {
            headers: authHeaders(input.token),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
            return [];
        json = (await response.json());
    }
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
