import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type {
  Attempt,
  DurableAction,
  ExperimentPollRequest,
  ExperimentProjection,
  Hash,
  OperationEnvelope,
  PollResult,
  RetryRequest,
  StartRequest,
  StopRequest,
  StorageListItem,
  UUID,
} from '../contracts/types.js'
import { LIMITS } from '../contracts/constants.js'
import { createAttempt, createExperimentDefinition } from '../domain/factory.js'
import { ModelPkException, fail, modelPkError, normalizeError } from '../core/error.js'
import { hashCanonical } from '../core/jcs.js'
import { isCancellableState, isRetryableTerminal } from '../core/state-machine.js'
import type { ControlStore } from '../storage/store.js'
import type { ArchiveManager } from './archive.js'
import type { ModelCatalog } from './model-catalog.js'
import type { PreflightService } from './preflight.js'
import type { Scheduler } from './scheduler.js'

export class Coordinator {
  private readonly waiter: EventWaiter

  constructor(
    private readonly store: ControlStore,
    private readonly archive: ArchiveManager,
    private readonly preflight: PreflightService,
    private readonly models: ModelCatalog,
    private readonly scheduler: Scheduler,
  ) {
    this.waiter = new EventWaiter(store)
  }

  dispose(): void {
    this.waiter.dispose()
  }

  async recoverStartingExperiments(): Promise<void> {
    for (const experiment of this.store.experimentsInState(['STARTING'])) {
      try {
        await this.archive.publishDefinition(experiment, experiment.runs)
        this.store.activateExperiment(experiment.experimentId)
      } catch (error) {
        this.store.markStartFailed(experiment.experimentId, modelPkError(
          'START_COMMIT_FAILED',
          'start-recovery',
          '实验定义发布失败',
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        ))
      }
    }
  }

  async recoverPendingDeletes(): Promise<void> {
    for (const action of this.store.pendingActions('DELETE')) {
      if (action.experimentId === null) {
        this.store.failAction(action.actionId, modelPkError('CONTROL_STORE_UNAVAILABLE', 'delete-recovery', '删除操作缺少 Experiment', `action=${action.actionId}`))
        continue
      }
      const experiment = this.store.getExperiment(action.experimentId)
      if (experiment === null) continue
      try {
        let trashPath = await this.archive.findTrashForExperiment(experiment.experimentId)
        if (trashPath === null) trashPath = await this.archive.moveToTrash(experiment.experimentPath, experiment.experimentId)
        const receipt = {
          schemaVersion: 'model-pk/deletion-receipt/v1',
          operationId: action.actionId,
          requestHash: action.requestHash,
          experimentId: experiment.experimentId,
          deletedAt: new Date().toISOString(),
          recovered: true,
        }
        this.store.deleteExperimentControlRows(experiment.experimentId, action.actionId, action.requestHash, receipt)
        await this.archive.removeTrash(trashPath)
      } catch (error) {
        this.store.appendEvent(experiment.experimentId, null, 'DELETE_RECOVERY_ERROR', {
          actionId: action.actionId,
          error: normalizeError(error, 'delete-recovery'),
        })
      }
    }
    for (const entry of await this.archive.trashEntries()) {
      if (this.store.getExperiment(entry.experimentId) === null) await this.archive.removeTrash(entry.path)
    }
  }

