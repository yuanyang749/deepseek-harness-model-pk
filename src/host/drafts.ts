import { chmod, copyFile, open, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AttachmentBeginRequest,
  AttachmentBeginResponse,
  AttachmentChunkRequest,
  AttachmentRecord,
  BaselineSelectRequest,
  Draft,
  DraftCreateRequest,
  DraftUpdateRequest,
  Hash,
  UUID,
} from '../contracts/types.js'
import { LIMITS } from '../contracts/constants.js'
import { fail, modelPkError } from '../core/error.js'
import { uuid } from '../core/ids.js'
import { sha256File, sha256Text } from '../core/jcs.js'
import {
  sanitizeFileName,
  validateAttachmentMetadata,
  validateConcurrency,
  validateUnicode,
} from '../core/validation.js'
import type { NativeHelper } from '../native/helper.js'
import type { ArchiveManager } from './archive.js'
import type { ControlStore, UploadRecord } from '../storage/store.js'

export class DraftService {
  private readonly mutationTails = new Map<UUID, Promise<void>>()

  constructor(
    private readonly store: ControlStore,
    private readonly archive: ArchiveManager,
    private readonly helper: NativeHelper,
  ) {}

  async create(request: DraftCreateRequest = {}): Promise<Draft> {
    const now = new Date().toISOString()
    const taskName = request.taskName ?? ''
    const taskType = request.taskType ?? ''
    const prompt = request.prompt ?? ''
    validateDraftText(taskName, taskType, prompt)
    const draft: Draft = {
      draftId: uuid(),
      revision: 0,
      taskName,
      taskType,
      prompt,
      promptHash: sha256Text(prompt),
      selectedModelConfigIds: [],
      attachments: [],
      baseline: null,
      concurrency: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.archive.prepareDraft(draft.draftId)
    this.store.putDraft(draft)
    return draft
  }

  get(draftId: UUID): Draft {
    const draft = this.store.getDraft(draftId)
    if (draft === null) fail('NOT_FOUND', 'draft', '草稿不存在', `draft missing ${draftId}`)
    return draft
  }

  update(request: DraftUpdateRequest): Promise<Draft> {
    return this.withDraftLock(request.draftId, () => this.updateUnlocked(request))
  }

  private updateUnlocked(request: DraftUpdateRequest): Draft {
    const current = this.get(request.draftId)
    if (current.revision !== request.expectedRevision) {
      fail('ACTION_TARGET_STALE', 'draft', '草稿已变化，请刷新后重试', `expected=${request.expectedRevision}; actual=${current.revision}`)
    }
    const taskName = request.patch.taskName ?? current.taskName
    const taskType = request.patch.taskType ?? current.taskType
    const prompt = request.patch.prompt ?? current.prompt
    validateDraftText(taskName, taskType, prompt)
    const selected = request.patch.selectedModelConfigIds ?? current.selectedModelConfigIds
    if (selected.length > LIMITS.modelMax || new Set(selected).size !== selected.length) {
      fail('VALIDATION_ERROR', 'draft', '模型最多 10 个且不能重复', `selected model count=${selected.length}`)
    }
    let attachments = [...current.attachments]
    if (request.patch.attachmentOrder !== undefined) {
      const expected = new Set(attachments.map(item => item.attachmentId))
      if (request.patch.attachmentOrder.length !== expected.size
        || request.patch.attachmentOrder.some(id => !expected.has(id))) {
        fail('VALIDATION_ERROR', 'draft', '附件顺序与当前附件不一致', 'attachmentOrder is not a permutation')
      }
      const byId = new Map(attachments.map(item => [item.attachmentId, item]))
      attachments = request.patch.attachmentOrder.map((id, ordinal) => ({ ...byId.get(id)!, ordinal }))
    }
    const concurrency = request.patch.concurrency
      ?? (request.patch.selectedModelConfigIds === undefined
        ? current.concurrency
        : Math.min(LIMITS.defaultConcurrencyCap, Math.max(1, selected.length)))
    if (selected.length > 0) validateConcurrency(concurrency, selected.length)
    else if (concurrency !== 1) fail('VALIDATION_ERROR', 'draft', '未选择模型时并发数必须为 1', `concurrency=${concurrency}`)
    const next: Draft = {
      ...current,
      revision: current.revision + 1,
      taskName,
      taskType,
      prompt,
      promptHash: sha256Text(prompt),
      selectedModelConfigIds: [...selected],
      attachments,
      concurrency,
      updatedAt: new Date().toISOString(),
    }
    return this.store.putDraft(next, current.revision)
  }

  async beginAttachment(request: AttachmentBeginRequest): Promise<AttachmentBeginResponse> {
    const draft = this.get(request.draftId)
    assertDraftRevision(draft, request.expectedRevision)
    const total = draft.attachments.reduce((sum, item) => sum + item.byteLength, 0)
    validateAttachmentMetadata(request.mimeType, request.byteLength, draft.attachments.length, total)
    const uploadId = uuid()
    const attachmentId = uuid()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + LIMITS.draftTtlMs).toISOString()
    const tempPath = join(this.archive.draftPath(draft.draftId), 'uploads', `${uploadId}.part`)
    const handle = await open(tempPath, 'wx', 0o600)
    await handle.close()
    const upload: UploadRecord = {
      uploadId,
      attachmentId,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      name: sanitizeFileName(request.name),
      mimeType: request.mimeType,
      byteLength: request.byteLength,
      expectedHash: request.expectedHash,
      tempPath,
      receivedBytes: 0,
      state: 'UPLOADING',
      error: null,
      createdAt: now.toISOString(),
      expiresAt,
    }
    this.store.createUpload(upload)
    return { uploadId, attachmentId, chunkSize: LIMITS.uploadChunkBytes, expiresAt }
  }

