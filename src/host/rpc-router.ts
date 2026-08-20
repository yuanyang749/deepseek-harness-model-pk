import type {
  AttachmentBeginRequest,
  AttachmentChunkRequest,
  BaselineSelectRequest,
  ConfirmWarningRequest,
  DraftCreateRequest,
  DraftUpdateRequest,
  ExperimentPollRequest,
  Hash,
  OperationEnvelope,
  RetryRequest,
  StartRequest,
  StopRequest,
  UUID,
  WireResult,
} from '../contracts/types.js'
import { RPC_ENDPOINTS, type RpcEndpoint } from '../contracts/rpc.js'
import { LIMITS } from '../contracts/constants.js'
import { normalizeError } from '../core/error.js'
import { isHash } from '../core/jcs.js'
import {
  assertNoUnknownKeys,
  assertRecord,
  optionalString,
  requiredHash,
  requiredInteger,
  requiredString,
  requiredStringArray,
} from '../core/validation.js'
import type { CompatibilityEvidence } from './compatibility.js'
import type { Coordinator } from './coordinator.js'
import type { DraftService } from './drafts.js'
import type { ModelCatalog } from './model-catalog.js'
import type { PreflightService } from './preflight.js'

export interface RpcServices {
  readonly compatibility: () => CompatibilityEvidence
  readonly drafts: DraftService
  readonly preflight: PreflightService
  readonly models: ModelCatalog
  readonly coordinator: Coordinator
}

type HostRpcResult = {
  readonly ok: true
  readonly value: WireResult<unknown>
}

export function createBusinessRpcHandler(services: RpcServices): (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<HostRpcResult> {
  return async (endpoint, payload, signal) => safeRpc(endpoint, async () => {
    switch (endpoint as RpcEndpoint) {
      case RPC_ENDPOINTS.capabilitiesGet:
        emptyObject(payload)
        return services.compatibility().report
      case RPC_ENDPOINTS.modelsList:
        emptyObject(payload)
        return services.models.list()
      case RPC_ENDPOINTS.draftCreate:
        return services.drafts.create(parseDraftCreate(payload))
      case RPC_ENDPOINTS.draftGet:
        return services.drafts.get(idObject(payload, 'draftId').draftId)
      case RPC_ENDPOINTS.draftUpdate:
        return services.drafts.update(parseDraftUpdate(payload))
      case RPC_ENDPOINTS.attachmentBegin:
        return services.drafts.beginAttachment(parseAttachmentBegin(payload))
      case RPC_ENDPOINTS.attachmentChunk:
        return services.drafts.writeAttachmentChunk(parseAttachmentChunk(payload))
      case RPC_ENDPOINTS.attachmentCommit:
        return services.drafts.commitAttachment(idObject(payload, 'uploadId').uploadId)
      case RPC_ENDPOINTS.attachmentRemove: {
        const request = revisionedIdObject(payload, 'attachmentId')
        return services.drafts.removeAttachment(request.draftId, request.expectedRevision, request.attachmentId)
      }
      case RPC_ENDPOINTS.baselineSelect:
        return services.drafts.selectBaseline(parseBaselineSelect(payload))
      case RPC_ENDPOINTS.baselineClear: {
        const request = revisionedObject(payload)
        return services.drafts.clearBaseline(request.draftId, request.expectedRevision)
      }
      case RPC_ENDPOINTS.preflightRun:
        return services.preflight.run(idObject(payload, 'draftId').draftId)
      case RPC_ENDPOINTS.preflightConfirm: {
        const request = parseConfirmWarning(payload)
        return services.preflight.confirmWarning(request.draftId, request.preflightId, request.snapshotHash)
      }
      case RPC_ENDPOINTS.experimentStart:
        return services.coordinator.startExperiment(parseEnvelope(payload, parseStart))
      case RPC_ENDPOINTS.attemptStop:
        return services.coordinator.stopAttempt(parseEnvelope(payload, parseStop))
      case RPC_ENDPOINTS.experimentStopAll:
        return services.coordinator.stopAll(parseEnvelope(payload, value => idObject(value, 'experimentId')))
      case RPC_ENDPOINTS.runRetry:
        return services.coordinator.retry(parseEnvelope(payload, parseRetry))
      case RPC_ENDPOINTS.runAgain:
        return services.coordinator.runAgain(parseEnvelope(payload, parseRetry))
      case RPC_ENDPOINTS.experimentRetryFailed:
        return services.coordinator.retryFailed(parseEnvelope(payload, value => idObject(value, 'experimentId')))
      case RPC_ENDPOINTS.experimentGet:
        return services.coordinator.getExperiment(idObject(payload, 'experimentId').experimentId)
      case RPC_ENDPOINTS.experimentPoll:
        return services.coordinator.poll(parsePoll(payload), signal)
      case RPC_ENDPOINTS.storageListForDeletion:
        emptyObject(payload)
        return services.coordinator.listStorage()
      case RPC_ENDPOINTS.experimentDelete:
        return services.coordinator.deleteExperiment(parseEnvelope(payload, value => idObject(value, 'experimentId')))
      case RPC_ENDPOINTS.experimentOpenFolder:
        throw new Error('native endpoint must use /model-pk-native')
      default:
        throw new Error(`unsupported endpoint: ${endpoint}`)
    }
  })
}

export function createNativeRpcHandler(services: RpcServices): (
  endpoint: string,
  payload: unknown,
) => Promise<HostRpcResult> {
  return async (endpoint, payload) => safeRpc(endpoint, async () => {
    if (endpoint === RPC_ENDPOINTS.experimentOpenFolder) {
      return services.coordinator.openFolder(idObject(payload, 'experimentId').experimentId)
    }
    if (endpoint === RPC_ENDPOINTS.attemptOpenResult) {
      const request = parseOpenResult(payload)
      return services.coordinator.openResult(request.experimentId, request.attemptId)
    }
    if (endpoint === RPC_ENDPOINTS.baselineChooseFolder) {
      return services.coordinator.chooseBaselineFolder()
    }
    throw new Error(`unsupported native endpoint: ${endpoint}`)
  })
}

async function safeRpc(endpoint: string, operation: () => Promise<unknown> | unknown): Promise<HostRpcResult> {
  try {
    return { ok: true, value: { ok: true, value: await operation() } }
  } catch (error) {
    return { ok: true, value: { ok: false, error: normalizeError(error, `rpc:${endpoint}`) } }
  }
}

function parseDraftCreate(value: unknown): DraftCreateRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['taskName', 'taskType', 'prompt'])
  const taskName = optionalString(value, 'taskName')
  const taskType = optionalString(value, 'taskType')
  const prompt = optionalString(value, 'prompt')
  return {
    ...(taskName === undefined ? {} : { taskName }),
    ...(taskType === undefined ? {} : { taskType }),
    ...(prompt === undefined ? {} : { prompt }),
  }
}

