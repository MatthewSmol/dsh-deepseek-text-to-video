/**
 * RU: Ошибки GenVideo с машиночитаемым кодом. Код переводится в UI, текст
 *     остаётся английским для логов, MCP и агента.
 * EN: GenVideo errors with a machine-readable code. The code is localized by the
 *     UI, while the message stays English for logs, MCP and the agent.
 */

/** RU: Прикладная ошибка сервиса. EN: Service application error. */
export class GenVideoError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, options: { status?: number; details?: unknown } = {}) {
    super(message)
    this.name = 'GenVideoError'
    this.code = code
    this.status = options.status ?? 400
    this.details = options.details
  }
}

/** RU: Преобразует любое исключение в безопасный объект для API.
 *  EN: Converts any thrown value into a safe API object. */
export function toApiError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof GenVideoError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof Error) {
    return { code: 'internal', message: error.message }
  }
  return { code: 'internal', message: String(error) }
}

/** RU: Хелпер для проверки предусловий. EN: Precondition helper. */
export function requireCondition(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new GenVideoError(code, message, { status })
}
