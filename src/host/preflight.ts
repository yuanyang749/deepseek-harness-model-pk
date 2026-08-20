import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LIMITS } from '../contracts/constants.js'
import type {
  AttachmentRecord,
  Draft,
  Hash,
  ModelConfigSnapshot,
  PreflightCheck,
  PreflightSnapshot,
  TaskPackage,
  UUID,
} from '../contracts/types.js'
import { defaultExecutionConditions } from '../domain/factory.js'
import { ModelPkException, modelPkError, normalizeError } from '../core/error.js'
import { uuid } from '../core/ids.js'
import { hashCanonical, sha256File } from '../core/jcs.js'
import { validateConcurrency, validateModelSelection, validatePrompt, validateTaskName, validateTaskType } from '../core/validation.js'
import type { NativeHelper } from '../native/helper.js'
import type { ControlStore } from '../storage/store.js'
import type { ArchiveManager } from './archive.js'
import type { CompatibilityEvidence } from './compatibility.js'
import type { DshHostContext } from './dsh.js'
import { resolveHarness } from './harness.js'
import type { ModelCatalog } from './model-catalog.js'
import type { SeatbeltRunner } from '../native/seatbelt.js'

export class PreflightService {
  constructor(
    private readonly ctx: DshHostContext,
    private readonly store: ControlStore,
    private readonly archive: ArchiveManager,
    private readonly helper: NativeHelper,
    private readonly seatbelt: SeatbeltRunner,
    private readonly models: ModelCatalog,
    private readonly compatibility: () => CompatibilityEvidence,
  ) {}