  async startExperiment(envelope: OperationEnvelope<StartRequest>): Promise<ExperimentProjection> {
    const requestHash = hashCanonical(envelope.request)
    const existing = this.existingAction(envelope.operationId, 'START', requestHash)
    if (existing !== null) {
      const experimentId = existing.experimentId ?? stringResult(existing, 'experimentId')
      if (experimentId === null) fail('CONTROL_STORE_UNAVAILABLE', 'start', '启动操作尚未恢复完成', `pending start action=${envelope.operationId}`)
      return this.store.getExperimentRequired(experimentId)
    }
    const snapshot = this.preflight.assertStartable(
      envelope.request.draftId,
      envelope.request.preflightId,
      envelope.request.snapshotHash,
    )
    for (const model of snapshot.models) await this.models.assertNoDrift(model)
    const active = this.store.activeExperiment()
    if (active !== null) fail('CONFLICT', 'start', '当前已有运行中的 Experiment', `active experiment=${active.experimentId}`)
    const provisionalId = crypto.randomUUID()
    const path = this.archive.experimentPath(provisionalId, snapshot.taskPackage.taskName)
    const definition = createExperimentDefinition({
      preflight: snapshot,
      experimentPath: path,
      experimentId: provisionalId,
      firstQueueSeq: this.store.nextQueueSequence(),
    })
    const action = this.store.createExperiment({
      ...definition,
      actionId: envelope.operationId,
      requestHash,
    })
    if (action.state === 'FAILED') throw new ModelPkException(action.error ?? modelPkError('START_COMMIT_FAILED', 'start', '启动操作失败', 'action failed without error'))
    try {
      await this.archive.publishDefinition(definition.experiment, definition.runs)
      const projection = this.store.activateExperiment(definition.experiment.experimentId)
      await this.archive.writeProjection(projection)
      void this.scheduler.tick()
      return projection
    } catch (error) {
      const detail = error instanceof ModelPkException
        ? error.detail
        : modelPkError('START_COMMIT_FAILED', 'start-publish', '实验定义发布失败', error instanceof Error ? error.message : String(error), { retryable: true })
      return this.store.markStartFailed(definition.experiment.experimentId, detail)
    }
  }

  stopAttempt(envelope: OperationEnvelope<StopRequest>): DurableAction {
    const requestHash = hashCanonical(envelope.request)
    const existing = this.existingAction(envelope.operationId, 'STOP', requestHash)
    if (existing !== null) return existing
    const action = this.store.transaction(() => {
      const claim = this.store.claimAction(envelope.operationId, 'STOP', envelope.request.experimentId, requestHash)
      if (claim.existing) return claim.action
      const attempt = this.store.getAttemptRequired(envelope.request.attemptId)
      if (this.experimentIdForAttempt(attempt) !== envelope.request.experimentId) {
        fail('NOT_FOUND', 'stop', 'Attempt 不属于该 Experiment', `attempt=${attempt.attemptId}`)
      }
      if (attempt.lifecycleVersion !== envelope.request.expectedLifecycleVersion || !isCancellableState(attempt.state)) {
        fail('ACTION_TARGET_STALE', 'stop', 'Attempt 状态已变化，请刷新后重试', `state=${attempt.state}; version=${attempt.lifecycleVersion}`)
      }
      this.store.addActionTarget(envelope.operationId, attempt.attemptId, attempt.lifecycleVersion)
      const now = new Date().toISOString()
      if (attempt.state === 'QUEUED') {
        const conditions = this.store.getExperimentRequired(envelope.request.experimentId).executionConditions
        this.store.transitionAttempt(attempt.attemptId, {
          expectedVersion: attempt.lifecycleVersion,
          to: 'FINALIZING',
          patch: {
            observedExecutionOutcome: 'CANCELLED',
            pendingOutcome: 'CANCELLED',
            finalizationId: crypto.randomUUID(),
            finalizationStage: 'INTENT_RECORDED',
            finalizationStartedAt: now,
            finalizationDeadlineAt: new Date(Date.now() + conditions.finalizationTimeoutMs).toISOString(),
            executionEndedAt: now,
            executionTerminationConfirmed: true,
            cancelReason: 'USER_CANCELLED',
          },
        })
      } else {
        this.store.transitionAttempt(attempt.attemptId, {
          expectedVersion: attempt.lifecycleVersion,
          to: 'CANCELLING',
          patch: { cancelReason: 'USER_CANCELLED' },
        })
      }
      this.store.updateActionTarget(envelope.operationId, attempt.attemptId, 'ACCEPTED')
      return this.store.finishAction(envelope.operationId, { attemptId: attempt.attemptId })
    })
    this.scheduler.requestCancel(envelope.request.attemptId, 'USER_CANCELLED')
    return action
  }