  async writeAttachmentChunk(request: AttachmentChunkRequest): Promise<{ receivedBytes: number; complete: boolean }> {
    const upload = this.uploadRequired(request.uploadId)
    if (upload.state !== 'UPLOADING') fail('CONFLICT', 'attachment', '上传已结束', `upload state=${upload.state}`)
    if (upload.receivedBytes !== request.offset) {
      fail('ACTION_TARGET_STALE', 'attachment', '上传偏移已变化', `expected offset=${upload.receivedBytes}; got=${request.offset}`)
    }
    const bytes = decodeBase64(request.bytesBase64)
    if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.uploadChunkBytes || request.offset + bytes.byteLength > upload.byteLength) {
      fail('ATTACHMENT_INVALID', 'attachment', '上传分片大小无效', `chunk=${bytes.byteLength}; offset=${request.offset}; total=${upload.byteLength}`)
    }
    const handle = await open(upload.tempPath, 'r+')
    try {
      await handle.write(bytes, 0, bytes.byteLength, request.offset)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const next = this.store.advanceUpload(upload.uploadId, request.offset, request.offset + bytes.byteLength)
    return { receivedBytes: next.receivedBytes, complete: next.receivedBytes === next.byteLength }
  }

  async commitAttachment(uploadId: UUID): Promise<Draft> {
    const upload = this.uploadRequired(uploadId)
    if (upload.state === 'READY') return this.get(upload.draftId)
    return this.withDraftLock(upload.draftId, () => this.commitAttachmentUnlocked(upload))
  }

