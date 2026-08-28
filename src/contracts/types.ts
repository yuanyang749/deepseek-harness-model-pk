import type { TERMINAL_ATTEMPT_STATES, NON_TERMINAL_ATTEMPT_STATES } from './constants.js'

export type IsoDateTime = string
export type Hash = `sha256:${string}`
export type UUID = string

export type AttemptTerminalState = typeof TERMINAL_ATTEMPT_STATES[number]
export type AttemptNonTerminalState = typeof NON_TERMINAL_ATTEMPT_STATES[number]
export type AttemptState = AttemptTerminalState | AttemptNonTerminalState
export type AttemptTrigger = 'INITIAL' | 'RETRY' | 'RUN_AGAIN' | 'RETRY_FAILED'
export type ExperimentLifecycle = 'STARTING' | 'ACTIVE' | 'START_FAILED' | 'SETTLED'
export type ExperimentOutcome = 'ALL_SUCCEEDED' | 'PARTIAL_SUCCESS' | 'NONE_SUCCEEDED' | 'ALL_CANCELLED' | null
export type ArchiveCompleteness = 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE'
export type ArchiveFreshness = 'CURRENT' | 'STALE'
export type ArchiveIntegrity = 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE'
export type WorkspaceSealState = 'OPEN' | 'SEALED' | 'QUARANTINED_UNSAFE'
export type ReservationState = 'NOT_ACQUIRED' | 'HELD' | 'RELEASED' | 'ORPHANED'
export type FinalizationStage =
  | 'INTENT_RECORDED'
  | 'ISOLATION_RESOLVED'
  | 'ARCHIVE_RESOLVED'
  | 'CONTROL_COMMITTED'
export type CancelReason = 'USER_CANCELLED' | 'STOP_ALL' | 'FORCE_CANCELLED_AFTER_GRACE'
export type PreflightStatus = 'READY' | 'WARNING' | 'BLOCKED'
export type CheckStatus = 'PASS' | 'WARNING' | 'BLOCKED'
export type UploadState = 'UPLOADING' | 'READY' | 'FAILED'
export type ActionKind = 'START' | 'STOP' | 'STOP_ALL' | 'RETRY' | 'RUN_AGAIN' | 'RETRY_FAILED' | 'DELETE'
export type ActionState = 'PENDING' | 'APPLIED' | 'FAILED'

export type ModelPkErrorCode =
  | 'DSH_UNREACHABLE'
  | 'DSH_VERSION_UNSUPPORTED'
  | 'MODEL_CONFIG_NOT_FOUND'
  | 'MODEL_CONFIG_DRIFT'
  | 'HARNESS_PROFILE_DRIFT'
  | 'RUNTIME_VERSION_DRIFT'
  | 'ADAPTER_VERSION_DRIFT'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'IMAGE_INPUT_UNSUPPORTED'
  | 'ATTACHMENT_INVALID'
  | 'ATTACHMENT_CONTENT_TRANSFORMED'
  | 'ATTACHMENT_TRANSFORM_UNVERIFIED'
  | 'INPUT_ENCODING_INVALID'
  | 'INPUT_TOO_LARGE'
  | 'PARAMETER_UNSUPPORTED'
  | 'SESSION_ISOLATION_UNSUPPORTED'
  | 'EXECUTION_ISOLATION_UNSUPPORTED'
  | 'HARNESS_PROFILE_UNAVAILABLE'
  | 'WORKSPACE_NOT_READABLE'
  | 'ARCHIVE_NOT_WRITABLE'
  | 'CONTROL_STORE_CAPACITY_UNAVAILABLE'
  | 'PREFLIGHT_STALE'
  | 'WARNING_CONFIRMATION_REQUIRED'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_HASH_MISMATCH'
  | 'WORKSPACE_PREPARE_FAILED'
  | 'WORKSPACE_NOT_CLEAN'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_5XX'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_INPUT'
  | 'CONTENT_POLICY_REJECTED'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'EMPTY_RESPONSE'
  | 'ADAPTER_ERROR'
  | 'DSH_RUNNER_ERROR'
  | 'PROCESS_EXITED'
  | 'DISPATCH_UNCERTAIN'
  | 'STREAM_DISCONNECTED'
  | 'WORKER_DISCONNECTED'
  | 'STALL_TIMEOUT'
  | 'EXECUTION_TIMEOUT'
  | 'ARCHIVE_WRITE_FAILED'
  | 'RESULT_EXPORT_FAILED'
  | 'DISK_FULL'
  | 'ARCHIVE_PATH_ESCAPE'
  | 'CANCEL_FAILED'
  | 'RECOVERY_UNRESOLVED'
  | 'EXECUTION_ISOLATION_UNRESOLVED'
  | 'START_COMMIT_FAILED'
  | 'ACTION_ID_CONFLICT'
  | 'ACTION_TARGET_STALE'
  | 'CONTROL_STORE_UNAVAILABLE'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_ENDPOINT'
  | 'DELETE_NOT_ALLOWED'
  | 'NATIVE_HELPER_UNAVAILABLE'
  | 'NATIVE_HELPER_INVALID'
  | 'INTERNAL_ERROR'