  async run(draftId: UUID): Promise<PreflightSnapshot> {
    const draft = this.store.getDraft(draftId)
    if (draft === null) throw new ModelPkException(modelPkError('NOT_FOUND', 'preflight', '草稿不存在', `draft missing ${draftId}`))
    const checks: PreflightCheck[] = []
    const addCheck = async (
      id: string,
      label: string,
      operation: () => Promise<Readonly<Record<string, unknown>> | void>,
    ): Promise<void> => {
      try {
        const diagnostics = await operation()
        const warning = typeof diagnostics?.warning === 'string' ? diagnostics.warning : undefined
        const summary = typeof diagnostics?.summary === 'string' ? diagnostics.summary : warning ?? '通过'
        checks.push({
          id,
          label,
          status: warning === undefined ? 'PASS' : 'WARNING',
          summary,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        })
      } catch (error) {
        const detail = error instanceof ModelPkException ? error.detail : normalizeError(error, `preflight:${id}`)
        checks.push({ id, label, status: 'BLOCKED', summary: detail.userMessage, error: detail })
      }
    }
    await addCheck('input', '任务输入', async () => {
      validateTaskName(draft.taskName)
      validateTaskType(draft.taskType)
      validatePrompt(draft.prompt)
      validateModelSelection(draft.selectedModelConfigIds)
      validateConcurrency(draft.concurrency, draft.selectedModelConfigIds.length)
      return { promptBytes: Buffer.byteLength(draft.prompt, 'utf8'), modelCount: draft.selectedModelConfigIds.length }
    })
    await addCheck('compatibility', 'DSH 与执行隔离', async () => {
      const evidence = this.compatibility()
      if (!evidence.report.executionEnabled) {
        const first = evidence.report.blockers[0]
        if (first !== undefined) throw new ModelPkException(first)
        throw new Error('compatibility gate is blocked')
      }
      return { nativeHelperHash: evidence.report.nativeHelper.hash, checks: evidence.checks }
    })
    await addCheck('attachments', '附件完整性', () => this.verifyAttachments(draft))
    await addCheck('baseline', 'Baseline 快照', () => this.verifyBaseline(draft))
    const snapshots: ModelConfigSnapshot[] = []
    await this.models.list()
    await addCheck('models', '模型配置', async () => {
      const rows: Array<{ readonly model: string; readonly status: 'ok' | 'blocked'; readonly detail: string }> = []
      for (const modelConfigId of draft.selectedModelConfigIds) {
        try {
          const snapshot = await this.models.snapshot(modelConfigId)
          snapshots.push(snapshot)
          rows.push({ model: snapshot.modelName, status: 'ok', detail: snapshot.modelId })
        } catch (error) {
          const detail = error instanceof ModelPkException ? error.detail : normalizeError(error, 'preflight:models')
          rows.push({ model: modelConfigId, status: 'blocked', detail: detail.userMessage })
        }
      }
      if (rows.some(row => row.status === 'blocked')) {
        throw new ModelPkException(modelPkError(
          'MODEL_CONFIG_NOT_FOUND',
          'preflight',
          rows.filter(row => row.status === 'blocked').map(row => `${row.model}：${row.detail}`).join('；'),
          'one or more model snapshots failed',
          { details: { models: rows } },
        ))
      }
      return { summary: `已核对 ${rows.length} 个模型`, models: rows }
    })
    await addCheck('modalities', '公共输入模态', async () => {
      if (draft.attachments.length === 0) return { images: 0 }
      if (snapshots.length !== draft.selectedModelConfigIds.length) throw new Error('not every model has a valid snapshot')
      const unverified: Array<{ readonly model: string; readonly reason: string }> = []
      for (const snapshot of snapshots) {
        const capability = this.models.imageCapability(snapshot)
        if (capability.status === 'declared') {
          if (!this.models.isImagePathVerified(snapshot)) {
            throw new ModelPkException(modelPkError('ATTACHMENT_TRANSFORM_UNVERIFIED', 'preflight', `${snapshot.modelName} 的图片无损路径尚未验证`, `protocol=${snapshot.protocol}`))
          }
          continue
        }
        if (capability.status === 'unsupported' && capability.source === 'deepseek-text-only') {
          throw new ModelPkException(modelPkError('IMAGE_INPUT_UNSUPPORTED', 'preflight', `${snapshot.modelName} 不支持图片输入`, `model=${snapshot.modelConfigId}; source=${capability.source}`))
        }
        unverified.push({
          model: snapshot.modelName,
          reason: capability.source === 'pi-ai-catalog' ? 'pi-ai 目录未标注图片' : '自定义模型，目录未收录',
        })
      }
      const limits = this.ctx.attachments?.imageLimits
      if (limits === undefined || this.ctx.attachments?.saveImages === undefined) {
        throw new ModelPkException(modelPkError('ATTACHMENT_TRANSFORM_UNVERIFIED', 'preflight', 'DSH 附件服务不可用', 'attachment store or saveImages is absent'))
      }
      const total = draft.attachments.reduce((sum, item) => sum + item.byteLength, 0)
      const oversized = draft.attachments.find(item => item.byteLength > Math.min(LIMITS.imageBytes, limits.maxImageBytes))
      if (oversized !== undefined || draft.attachments.length > Math.min(LIMITS.imageCount, limits.maxImagesPerMessage)
        || total > Math.min(LIMITS.imageTotalBytes, limits.maxMessageImageBytes)) {
        throw new ModelPkException(modelPkError('ATTACHMENT_INVALID', 'preflight', '图片超过当前 DSH 附件能力限制', `DSH limits=${JSON.stringify(limits)}`))
      }
      if (draft.attachments.some(item => !limits.mediaTypes.includes(item.mimeType))) {
        throw new ModelPkException(modelPkError('ATTACHMENT_INVALID', 'preflight', '当前 DSH 不接受所选图片格式', `mediaTypes=${limits.mediaTypes.join(',')}`))
      }
      return {
        images: draft.attachments.length,
        totalBytes: total,
        dshLimits: limits,
        ...(unverified.length === 0 ? {} : {
          warning: `${unverified.length} 个模型无法自动证明支持图片，需你确认后才能带着图片开跑。`,
          unverifiedModels: unverified,
        }),
      }
    })
    const harness = resolveHarness(this.seatbelt)
    await addCheck('harness', '固定 Harness', async () => {
      if (harness.toolNames.join('\0') !== 'bash\0edit\0glob\0grep\0read\0write') throw new Error('tool contract drift')
      return { fingerprint: harness.fingerprint, preset: harness.preset }
    })
    await addCheck('capacity', '控制存储容量', async () => {
      const quickCheck = this.store.db.prepare('PRAGMA quick_check').get() as { quick_check?: string }
      if (quickCheck.quick_check !== 'ok') throw new Error(`SQLite quick_check=${quickCheck.quick_check ?? 'missing'}`)
      const free = this.store.freeCapacitySlotCount()
      if (free < draft.selectedModelConfigIds.length) {
        throw new ModelPkException(modelPkError('CONTROL_STORE_CAPACITY_UNAVAILABLE', 'preflight', '控制存储预留容量不足', `required=${draft.selectedModelConfigIds.length}; free=${free}`))
      }
      return { freeSlots: free, requiredSlots: draft.selectedModelConfigIds.length }
    })
    const taskPackage = createTaskPackage(draft)
    const taskPackageHash = hashCanonical(taskPackage)
    const executionConditions = defaultExecutionConditions(draft.concurrency)
    const executionConditionsHash = hashCanonical(executionConditions)
    const status = checks.some(check => check.status === 'BLOCKED')
      ? 'BLOCKED'
      : checks.some(check => check.status === 'WARNING') ? 'WARNING' : 'READY'
    const createdAt = new Date().toISOString()
    const snapshotCore = {
      schemaVersion: 'model-pk/preflight/v1',
      draftId: draft.draftId,
      draftRevision: draft.revision,
      status,
      checks,
      taskPackageHash,
      modelFingerprints: snapshots.map(snapshot => snapshot.fingerprint),
      resolvedHarnessFingerprint: harness.fingerprint,
      executionConditionsHash,
      compatibilityHash: hashCanonical(this.compatibility().report),
    }
    const snapshotHash = hashCanonical(snapshotCore)
    const snapshot: PreflightSnapshot = {
      preflightId: uuid(),
      draftId: draft.draftId,
      draftRevision: draft.revision,
      snapshotHash,
      status,
      checks,
      taskPackage,
      taskPackageHash,
      models: snapshots,
      resolvedHarness: harness,
      resolvedHarnessFingerprint: harness.fingerprint,
      executionConditions,
      executionConditionsHash,
      capacityEstimateBytes: LIMITS.controlSlotBytes * draft.selectedModelConfigIds.length
        + taskPackage.attachments.reduce((sum, item) => sum + item.byteLength, 0)
        + (taskPackage.baseline?.byteLength ?? 0),
      confirmedSnapshotHash: null,
      createdAt,
    }
    this.store.putPreflight(snapshot)
    return snapshot
  }

