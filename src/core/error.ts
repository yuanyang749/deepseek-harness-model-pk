import type { ModelPkError, ModelPkErrorCode } from '../contracts/types.js'

const RETRYABLE_CODES = new Set<ModelPkErrorCode>([
  'DSH_UNREACHABLE',
  'PROVIDER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'PREFLIGHT_STALE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_ERROR',
  'PROVIDER_5XX',
  'EMPTY_RESPONSE',
  'DSH_RUNNER_ERROR',
  'PROCESS_EXITED',
  'DISPATCH_UNCERTAIN',
  'STREAM_DISCONNECTED',
  'WORKER_DISCONNECTED',
  'STALL_TIMEOUT',
  'EXECUTION_TIMEOUT',
  'CANCEL_FAILED',
  'RECOVERY_UNRESOLVED',
  'ACTION_TARGET_STALE',
  'CONTROL_STORE_UNAVAILABLE',
])

export class ModelPkException extends Error {
  readonly detail: ModelPkError

  constructor(detail: ModelPkError) {
    super(detail.technicalMessage)
    this.name = 'ModelPkException'
    this.detail = detail
  }
}

export interface ErrorOptions {
  readonly retryable?: boolean
  readonly providerCode?: string
  readonly providerRequestId?: string
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

export function modelPkError(
  code: ModelPkErrorCode,
  phase: string,
  userMessage: string,
  technicalMessage: string,
  options: ErrorOptions = {},
): ModelPkError {
  const details = options.details === undefined ? undefined : redactObject(options.details)
  return {
    code,
    phase,
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    userMessage,
    technicalMessage: redactTechnical(technicalMessage),
    ...(options.providerCode === undefined ? {} : { providerCode: redactTechnical(options.providerCode) }),
    ...(options.providerRequestId === undefined ? {} : { providerRequestId: redactTechnical(options.providerRequestId) }),
    occurredAt: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  }
}

export function fail(
  code: ModelPkErrorCode,
  phase: string,
  userMessage: string,
  technicalMessage = userMessage,
  options?: ErrorOptions,
): never {
  throw new ModelPkException(modelPkError(code, phase, userMessage, technicalMessage, options))
}

export function normalizeError(error: unknown, phase: string): ModelPkError {
  if (error instanceof ModelPkException) return error.detail
  const message = error instanceof Error ? error.message : String(error)
  const code = isNoSpaceError(error) ? 'DISK_FULL' : 'INTERNAL_ERROR'
  return modelPkError(code, phase, '操作未完成', message, { retryable: code !== 'DISK_FULL' })
}

function isNoSpaceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOSPC'
}

const SECRET_PATTERNS = [
  /\b(?:sk|api|token|key)[-_][A-Za-z0-9._-]{8,}\b/giu,
  /\b(?:authorization|api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
  /(?:^|\s)\/(?:Users|home)\/[^\s]+/gu,
]

export function redactTechnical(value: string): string {
  let result = value.slice(0, 8192)
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]')
  return result
}

function redactObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/secret|password|token|authorization|api.?key/iu.test(key)) {
      result[key] = '[REDACTED]'
    } else if (typeof item === 'string') {
      result[key] = redactTechnical(item)
    } else if (Array.isArray(item)) {
      result[key] = item.map(element => typeof element === 'string' ? redactTechnical(element) : element)
    } else if (item !== null && typeof item === 'object') {
      result[key] = redactObject(item as Record<string, unknown>)
    } else {
      result[key] = item
    }
  }
  return Object.freeze(result)
}

