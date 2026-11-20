/**
 * RU: Запуск внешних процессов (ffmpeg, ffprobe, python, cargo) без внешних
 *     зависимостей. Все вызовы принимают AbortSignal, чтобы отмена задания
 *     гарантированно убивала дочерний процесс.
 * EN: External process execution (ffmpeg, ffprobe, python, cargo) without
 *     third-party dependencies. Every call accepts an AbortSignal so cancelling
 *     a job reliably kills the child process.
 */
import { spawn } from 'node:child_process'

/** RU: Результат короткой команды. EN: Result of a short command. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** RU: Опции запуска. EN: Spawn options. */
export interface RunOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  maxOutput?: number
}

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_OUTPUT = 1_048_576

/** RU: Запускает команду и собирает stdout/stderr с лимитом.
 *  EN: Runs a command and collects stdout/stderr with a cap. */
export function runCommand(command: string, args: string[] = [], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, code = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ code, stdout, stderr })
    }
    const kill = () => {
      try { child.kill('SIGKILL') } catch { /* best effort */ }
    }
    const timer = setTimeout(() => {
      kill()
      finish(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, Math.max(1000, timeoutMs))
    const onAbort = () => {
      kill()
      finish(new Error('aborted'))
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => finish(null, code ?? (signal ? 1 : 0)))
  })
}

/** RU: Колбэк построчного чтения. EN: Line callback. */
export type LineSink = (line: string, stream: 'stdout' | 'stderr') => void

/** RU: Запускает команду, отдавая строки вывода построчно, и возвращает код
 *     выхода и хвост stderr. Используется для ffmpeg -progress и логов
 *     раннеров.
 *  EN: Runs a command, delivering output line by line, and returns the exit code
 *     and stderr tail. Used for ffmpeg -progress and runner logs. */
export function runStreaming(
  command: string,
  args: string[],
  options: RunOptions & { onLine?: LineSink; onStdout?: (text: string) => void; onStderr?: (text: string) => void } = {},
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      })
    } catch (error) {
      reject(error)
      return
    }

    let settled = false
    let stderrTail = ''
    const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
    const finish = (error: Error | null, code = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ code, stderrTail })
    }
    const kill = () => {
      try { child.kill('SIGKILL') } catch { /* best effort */ }
    }
    const timeoutMs = options.timeoutMs ?? 0
    const timer = timeoutMs > 0
      ? setTimeout(() => { kill(); finish(new Error(`${command} timed out after ${timeoutMs}ms`)) }, timeoutMs)
      : undefined
    const onAbort = () => { kill(); finish(new Error('aborted')) }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stream === 'stdout') options.onStdout?.(text)
      else {
        options.onStderr?.(text)
        stderrTail = (stderrTail + text).slice(-8192)
      }
      pending[stream] += text
      const lines = pending[stream].split(/\r?\n/)
      pending[stream] = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        options.onLine?.(line, stream)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => feed('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => feed('stderr', chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const rest = pending[stream].trim()
        if (rest) options.onLine?.(rest, stream)
      }
      finish(null, code ?? 0)
    })
  })
}

/** RU: Ищет первый рабочий исполняемый файл из кандидатов по `--version`.
 *  EN: Finds the first working executable among candidates via `--version`. */
export async function firstWorking(candidates: string[], args: string[] = ['--version']): Promise<{ path: string; version: string } | null> {
  for (const command of candidates) {
    if (!command) continue
    try {
      const result = await runCommand(command, args, { timeoutMs: 8000 })
      if (result.code === 0) {
        const version = (result.stdout.split('\n')[0] || result.stderr.split('\n')[0] || '').trim()
        return { path: command, version }
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}
