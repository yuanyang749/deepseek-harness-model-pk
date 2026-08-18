import { performance } from 'node:perf_hooks'
import { rm } from 'node:fs/promises'
import type {
  Attempt,
  AttemptTerminalState,
  CancelReason,
  ExperimentProjection,
  ModelPkError,
  Run,
  UUID,
} from '../contracts/types.js'
import { LIMITS } from '../contracts/constants.js'
import { ModelPkException, modelPkError, normalizeError } from '../core/error.js'
import { uuid } from '../core/ids.js'
import { canonicalize } from '../core/jcs.js'
import { isTerminalAttemptState } from '../core/state-machine.js'
import type { NativeHelper } from '../native/helper.js'
import type { ControlStore } from '../storage/store.js'
import type { ArchiveManager, AttemptRuntimePaths } from './archive.js'
import type { AttemptExecutor, ExecutionResult, PreparedExecution } from './executor.js'

interface ActiveExecution {
  readonly controller: AbortController
  prepared: PreparedExecution | null
  forcedOutcome: AttemptTerminalState | null
  cancelReason: CancelReason | null
  warningEmitted: boolean
  ackMonotonic: number | null
}

export class Scheduler {
  private readonly active = new Map<UUID, ActiveExecution>()
  private readonly tasks = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = false
  private readonly clock: DurableClock