  private async commitAttachmentUnlocked(upload: UploadRecord): Promise<Draft> {
    if (upload.state !== 'UPLOADING' || upload.receivedBytes !== upload.byteLength) {
      fail('ATTACHMENT_INVALID', 'attachment', '附件尚未完整上传', `state=${upload.state}; received=${upload.receivedBytes}; expected=${upload.byteLength}`)
    }
    const draft = this.get(upload.draftId)
    assertDraftRevision(draft, upload.expectedRevision)
    const actualHash = await sha256File(upload.tempPath)
    const bytes = await readFile(upload.tempPath)
    try {
      if (actualHash !== upload.expectedHash) {
        fail('ATTACHMENT_HASH_MISMATCH', 'attachment', '附件哈希不匹配', `expected=${upload.expectedHash}; actual=${actualHash}`)
      }
      assertImageSignature(bytes, upload.mimeType)
      const immutablePath = join(this.archive.draftPath(draft.draftId), 'attachments', `${upload.attachmentId}-${upload.name}`)
      await publishAttachment(upload.tempPath, immutablePath, actualHash)
      const attachment: AttachmentRecord = {
        attachmentId: upload.attachmentId,
        draftId: draft.draftId,
        ordinal: draft.attachments.length,
        name: upload.name,
        mimeType: upload.mimeType as AttachmentRecord['mimeType'],
        byteLength: upload.byteLength,
        hash: actualHash,
        state: 'READY',
        immutablePath,
      }
      const next: Draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: [...draft.attachments, attachment],
        updatedAt: new Date().toISOString(),
      }
      this.store.commitUploadToDraft(upload.uploadId, next, draft.revision)
      await rm(upload.tempPath, { force: true }).catch(() => undefined)
      return next
    } catch (error) {
      const detail = error instanceof Error && 'detail' in error
        ? (error as { detail: ReturnType<typeof modelPkError> }).detail
        : modelPkError('ATTACHMENT_INVALID', 'attachment', '附件校验失败', String(error))
      if (this.store.getUpload(upload.uploadId)?.state === 'UPLOADING') this.store.finishUpload(upload.uploadId, 'FAILED', detail)
      throw error
    }
  }

  async removeAttachment(draftId: UUID, expectedRevision: number, attachmentId: UUID): Promise<Draft> {
    return this.withDraftLock(draftId, () => this.removeAttachmentUnlocked(draftId, expectedRevision, attachmentId))
  }

  private async removeAttachmentUnlocked(draftId: UUID, expectedRevision: number, attachmentId: UUID): Promise<Draft> {
    const draft = this.get(draftId)
    assertDraftRevision(draft, expectedRevision)
    const attachment = draft.attachments.find(item => item.attachmentId === attachmentId)
    if (attachment === undefined) fail('NOT_FOUND', 'attachment', '附件不存在', `attachment missing ${attachmentId}`)
    const attachments = draft.attachments
      .filter(item => item.attachmentId !== attachmentId)
      .map((item, ordinal) => ({ ...item, ordinal }))
    const next: Draft = { ...draft, revision: draft.revision + 1, attachments, updatedAt: new Date().toISOString() }
    this.store.putDraft(next, draft.revision)
    if (attachment.immutablePath !== undefined) await rm(attachment.immutablePath, { force: true })
    return next
  }

  async selectBaseline(request: BaselineSelectRequest): Promise<Draft> {
    return this.withDraftLock(request.draftId, () => this.selectBaselineUnlocked(request))
  }

  private async selectBaselineUnlocked(request: BaselineSelectRequest): Promise<Draft> {
    const draft = this.get(request.draftId)
    assertDraftRevision(draft, request.expectedRevision)
    const sourcePath = await realpath(resolve(request.sourcePath))
    if (pathsOverlap(sourcePath, this.archive.layout.root)) {
      fail('WORKSPACE_NOT_READABLE', 'baseline', 'Baseline 不能包含 Model PK 数据目录', `baseline/data-root overlap: ${sourcePath}`)
    }
    const root = join(this.archive.draftPath(draft.draftId), 'baseline', uuid())
    const objects = join(root, 'objects')
    const manifestPath = join(root, 'manifest.json')
    let manifest
    try {
      manifest = await this.helper.snapshotTo(sourcePath, objects, manifestPath, LIMITS.baselineBytes, LIMITS.baselineFiles)
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
    const baseline = {
      sourcePath,
      objectHash: manifest.treeHash,
      byteLength: manifest.byteLength,
      fileCount: manifest.fileCount,
      directoryCount: manifest.directoryCount,
      manifestPath,
      scannedAt: new Date().toISOString(),
    }
    const next: Draft = { ...draft, revision: draft.revision + 1, baseline, updatedAt: new Date().toISOString() }
    const committed = this.store.putDraft(next, draft.revision)
    if (draft.baseline !== null) await rm(dirname(draft.baseline.manifestPath), { recursive: true, force: true }).catch(() => undefined)
    return committed
  }

  clearBaseline(draftId: UUID, expectedRevision: number): Promise<Draft> {
    return this.withDraftLock(draftId, () => this.clearBaselineUnlocked(draftId, expectedRevision))
  }

  private async clearBaselineUnlocked(draftId: UUID, expectedRevision: number): Promise<Draft> {
    const draft = this.get(draftId)
    assertDraftRevision(draft, expectedRevision)
    const next: Draft = { ...draft, revision: draft.revision + 1, baseline: null, updatedAt: new Date().toISOString() }
    const committed = this.store.putDraft(next, draft.revision)
    if (draft.baseline !== null) await rm(dirname(draft.baseline.manifestPath), { recursive: true, force: true }).catch(() => undefined)
    return committed
  }

  async cleanupExpired(): Promise<void> {
    const before = new Date(Date.now() - LIMITS.draftTtlMs).toISOString()
    const expired = this.store.expiredDraftIds(before)
    this.store.deleteExpiredDrafts(before)
    await Promise.allSettled(expired.map(draftId => rm(this.archive.draftPath(draftId), { recursive: true, force: true })))
  }

  private uploadRequired(uploadId: UUID): UploadRecord {
    const upload = this.store.getUpload(uploadId)
    if (upload === null) fail('NOT_FOUND', 'attachment', '上传不存在', `upload missing ${uploadId}`)
    if (Date.parse(upload.expiresAt) <= Date.now()) fail('CONFLICT', 'attachment', '上传已过期', `upload expired ${uploadId}`)
    return upload
  }

  private async withDraftLock<T>(draftId: UUID, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationTails.get(draftId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.mutationTails.set(draftId, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(draftId) === tail) this.mutationTails.delete(draftId)
    }
  }
}