  confirmWarning(draftId: UUID, preflightId: UUID, snapshotHash: Hash): PreflightSnapshot {
    const draft = this.store.getDraft(draftId)
    const snapshot = this.store.getPreflight(preflightId)
    if (draft === null || snapshot === null || snapshot.draftId !== draftId
      || snapshot.draftRevision !== draft.revision || snapshot.snapshotHash !== snapshotHash) {
      throw new ModelPkException(modelPkError('PREFLIGHT_STALE', 'preflight', 'Preflight 快照已失效', 'draft/preflight revision or hash mismatch'))
    }
    return this.store.confirmPreflight(preflightId, snapshotHash)
  }

  assertStartable(draftId: UUID, preflightId: UUID, snapshotHash: Hash): PreflightSnapshot {
    const draft = this.store.getDraft(draftId)
    const snapshot = this.store.getPreflight(preflightId)
    if (draft === null || snapshot === null || snapshot.draftId !== draftId
      || snapshot.draftRevision !== draft.revision || snapshot.snapshotHash !== snapshotHash) {
      throw new ModelPkException(modelPkError('PREFLIGHT_STALE', 'start', 'Preflight 快照已失效，请重新检查', 'start snapshot mismatch'))
    }
    if (snapshot.status === 'BLOCKED') {
      const error = snapshot.checks.find(check => check.status === 'BLOCKED')?.error
        ?? modelPkError('PREFLIGHT_STALE', 'start', 'Preflight 未通过', 'blocked preflight has no detailed error')
      throw new ModelPkException(error)
    }
    const needsImageConfirm = snapshot.checks.some(check => check.id === 'modalities' && check.status === 'WARNING')
    if (needsImageConfirm && snapshot.confirmedSnapshotHash !== snapshotHash) {
      throw new ModelPkException(modelPkError('WARNING_CONFIRMATION_REQUIRED', 'start', '请先确认这些模型支持图片', 'image capability warning is not confirmed'))
    }
    if (snapshot.models.length !== snapshot.taskPackage.selectedModelConfigIds.length) {
      throw new ModelPkException(modelPkError('MODEL_CONFIG_NOT_FOUND', 'start', '模型快照不完整', 'snapshot model count mismatch'))
    }
    return snapshot
  }