  stopAll(envelope: OperationEnvelope<{ readonly experimentId: UUID }>): DurableAction {
    const requestHash = hashCanonical(envelope.request)
    const existing = this.existingAction(envelope.operationId, 'STOP_ALL', requestHash)
    if (existing !== null) return existing
    const targets: UUID[] = []
    const action = this.store.transaction(() => {
      const claim = this.store.claimAction(envelope.operationId, 'STOP_ALL', envelope.request.experimentId, requestHash)
      if (claim.existing) return claim.action
      const experiment = this.store.getExperimentRequired(envelope.request.experimentId)
      const now = new Date().toISOString()
      const frozen = experiment.runs
        .flatMap(run => run.attempts)
        .filter(attempt => isCancellableState(attempt.state))
      for (const attempt of frozen) {
        this.store.addActionTarget(envelope.operationId, attempt.attemptId, attempt.lifecycleVersion)
        if (attempt.state === 'QUEUED') {
          this.store.transitionAttempt(attempt.attemptId, {
            expectedVersion: attempt.lifecycleVersion,
            to: 'FINALIZING',
            patch: {
              observedExecutionOutcome: 'CANCELLED',
              pendingOutcome: 'CANCELLED',
              finalizationId: crypto.randomUUID(),
              finalizationStage: 'INTENT_RECORDED',
              finalizationStartedAt: now,
              finalizationDeadlineAt: new Date(Date.now() + experiment.executionConditions.finalizationTimeoutMs).toISOString(),
              executionEndedAt: now,
              executionTerminationConfirmed: true,
              cancelReason: 'STOP_ALL',
            },
          })
        } else {
          this.store.transitionAttempt(attempt.attemptId, {
            expectedVersion: attempt.lifecycleVersion,
            to: 'CANCELLING',
            patch: { cancelReason: 'STOP_ALL' },
          })
        }
        this.store.updateActionTarget(envelope.operationId, attempt.attemptId, 'ACCEPTED')
        targets.push(attempt.attemptId)
      }
      return this.store.finishAction(envelope.operationId, { targetAttemptIds: targets })
    })
    for (const target of targets) this.scheduler.requestCancel(target, 'STOP_ALL')
    return action
  }

  async retry(envelope: OperationEnvelope<RetryRequest>): Promise<DurableAction> {
    return this.createSingleAttempt(envelope, 'RETRY')
  }

  async runAgain(envelope: OperationEnvelope<RetryRequest>): Promise<DurableAction> {
    return this.createSingleAttempt(envelope, 'RUN_AGAIN')
  }