function validateDraftText(taskName: string, taskType: string, prompt: string): void {
  validateUnicode(taskName, 'taskName')
  validateUnicode(taskType, 'taskType')
  validateUnicode(prompt, 'prompt')
  if ([...taskName].length > LIMITS.taskNameCodePoints) fail('VALIDATION_ERROR', 'draft', 'Task Name 最多 120 个字符')
  if ([...taskType].length > LIMITS.taskTypeCodePoints) fail('VALIDATION_ERROR', 'draft', 'Task Type 最多 64 个字符')
  if (Buffer.byteLength(prompt, 'utf8') > LIMITS.promptBytes) fail('INPUT_TOO_LARGE', 'draft', 'Prompt 超过 1 MiB')
}

function assertDraftRevision(draft: Draft, expected: number): void {
  if (draft.revision !== expected) fail('ACTION_TARGET_STALE', 'draft', '草稿已变化，请刷新后重试', `expected=${expected}; actual=${draft.revision}`)
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  const canonical = bytes.toString('base64').replace(/=+$/u, '')
  if (canonical !== value.replace(/=+$/u, '')) fail('ATTACHMENT_INVALID', 'attachment', '上传分片编码无效', 'non-canonical base64')
  return bytes
}

function assertImageSignature(bytes: Uint8Array, mimeType: string): void {
  const match = mimeType === 'image/png'
    ? Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === 'image/webp'
        ? Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
          && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
        : false
  if (!match) fail('ATTACHMENT_INVALID', 'attachment', '附件内容与图片格式不匹配', `signature mismatch for ${mimeType}`)
}

async function publishAttachment(source: string, destination: string, expectedHash: Hash): Promise<void> {
  try {
    await copyFile(source, destination, 1)
    await chmod(destination, 0o600)
    const handle = await open(destination, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch (error) {
    const existingHash = await sha256File(destination).catch(() => null)
    if (existingHash !== expectedHash) throw error
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  if (isAbsolute(leftToRight) || isAbsolute(rightToLeft)) return false
  return leftToRight === '' || rightToLeft === ''
    || !leftToRight.startsWith(`..${sep}`) && leftToRight !== '..'
    || !rightToLeft.startsWith(`..${sep}`) && rightToLeft !== '..'
}