  constructor(
    private readonly store: ControlStore,
    private readonly archive: ArchiveManager,
    private readonly helper: NativeHelper,
    private readonly executor: AttemptExecutor,
  ) {
    this.clock = new DurableClock(store)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.recoverOnStartup()
    await this.recoverSeals()
    this.timer = setInterval(() => { void this.tick() }, 250)
    this.timer.unref()
    await this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const execution of this.active.values()) {
      execution.forcedOutcome = 'DISCONNECTED'
      execution.controller.abort()
      execution.prepared?.cancel()
    }
    await Promise.allSettled([...this.active.values()].map(execution => execution.prepared?.dispose()))
    await Promise.allSettled([...this.tasks])
  }

  requestCancel(attemptId: UUID, reason: CancelReason): void {
    const execution = this.active.get(attemptId)
    if (execution === undefined) {
      void this.tick()
      return
    }
    execution.forcedOutcome = 'CANCELLED'
    execution.cancelReason = reason
    execution.controller.abort()
    execution.prepared?.cancel()
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      this.clock.checkpoint()
      await this.finalizeOrRecoverPending()
      await this.applyWatchdogs()
      const experiment = this.store.activeExperiment()
      if (experiment === null || experiment.lifecycleState !== 'ACTIVE') return
      const available = Math.max(0, experiment.executionConditions.concurrency - this.store.heldReservationCount(experiment.experimentId))
      const queued = this.store.queuedAttempts(experiment.experimentId, available)
      for (const attempt of queued) {
        if (this.active.has(attempt.attemptId)) continue
        const now = this.clock.now()
        const preparingDeadline = new Date(now + experiment.executionConditions.prepareTimeoutMs).toISOString()
        const releaseDeadline = new Date(now + experiment.executionConditions.prepareTimeoutMs + experiment.executionConditions.cancelGraceMs).toISOString()
        try {
          const claimed = this.store.claimReservation(attempt.attemptId, new Date(now).toISOString(), preparingDeadline, releaseDeadline)
          const active: ActiveExecution = {
            controller: new AbortController(),
            prepared: null,
            forcedOutcome: null,
            cancelReason: null,
            warningEmitted: false,
            ackMonotonic: null,
          }
          this.active.set(attempt.attemptId, active)
          const task = this.runAttempt(experiment.experimentId, claimed, active)
          this.tasks.add(task)
          void task.then(
            () => { this.tasks.delete(task) },
            () => { this.tasks.delete(task) },
          )
        } catch (error) {
          if (!(error instanceof ModelPkException && error.detail.code === 'ACTION_TARGET_STALE')) throw error
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async runAttempt(experimentId: UUID, claimed: Attempt, active: ActiveExecution): Promise<void> {
    let prepared: PreparedExecution | null = null
    try {
      let projection = this.store.getExperimentRequired(experimentId)
      const run = runForAttempt(projection, claimed)
      if (active.controller.signal.aborted) {
        await this.beginAndFinishFinalization(projection, run, claimed, null, cancelledResult(), active)
        return
      }
      prepared = await this.executor.prepare(projection, run, claimed)
      active.prepared = prepared
      let current = this.store.getAttemptRequired(claimed.attemptId)
      if (active.controller.signal.aborted || current.state === 'CANCELLING') {
        prepared.cancel()
        await this.beginAndFinishFinalization(projection, run, current, prepared, cancelledResult(), active)
        return
      }
      if (current.state !== 'PREPARING') return
      const now = this.clock.now()
      const dispatchIntentId = uuid()
      current = this.store.transitionAttempt(current.attemptId, {
        expectedVersion: current.lifecycleVersion,
        to: 'DISPATCHING',
        patch: {
          dispatchIntentId,
          dispatchIntentAt: new Date(now).toISOString(),
          dshSessionId: prepared.sessionId,
          effectiveInputHash: prepared.effectiveInputHash,
          workspacePath: prepared.runtime.workspace,
          artifactPath: prepared.runtime.artifacts,
          reservationReleaseDeadline: new Date(now + projection.executionConditions.executionTimeoutMs + projection.executionConditions.cancelGraceMs).toISOString(),
          lastProgressAt: new Date(now).toISOString(),
          workerHeartbeatAt: new Date(now).toISOString(),
        },
      })
      this.store.appendEvent(experimentId, current.attemptId, 'DISPATCH_INTENT_RECORDED', {
        dispatchIntentId,
        idempotencyKey: current.idempotencyKey,
      })
      const result = await prepared.dispatch(active.controller.signal, {
        onDispatchAck: async () => {
          const before = this.store.getAttemptRequired(current.attemptId)
          const ackAtMs = this.clock.now()
          active.ackMonotonic = performance.now()
          const patch: Partial<Attempt> = {
            dispatchAckAt: new Date(ackAtMs).toISOString(),
            startedAt: new Date(ackAtMs).toISOString(),
            executionDeadlineAt: new Date(ackAtMs + projection.executionConditions.executionTimeoutMs).toISOString(),
            reservationReleaseDeadline: new Date(ackAtMs + projection.executionConditions.executionTimeoutMs + projection.executionConditions.cancelGraceMs).toISOString(),
            lastProgressAt: new Date(ackAtMs).toISOString(),
            workerHeartbeatAt: new Date(ackAtMs).toISOString(),
          }
          if (before.state === 'DISPATCHING') {
            current = this.store.transitionAttempt(before.attemptId, {
              expectedVersion: before.lifecycleVersion,
              to: 'RUNNING',
              patch,
            })
          } else if (before.state === 'CANCELLING') {
            current = this.store.updateAttemptProjection(before.attemptId, patch)
            prepared?.cancel()
          } else {
            throw new ModelPkException(modelPkError('ACTION_TARGET_STALE', 'dispatch-ack', 'Attempt 状态已变化', `unexpected ACK state=${before.state}`))
          }
          this.store.appendEvent(experimentId, current.attemptId, 'DISPATCH_ACK_RECORDED', { dispatchIntentId })
        },
        onEvent: event => {
          const latest = this.store.getAttempt(current.attemptId)
          if (latest === null || isTerminalAttemptState(latest.state) || latest.state === 'FINALIZING') return
          this.store.appendEvent(experimentId, current.attemptId, 'ATTEMPT_RUNTIME_EVENT', compactEvent(event))
        },
        onOutput: delta => {
          const latest = this.store.getAttempt(current.attemptId)
          if (latest === null || isTerminalAttemptState(latest.state) || latest.state === 'FINALIZING') return
          const nowIso = new Date(this.clock.now()).toISOString()
          const preview = `${latest.outputPreview}${delta}`.slice(-64 * 1024)
          this.store.updateAttemptProjection(latest.attemptId, {
            outputPreview: preview,
            firstOutputAt: latest.firstOutputAt ?? nowIso,
            lastProgressAt: nowIso,
            workerHeartbeatAt: nowIso,
          })
          this.store.appendEvent(experimentId, latest.attemptId, 'ATTEMPT_OUTPUT_DELTA', { delta })
        },
        onProgress: () => {
          const latest = this.store.getAttempt(current.attemptId)
          if (latest === null || isTerminalAttemptState(latest.state) || latest.state === 'FINALIZING') return
          const nowIso = new Date(this.clock.now()).toISOString()
          this.store.updateAttemptProjection(latest.attemptId, { lastProgressAt: nowIso, workerHeartbeatAt: nowIso })
        },
      })
      projection = this.store.getExperimentRequired(experimentId)
      const latestRun = runForAttempt(projection, claimed)
      const latest = this.store.getAttemptRequired(claimed.attemptId)
      await this.beginAndFinishFinalization(projection, latestRun, latest, prepared, result, active)
    } catch (error) {
      const latest = this.store.getAttempt(claimed.attemptId)
      if (latest !== null && !isTerminalAttemptState(latest.state) && latest.state !== 'FINALIZING') {
        const projection = this.store.getExperimentRequired(experimentId)
        const run = runForAttempt(projection, latest)
        const result: ExecutionResult = {
          outcome: active.controller.signal.aborted ? 'CANCELLED' : 'FAILED',
          finalResponse: latest.finalResponse,
          error: active.controller.signal.aborted ? null : normalizeExecutionFailure(error),
          providerRequestId: null,
          executionTerminationConfirmed: prepared !== null || latest.dispatchIntentId === null,
        }
        await this.beginAndFinishFinalization(projection, run, latest, prepared, result, active).catch(finalizationError => {
          this.store.appendEvent(experimentId, latest.attemptId, 'FINALIZATION_DRIVER_ERROR', { error: normalizeError(finalizationError, 'scheduler-finalize') })
        })
      } else if (latest?.state === 'FINALIZING') {
        await this.finalizeExisting(latest, prepared).catch(() => undefined)
      }
    } finally {
      if (prepared !== null) await prepared.dispose().catch(() => undefined)
      this.active.delete(claimed.attemptId)
      void this.tick()
    }
  }

  private async beginAndFinishFinalization(
    experiment: ExperimentProjection,
    _run: Run,
    attempt: Attempt,
    prepared: PreparedExecution | null,
    executionResult: ExecutionResult,
    active: ActiveExecution,
  ): Promise<void> {
    const current = this.store.getAttemptRequired(attempt.attemptId)
    if (isTerminalAttemptState(current.state)) return
    if (current.state === 'FINALIZING') {
      await this.finalizeExisting(current, prepared)
      return
    }
    let pendingOutcome: AttemptTerminalState = active.forcedOutcome ?? executionResult.outcome
    let error = executionResult.error
    let cancelReason = active.cancelReason
    if (pendingOutcome === 'STALLED') error = modelPkError('STALL_TIMEOUT', 'watchdog', 'Attempt 长时间无有效进展', 'stalled watchdog threshold reached', { retryable: true })
    if (pendingOutcome === 'TIMED_OUT') error = modelPkError('EXECUTION_TIMEOUT', 'watchdog', 'Attempt 超过 30 分钟执行时限', 'hard execution deadline reached', { retryable: true })
    if (pendingOutcome === 'DISCONNECTED') error = error ?? modelPkError('RECOVERY_UNRESOLVED', 'recovery', '执行状态无法恢复', 'provider/session request cannot be queried', { retryable: true })
    if (pendingOutcome === 'CANCELLED') cancelReason = cancelReason ?? 'USER_CANCELLED'
    if (pendingOutcome === 'SUCCEEDED' && executionResult.finalResponse === null) {
      pendingOutcome = 'FAILED'
      error = modelPkError('EMPTY_RESPONSE', 'execute', '模型没有返回可展示文本', 'successful result has no final response', { retryable: true })
    }
    const now = this.clock.now()
    const finalizing = this.store.transitionAttempt(current.attemptId, {
      expectedVersion: current.lifecycleVersion,
      to: 'FINALIZING',
      patch: {
        observedExecutionOutcome: pendingOutcome,
        pendingOutcome,
        finalizationId: uuid(),
        finalizationStage: 'INTENT_RECORDED',
        finalizationStartedAt: new Date(now).toISOString(),
        finalizationDeadlineAt: new Date(now + experiment.executionConditions.finalizationTimeoutMs).toISOString(),
        executionEndedAt: new Date(now).toISOString(),
        finalResponse: executionResult.finalResponse,
        providerRequestId: executionResult.providerRequestId,
        executionTerminationConfirmed: executionResult.executionTerminationConfirmed,
        error,
        cancelReason,
      },
    })
    await this.finalizeExisting(finalizing, prepared)
  }

  private async finalizeExisting(initial: Attempt, prepared: PreparedExecution | null): Promise<void> {
    let attempt = this.store.getAttemptRequired(initial.attemptId)
    if (attempt.state !== 'FINALIZING') return
    const experiment = this.store.getExperimentRequired(this.experimentIdForAttempt(attempt))
    const run = runForAttempt(experiment, attempt)
    let runtime: AttemptRuntimePaths | null = attempt.workspacePath === null
      ? null
      : this.archive.attemptRuntimePaths(experiment.experimentId, attempt.attemptId)
    if (attempt.finalizationStage === 'INTENT_RECORDED') {
      if (runtime !== null) await this.archive.revokeLease(runtime).catch(() => undefined)
      if (prepared !== null) {
        prepared.cancel()
        await prepared.dispose().catch(() => undefined)
      }
      attempt = this.store.updateAttemptProjection(attempt.attemptId, {
        finalizationStage: 'ISOLATION_RESOLVED',
        executionReservationState: attempt.executionTerminationConfirmed ? 'RELEASED' : 'ORPHANED',
        orphanedExecution: !attempt.executionTerminationConfirmed,
        orphanedAt: attempt.executionTerminationConfirmed ? null : new Date(this.clock.now()).toISOString(),
        workspaceSealState: attempt.executionTerminationConfirmed ? 'SEALED' : 'QUARANTINED_UNSAFE',
      })
      if (!attempt.executionTerminationConfirmed) runtime = null
    }
    if (attempt.finalizationStage === 'ISOLATION_RESOLVED') {
      const archived = await this.archive.finalizeAttempt({
        experiment,
        run,
        attempt,
        runtime,
        finalResponse: attempt.finalResponse,
        primaryError: attempt.error,
        cancelReason: attempt.cancelReason,
      })
      const archiveCompleteness = attempt.workspaceSealState === 'QUARANTINED_UNSAFE' ? 'INCOMPLETE' : archived.completeness
      attempt = this.store.updateAttemptProjection(attempt.attemptId, {
        finalizationStage: 'ARCHIVE_RESOLVED',
        archiveCompleteness,
        archiveError: archived.error,
      })
    }
    if (attempt.finalizationStage === 'ARCHIVE_RESOLVED') {
      let terminal = attempt.pendingOutcome ?? 'FAILED'
      let primaryError = attempt.error
      if (attempt.workspaceSealState === 'QUARANTINED_UNSAFE') {
        terminal = 'DISCONNECTED'
        primaryError = modelPkError('EXECUTION_ISOLATION_UNRESOLVED', 'finalization', '旧执行未能安全隔离', 'execution termination was not confirmed', { retryable: false })
      } else if (terminal === 'SUCCEEDED' && attempt.archiveCompleteness !== 'COMPLETE') {
        terminal = 'FAILED'
        primaryError = attempt.archiveError ?? modelPkError('ARCHIVE_WRITE_FAILED', 'finalization', '结果归档失败', 'successful execution has incomplete archive')
      }
      const slot = this.store.capacitySlotForAttempt(attempt.attemptId)
      const generation = slot.generation + 1
      const terminalFact = Buffer.from(canonicalize({
        schemaVersion: 'model-pk/control-terminal/v1',
        attemptId: attempt.attemptId,
        finalizationId: attempt.finalizationId,
        terminal,
        archiveCompleteness: attempt.archiveCompleteness,
        error: primaryError,
        lifecycleVersion: attempt.lifecycleVersion + 1,
      }))
      const committed = await this.helper.slotWrite(slot.path, generation, terminalFact)
      this.store.commitCapacitySlot(slot.slotId, generation, committed.checksum)
      attempt = this.store.updateAttemptProjection(attempt.attemptId, {
        finalizationStage: 'CONTROL_COMMITTED',
        pendingOutcome: terminal,
        error: primaryError,
      })
    }
    if (attempt.finalizationStage === 'CONTROL_COMMITTED') {
      const terminal = attempt.pendingOutcome ?? 'FAILED'
      const finalized = this.store.transitionAttempt(attempt.attemptId, {
        expectedVersion: attempt.lifecycleVersion,
        to: terminal,
        patch: {
          finalizedAt: new Date(this.clock.now()).toISOString(),
          executionReservationState: attempt.executionReservationState,
        },
      })
      this.store.appendEvent(experiment.experimentId, finalized.attemptId, 'ATTEMPT_FINALIZED', {
        state: finalized.state,
        archiveCompleteness: finalized.archiveCompleteness,
      })
      const projection = this.store.getExperimentRequired(experiment.experimentId)
      await this.archive.writeProjection(projection)
      if (projection.lifecycleState === 'SETTLED') await this.seal(projection)
      if (runtime !== null) await rm(runtime.attemptRoot, { recursive: true, force: true })
    }
  }

  private async seal(projection: ExperimentProjection): Promise<void> {
    const candidate = await this.archive.sealExperiment(projection, this.store.allEventsThrough(projection.experimentId, projection.latestCursor))
    const activationId = uuid()
    const started = this.store.beginSealActivation({
      experimentId: projection.experimentId,
      expectedGeneration: projection.generation,
      expectedSemanticCursor: projection.semanticEventCursor,
      expectedAttemptSetHash: projection.attemptSetHash,
      activationId,
    })
    if (!started) return
    await this.archive.commitSeal(candidate.sealPath, activationId, candidate.indexHash)
    const integrity = projection.runs.every(run => run.attempts.every(attempt => attempt.archiveCompleteness === 'COMPLETE'))
      ? 'COMPLETE' : projection.runs.some(run => run.attempts.some(attempt => attempt.archiveCompleteness === 'COMPLETE')) ? 'PARTIAL' : 'INCOMPLETE'
    const activated = this.store.finishSealActivation({
      experimentId: projection.experimentId,
      expectedGeneration: projection.generation,
      expectedSemanticCursor: projection.semanticEventCursor,
      expectedAttemptSetHash: projection.attemptSetHash,
      activationId,
      archiveRevision: candidate.revision,
      indexHash: candidate.indexHash,
      integrity,
    })
    if (activated) await this.archive.writeProjection(this.store.getExperimentRequired(projection.experimentId))
  }

  private async recoverOnStartup(): Promise<void> {
    const now = this.clock.now()
    for (const attempt of this.store.recoverableAttempts()) {
      if (attempt.state === 'FINALIZING') continue
      if (attempt.state === 'RECOVERING') {
        if (attempt.recoveryDeadlineAt === null) {
          this.store.updateAttemptProjection(attempt.attemptId, {
            recoveryDeadlineAt: new Date(now + LIMITS.recoveryTimeoutMs).toISOString(),
          })
        }
        continue
      }
      this.store.transitionAttempt(attempt.attemptId, {
        expectedVersion: attempt.lifecycleVersion,
        to: 'RECOVERING',
        patch: {
          recoveryDeadlineAt: new Date(now + LIMITS.recoveryTimeoutMs).toISOString(),
          error: modelPkError('DISPATCH_UNCERTAIN', 'recovery', '正在确认中断前的执行状态', `recovered from ${attempt.state}`, { retryable: true }),
        },
      })
    }
  }

  private async recoverSeals(): Promise<void> {
    for (const experiment of this.store.experimentsInState(['SETTLED'])) {
      if (experiment.archiveFreshness !== 'STALE') continue
      await this.seal(experiment).catch(error => {
        this.store.appendEvent(experiment.experimentId, null, 'SEAL_RECOVERY_ERROR', {
          error: normalizeError(error, 'seal-recovery'),
        })
      })
    }
  }

  private async finalizeOrRecoverPending(): Promise<void> {
    for (const attempt of this.store.attemptsInState(['FINALIZING'])) {
      if (this.active.has(attempt.attemptId)) continue
      await this.finalizeExisting(attempt, null).catch(error => {
        this.store.appendEvent(this.experimentIdForAttempt(attempt), attempt.attemptId, 'FINALIZATION_RECOVERY_ERROR', {
          error: normalizeError(error, 'finalization-recovery'),
        })
      })
    }
    const now = this.clock.now()
    for (const attempt of this.store.attemptsInState(['RECOVERING'])) {
      if (attempt.recoveryDeadlineAt === null || Date.parse(attempt.recoveryDeadlineAt) > now) continue
      const experiment = this.store.getExperimentRequired(this.experimentIdForAttempt(attempt))
      const run = runForAttempt(experiment, attempt)
      await this.beginAndFinishFinalization(experiment, run, attempt, null, {
        outcome: 'FAILED',
        finalResponse: attempt.finalResponse,
        error: modelPkError('RECOVERY_UNRESOLVED', 'recovery', '执行状态无法恢复', 'recovery deadline elapsed without query capability', { retryable: true }),
        providerRequestId: attempt.providerRequestId,
        executionTerminationConfirmed: false,
      }, {
        controller: new AbortController(), prepared: null, forcedOutcome: 'DISCONNECTED', cancelReason: null,
        warningEmitted: false, ackMonotonic: null,
      })
    }
  }

  private async applyWatchdogs(): Promise<void> {
    const now = this.clock.now()
    for (const [attemptId, active] of this.active) {
      const attempt = this.store.getAttempt(attemptId)
      if (attempt === null || attempt.state !== 'RUNNING') continue
      const lastProgress = attempt.lastProgressAt === null ? now : Date.parse(attempt.lastProgressAt)
      const idleMs = Math.max(0, now - lastProgress)
      if (idleMs >= LIMITS.noProgressWarningMs && !active.warningEmitted) {
        active.warningEmitted = true
        this.store.updateAttemptProjection(attemptId, { healthFlags: [...new Set([...attempt.healthFlags, 'NO_PROGRESS_WARNING'])] })
        this.store.appendEvent(this.experimentIdForAttempt(attempt), attemptId, 'NO_PROGRESS_WARNING', { idleMs })
      }
      const elapsedMono = active.ackMonotonic === null ? 0 : performance.now() - active.ackMonotonic
      const hardDeadline = attempt.executionDeadlineAt !== null && now >= Date.parse(attempt.executionDeadlineAt)
      if (hardDeadline || elapsedMono >= LIMITS.executionTimeoutMs) {
        active.forcedOutcome = 'TIMED_OUT'
        active.controller.abort()
        active.prepared?.cancel()
      } else if (idleMs >= LIMITS.stalledMs) {
        active.forcedOutcome = 'STALLED'
        active.controller.abort()
        active.prepared?.cancel()
      }
    }
  }

  private experimentIdForAttempt(attempt: Attempt): UUID {
    const row = this.store.db.prepare('SELECT experiment_id FROM attempts WHERE attempt_id=?').get(attempt.attemptId) as { experiment_id: string } | undefined
    if (row === undefined) throw new Error(`attempt has no experiment: ${attempt.attemptId}`)
    return row.experiment_id
  }
}

class DurableClock {
  private readonly baseWall: number
  private readonly baseMono: number
  private lastPersisted: number

  constructor(private readonly store: ControlStore) {
    const stored = Number(store.getMeta('last_wall_clock_ms') ?? 0)
    this.baseWall = Math.max(Date.now(), Number.isFinite(stored) ? stored : 0)
    this.baseMono = performance.now()
    this.lastPersisted = this.baseWall
  }

  now(): number {
    return Math.max(Date.now(), this.baseWall + (performance.now() - this.baseMono))
  }

  checkpoint(): void {
    const now = this.now()
    if (now - this.lastPersisted >= 1000) {
      this.store.setMeta('last_wall_clock_ms', String(Math.floor(now)))
      this.lastPersisted = now
    }
  }
}

function runForAttempt(experiment: ExperimentProjection, attempt: Attempt): Run {
  const run = experiment.runs.find(candidate => candidate.runId === attempt.runId)
  if (run === undefined) throw new Error(`run missing for attempt ${attempt.attemptId}`)
  return run
}

function cancelledResult(): ExecutionResult {
  return { outcome: 'CANCELLED', finalResponse: null, error: null, providerRequestId: null, executionTerminationConfirmed: true }
}

function normalizeExecutionFailure(error: unknown): ModelPkError {
  if (error instanceof ModelPkException) return error.detail
  return modelPkError('DSH_RUNNER_ERROR', 'execute', 'DSH 执行器异常', error instanceof Error ? error.message : String(error), { retryable: true })
}

function compactEvent(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const seq = typeof event.seq === 'number' ? event.seq : null
  const time = typeof event.time === 'number' ? event.time : null
  return { type, seq, time }
}
