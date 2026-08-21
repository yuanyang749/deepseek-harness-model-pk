import { DSH_VERSION, LIMITS, PLUGIN_VERSION } from '../contracts/constants.js'
import type {
  Attempt,
  AttemptTrigger,
  Experiment,
  ExecutionConditions,
  ModelConfigSnapshot,
  PreflightSnapshot,
  ResolvedHarness,
  Run,
  TaskPackage,
  UUID,
} from '../contracts/types.js'
import { fencingToken, uuid } from '../core/ids.js'
import { hashCanonical } from '../core/jcs.js'

export function defaultExecutionConditions(concurrency: number): ExecutionConditions {
  return Object.freeze({
    schemaVersion: 'model-pk/execution-conditions/v1',
    concurrency,
    maxParallelToolCalls: 1,
    maxSteps: 64,
    maxOutputTokens: 8192,
    noProgressWarningMs: LIMITS.noProgressWarningMs,
    stalledMs: LIMITS.stalledMs,
    executionTimeoutMs: LIMITS.executionTimeoutMs,
    cancelGraceMs: LIMITS.cancelGraceMs,
    prepareTimeoutMs: LIMITS.prepareTimeoutMs,
    recoveryTimeoutMs: LIMITS.recoveryTimeoutMs,
    finalizationTimeoutMs: LIMITS.finalizationTimeoutMs,
  })
}

export interface CreateExperimentDefinitionInput {
  readonly preflight: PreflightSnapshot
  readonly experimentPath: string
  readonly now?: string
  readonly experimentId?: UUID
  readonly resultPath?: string | null
  readonly firstQueueSeq: number
}

export interface ExperimentDefinition {
  readonly experiment: Experiment
  readonly runs: readonly Run[]
  readonly attempts: readonly Attempt[]
}

export function createExperimentDefinition(input: CreateExperimentDefinitionInput): ExperimentDefinition {
  const now = input.now ?? new Date().toISOString()
  const experimentId = input.experimentId ?? uuid()
  const runIds = input.preflight.models.map(() => uuid())
  const attemptIds = input.preflight.models.map(() => uuid())
  const attemptSetHash = hashCanonical({
    schemaVersion: 'model-pk/attempt-set/v1',
    attemptIds: [...attemptIds].sort(),
  })
  const experiment: Experiment = {
    experimentId,
    name: input.preflight.taskPackage.taskName,
    taskType: input.preflight.taskPackage.taskType,
    lifecycleState: 'STARTING',
    outcome: null,
    generation: 0,
    semanticEventCursor: 0,
    auditSequence: 0,
    attemptSetHash,
    archiveFreshness: 'STALE',
    archiveIntegrity: 'INCOMPLETE',
    archiveRevision: 0,
    latestSealHash: null,
    taskPackage: input.preflight.taskPackage,
    taskPackageHash: input.preflight.taskPackageHash,
    resolvedHarness: input.preflight.resolvedHarness,
    resolvedHarnessFingerprint: input.preflight.resolvedHarnessFingerprint,
    executionConditions: input.preflight.executionConditions,
    executionConditionsHash: input.preflight.executionConditionsHash,
    selectedModels: input.preflight.models,
    preflightSnapshotHash: input.preflight.snapshotHash,
    dshVersion: DSH_VERSION,
    pluginVersion: PLUGIN_VERSION,
    experimentPath: input.experimentPath,
    resultPath: input.resultPath ?? null,
    runs: [],
    createdAt: now,
    frozenAt: now,
    settledAt: null,
  }
  const attempts = input.preflight.models.map((model, ordinal) => createAttempt({
    runId: runIds[ordinal]!,
    attemptId: attemptIds[ordinal]!,
    attemptNo: 1,
    trigger: 'INITIAL',
    batchActionId: null,
    model,
    taskPackage: input.preflight.taskPackage,
    taskPackageHash: input.preflight.taskPackageHash,
    harness: input.preflight.resolvedHarness,
    executionConditions: input.preflight.executionConditions,
    executionConditionsHash: input.preflight.executionConditionsHash,
    queueSeq: input.firstQueueSeq + ordinal,
    now,
  }))
  const runs = input.preflight.models.map((model, ordinal): Run => ({
    runId: runIds[ordinal]!,
    experimentId,
    ordinal,
    modelConfig: model,
    modelConfigFingerprint: model.fingerprint,
    latestAttemptId: attemptIds[ordinal]!,
    lastSuccessfulAttemptId: null,
    attemptCount: 1,
    attempts: [attempts[ordinal]!],
    createdAt: now,
  }))
  return { experiment: { ...experiment, runs }, runs, attempts }
}