export interface ModelPkError {
  readonly code: ModelPkErrorCode
  readonly phase: string
  readonly retryable: boolean
  readonly userMessage: string
  readonly technicalMessage: string
  readonly providerCode?: string
  readonly providerRequestId?: string
  readonly occurredAt: IsoDateTime
  readonly details?: Readonly<Record<string, unknown>>
}

export type WireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ModelPkError }

export interface OperationEnvelope<T> {
  readonly operationId: UUID
  readonly request: T
}

export interface ModelListItem {
  readonly modelConfigId: Hash
  readonly providerRoute: string
  readonly modelId: string
  readonly displayName: string
  readonly providerDisplayName: string
  readonly inputModalities: readonly ('text' | 'image')[]
  readonly adapterKind: 'deepseek' | 'pi-ai' | 'unknown'
  readonly protocol?: 'deepseek-chat' | 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  readonly support: 'SUPPORTED' | 'BLOCKED'
  readonly supportReason?: string
}

export interface ModelConfigSnapshot {
  readonly schemaVersion: 'model-pk/model-config/v1'
  readonly modelConfigId: Hash
  readonly providerRoute: string
  readonly providerProfileId: string
  readonly providerDisplayName: string
  readonly modelId: string
  readonly modelName: string
  readonly adapterPackage: string
  readonly adapterVersion: string
  readonly protocol: string
  readonly revision: string
  readonly inputModalities: readonly ('text' | 'image')[]
  readonly contextWindow: number | null
  readonly defaultMaxTokens: number | null
  /** Resolved model output capability, distinct from the request default. */
  readonly outputTokenCapacity: number | null
  readonly maxOutputTokens: number
  readonly reasoning: boolean | null
  readonly nonSensitiveSettings: Readonly<Record<string, unknown>>
  readonly retryPolicy: Readonly<Record<string, unknown>>
  readonly serializerDependencies: Readonly<Record<string, string>>
  readonly fingerprint: Hash
}

export interface AttachmentRecord {
  readonly attachmentId: UUID
  readonly draftId: UUID
  readonly ordinal: number
  readonly name: string
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly byteLength: number
  readonly hash: Hash
  readonly state: UploadState
  readonly immutablePath?: string
  readonly error?: ModelPkError
}

export interface BaselineSnapshot {
  readonly sourcePath: string
  readonly objectHash: Hash
  readonly byteLength: number
  readonly fileCount: number
  readonly directoryCount: number
  readonly manifestPath: string
  readonly scannedAt: IsoDateTime
}