function parseDraftUpdate(value: unknown): DraftUpdateRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'expectedRevision', 'patch'])
  const draftId = uuid(value, 'draftId')
  const expectedRevision = requiredInteger(value, 'expectedRevision')
  const rawPatch = value.patch
  assertRecord(rawPatch, 'patch')
  assertNoUnknownKeys(rawPatch, ['taskName', 'taskType', 'prompt', 'selectedModelConfigIds', 'concurrency', 'attachmentOrder'], 'patch')
  const taskName = optionalString(rawPatch, 'taskName')
  const taskType = optionalString(rawPatch, 'taskType')
  const prompt = optionalString(rawPatch, 'prompt')
  const selected = rawPatch.selectedModelConfigIds === undefined ? undefined : requiredStringArray(rawPatch, 'selectedModelConfigIds')
  if (selected?.some(item => !isHash(item))) throw new Error('selectedModelConfigIds contains an invalid hash')
  const concurrency = rawPatch.concurrency === undefined
    ? undefined
    : requiredInteger(rawPatch, 'concurrency', 1, LIMITS.modelMax)
  const attachmentOrder = rawPatch.attachmentOrder === undefined ? undefined : requiredStringArray(rawPatch, 'attachmentOrder')
  attachmentOrder?.forEach(item => assertUuid(item, 'attachmentOrder'))
  return {
    draftId,
    expectedRevision,
    patch: {
      ...(taskName === undefined ? {} : { taskName }),
      ...(taskType === undefined ? {} : { taskType }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(selected === undefined ? {} : { selectedModelConfigIds: selected as Hash[] }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(attachmentOrder === undefined ? {} : { attachmentOrder }),
    },
  }
}

function parseAttachmentBegin(value: unknown): AttachmentBeginRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'expectedRevision', 'name', 'mimeType', 'byteLength', 'expectedHash'])
  return {
    draftId: uuid(value, 'draftId'),
    expectedRevision: requiredInteger(value, 'expectedRevision'),
    name: requiredString(value, 'name'),
    mimeType: requiredString(value, 'mimeType'),
    byteLength: requiredInteger(value, 'byteLength', 1, LIMITS.imageBytes),
    expectedHash: requiredHash(value, 'expectedHash'),
  }
}

