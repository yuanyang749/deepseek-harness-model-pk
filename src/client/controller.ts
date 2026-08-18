import type {
  AuditEvent,
  CapabilityReport,
  Draft,
  DraftUpdateRequest,
  ExperimentProjection,
  ModelListItem,
  ModelPkError,
  PollResult,
  PreflightSnapshot,
  StorageListItem,
} from '../contracts/types.js'
import { RPC_ENDPOINTS } from '../contracts/rpc.js'
import { ClientApiError, ModelPkApi } from './api.js'

export type UiScreen = 'create' | 'preflight' | 'experiment' | 'storage'

export interface UiSnapshot {
  readonly open: boolean
  readonly screen: UiScreen
  readonly busy: boolean
  readonly busyLabel: string | null
  readonly error: ModelPkError | null
  readonly capability: CapabilityReport | null
  readonly models: readonly ModelListItem[]
  readonly draft: Draft | null
  readonly preflight: PreflightSnapshot | null
  readonly experiment: ExperimentProjection | null
  readonly events: readonly AuditEvent[]
  readonly storage: readonly StorageListItem[]
}

const LAST_EXPERIMENT_KEY = 'dsh-model-pk:last-experiment-id'
const DRAFT_KEY = 'dsh-model-pk:draft-id'

export class ModelPkUiController {
  private value: UiSnapshot = {
    open: false,
    screen: 'create',
    busy: false,
    busyLabel: null,
    error: null,
    capability: null,
    models: [],
    draft: null,
    preflight: null,
    experiment: null,
    events: [],
    storage: [],
  }
  private readonly listeners = new Set<() => void>()
  private pollAbort: AbortController | null = null
  private booted = false

  constructor(private readonly api: ModelPkApi) {}

  readonly getSnapshot = (): UiSnapshot => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async open(): Promise<void> {
    this.patch({ open: true })
    if (this.booted) {
      if (this.value.experiment !== null) this.watchExperiment(this.value.experiment.experimentId)
      return
    }
    this.booted = true
    await this.run('正在连接 Model PK…', async () => {
      const [capability, models] = await Promise.all([
        this.api.business<CapabilityReport>(RPC_ENDPOINTS.capabilitiesGet, {}),
        this.api.business<readonly ModelListItem[]>(RPC_ENDPOINTS.modelsList, {}),
      ])
      let draft: Draft | null = null
      const draftId = localStorage.getItem(DRAFT_KEY)
      if (draftId !== null) {
        draft = await this.api.business<Draft>(RPC_ENDPOINTS.draftGet, { draftId }).catch(() => null)
      }
      if (draft === null) {
        draft = await this.api.business<Draft>(RPC_ENDPOINTS.draftCreate, {})
        localStorage.setItem(DRAFT_KEY, draft.draftId)
      }
      this.patch({ capability, models, draft })
      const experimentId = localStorage.getItem(LAST_EXPERIMENT_KEY)
      if (experimentId !== null) {
        const experiment = await this.api.business<ExperimentProjection>(RPC_ENDPOINTS.experimentGet, { experimentId }).catch(() => null)
        if (experiment !== null) {
          this.patch({ experiment, screen: 'experiment' })
          this.watchExperiment(experiment.experimentId)
        }
      }
    })
    if (this.value.capability === null) this.booted = false
  }

  close(): void {
    this.stopWatchingExperiment()
    this.patch({ open: false })
  }

  show(screen: UiScreen): void {
    this.patch({ screen, error: null })
    if (screen === 'storage') void this.loadStorage()
    if (screen === 'experiment' && this.value.experiment !== null) this.watchExperiment(this.value.experiment.experimentId)
  }

  async newDraft(): Promise<void> {
    await this.run('正在创建草稿…', async () => {
      const draft = await this.api.business<Draft>(RPC_ENDPOINTS.draftCreate, {})
      localStorage.setItem(DRAFT_KEY, draft.draftId)
      this.patch({ draft, preflight: null, screen: 'create' })
    })
  }

  async saveDraft(patch: DraftUpdateRequest['patch']): Promise<Draft> {
    const current = this.requiredDraft()
    const draft = await this.api.business<Draft>(RPC_ENDPOINTS.draftUpdate, {
      draftId: current.draftId,
      expectedRevision: current.revision,
      patch,
    })
    this.patch({ draft, preflight: null })
    return draft
  }

  async saveDraftSafely(patch: DraftUpdateRequest['patch']): Promise<boolean> {
    let saved = false
    await this.run('正在保存草稿…', async () => {
      await this.saveDraft(patch)
      saved = true
    })
    return saved
  }