export interface Draft {
  readonly draftId: UUID
  readonly revision: number
  readonly taskName: string
  readonly taskType: string
  readonly prompt: string
  readonly promptHash: Hash
  readonly selectedModelConfigIds: readonly Hash[]
  readonly attachments: readonly AttachmentRecord[]
  readonly baseline: BaselineSnapshot | null
  readonly resultRootPath: string | null
  readonly concurrency: number
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface TaskPackage {
  readonly schemaVersion: 'model-pk/task-package/v1'
  readonly taskName: string
  readonly taskType: string
  readonly prompt: string
  readonly promptHash: Hash
  readonly attachments: readonly Omit<AttachmentRecord, 'draftId' | 'state' | 'error'>[]
  readonly baseline: BaselineSnapshot | null
  readonly selectedModelConfigIds: readonly Hash[]
}

export interface ExecutionConditions {
  readonly schemaVersion: 'model-pk/execution-conditions/v1'
  readonly concurrency: number
  readonly maxParallelToolCalls: 1
  readonly maxSteps: 64
  readonly maxOutputTokens: 8192
  readonly noProgressWarningMs: number
  readonly stalledMs: number
  readonly executionTimeoutMs: number
  readonly cancelGraceMs: number
  readonly prepareTimeoutMs: number
  readonly recoveryTimeoutMs: number
  readonly finalizationTimeoutMs: number
}

export interface ResolvedHarness {
  readonly schemaVersion: 'model-pk/harness/v1'
  readonly preset: 'model-pk-v1'
  readonly systemPrompt: string
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
    readonly output: Readonly<Record<string, unknown>>
  }[]
  readonly toolNames: readonly string[]
  readonly permissions: Readonly<Record<string, unknown>>
  readonly agentLoop: Readonly<Record<string, unknown>>
  readonly sandbox: Readonly<Record<string, unknown>>
  readonly contextPolicy: Readonly<Record<string, unknown>>
  readonly versions: Readonly<Record<string, string>>
  readonly fingerprint: Hash
}

export interface PreflightCheck {
  readonly id: string
  readonly label: string
  readonly status: CheckStatus
  readonly summary: string
  readonly error?: ModelPkError
  readonly diagnostics?: Readonly<Record<string, unknown>>
}

export interface PreflightSnapshot {
  readonly preflightId: UUID
  readonly draftId: UUID
  readonly draftRevision: number
  readonly snapshotHash: Hash
  readonly status: PreflightStatus
  readonly checks: readonly PreflightCheck[]
  readonly resultRootPath: string | null
  readonly taskPackage: TaskPackage
  readonly taskPackageHash: Hash
  readonly models: readonly ModelConfigSnapshot[]
  readonly resolvedHarness: ResolvedHarness
  readonly resolvedHarnessFingerprint: Hash
  readonly executionConditions: ExecutionConditions
  readonly executionConditionsHash: Hash
  readonly capacityEstimateBytes: number
  readonly confirmedSnapshotHash: Hash | null
  readonly createdAt: IsoDateTime
}

export interface WorkspaceFileChange {
  readonly path: string
  readonly changeType: 'ADDED' | 'MODIFIED' | 'DELETED'
  readonly byteLength: number | null
}

export interface WorkspaceSummary {
  readonly mode: 'TEXT_RESPONSE' | 'TEXT_FILE' | 'ENGINEERING'
  readonly changedFileCount: number
  readonly addedFileCount: number
  readonly modifiedFileCount: number
  readonly deletedFileCount: number
  readonly files: readonly WorkspaceFileChange[]
  readonly truncated: boolean
  readonly textFilePath: string | null
  readonly textContent: string | null
}

export interface ModelTokenUsage {
  readonly requestCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number | null
  readonly cacheReadTokensReported?: boolean
  readonly cacheWriteTokens: number
}