function parseAttachmentChunk(value: unknown): AttachmentChunkRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['uploadId', 'offset', 'bytesBase64'])
  const bytesBase64 = requiredString(value, 'bytesBase64')
  if (bytesBase64.length > Math.ceil(LIMITS.uploadChunkBytes / 3) * 4 + 4) throw new Error('attachment chunk exceeds the wire limit')
  return {
    uploadId: uuid(value, 'uploadId'),
    offset: requiredInteger(value, 'offset'),
    bytesBase64,
  }
}

function parseBaselineSelect(value: unknown): BaselineSelectRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'expectedRevision', 'sourcePath'])
  return {
    draftId: uuid(value, 'draftId'),
    expectedRevision: requiredInteger(value, 'expectedRevision'),
    sourcePath: requiredString(value, 'sourcePath'),
  }
}

function parseConfirmWarning(value: unknown): ConfirmWarningRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'preflightId', 'snapshotHash'])
  return {
    draftId: uuid(value, 'draftId'),
    preflightId: uuid(value, 'preflightId'),
    snapshotHash: requiredHash(value, 'snapshotHash'),
  }
}

function parseStart(value: unknown): StartRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'preflightId', 'snapshotHash'])
  return {
    draftId: uuid(value, 'draftId'),
    preflightId: uuid(value, 'preflightId'),
    snapshotHash: requiredHash(value, 'snapshotHash'),
  }
}

function parseStop(value: unknown): StopRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['experimentId', 'attemptId', 'expectedLifecycleVersion'])
  return {
    experimentId: uuid(value, 'experimentId'),
    attemptId: uuid(value, 'attemptId'),
    expectedLifecycleVersion: requiredInteger(value, 'expectedLifecycleVersion'),
  }
}

function parseRetry(value: unknown): RetryRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['experimentId', 'runId', 'expectedAttemptId'])
  return {
    experimentId: uuid(value, 'experimentId'),
    runId: uuid(value, 'runId'),
    expectedAttemptId: uuid(value, 'expectedAttemptId'),
  }
}

function parsePoll(value: unknown): ExperimentPollRequest {
  assertRecord(value)
  assertNoUnknownKeys(value, ['experimentId', 'afterCursor'])
  return {
    experimentId: uuid(value, 'experimentId'),
    afterCursor: requiredInteger(value, 'afterCursor'),
  }
}

function parseEnvelope<T>(value: unknown, parseRequest: (value: unknown) => T): OperationEnvelope<T> {
  assertRecord(value)
  assertNoUnknownKeys(value, ['operationId', 'request'])
  return { operationId: uuid(value, 'operationId'), request: parseRequest(value.request) }
}

function parseOpenResult(value: unknown): { experimentId: UUID; attemptId: UUID } {
  assertRecord(value)
  assertNoUnknownKeys(value, ['experimentId', 'attemptId'])
  return { experimentId: uuid(value, 'experimentId'), attemptId: uuid(value, 'attemptId') }
}

function idObject<K extends string>(value: unknown, key: K): Record<K, UUID> {
  assertRecord(value)
  assertNoUnknownKeys(value, [key])
  return { [key]: uuid(value, key) } as Record<K, UUID>
}

function revisionedObject(value: unknown): { draftId: UUID; expectedRevision: number } {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'expectedRevision'])
  return { draftId: uuid(value, 'draftId'), expectedRevision: requiredInteger(value, 'expectedRevision') }
}

function revisionedIdObject<K extends string>(value: unknown, key: K): {
  draftId: UUID
  expectedRevision: number
} & Record<K, UUID> {
  assertRecord(value)
  assertNoUnknownKeys(value, ['draftId', 'expectedRevision', key])
  return {
    draftId: uuid(value, 'draftId'),
    expectedRevision: requiredInteger(value, 'expectedRevision'),
    [key]: uuid(value, key),
  } as { draftId: UUID; expectedRevision: number } & Record<K, UUID>
}

function emptyObject(value: unknown): void {
  assertRecord(value)
  assertNoUnknownKeys(value, [])
}

function uuid(record: Record<string, unknown>, key: string): UUID {
  const value = requiredString(record, key)
  assertUuid(value, key)
  return value
}

function assertUuid(value: string, key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${key} must be a UUID`)
  }
}