export interface CreateAttemptInput {
  readonly runId: UUID
  readonly attemptId?: UUID
  readonly attemptNo: number
  readonly trigger: AttemptTrigger
  readonly batchActionId: UUID | null
  readonly model: ModelConfigSnapshot
  readonly taskPackage: TaskPackage
  readonly taskPackageHash: `sha256:${string}`
  readonly harness: ResolvedHarness
  readonly executionConditions: ExecutionConditions
  readonly executionConditionsHash: `sha256:${string}`
  readonly queueSeq: number
  readonly now?: string
}

export function createAttempt(input: CreateAttemptInput): Attempt {
  const attemptId = input.attemptId ?? uuid()
  const now = input.now ?? new Date().toISOString()
  const inputFingerprint = hashCanonical({
    schemaVersion: 'model-pk/input/v1',
    taskPackageHash: input.taskPackageHash,
    modelConfigFingerprint: input.model.fingerprint,
    resolvedHarnessFingerprint: input.harness.fingerprint,
    logicalWorkspace: '/workspace',
  })
  return {
    attemptId,
    runId: input.runId,
    attemptNo: input.attemptNo,
    trigger: input.trigger,
    batchActionId: input.batchActionId,
    state: 'QUEUED',
    lifecycleVersion: 0,
    observedExecutionOutcome: null,
    pendingOutcome: null,
    finalizationId: null,
    finalizationStage: null,
    finalizationDeadlineAt: null,
    taskPackageHash: input.taskPackageHash,
    resolvedHarnessFingerprint: input.harness.fingerprint,
    executionConditionsHash: input.executionConditionsHash,
    modelConfigFingerprint: input.model.fingerprint,
    inputFingerprint,
    effectiveInputHash: null,
    dispatchIntentId: null,
    idempotencyKey: hashCanonical({ schemaVersion: 'model-pk/dispatch-key/v1', attemptId }),
    dshSessionId: null,
    providerRequestId: null,
    queueSeq: input.queueSeq,
    queuedAt: now,
    preparingAt: null,
    preparingDeadlineAt: null,
    dispatchIntentAt: null,
    dispatchAckAt: null,
    startedAt: null,
    executionDeadlineAt: null,
    executionEndedAt: null,
    finalizationStartedAt: null,
    finalizedAt: null,
    firstOutputAt: null,
    lastProgressAt: null,
    workerHeartbeatAt: null,
    recoveryDeadlineAt: null,
    executionLeaseId: uuid(),
    fencingToken: fencingToken(),
    executionTerminationConfirmed: false,
    executionReservationState: 'NOT_ACQUIRED',
    reservationAcquiredAt: null,
    reservationReleaseDeadline: null,
    orphanedExecution: false,
    orphanedAt: null,
    workspaceSealState: 'OPEN',
    workspacePath: null,
    artifactPath: null,
    resultPath: null,
    resultExportError: null,
    workspaceSummary: null,
    tokenUsage: null,
    finalResponse: null,
    outputPreview: '',
    archiveCompleteness: 'INCOMPLETE',
    error: null,
    archiveError: null,
    cancelReason: null,
    healthFlags: [],
  }
}