export interface Attempt {
  readonly attemptId: UUID
  readonly runId: UUID
  readonly attemptNo: number
  readonly trigger: AttemptTrigger
  readonly batchActionId: UUID | null
  readonly state: AttemptState
  readonly lifecycleVersion: number
  readonly observedExecutionOutcome: AttemptTerminalState | null
  readonly pendingOutcome: AttemptTerminalState | null
  readonly finalizationId: UUID | null
  readonly finalizationStage: FinalizationStage | null
  readonly finalizationDeadlineAt: IsoDateTime | null
  readonly taskPackageHash: Hash
  readonly resolvedHarnessFingerprint: Hash
  readonly executionConditionsHash: Hash
  readonly modelConfigFingerprint: Hash
  readonly inputFingerprint: Hash
  readonly effectiveInputHash: Hash | null
  readonly dispatchIntentId: UUID | null
  readonly idempotencyKey: string
  readonly dshSessionId: string | null
  readonly providerRequestId: string | null
  readonly queueSeq: number
  readonly queuedAt: IsoDateTime
  readonly preparingAt: IsoDateTime | null
  readonly preparingDeadlineAt: IsoDateTime | null
  readonly dispatchIntentAt: IsoDateTime | null
  readonly dispatchAckAt: IsoDateTime | null
  readonly startedAt: IsoDateTime | null
  readonly executionDeadlineAt: IsoDateTime | null
  readonly executionEndedAt: IsoDateTime | null
  readonly finalizationStartedAt: IsoDateTime | null
  readonly finalizedAt: IsoDateTime | null
  readonly firstOutputAt: IsoDateTime | null
  readonly lastProgressAt: IsoDateTime | null
  readonly workerHeartbeatAt: IsoDateTime | null
  readonly recoveryDeadlineAt: IsoDateTime | null
  readonly executionLeaseId: UUID
  readonly fencingToken: string
  readonly executionTerminationConfirmed: boolean
  readonly executionReservationState: ReservationState
  readonly reservationAcquiredAt: IsoDateTime | null
  readonly reservationReleaseDeadline: IsoDateTime | null
  readonly orphanedExecution: boolean
  readonly orphanedAt: IsoDateTime | null
  readonly workspaceSealState: WorkspaceSealState
  readonly workspacePath: string | null
  readonly artifactPath: string | null
  readonly resultPath: string | null
  readonly resultExportError: ModelPkError | null
  readonly workspaceSummary: WorkspaceSummary | null
  readonly tokenUsage: ModelTokenUsage | null
  readonly finalResponse: string | null
  readonly outputPreview: string
  readonly archiveCompleteness: ArchiveCompleteness
  readonly error: ModelPkError | null
  readonly archiveError: ModelPkError | null
  readonly cancelReason: CancelReason | null
  readonly healthFlags: readonly string[]
}

export interface Run {
  readonly runId: UUID
  readonly experimentId: UUID
  readonly ordinal: number
  readonly modelConfig: ModelConfigSnapshot
  readonly modelConfigFingerprint: Hash
  readonly latestAttemptId: UUID
  readonly lastSuccessfulAttemptId: UUID | null
  readonly attemptCount: number
  readonly attempts: readonly Attempt[]
  readonly createdAt: IsoDateTime
}

export interface Experiment {
  readonly experimentId: UUID
  readonly name: string
  readonly taskType: string
  readonly lifecycleState: ExperimentLifecycle
  readonly outcome: ExperimentOutcome
  readonly generation: number
  readonly semanticEventCursor: number
  readonly auditSequence: number
  readonly attemptSetHash: Hash
  readonly archiveFreshness: ArchiveFreshness
  readonly archiveIntegrity: ArchiveIntegrity
  readonly archiveRevision: number
  readonly latestSealHash: Hash | null
  readonly taskPackage: TaskPackage
  readonly taskPackageHash: Hash
  readonly resolvedHarness: ResolvedHarness
  readonly resolvedHarnessFingerprint: Hash
  readonly executionConditions: ExecutionConditions
  readonly executionConditionsHash: Hash
  readonly selectedModels: readonly ModelConfigSnapshot[]
  readonly preflightSnapshotHash: Hash
  readonly dshVersion: string
  readonly pluginVersion: string
  readonly experimentPath: string
  readonly resultPath: string | null
  readonly runs: readonly Run[]
  readonly createdAt: IsoDateTime
  readonly frozenAt: IsoDateTime
  readonly settledAt: IsoDateTime | null
}

export interface ExperimentCounts {
  readonly queued: number
  readonly active: number
  readonly finalizing: number
  readonly finished: number
  readonly total: number
}