  async retryFailed(envelope: OperationEnvelope<{ readonly experimentId: UUID }>): Promise<DurableAction> {
    const requestHash = hashCanonical(envelope.request)
    const existing = this.existingAction(envelope.operationId, 'RETRY_FAILED', requestHash)
    if (existing !== null) return existing
    const experiment = this.store.getExperimentRequired(envelope.request.experimentId)
    this.assertExperimentMayBecomeActive(experiment.experimentId)
    const targets = experiment.runs.flatMap(run => {
      const latest = run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId)
      return latest !== undefined && isRetryableTerminal(latest) ? [{ run, latest }] : []
    })
    if (targets.length === 0) {
      fail('ACTION_TARGET_STALE', 'retry-failed', '当前没有可重试的失败 Attempt', `experiment=${experiment.experimentId}`)
    }
    for (const { run } of targets) await this.models.assertNoDrift(run.modelConfig)
    const firstQueue = this.store.nextQueueSequence()
    const now = new Date().toISOString()
    const attempts = targets.map(({ run }, index) => createAttempt({
      runId: run.runId,
      attemptNo: run.attemptCount + 1,
      trigger: 'RETRY_FAILED',
      batchActionId: envelope.operationId,
      model: run.modelConfig,
      taskPackage: experiment.taskPackage,
      taskPackageHash: experiment.taskPackageHash,
      harness: experiment.resolvedHarness,
      executionConditions: experiment.executionConditions,
      executionConditionsHash: experiment.executionConditionsHash,
      queueSeq: firstQueue + index,
      now,
    }))
    const action = this.store.createAttemptBatch({
      attempts,
      actionId: envelope.operationId,
      actionKind: 'RETRY_FAILED',
      requestHash,
      experimentId: experiment.experimentId,
      expectedLatestByRun: Object.fromEntries(targets.map(({ run, latest }) => [run.runId, latest.attemptId])),
    })
    void this.scheduler.tick()
    return action
  }

  getExperiment(experimentId: UUID): ExperimentProjection {
    return this.store.getExperimentRequired(experimentId)
  }

  async poll(request: ExperimentPollRequest, signal?: AbortSignal): Promise<PollResult> {
    this.store.getExperimentRequired(request.experimentId)
    let events = this.store.eventsAfter(request.experimentId, request.afterCursor)
    if (events.length === 0) {
      await this.waiter.wait(request.experimentId, request.afterCursor, LIMITS.eventPollMs, signal)
      events = this.store.eventsAfter(request.experimentId, request.afterCursor)
    }
    const projection = this.store.getExperimentRequired(request.experimentId)
    return {
      experimentId: request.experimentId,
      fromCursor: request.afterCursor,
      nextCursor: events.at(-1)?.cursor ?? request.afterCursor,
      events,
      projection,
    }
  }

  async listStorage(): Promise<StorageListItem[]> {
    const rows = this.store.listStorage()
    return Promise.all(rows.map(async row => ({
      ...row,
      byteLength: await this.archive.directoryBytes(row.experimentPath).catch(() => 0),
    })))
  }

  async openFolder(experimentId: UUID): Promise<{ opened: true }> {
    const experiment = this.store.getExperimentRequired(experimentId)
    const registered = resolve(experiment.experimentPath)
    const actual = await realpath(registered)
    const root = await realpath(this.archive.layout.experiments)
    const rel = relative(root, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`)) fail('ARCHIVE_PATH_ESCAPE', 'open-folder', '实验目录路径无效', `path outside data root: ${actual}`)
    const info = await lstat(actual)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_PATH_ESCAPE', 'open-folder', '实验目录路径无效', `not a regular directory: ${actual}`)
    await openInFinder(actual)
    return { opened: true }
  }

  async chooseBaselineFolder(): Promise<{ path: string | null }> {
    return chooseFolder()
  }

  async openResult(experimentId: UUID, attemptId: UUID): Promise<{ opened: true }> {
    const experiment = this.store.getExperimentRequired(experimentId)
    const attempt = experiment.runs.flatMap(run => run.attempts).find(item => item.attemptId === attemptId)
    const run = experiment.runs.find(item => item.attempts.some(candidate => candidate.attemptId === attemptId))
    if (attempt === undefined || run === undefined) fail('NOT_FOUND', 'open-result', '执行记录不存在', `attempt missing ${attemptId}`)
    const registered = resolve(
      experiment.experimentPath,
      'runs',
      run.runId,
      'attempts',
      `${String(attempt.attemptNo).padStart(3, '0')}-${attempt.attemptId}`,
    )
    const actual = await realpath(registered)
    const root = await realpath(this.archive.layout.experiments)
    const rel = relative(root, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`)) fail('ARCHIVE_PATH_ESCAPE', 'open-result', '结果目录路径无效', `path outside data root: ${actual}`)
    const info = await lstat(actual)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_PATH_ESCAPE', 'open-result', '结果目录路径无效', `not a regular directory: ${actual}`)
    await openInFinder(actual)
    return { opened: true }
  }

  async deleteExperiment(envelope: OperationEnvelope<{ readonly experimentId: UUID }>): Promise<Readonly<Record<string, unknown>>> {
    const requestHash = hashCanonical(envelope.request)
    const receipt = this.store.deletionReceipt(envelope.operationId)
    if (receipt !== null) {
      if (receipt.requestHash !== requestHash) fail('ACTION_ID_CONFLICT', 'delete', 'operationId 已用于不同删除请求')
      return receipt
    }
    const experiment = this.store.getExperimentRequired(envelope.request.experimentId)
    if (experiment.lifecycleState !== 'SETTLED' || experiment.activeActions.length > 0) {
      fail('DELETE_NOT_ALLOWED', 'delete', '仅可删除已结束且没有进行中操作的实验', `lifecycle=${experiment.lifecycleState}`)
    }
    const claim = this.store.claimAction(envelope.operationId, 'DELETE', experiment.experimentId, requestHash)
    if (claim.existing && claim.action.state === 'FAILED') throw new ModelPkException(claim.action.error!)
    let trashPath: string
    try {
      trashPath = await this.archive.moveToTrash(experiment.experimentPath, experiment.experimentId)
    } catch (error) {
      const detail = normalizeError(error, 'delete-move')
      this.store.failAction(envelope.operationId, detail)
      throw new ModelPkException(detail)
    }
    const deletionReceipt = {
      schemaVersion: 'model-pk/deletion-receipt/v1',
      operationId: envelope.operationId,
      requestHash,
      experimentId: experiment.experimentId,
      deletedAt: new Date().toISOString(),
    }
    try {
      this.store.deleteExperimentControlRows(experiment.experimentId, envelope.operationId, requestHash, deletionReceipt)
    } catch (error) {
      throw new ModelPkException(normalizeError(error, 'delete-control'))
    }
    await this.archive.removeTrash(trashPath).catch(() => undefined)
    return deletionReceipt
  }

  private async createSingleAttempt(
    envelope: OperationEnvelope<RetryRequest>,
    trigger: 'RETRY' | 'RUN_AGAIN',
  ): Promise<DurableAction> {
    const requestHash = hashCanonical(envelope.request)
    const existing = this.existingAction(envelope.operationId, trigger, requestHash)
    if (existing !== null) return existing
    const experiment = this.store.getExperimentRequired(envelope.request.experimentId)
    this.assertExperimentMayBecomeActive(experiment.experimentId)
    const run = experiment.runs.find(candidate => candidate.runId === envelope.request.runId)
    if (run === undefined) fail('NOT_FOUND', 'retry', 'Run 不存在', `run=${envelope.request.runId}`)
    if (run.latestAttemptId !== envelope.request.expectedAttemptId) {
      fail('ACTION_TARGET_STALE', 'retry', 'Run 最新 Attempt 已变化', `expected=${envelope.request.expectedAttemptId}; actual=${run.latestAttemptId}`)
    }
    const latest = run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId)
    if (latest === undefined) fail('INTERNAL_ERROR', 'retry', 'Run 缺少最新 Attempt')
    if (trigger === 'RETRY' && !isRetryableTerminal(latest)) {
      fail('ACTION_TARGET_STALE', 'retry', '该 Attempt 当前不可 Retry', `state=${latest.state}; retryable=${latest.error?.retryable ?? false}`)
    }
    if (trigger === 'RUN_AGAIN' && latest.state !== 'SUCCEEDED') {
      fail('ACTION_TARGET_STALE', 'run-again', '仅成功 Run 可 Run Again', `state=${latest.state}`)
    }
    await this.models.assertNoDrift(run.modelConfig)
    const attempt = createAttempt({
      runId: run.runId,
      attemptNo: run.attemptCount + 1,
      trigger,
      batchActionId: null,
      model: run.modelConfig,
      taskPackage: experiment.taskPackage,
      taskPackageHash: experiment.taskPackageHash,
      harness: experiment.resolvedHarness,
      executionConditions: experiment.executionConditions,
      executionConditionsHash: experiment.executionConditionsHash,
      queueSeq: this.store.nextQueueSequence(),
    })
    const action = this.store.createAttempt({
      attempt,
      actionId: envelope.operationId,
      actionKind: trigger,
      requestHash,
      expectedLatestAttemptId: latest.attemptId,
    })
    void this.scheduler.tick()
    return action
  }

  private existingAction(operationId: UUID, kind: DurableAction['kind'], requestHash: Hash): DurableAction | null {
    const action = this.store.getAction(operationId)
    if (action === null) return null
    if (action.kind !== kind || action.requestHash !== requestHash) {
      fail('ACTION_ID_CONFLICT', 'action', 'operationId 已用于不同请求', `operation=${operationId}; existingKind=${action.kind}; requestedKind=${kind}`)
    }
    return action
  }

  private experimentIdForAttempt(attempt: Attempt): UUID {
    const row = this.store.db.prepare('SELECT experiment_id FROM attempts WHERE attempt_id=?').get(attempt.attemptId) as { experiment_id: string } | undefined
    if (row === undefined) fail('NOT_FOUND', 'query', 'Attempt 不存在', `attempt=${attempt.attemptId}`)
    return row.experiment_id
  }

  private assertExperimentMayBecomeActive(experimentId: UUID): void {
    const active = this.store.activeExperiment()
    if (active !== null && active.experimentId !== experimentId) {
      fail('CONFLICT', 'retry', '当前已有其他运行中的 Experiment', `active experiment=${active.experimentId}`)
    }
  }
}

