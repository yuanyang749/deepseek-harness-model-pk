export const PLUGIN_ID = 'dsh-model-pk'
export const PLUGIN_VERSION = '0.1.0'
export const SCHEMA_VERSION = 'model-pk/v1'
export const DSH_VERSION = '0.1.0-rc.7'
export const DSH_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const HARNESS_PRESET = 'model-pk-v1'
export const BUSINESS_RPC_CHANNEL = '/model-pk'
export const NATIVE_RPC_CHANNEL = '/model-pk-native'

export const LIMITS = Object.freeze({
  taskNameCodePoints: 120,
  taskTypeCodePoints: 64,
  promptBytes: 1024 * 1024,
  modelMin: 2,
  modelMax: 10,
  imageCount: 10,
  imageBytes: 20 * 1024 * 1024,
  imageTotalBytes: 50 * 1024 * 1024,
  baselineBytes: 5 * 1024 * 1024 * 1024,
  baselineFiles: 200_000,
  outputTokens: 8192,
  maxSteps: 64,
  maxParallelToolCalls: 1,
  defaultConcurrencyCap: 4,
  eventPollMs: 1000,
  uploadChunkBytes: 1024 * 1024,
  draftTtlMs: 24 * 60 * 60 * 1000,
  noProgressWarningMs: 3 * 60 * 1000,
  stalledMs: 5 * 60 * 1000,
  executionTimeoutMs: 30 * 60 * 1000,
  cancelGraceMs: 10 * 1000,
  prepareTimeoutMs: 2 * 60 * 1000,
  recoveryTimeoutMs: 2 * 60 * 1000,
  finalizationTimeoutMs: 2 * 60 * 1000,
  controlSlotBytes: 256 * 1024,
})

export const TOOL_NAMES = Object.freeze(['bash', 'read', 'write', 'edit', 'glob', 'grep'] as const)

export const IMAGE_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
] as const)

export const TERMINAL_ATTEMPT_STATES = Object.freeze([
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'STALLED',
  'DISCONNECTED',
  'CANCELLED',
] as const)

export const NON_TERMINAL_ATTEMPT_STATES = Object.freeze([
  'QUEUED',
  'PREPARING',
  'DISPATCHING',
  'RUNNING',
  'RECOVERING',
  'CANCELLING',
  'FINALIZING',
] as const)