  async uploadFiles(files: readonly File[]): Promise<void> {
    await this.run('正在校验并上传图片…', async () => {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const expectedHash = await sha256(bytes)
        const draft = this.requiredDraft()
        const begin = await this.api.business<{ uploadId: string; chunkSize: number }>(RPC_ENDPOINTS.attachmentBegin, {
          draftId: draft.draftId,
          expectedRevision: draft.revision,
          name: file.name,
          mimeType: file.type,
          byteLength: bytes.byteLength,
          expectedHash,
        })
        for (let offset = 0; offset < bytes.byteLength; offset += begin.chunkSize) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + begin.chunkSize))
          await this.api.business(RPC_ENDPOINTS.attachmentChunk, {
            uploadId: begin.uploadId,
            offset,
            bytesBase64: base64(chunk),
          })
        }
        const next = await this.api.business<Draft>(RPC_ENDPOINTS.attachmentCommit, { uploadId: begin.uploadId })
        this.patch({ draft: next, preflight: null })
      }
    })
  }

  async removeAttachment(attachmentId: string): Promise<void> {
    await this.run('正在移除图片…', async () => {
      const draft = this.requiredDraft()
      const next = await this.api.business<Draft>(RPC_ENDPOINTS.attachmentRemove, {
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        attachmentId,
      })
      this.patch({ draft: next, preflight: null })
    })
  }

  async reorderAttachments(attachmentOrder: readonly string[]): Promise<void> {
    await this.run('正在保存图片顺序…', async () => {
      await this.saveDraft({ attachmentOrder })
    })
  }

  async selectBaseline(sourcePath: string): Promise<void> {
    await this.run('正在扫描并冻结工作区基线…', async () => {
      const draft = this.requiredDraft()
      const next = await this.api.business<Draft>(RPC_ENDPOINTS.baselineSelect, {
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        sourcePath,
      })
      this.patch({ draft: next, preflight: null })
    })
  }

  async clearBaseline(): Promise<void> {
    await this.run('正在清除工作区基线…', async () => {
      const draft = this.requiredDraft()
      const next = await this.api.business<Draft>(RPC_ENDPOINTS.baselineClear, {
        draftId: draft.draftId,
        expectedRevision: draft.revision,
      })
      this.patch({ draft: next, preflight: null })
    })
  }

  async runPreflight(): Promise<void> {
    await this.run('正在执行 Preflight…', async () => {
      const draft = this.requiredDraft()
      const preflight = await this.api.business<PreflightSnapshot>(RPC_ENDPOINTS.preflightRun, { draftId: draft.draftId })
      this.patch({ preflight, screen: 'preflight' })
    })
  }

  async confirmWarning(): Promise<void> {
    await this.run('正在确认当前快照…', async () => {
      const current = this.requiredPreflight()
      const preflight = await this.api.business<PreflightSnapshot>(RPC_ENDPOINTS.preflightConfirm, {
        draftId: current.draftId,
        preflightId: current.preflightId,
        snapshotHash: current.snapshotHash,
      })
      this.patch({ preflight })
    })
  }

  async startExperiment(): Promise<void> {
    await this.run('正在持久化 Experiment…', async () => {
      const preflight = this.requiredPreflight()
      const experiment = await this.api.business<ExperimentProjection>(RPC_ENDPOINTS.experimentStart, {
        operationId: crypto.randomUUID(),
        request: {
          draftId: preflight.draftId,
          preflightId: preflight.preflightId,
          snapshotHash: preflight.snapshotHash,
        },
      })
      localStorage.setItem(LAST_EXPERIMENT_KEY, experiment.experimentId)
      this.patch({ experiment, events: [], screen: 'experiment' })
      this.watchExperiment(experiment.experimentId)
    })
  }

  async stopAttempt(attemptId: string, expectedLifecycleVersion: number): Promise<void> {
    const experiment = this.requiredExperiment()
    await this.action('正在停止 Attempt…', RPC_ENDPOINTS.attemptStop, {
      experimentId: experiment.experimentId,
      attemptId,
      expectedLifecycleVersion,
    })
  }

  async stopAll(): Promise<void> {
    const experiment = this.requiredExperiment()
    await this.action('正在停止全部 Attempt…', RPC_ENDPOINTS.experimentStopAll, { experimentId: experiment.experimentId })
  }

  async retry(runId: string, expectedAttemptId: string): Promise<void> {
    const experiment = this.requiredExperiment()
    await this.action('正在创建 Retry Attempt…', RPC_ENDPOINTS.runRetry, { experimentId: experiment.experimentId, runId, expectedAttemptId })
  }

  async runAgain(runId: string, expectedAttemptId: string): Promise<void> {
    const experiment = this.requiredExperiment()
    await this.action('正在创建 Run Again Attempt…', RPC_ENDPOINTS.runAgain, { experimentId: experiment.experimentId, runId, expectedAttemptId })
  }

  async retryFailed(): Promise<void> {
    const experiment = this.requiredExperiment()
    await this.action('正在批量创建 Retry Attempt…', RPC_ENDPOINTS.experimentRetryFailed, { experimentId: experiment.experimentId })
  }

  async openFolder(experimentId: string): Promise<void> {
    await this.run('正在打开归档目录…', () => this.api.native(RPC_ENDPOINTS.experimentOpenFolder, { experimentId }))
  }

  async loadStorage(): Promise<void> {
    await this.run('正在读取本地存储…', async () => {
      const storage = await this.api.business<readonly StorageListItem[]>(RPC_ENDPOINTS.storageListForDeletion, {})
      this.patch({ storage })
    })
  }

  async deleteExperiment(experimentId: string): Promise<void> {
    const deletingCurrent = this.value.experiment?.experimentId === experimentId
    if (deletingCurrent) this.stopWatchingExperiment()
    let deleted = false
    await this.run('正在永久删除实验…', async () => {
      await this.api.business(RPC_ENDPOINTS.experimentDelete, {
        operationId: crypto.randomUUID(),
        request: { experimentId },
      })
      deleted = true
      if (deletingCurrent) {
        localStorage.removeItem(LAST_EXPERIMENT_KEY)
        this.patch({ experiment: null, events: [] })
      }
      const storage = await this.api.business<readonly StorageListItem[]>(RPC_ENDPOINTS.storageListForDeletion, {})
      this.patch({ storage })
    })
    if (!deleted && deletingCurrent && this.value.experiment?.experimentId === experimentId && this.value.open) {
      this.watchExperiment(experimentId)
    }
  }

  clearError(): void {
    this.patch({ error: null })
  }

  private async action(label: string, endpoint: string, request: Readonly<Record<string, unknown>>): Promise<void> {
    await this.run(label, async () => {
      const experiment = this.requiredExperiment()
      await this.api.business(endpoint, { operationId: crypto.randomUUID(), request })
      const projection = await this.api.business<ExperimentProjection>(RPC_ENDPOINTS.experimentGet, { experimentId: experiment.experimentId })
      this.patch({ experiment: projection })
      this.watchExperiment(projection.experimentId)
    })
  }

  private watchExperiment(experimentId: string): void {
    this.stopWatchingExperiment()
    const controller = new AbortController()
    this.pollAbort = controller
    void (async () => {
      let cursor = this.value.events.at(-1)?.cursor ?? 0
      while (!controller.signal.aborted && this.value.open) {
        try {
          const result = await this.api.business<PollResult>(RPC_ENDPOINTS.experimentPoll, {
            experimentId,
            afterCursor: cursor,
          }, controller.signal)
          cursor = result.nextCursor
          const events = mergeEvents(this.value.events, result.events)
          this.patch({ experiment: result.projection, events })
        } catch (error) {
          if (controller.signal.aborted) return
          this.patch({ error: clientError(error, 'poll') })
          await delay(1000, controller.signal)
        }
      }
    })()
  }

  private stopWatchingExperiment(): void {
    this.pollAbort?.abort()
    this.pollAbort = null
  }

  private async run<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
    this.patch({ busy: true, busyLabel: label, error: null })
    try {
      return await operation()
    } catch (error) {
      this.patch({ error: clientError(error, 'client') })
      return undefined
    } finally {
      this.patch({ busy: false, busyLabel: null })
    }
  }

  private requiredDraft(): Draft {
    if (this.value.draft === null) throw new Error('Draft 尚未加载')
    return this.value.draft
  }

  private requiredPreflight(): PreflightSnapshot {
    if (this.value.preflight === null) throw new Error('Preflight 尚未运行')
    return this.value.preflight
  }

  private requiredExperiment(): ExperimentProjection {
    if (this.value.experiment === null) throw new Error('Experiment 尚未加载')
    return this.value.experiment
  }

  private patch(patch: Partial<UiSnapshot>): void {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function mergeEvents(current: readonly AuditEvent[], next: readonly AuditEvent[]): AuditEvent[] {
  const byCursor = new Map(current.map(event => [event.cursor, event]))
  for (const event of next) byCursor.set(event.cursor, event)
  return [...byCursor.values()].sort((left, right) => left.cursor - right.cursor).slice(-2000)
}

function clientError(error: unknown, phase: string): ModelPkError {
  if (error instanceof ClientApiError) return error.detail
  return {
    code: 'DSH_UNREACHABLE',
    phase,
    retryable: true,
    userMessage: error instanceof Error ? error.message : '连接 Model PK 失败',
    technicalMessage: error instanceof Error ? error.stack ?? error.message : String(error),
    occurredAt: new Date().toISOString(),
  }
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input.buffer)
  return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const stride = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + stride)))
  }
  return btoa(binary)
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(finish, milliseconds)
    function finish(): void {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}