export interface ExperimentProjection extends Experiment {
  readonly counts: ExperimentCounts
  readonly latestCursor: number
  readonly activeActions: readonly DurableAction[]
  readonly recoveryNotice: string | null
}

export interface DurableAction {
  readonly actionId: UUID
  readonly kind: ActionKind
  readonly experimentId: UUID | null
  readonly requestHash: Hash
  readonly state: ActionState
  readonly result: Readonly<Record<string, unknown>> | null
  readonly error: ModelPkError | null
  readonly createdAt: IsoDateTime
  readonly completedAt: IsoDateTime | null
}

export interface AuditEvent {
  readonly cursor: number
  readonly experimentId: UUID
  readonly attemptId: UUID | null
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly occurredAt: IsoDateTime
}

export interface PollResult {
  readonly experimentId: UUID
  readonly fromCursor: number
  readonly nextCursor: number
  readonly events: readonly AuditEvent[]
  readonly projection: ExperimentProjection
}

export interface StorageListItem {
  readonly experimentId: UUID
  readonly name: string
  readonly lifecycleState: ExperimentLifecycle
  readonly outcome: ExperimentOutcome
  readonly createdAt: IsoDateTime
  readonly settledAt: IsoDateTime | null
  readonly byteLength: number
  readonly experimentPath: string
  readonly resultPath: string | null
  readonly canDelete: boolean
  readonly blockedReason: string | null
}

export interface CapabilityReport {
  readonly pluginVersion: string
  readonly expectedDshVersion: string
  readonly expectedDshCommit: string
  readonly hostPlatform: string
  readonly hostArch: string
  readonly dataRoot: string
  readonly nativeHelper: {
    readonly status: 'READY' | 'BLOCKED'
    readonly path: string | null
    readonly version: string | null
    readonly hash: Hash | null
    readonly reason: string | null
  }
  readonly executionEnabled: boolean
  readonly blockers: readonly ModelPkError[]
}

export interface DraftCreateRequest {
  readonly taskName?: string
  readonly taskType?: string
  readonly prompt?: string
}

export interface DraftUpdateRequest {
  readonly draftId: UUID
  readonly expectedRevision: number
  readonly patch: {
    readonly taskName?: string
    readonly taskType?: string
    readonly prompt?: string
    readonly selectedModelConfigIds?: readonly Hash[]
    readonly concurrency?: number
    readonly attachmentOrder?: readonly UUID[]
  }
}

export interface AttachmentBeginRequest {
  readonly draftId: UUID
  readonly expectedRevision: number
  readonly name: string
  readonly mimeType: string
  readonly byteLength: number
  readonly expectedHash: Hash
}

export interface AttachmentBeginResponse {
  readonly uploadId: UUID
  readonly attachmentId: UUID
  readonly chunkSize: number
  readonly expiresAt: IsoDateTime
}

export interface AttachmentChunkRequest {
  readonly uploadId: UUID
  readonly offset: number
  readonly bytesBase64: string
}

export interface BaselineSelectRequest {
  readonly draftId: UUID
  readonly expectedRevision: number
  readonly sourcePath: string
}

export interface ResultRootSelectRequest {
  readonly draftId: UUID
  readonly expectedRevision: number
  readonly rootPath: string
}

export interface PreflightRequest {
  readonly draftId: UUID
}

export interface ConfirmWarningRequest {
  readonly draftId: UUID
  readonly preflightId: UUID
  readonly snapshotHash: Hash
}

export interface StartRequest {
  readonly draftId: UUID
  readonly preflightId: UUID
  readonly snapshotHash: Hash
}

export interface StopRequest {
  readonly experimentId: UUID
  readonly attemptId: UUID
  readonly expectedLifecycleVersion: number
}

export interface RetryRequest {
  readonly experimentId: UUID
  readonly runId: UUID
  readonly expectedAttemptId: UUID
}

export interface ExperimentPollRequest {
  readonly experimentId: UUID
  readonly afterCursor: number
}