class EventWaiter {
  private readonly waiters = new Set<{
    readonly experimentId: UUID
    readonly afterCursor: number
    resolve(): void
  }>()
  private readonly off: () => void

  constructor(store: ControlStore) {
    this.off = store.onEvent(event => {
      for (const waiter of this.waiters) {
        if (waiter.experimentId === event.experimentId && event.cursor > waiter.afterCursor) waiter.resolve()
      }
    })
  }

  wait(experimentId: UUID, afterCursor: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolvePromise => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        this.waiters.delete(waiter)
        resolvePromise()
      }
      const waiter = { experimentId, afterCursor, resolve: finish }
      const timer = setTimeout(finish, Math.min(1000, Math.max(0, timeoutMs)))
      signal?.addEventListener('abort', finish, { once: true })
      this.waiters.add(waiter)
    })
  }

  dispose(): void {
    this.off()
    for (const waiter of this.waiters) waiter.resolve()
    this.waiters.clear()
  }
}

function stringResult(action: DurableAction, key: string): string | null {
  const value = action.result?.[key]
  return typeof value === 'string' ? value : null
}

function openInFinder(target: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [target], { stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('/usr/bin/open', [target], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } })
        : null
    if (child === null) {
      rejectPromise(new Error(`打开目录仅支持 macOS 和 Windows，当前是 ${process.platform}`))
      return
    }
    child.once('error', rejectPromise)
    child.once('close', code => {
      if (code === 0 || process.platform === 'win32' && (code === 1 || code === null)) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`open exited ${code}`))
    })
  })
}