  private async verifyAttachments(draft: Draft): Promise<Readonly<Record<string, unknown>>> {
    if (draft.attachments.some(item => item.state !== 'READY' || item.immutablePath === undefined)) {
      throw new ModelPkException(modelPkError('ATTACHMENT_INVALID', 'preflight', '仍有图片未完成上传', 'attachment is not READY'))
    }
    for (const item of draft.attachments) {
      const hash = await sha256File(item.immutablePath!)
      if (hash !== item.hash) {
        throw new ModelPkException(modelPkError('ATTACHMENT_HASH_MISMATCH', 'preflight', '图片哈希已变化', `attachment=${item.attachmentId}`))
      }
    }
    return { count: draft.attachments.length, totalBytes: draft.attachments.reduce((sum, item) => sum + item.byteLength, 0) }
  }

  private async verifyBaseline(draft: Draft): Promise<Readonly<Record<string, unknown>>> {
    if (draft.baseline === null) {
      throw new ModelPkException(modelPkError('WORKSPACE_NOT_READABLE', 'preflight', '请先指定项目起始目录', 'baseline is required'))
    }
    const manifestBytes = await readFile(draft.baseline.manifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { treeHash?: unknown; fileCount?: unknown; byteLength?: unknown }
    if (manifest.treeHash !== draft.baseline.objectHash || manifest.fileCount !== draft.baseline.fileCount
      || manifest.byteLength !== draft.baseline.byteLength) {
      throw new ModelPkException(modelPkError('WORKSPACE_NOT_READABLE', 'preflight', 'Baseline manifest 校验失败', 'baseline metadata mismatch'))
    }
    const verifyPath = join(this.archive.draftPath(draft.draftId), `baseline-verify-${uuid()}`)
    const objectRoot = join(dirname(draft.baseline.manifestPath), 'objects')
    try {
      await this.helper.materialize(draft.baseline.manifestPath, objectRoot, verifyPath)
    } finally {
      await rm(verifyPath, { recursive: true, force: true })
    }
    return {
      summary: draft.baseline.fileCount === 0
        ? '全新项目对照：空白起始目录已冻结，各模型将从零生成。'
        : `已有项目对照：已冻结 ${draft.baseline.fileCount.toLocaleString()} 个文件。`,
      kind: draft.baseline.fileCount === 0 ? 'new-project' : 'existing-project',
      treeHash: draft.baseline.objectHash,
      files: draft.baseline.fileCount,
      bytes: draft.baseline.byteLength,
    }
  }
}

function createTaskPackage(draft: Draft): TaskPackage {
  const attachments = draft.attachments.map((item): Omit<AttachmentRecord, 'draftId' | 'state' | 'error'> => ({
    attachmentId: item.attachmentId,
    ordinal: item.ordinal,
    name: item.name,
    mimeType: item.mimeType,
    byteLength: item.byteLength,
    hash: item.hash,
    ...(item.immutablePath === undefined ? {} : { immutablePath: item.immutablePath }),
  }))
  return Object.freeze({
    schemaVersion: 'model-pk/task-package/v1',
    taskName: draft.taskName,
    taskType: draft.taskType,
    prompt: draft.prompt,
    promptHash: draft.promptHash,
    attachments,
    baseline: draft.baseline,
    selectedModelConfigIds: [...draft.selectedModelConfigIds],
  })
}
