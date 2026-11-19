/**
 * RU: Очередь заданий GenVideo. Две полосы: `gpu` (одна задача на видеокарту,
 *     последовательно) и `media` (ffmpeg-склейка/перекодирование, до двух
 *     параллельно). Задания переживают перезапуск сервиса, отмена убивает
 *     дочерние процессы через AbortSignal.
 * EN: GenVideo job queue. Two lanes: `gpu` (one job at a time on the GPU) and
 *     `media` (ffmpeg merge/transcode, up to two in parallel). Jobs survive a
 *     service restart, and cancellation kills child processes via AbortSignal.
 */
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GenVideoError } from './errors.js';
import { jobsFile, logsDir, readJsonFile, writeJsonAtomic, ensureDirSync } from './paths.js';
/** RU: Менеджер заданий. EN: Job manager. */
export class JobManager {
    file;
    retention;
    jobs = new Map();
    executors = new Map();
    aborters = new Map();
    listeners = new Set();
    lanes = { gpu: [], media: [] };
    running = { gpu: false, media: false };
    seq = 0;
    saveTimer = null;
    lastEmit = new Map();
    constructor(file = jobsFile(), retention = { jobs: 200, logBytes: 2_000_000 }) {
        this.file = file;
        this.retention = retention;
        ensureDirSync(logsDir());
        this.load();
    }
    /** RU: Загружает историю и помечает прерванные задания. EN: Loads history and marks interrupted jobs. */
    load() {
        const raw = readJsonFile(this.file, []);
        if (!Array.isArray(raw))
            return;
        for (const item of raw.slice(-this.retention.jobs)) {
            if (!item || typeof item !== 'object')
                continue;
            const record = item;
            if (!record.id || !record.kind)
                continue;
            if (record.status === 'running' || record.status === 'queued') {
                record.status = 'failed';
                record.phase = 'failed';
                record.error = { code: 'interrupted', message: 'The service restarted before this job finished' };
                record.finishedAt = Date.now();
            }
            this.jobs.set(record.id, record);
        }
    }
    /** RU: Подписка на события (SSE). EN: Event subscription (SSE). */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** RU: Список заданий, новые первыми. EN: Jobs list, newest first. */
    list(limit = 50) {
        return Array.from(this.jobs.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, Math.max(1, Math.min(500, limit)))
            .map((job) => structuredClone(job));
    }
    /** RU: Одно задание по id. EN: One job by id. */
    get(id) {
        const job = this.jobs.get(id);
        return job ? structuredClone(job) : null;
    }
    /** RU: Активные задания. EN: Active jobs. */
    active() {
        return this.list(500).filter((job) => job.status === 'running' || job.status === 'queued');
    }
    /** RU: Создаёт запись задания (ещё не запущенную). EN: Creates a job record (not started yet). */
    create(kind, params) {
        const job = {
            id: randomUUID(),
            kind,
            status: 'queued',
            phase: 'queued',
            percent: 0,
            message: '',
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            params,
            progress: { segmentIndex: 0, segmentCount: 0, step: 0, totalSteps: 0, etaMs: null, bytes: null, totalBytes: null },
            segments: [],
            outputs: [],
            error: null,
            logTail: [],
        };
        this.jobs.set(job.id, job);
        this.trim();
        this.emit({ seq: this.nextSeq(), kind: 'job', job: structuredClone(job) });
        this.persist();
        return job;
    }
    /** RU: Ставит задание в очередь и запускает полосу. EN: Enqueues a job and starts its lane. */
    start(job, executor) {
        this.executors.set(job.id, executor);
        const lane = job.kind === 'generate' || job.kind === 'install' ? 'gpu' : 'media';
        this.lanes[lane].push(job.id);
        void this.pump(lane);
    }
    /** RU: Отменяет задание (в очереди — сразу, в работе — через abort).
     *  EN: Cancels a job (queued immediately, running through abort). */
    cancel(id) {
        const job = this.jobs.get(id);
        if (!job)
            return false;
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
            return false;
        if (job.status === 'queued') {
            for (const lane of ['gpu', 'media']) {
                this.lanes[lane] = this.lanes[lane].filter((item) => item !== id);
            }
            this.finish(job, 'cancelled', 'cancelled', { code: 'cancelled', message: 'Cancelled before start' });
            return true;
        }
        this.aborters.get(id)?.abort();
        return true;
    }
    /** RU: Внутренний насос полосы. EN: Lane pump. */
    async pump(lane) {
        if (this.running[lane])
            return;
        const id = this.lanes[lane].shift();
        if (!id)
            return;
        const job = this.jobs.get(id);
        const executor = this.executors.get(id);
        if (!job || !executor) {
            this.executors.delete(id);
            void this.pump(lane);
            return;
        }
        this.running[lane] = true;
        job.status = 'running';
        job.startedAt = Date.now();
        job.phase = 'resolving';
        job.message = 'Starting';
        this.emitJob(job, true);
        this.persist();
        const controller = new AbortController();
        this.aborters.set(id, controller);
        const context = this.createContext(job, controller.signal);
        try {
            await executor(context);
            if (controller.signal.aborted)
                this.finish(job, 'cancelled', 'cancelled', { code: 'cancelled', message: 'Cancelled' });
            else
                this.finish(job, 'done', 'done', null);
        }
        catch (error) {
            if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                this.finish(job, 'cancelled', 'cancelled', { code: 'cancelled', message: 'Cancelled' });
            }
            else if (error instanceof GenVideoError) {
                this.finish(job, 'failed', 'failed', { code: error.code, message: error.message, details: error.details });
            }
            else {
                this.finish(job, 'failed', 'failed', {
                    code: 'executor-failed',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        finally {
            this.aborters.delete(id);
            this.executors.delete(id);
            this.running[lane] = false;
            void this.pump(lane);
        }
    }
    /** RU: Создаёт контекст исполнителя. EN: Creates the executor context. */
    createContext(job, signal) {
        const touch = (force) => {
            const now = Date.now();
            const previous = this.lastEmit.get(job.id) ?? 0;
            if (!force && now - previous < 150)
                return;
            this.lastEmit.set(job.id, now);
            this.emitJob(job, force);
        };
        const appendLog = (line) => {
            const text = String(line).slice(0, 4000);
            job.logTail.push(text);
            if (job.logTail.length > 200)
                job.logTail.splice(0, job.logTail.length - 200);
            this.emit({ seq: this.nextSeq(), kind: 'log', jobId: job.id, line: text });
            void this.appendLogFile(job.id, text);
        };
        return {
            job,
            signal,
            phase(phase, message) {
                job.phase = phase;
                if (message)
                    job.message = message;
                touch(true);
            },
            progress(patch) {
                if (typeof patch.percent === 'number')
                    job.percent = Math.max(0, Math.min(100, Math.round(patch.percent)));
                if (typeof patch.message === 'string')
                    job.message = patch.message;
                for (const key of ['segmentIndex', 'segmentCount', 'step', 'totalSteps', 'etaMs', 'bytes', 'totalBytes']) {
                    const value = patch[key];
                    if (value !== undefined) {
                        ;
                        job.progress[key] = value;
                    }
                }
                touch(false);
            },
            log: appendLog,
            segments(count) {
                job.progress.segmentCount = Math.max(0, Math.floor(count));
                job.progress.segmentIndex = 0;
                job.segments = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => ({
                    index,
                    status: 'queued',
                    percent: 0,
                }));
                touch(true);
            },
            segment(index, status, percent) {
                const segment = job.segments[index];
                if (!segment)
                    return;
                segment.status = status;
                segment.percent = Math.max(0, Math.min(100, Math.round(percent)));
                job.progress.segmentIndex = index;
                touch(false);
            },
            output(artifact) {
                job.outputs.push(artifact);
                touch(true);
            },
        };
    }
    /** RU: Завершает задание. EN: Finalizes a job. */
    finish(job, status, phase, error) {
        job.status = status;
        job.phase = phase;
        job.finishedAt = Date.now();
        job.error = error;
        if (status === 'done') {
            job.percent = 100;
            job.message = 'Done';
            job.segments = job.segments.map((segment) => ({ ...segment, status: 'done', percent: 100 }));
        }
        else if (status === 'cancelled') {
            job.message = 'Cancelled';
            job.segments = job.segments.map((segment) => segment.status === 'running' || segment.status === 'queued' ? { ...segment, status: 'cancelled' } : segment);
        }
        else {
            job.message = error?.message ?? 'Failed';
        }
        this.emitJob(job, true);
        this.persist(true);
    }
    /** RU: Отправляет событие задания. EN: Emits a job event. */
    emitJob(job, force) {
        if (!force) {
            // RU: Редкие обновления всё равно нужны для плавного прогресса.
            // EN: Sparse updates are still needed for smooth progress.
        }
        this.emit({ seq: this.nextSeq(), kind: 'job', job: structuredClone(job) });
    }
    /** RU: Отправляет событие подписчикам. EN: Sends an event to subscribers. */
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch {
                /* a broken SSE client must not break the queue */
            }
        }
    }
    /** RU: Монотонный номер события. EN: Monotonic event sequence. */
    nextSeq() {
        this.seq += 1;
        return this.seq;
    }
    /** RU: Пишет хвост лога в файл с ограничением. EN: Appends to the log file with a cap. */
    async appendLogFile(jobId, line) {
        const file = join(logsDir(), `${jobId}.log`);
        try {
            await appendFile(file, `${line}\n`, 'utf8');
            const info = await stat(file);
            if (info.size > this.retention.logBytes) {
                const job = this.jobs.get(jobId);
                await writeFile(file, `${(job?.logTail ?? []).slice(-50).join('\n')}\n`, 'utf8');
            }
        }
        catch {
            /* logging must never fail a job */
        }
    }
    /** RU: Ограничивает историю. EN: Trims the history. */
    trim() {
        if (this.jobs.size <= this.retention.jobs)
            return;
        const sorted = Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
        for (const job of sorted.slice(0, this.jobs.size - this.retention.jobs)) {
            if (job.status === 'running' || job.status === 'queued')
                continue;
            this.jobs.delete(job.id);
        }
    }
    /** RU: Планирует запись истории на диск. EN: Schedules a history write. */
    persist(immediate = false) {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        const write = () => {
            this.saveTimer = null;
            const snapshot = Array.from(this.jobs.values())
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-this.retention.jobs)
                .map((job) => ({ ...job, logTail: job.logTail.slice(-40) }));
            void writeJsonAtomic(this.file, snapshot).catch(() => undefined);
        };
        if (immediate)
            write();
        else
            this.saveTimer = setTimeout(write, 800);
    }
    /** RU: Останавливает таймеры при выключении сервиса. EN: Stops timers on shutdown. */
    dispose() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = null;
        for (const controller of this.aborters.values())
            controller.abort();
        this.aborters.clear();
    }
}
/** RU: Создаёт файл истории, если его нет (для первого запуска).
 *  EN: Creates the history file when missing (first launch). */
export async function ensureJobsFile(file = jobsFile()) {
    await mkdir(join(file, '..'), { recursive: true }).catch(() => undefined);
}