function chooseFolder(): Promise<{ path: string | null }> {
  if (process.platform === 'darwin') return chooseFolderMac()
  if (process.platform === 'win32') return chooseFolderWindows()
  return Promise.reject(new Error(`选择目录仅支持 macOS 和 Windows，当前是 ${process.platform}`))
}

function chooseFolderMac(): Promise<{ path: string | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目起始目录")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    })
    collectProcess(child, (code, stdout, stderr) => {
      if (code === 0) {
        const path = stdout.trim().replace(/\/$/u, '')
        resolvePromise({ path: path.length === 0 ? null : path })
        return
      }
      if (stderr.includes('User canceled') || stderr.includes('-128')) {
        resolvePromise({ path: null })
        return
      }
      rejectPromise(new Error(stderr.trim() || `osascript exited ${code}`))
    }, rejectPromise)
  })
}

function chooseFolderWindows(): Promise<{ path: string | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "选择项目起始目录"',
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }',
      'Write-Output $dialog.SelectedPath',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    collectProcess(child, (code, stdout, stderr) => {
      if (code === 0) {
        const path = stdout.trim().replace(/[\\/]+$/u, '')
        resolvePromise({ path: path.length === 0 ? null : path })
        return
      }
      if (code === 2) {
        resolvePromise({ path: null })
        return
      }
      rejectPromise(new Error(stderr.trim() || `powershell exited ${code}`))
    }, rejectPromise)
  })
}

function collectProcess(
  child: ReturnType<typeof spawn>,
  finish: (code: number | null, stdout: string, stderr: string) => void,
  fail: (error: Error) => void,
): void {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  child.once('error', fail)
  child.once('close', code => finish(code, stdout, stderr))
}
