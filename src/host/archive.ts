import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  Attempt,
  AuditEvent,
  Experiment,
  ExperimentProjection,
  Hash,
  ModelPkError,
  ModelTokenUsage,
  Run,
  WorkspaceSummary,
} from '../contracts/types.js'
import { canonicalize, hashCanonical, sha256Bytes, sha256File } from '../core/jcs.js'
import { fail, normalizeError } from '../core/error.js'
import { sanitizeFileName } from '../core/validation.js'
import type { NativeHelper, NativeTreeManifest } from '../native/helper.js'
import { buildWorkspaceSummary, summarizeTokenUsage } from './workspace-summary.js'

export interface DataLayout {
  readonly root: string
  readonly control: string
  readonly capacity: string
  readonly drafts: string
  readonly experiments: string
  readonly runtime: string
  readonly trash: string
}

export interface AttemptRuntimePaths {
  readonly attemptRoot: string
  readonly workspace: string
  readonly home: string
  readonly temp: string
  readonly artifacts: string
  readonly leasePath: string
  readonly transcriptPath: string
  readonly logPath: string
  readonly eventPath: string
}

export interface FinalizeArchiveInput {
  readonly experiment: ExperimentProjection
  readonly run: Run
  readonly attempt: Attempt
  readonly runtime: AttemptRuntimePaths | null
  readonly finalResponse: string | null
  readonly primaryError: ModelPkError | null
  readonly cancelReason: string | null
}

export interface FinalizeArchiveResult {
  readonly completeness: 'COMPLETE' | 'PARTIAL' | 'INCOMPLETE'
  readonly workspaceTreeHash: Hash | null
  readonly indexHash: Hash | null
  readonly error: ModelPkError | null
  readonly resultPath: string | null
  readonly resultExportError: ModelPkError | null
  readonly workspaceSummary: WorkspaceSummary | null
  readonly tokenUsage: ModelTokenUsage | null
}

export function dataLayout(dshHome: string): DataLayout {
  return dataLayoutAtRoot(resolve(dshHome, 'model-pk', 'v1'))
}

export function dataLayoutAtRoot(inputRoot: string): DataLayout {
  // Resolve existing ancestors before passing paths to the native no-follow
  // implementation. This handles macOS /var aliases and Windows junctions.
  const root = canonicalPathWithMissingTail(inputRoot)
  return {
    root,
    control: join(root, 'control'),
    capacity: join(root, 'control', 'capacity'),
    drafts: join(root, 'drafts'),
    experiments: join(root, 'experiments'),
    runtime: join(root, 'runtime'),
    trash: join(root, 'trash'),
  }
}

function canonicalPathWithMissingTail(input: string): string {
  let cursor = resolve(input)
  const missing: string[] = []
  while (true) {
    try {
      return join(realpathSync.native(cursor), ...missing.reverse())
    } catch (error) {
      if (!isMissingPath(error)) throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { readonly code?: unknown }).code === 'EEXIST'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function resultExportFailure(error: unknown, phase: string): ModelPkError {
  const normalized = normalizeError(error, phase)
  return normalized.code === 'DISK_FULL'
    ? normalized
    : { ...normalized, code: 'RESULT_EXPORT_FAILED', retryable: true }
}

export class ArchiveManager {
  constructor(readonly layout: DataLayout, private readonly helper: NativeHelper) {}

  async initialize(): Promise<void> {
    for (const path of Object.values(this.layout)) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
    }
    await this.writeProbe()
  }

  experimentPath(experimentId: string, name: string, createdAt = new Date()): string {
    const day = createdAt.toISOString().slice(0, 10)
    const normalizedSlug = name.normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
    const slug = [...normalizedSlug].slice(0, 48).join('') || 'experiment'
    return join(this.layout.experiments, day, `${experimentId}-${slug}`)
  }

  resultPath(rootPath: string, experimentId: string, name: string, createdAt = new Date()): string {
    const stamp = createdAt.toISOString().replace(/[-:]/gu, '').slice(0, 15).replace('T', '-')
    return join(rootPath, `${safeName(name)}-${stamp}-${experimentId.slice(0, 8)}`)
  }

  draftPath(draftId: string): string {
    return join(this.layout.drafts, draftId)
  }

  async prepareDraft(draftId: string): Promise<string> {
    const path = this.draftPath(draftId)
    await this.ensureNewOwnedDirectory(path)
    await mkdir(join(path, 'uploads'), { recursive: true, mode: 0o700 })
    await mkdir(join(path, 'attachments'), { recursive: true, mode: 0o700 })
    await mkdir(join(path, 'baseline', 'objects'), { recursive: true, mode: 0o700 })
    return path
  }

  async publishDefinition(experiment: Experiment, runs: readonly Run[]): Promise<Hash> {
    const root = this.assertUnder(this.layout.experiments, experiment.experimentPath)
    await this.ensureNewOwnedDirectory(root)
    const indexEntries: { path: string; hash: Hash; byteLength: number }[] = []
    const publish = async (relativePath: string, value: Uint8Array | string | object): Promise<void> => {
      const bytes = typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(`${canonicalize(value)}\n`, 'utf8')
      const target = this.assertUnder(root, join(root, relativePath))
      await atomicWrite(target, bytes, 0o600)
      indexEntries.push({ path: relativePath, hash: sha256Bytes(bytes), byteLength: bytes.byteLength })
    }
    await publish('task/prompt.raw', experiment.taskPackage.prompt)
    const archivedTaskPackage = archiveTaskPackage(experiment.taskPackage)
    await publish('task/task-package.json', archivedTaskPackage)
    await publish('task/task-package.portable.json', archivedTaskPackage)
    for (const attachment of experiment.taskPackage.attachments) {
      if (attachment.immutablePath === undefined) {
        fail('ATTACHMENT_MISSING', 'start-publish', '附件文件不存在', `attachment has no immutable path: ${attachment.attachmentId}`)
      }
      const bytes = await readFile(attachment.immutablePath)
      const actual = sha256Bytes(bytes)
      if (actual !== attachment.hash) {
        fail('ATTACHMENT_HASH_MISMATCH', 'start-publish', '附件校验失败', `attachment hash mismatch ${attachment.attachmentId}`)
      }
      await publish(`task/attachments/${String(attachment.ordinal + 1).padStart(2, '0')}-${safeName(attachment.name)}`, bytes)
    }
    if (experiment.taskPackage.baseline !== null) {
      await this.copyBaselineIntoExperiment(experiment.taskPackage.baseline.manifestPath, root, publish)
    } else {
      await publish('task/baseline/manifest.json', {
        schemaVersion: 1,
        empty: true,
        entries: [],
        treeHash: hashCanonical({ schemaVersion: 1, entries: [] }),
      })
    }
    for (const model of experiment.selectedModels) {
      await publish(`models/${String(experiment.selectedModels.indexOf(model) + 1).padStart(2, '0')}-${model.modelConfigId.slice(7, 19)}.json`, model)
    }
    await publish('harness/resolved-harness.json', experiment.resolvedHarness)
    const immutableExperiment = {
      schemaVersion: 'model-pk/experiment/v1',
      experimentId: experiment.experimentId,
      name: experiment.name,
      taskType: experiment.taskType,
      taskPackage: archivedTaskPackage,
      taskPackageHash: experiment.taskPackageHash,
      resolvedHarness: experiment.resolvedHarness,
      resolvedHarnessFingerprint: experiment.resolvedHarnessFingerprint,
      executionConditions: experiment.executionConditions,
      executionConditionsHash: experiment.executionConditionsHash,
      selectedModels: experiment.selectedModels,
      preflightSnapshotHash: experiment.preflightSnapshotHash,
      dshVersion: experiment.dshVersion,
      pluginVersion: experiment.pluginVersion,
      createdAt: experiment.createdAt,
      frozenAt: experiment.frozenAt,
      archiveRoot: '.',
      stateRef: 'state.json',
      eventsRef: 'events.jsonl',
    }
    await publish('experiment.json', immutableExperiment)
    for (const run of runs) {
      await publish(`runs/${run.runId}/run.json`, {
        schemaVersion: 'model-pk/run/v1',
        runId: run.runId,
        experimentId: run.experimentId,
        ordinal: run.ordinal,
        modelConfigSnapshot: run.modelConfig,
        modelConfigFingerprint: run.modelConfigFingerprint,
        createdAt: run.createdAt,
      })
    }
    indexEntries.sort((left, right) => left.path.localeCompare(right.path))
    const definitionIndex = {
      schemaVersion: 'model-pk/definition-index/v1',
      experimentId: experiment.experimentId,
      entries: indexEntries,
      definitionHash: hashCanonical(indexEntries),
    }
    await publish('definition-index.json', definitionIndex)
    const commit = {
      schemaVersion: 'model-pk/start-commit/v1',
      experimentId: experiment.experimentId,
      definitionIndexHash: await sha256File(join(root, 'definition-index.json')),
      committedAt: new Date().toISOString(),
    }
    await publish('start.commit', commit)
    await fsyncDirectory(root)
    await this.prepareResultDirectory(experiment, runs)
    return commit.definitionIndexHash
  }

  async createAttemptRuntime(experiment: Experiment, run: Run, attempt: Attempt): Promise<AttemptRuntimePaths> {
    const paths = this.attemptRuntimePaths(experiment.experimentId, attempt.attemptId)
    const root = paths.attemptRoot
    await this.ensureNewOwnedDirectory(root)
    for (const path of [paths.workspace, paths.home, paths.temp, paths.artifacts, dirname(paths.leasePath), dirname(paths.transcriptPath)]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
    }
    await atomicWrite(paths.leasePath, Buffer.from(`${attempt.fencingToken}\n`, 'utf8'), 0o600)
    // Empty evidence streams are still complete evidence: their absence means
    // “not archived”, while an empty owner-only file means no records occurred.
    await atomicWrite(paths.transcriptPath, Buffer.alloc(0), 0o600)
    await atomicWrite(paths.logPath, Buffer.alloc(0), 0o600)
    if (experiment.taskPackage.baseline !== null) {
      const manifestPath = join(experiment.experimentPath, 'task', 'baseline', 'manifest.json')
      const objectRoot = join(experiment.experimentPath, 'objects')
      await this.helper.materialize(manifestPath, objectRoot, paths.workspace)
    }
    await appendJsonLine(paths.eventPath, {
      kind: 'ATTEMPT_RUNTIME_CREATED',
      attemptId: attempt.attemptId,
      runId: run.runId,
      occurredAt: new Date().toISOString(),
    })
    return paths
  }

  attemptRuntimePaths(experimentId: string, attemptId: string): AttemptRuntimePaths {
    const root = this.assertUnder(this.layout.runtime, join(this.layout.runtime, experimentId, attemptId))
    return {
      attemptRoot: root,
      workspace: join(root, 'workspace'),
      home: join(root, 'home'),
      temp: join(root, 'tmp'),
      artifacts: join(root, 'artifacts'),
      leasePath: join(root, 'lease', 'fencing-token'),
      transcriptPath: join(root, 'evidence', 'transcript.jsonl'),
      logPath: join(root, 'evidence', 'logs.jsonl'),
      eventPath: join(root, 'evidence', 'events.jsonl'),
    }
  }

  experimentAttachmentPath(experiment: Experiment, ordinal: number, name: string): string {
    return this.assertUnder(
      experiment.experimentPath,
      join(experiment.experimentPath, 'task', 'attachments', `${String(ordinal + 1).padStart(2, '0')}-${safeName(name)}`),
    )
  }

  async revokeLease(runtime: AttemptRuntimePaths): Promise<void> {
    await atomicWrite(runtime.leasePath, Buffer.from(`revoked:${Date.now()}\n`, 'utf8'), 0o600)
  }

  async appendTranscript(runtime: AttemptRuntimePaths, value: unknown): Promise<void> {
    await appendJsonLine(runtime.transcriptPath, value)
  }

  async appendLog(runtime: AttemptRuntimePaths, value: unknown): Promise<void> {
    await appendJsonLine(runtime.logPath, value)
  }

  async appendAttemptEvent(runtime: AttemptRuntimePaths, value: unknown): Promise<void> {
    await appendJsonLine(runtime.eventPath, value)
  }

  async finalizeAttempt(input: FinalizeArchiveInput): Promise<FinalizeArchiveResult> {
    const attemptRoot = join(
      input.experiment.experimentPath,
      'runs', input.run.runId,
      'attempts', `${String(input.attempt.attemptNo).padStart(3, '0')}-${input.attempt.attemptId}`,
    )
    try {
      await this.ensureNewOwnedDirectory(attemptRoot)
      const entries: { path: string; hash: Hash; byteLength: number; available: boolean; reason?: string }[] = []
      const publish = async (relativePath: string, content: Uint8Array | string | object): Promise<void> => {
        const bytes = typeof content === 'string'
          ? Buffer.from(content, 'utf8')
          : content instanceof Uint8Array
            ? Buffer.from(content)
            : Buffer.from(`${canonicalize(content)}\n`, 'utf8')
        await atomicWrite(join(attemptRoot, relativePath), bytes, 0o600)
        entries.push({ path: relativePath, hash: sha256Bytes(bytes), byteLength: bytes.byteLength, available: true })
      }
      let workspaceManifest: NativeTreeManifest | null = null
      if (input.runtime !== null) {
        await copyIfPresent(input.runtime.transcriptPath, join(attemptRoot, 'transcript.jsonl'), entries, 'transcript.jsonl')
        await copyIfPresent(input.runtime.logPath, join(attemptRoot, 'logs.jsonl'), entries, 'logs.jsonl')
        await copyIfPresent(input.runtime.eventPath, join(attemptRoot, 'events.jsonl'), entries, 'events.jsonl')
        const objectRoot = join(input.experiment.experimentPath, 'objects')
        await mkdir(objectRoot, { recursive: true, mode: 0o700 })
        const workspaceTemp = join(attemptRoot, `.workspace-manifest-${randomUUID()}.json`)
        const workspaceSnapshotSummary = await this.helper.snapshotTo(input.runtime.workspace, objectRoot, workspaceTemp, 20 * 1024 * 1024 * 1024, 1_000_000)
        const workspaceBytes = await readFile(workspaceTemp)
        await rm(workspaceTemp, { force: true })
        workspaceManifest = JSON.parse(workspaceBytes.toString('utf8')) as NativeTreeManifest
        await publish('workspace-manifest.json', workspaceBytes)
        const artifactTemp = join(attemptRoot, `.artifact-manifest-${randomUUID()}.json`)
        await this.helper.snapshotTo(input.runtime.artifacts, objectRoot, artifactTemp, 20 * 1024 * 1024 * 1024, 1_000_000)
        const artifactBytes = await readFile(artifactTemp)
        await rm(artifactTemp, { force: true })
        await publish('artifacts/manifest.json', artifactBytes)
        if (workspaceManifest.treeHash !== workspaceSnapshotSummary.treeHash) throw new Error('workspace snapshot summary mismatch')
      } else {
        for (const path of ['transcript.jsonl', 'logs.jsonl', 'events.jsonl', 'workspace-manifest.json', 'artifacts/manifest.json']) {
          entries.push({ path, hash: hashCanonical({ unavailable: true }), byteLength: 0, available: false, reason: 'runtime-not-materialized' })
        }
      }
      let workspaceSummary: WorkspaceSummary | null = null
      let tokenUsage: ModelTokenUsage | null = null
      if (input.runtime !== null && workspaceManifest !== null) {
        const baselineManifest = JSON.parse(await readFile(
          join(input.experiment.experimentPath, 'task', 'baseline', 'manifest.json'),
          'utf8',
        )) as NativeTreeManifest
        workspaceSummary = await buildWorkspaceSummary(
          baselineManifest,
          workspaceManifest,
          async path => Buffer.from((await this.helper.read(input.runtime!.workspace, path, 1024 * 1024 + 1)).bytesBase64, 'base64'),
        )
        tokenUsage = summarizeTokenUsage(await readFile(input.runtime.transcriptPath, 'utf8').catch(() => ''))
      }
      await publish('effective-input.redacted.json', {
        taskPackageHash: input.attempt.taskPackageHash,
        inputFingerprint: input.attempt.inputFingerprint,
        logicalWorkspace: '/workspace',
      })
      await publish('effective-attachments.json', input.experiment.taskPackage.attachments.map(attachment => ({
        ordinal: attachment.ordinal,
        hash: attachment.hash,
        byteLength: attachment.byteLength,
        mimeType: attachment.mimeType,
      })))
      if (input.finalResponse !== null) await publish('result.md', input.finalResponse)
      else entries.push({ path: 'result.md', hash: hashCanonical({ unavailable: true }), byteLength: 0, available: false, reason: 'no-final-response' })
      if (input.primaryError !== null) await publish('error.json', input.primaryError)
      const completeness = [...entries, { path: 'metadata.json', available: true }, { path: 'archive-index.json', available: true }]
        .every(entry => entry.available || optionalForAttempt(input.attempt, entry.path))
        ? 'COMPLETE' as const
        : 'PARTIAL' as const
      await publish('metadata.json', {
        ...input.attempt,
        state: input.attempt.pendingOutcome ?? 'FAILED',
        archiveCompleteness: completeness,
        workspacePath: input.runtime === null ? null : '/workspace',
        artifactPath: input.runtime === null ? null : '/workspace/.model-pk-artifacts',
        workspaceSummary,
        tokenUsage,
        cancelReason: input.cancelReason,
      })
      entries.sort((left, right) => left.path.localeCompare(right.path))
      const index = {
        schemaVersion: 'model-pk/attempt-archive-index/v1',
        experimentId: input.experiment.experimentId,
        runId: input.run.runId,
        attemptId: input.attempt.attemptId,
        state: input.attempt.pendingOutcome,
        entries,
        indexContentHash: hashCanonical(entries),
      }
      await publish('archive-index.json', index)
      await fsyncDirectory(attemptRoot)
      let resultPath: string | null = null
      let resultExportError: ModelPkError | null = null
      try {
        resultPath = await this.exportAttemptResult(input, workspaceSummary)
      } catch (error) {
        resultExportError = resultExportFailure(error, 'result-export')
      }
      return {
        completeness,
        workspaceTreeHash: workspaceManifest?.treeHash ?? null,
        indexHash: await sha256File(join(attemptRoot, 'archive-index.json')),
        error: null,
        resultPath,
        resultExportError,
        workspaceSummary,
        tokenUsage,
      }
    } catch (error) {
      const normalized = normalizeError(error, 'archive-finalize')
      const archiveError = normalized.code === 'DISK_FULL'
        ? normalized
        : { ...normalized, code: 'ARCHIVE_WRITE_FAILED' as const, retryable: false }
      return {
        completeness: 'INCOMPLETE',
        workspaceTreeHash: null,
        indexHash: null,
        error: archiveError,
        resultPath: null,
        resultExportError: null,
        workspaceSummary: null,
        tokenUsage: null,
      }
    }
  }

  async writeProjection(experiment: ExperimentProjection): Promise<void> {
    await atomicWrite(join(experiment.experimentPath, 'state.json'), Buffer.from(`${canonicalize({
      schemaVersion: 'model-pk/state/v1',
      lifecycleState: experiment.lifecycleState,
      outcome: experiment.outcome,
      experimentGeneration: experiment.generation,
      semanticEventCursor: experiment.semanticEventCursor,
      auditSequence: experiment.auditSequence,
      attemptSetHash: experiment.attemptSetHash,
      experimentArchiveFreshness: experiment.archiveFreshness,
      experimentArchiveIntegrity: experiment.archiveIntegrity,
      archiveRevision: experiment.archiveRevision,
      latestSealHash: experiment.latestSealHash,
      counts: experiment.counts,
      runs: experiment.runs.map(run => ({
        runId: run.runId,
        latestAttemptId: run.latestAttemptId,
        lastSuccessfulAttemptId: run.lastSuccessfulAttemptId,
        attemptCount: run.attemptCount,
        derivedState: run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId)?.state ?? 'NOT_STARTED',
      })),
    })}\n`, 'utf8'), 0o600)
  }

  async exportComparison(experiment: ExperimentProjection): Promise<{ path: string }> {
    if (experiment.resultPath === null) fail('CONFLICT', 'result-export', '该实验没有配置结果输出目录')
    const sections = experiment.runs.map(run => {
      const attempt = run.attempts.find(item => item.attemptId === run.latestAttemptId)
      return `## ${String(run.ordinal + 1).padStart(2, '0')} · ${run.modelConfig.modelName}\n\n${comparisonReportBody(attempt)}`
    })
    const path = join(experiment.resultPath, '对照结果.md')
    await atomicWrite(path, Buffer.from(`# ${experiment.name}\n\n${sections.join('\n\n---\n\n')}\n`, 'utf8'), 0o600)
    return { path }
  }

  async exportAttemptWorkspace(
    experiment: ExperimentProjection,
    run: Run,
    attempt: Attempt,
  ): Promise<{ path: string }> {
    if (experiment.resultPath === null) fail('CONFLICT', 'workspace-export', '该实验没有配置结果输出目录')
    const runRoot = this.runResultDirectory(experiment, run)
    const target = join(runRoot, `workspace-attempt-${String(attempt.attemptNo).padStart(3, '0')}`)
    if (await pathExists(target)) fail('CONFLICT', 'workspace-export', '工作区导出目录已存在', `target exists: ${target}`)
    const temporary = join(runRoot, `.workspace-${attempt.attemptId}-${randomUUID()}.tmp`)
    const archiveAttemptRoot = this.archiveAttemptDirectory(experiment, run, attempt)
    try {
      await this.helper.materialize(
        join(archiveAttemptRoot, 'workspace-manifest.json'),
        join(experiment.experimentPath, 'objects'),
        temporary,
      )
      await rename(temporary, target)
      return { path: target }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async prepareResultDirectory(experiment: Experiment, runs: readonly Run[]): Promise<void> {
    if (experiment.resultPath === null) return
    const root = dirname(experiment.resultPath)
    const actualRoot = await realpath(root)
    if (actualRoot !== resolve(root)) fail('ARCHIVE_PATH_ESCAPE', 'result-export', '结果输出目录路径已变化', `expected=${root}; actual=${actualRoot}`)
    try {
      await mkdir(experiment.resultPath, { mode: 0o700 })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const marker = await readFile(join(experiment.resultPath, '.model-pk-result.json'), 'utf8').catch(() => null)
      if (marker === null || JSON.parse(marker).experimentId !== experiment.experimentId) {
        fail('CONFLICT', 'result-export', '结果目录已存在且不属于当前实验', `result path collision: ${experiment.resultPath}`)
      }
    }
    await atomicWrite(join(experiment.resultPath, '.model-pk-result.json'), Buffer.from(`${canonicalize({
      schemaVersion: 'model-pk/user-result/v1',
      experimentId: experiment.experimentId,
      createdAt: experiment.createdAt,
    })}\n`, 'utf8'), 0o600)
    for (const run of runs) {
      const runRoot = this.runResultDirectory(experiment, run)
      await mkdir(join(runRoot, 'attempts'), { recursive: true, mode: 0o700 })
    }
  }

  private async exportAttemptResult(input: FinalizeArchiveInput, workspaceSummary: WorkspaceSummary | null): Promise<string | null> {
    const content = workspaceSummary?.mode === 'TEXT_FILE' && workspaceSummary.textContent !== null
      ? workspaceSummary.textContent
      : input.finalResponse
    if (input.experiment.resultPath === null || content === null) return null
    const runRoot = this.runResultDirectory(input.experiment, input.run)
    const attemptRoot = join(
      runRoot,
      'attempts',
      `${String(input.attempt.attemptNo).padStart(3, '0')}-${input.attempt.attemptId}`,
    )
    await mkdir(attemptRoot, { recursive: true, mode: 0o700 })
    const resultPath = join(attemptRoot, 'result.md')
    const bytes = Buffer.from(content, 'utf8')
    await atomicWrite(resultPath, bytes, 0o600)
    await atomicWrite(join(runRoot, 'result.md'), bytes, 0o600)
    return resultPath
  }

  runResultDirectory(experiment: Experiment, run: Run): string {
    if (experiment.resultPath === null) fail('CONFLICT', 'result-export', '该实验没有配置结果输出目录')
    return join(experiment.resultPath, `${String(run.ordinal + 1).padStart(2, '0')}-${safeName(run.modelConfig.modelName)}`)
  }

  private archiveAttemptDirectory(experiment: Experiment, run: Run, attempt: Attempt): string {
    return join(
      experiment.experimentPath,
      'runs', run.runId,
      'attempts', `${String(attempt.attemptNo).padStart(3, '0')}-${attempt.attemptId}`,
    )
  }

  async appendAuditExport(experiment: Experiment, event: AuditEvent): Promise<void> {
    await appendJsonLine(join(experiment.experimentPath, 'events.jsonl'), event)
  }

  async writeAuditExport(experiment: Experiment, events: readonly AuditEvent[]): Promise<void> {
    const body = events.map(event => canonicalize(event)).join('\n')
    await atomicWrite(
      join(experiment.experimentPath, 'events.jsonl'),
      Buffer.from(body.length === 0 ? '' : `${body}\n`, 'utf8'),
      0o600,
    )
  }

  async sealExperiment(experiment: ExperimentProjection, events: readonly AuditEvent[]): Promise<{ revision: number; indexHash: Hash; sealPath: string }> {
    if (experiment.lifecycleState !== 'SETTLED') fail('ACTION_TARGET_STALE', 'seal', '实验尚未结束', `cannot seal lifecycle=${experiment.lifecycleState}`)
    const revision = experiment.archiveRevision + 1
    const sealPath = join(experiment.experimentPath, 'experiment-seals', String(revision).padStart(6, '0'))
    await this.ensureNewOwnedDirectory(sealPath)
    const snapshot = {
      schemaVersion: 'model-pk/settled-state/v1',
      expectedGeneration: experiment.generation,
      semanticEventCursor: experiment.semanticEventCursor,
      auditSequenceAtSnapshot: experiment.auditSequence,
      attemptSetHash: experiment.attemptSetHash,
      lifecycleState: experiment.lifecycleState,
      outcome: experiment.outcome,
      runs: experiment.runs,
    }
    await atomicWrite(join(sealPath, 'settled-state.json'), Buffer.from(`${canonicalize(snapshot)}\n`), 0o600)
    const eventBytes = Buffer.from(events.filter(event => event.cursor <= experiment.latestCursor).map(event => canonicalize(event)).join('\n') + '\n')
    await atomicWrite(join(sealPath, 'settled-events.jsonl'), eventBytes, 0o600)
    const index = {
      schemaVersion: 'model-pk/experiment-archive-index/v1',
      experimentId: experiment.experimentId,
      archiveRevision: revision,
      expectedGeneration: experiment.generation,
      semanticEventCursor: experiment.semanticEventCursor,
      attemptSetHash: experiment.attemptSetHash,
      definitionIndexHash: await sha256File(join(experiment.experimentPath, 'definition-index.json')),
      settledStateHash: await sha256File(join(sealPath, 'settled-state.json')),
      settledEventsHash: await sha256File(join(sealPath, 'settled-events.jsonl')),
      attempts: await this.attemptIndexHashes(experiment),
    }
    await atomicWrite(join(sealPath, 'experiment-archive-index.json'), Buffer.from(`${canonicalize(index)}\n`), 0o600)
    const indexHash = await sha256File(join(sealPath, 'experiment-archive-index.json'))
    await fsyncDirectory(sealPath)
    return { revision, indexHash, sealPath }
  }

  async commitSeal(sealPath: string, activationId: string, indexHash: Hash): Promise<void> {
    await atomicWrite(join(sealPath, 'seal.commit'), Buffer.from(`${canonicalize({
      schemaVersion: 'model-pk/seal-commit/v1',
      activationId,
      indexHash,
      committedAt: new Date().toISOString(),
    })}\n`), 0o600)
    await fsyncDirectory(sealPath)
  }

  async moveToTrash(experimentPath: string, experimentId: string): Promise<string> {
    const source = this.assertUnder(this.layout.experiments, experimentPath)
    const target = this.assertUnder(this.layout.trash, join(this.layout.trash, `${experimentId}-${Date.now()}`))
    await mkdir(this.layout.trash, { recursive: true, mode: 0o700 })
    await rename(source, target)
    await fsyncDirectory(dirname(source))
    await fsyncDirectory(this.layout.trash)
    return target
  }

  async removeTrash(path: string): Promise<void> {
    const target = this.assertUnder(this.layout.trash, path)
    await rm(target, { recursive: true, force: true })
  }

  async findTrashForExperiment(experimentId: string): Promise<string | null> {
    const names = await readdir(this.layout.trash)
    const matches = names.filter(name => name.startsWith(`${experimentId}-`)).sort()
    if (matches.length === 0) return null
    const path = this.assertUnder(this.layout.trash, join(this.layout.trash, matches.at(-1)!))
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_PATH_ESCAPE', 'delete-recovery', '回收站目录不安全', `invalid trash entry ${path}`)
    return path
  }

  async trashEntries(): Promise<readonly { experimentId: string; path: string }[]> {
    const entries: { experimentId: string; path: string }[] = []
    for (const name of await readdir(this.layout.trash)) {
      const path = this.assertUnder(this.layout.trash, join(this.layout.trash, name))
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const experimentId = name.slice(0, 36)
      if (/^[0-9a-f-]{36}$/iu.test(experimentId)) entries.push({ experimentId, path })
    }
    return entries
  }

  async directoryBytes(path: string): Promise<number> {
    const root = this.assertUnder(this.layout.experiments, path)
    const manifestPath = join(this.layout.control, `.size-${randomUUID()}.json`)
    try {
      const manifest = await this.helper.scanTo(root, manifestPath, Number.MAX_SAFE_INTEGER, 2_000_000)
      return manifest.byteLength
    } finally {
      await rm(manifestPath, { force: true })
    }
  }

  private async copyBaselineIntoExperiment(
    sourceManifestPath: string,
    experimentRoot: string,
    publish: (path: string, value: Uint8Array | string | object) => Promise<void>,
  ): Promise<void> {
    const manifestBytes = await readFile(sourceManifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as NativeTreeManifest
    await publish('task/baseline/manifest.json', manifestBytes)
    const sourceObjects = join(dirname(sourceManifestPath), 'objects')
    for (const entry of manifest.entries) {
      if (entry.kind !== 'FILE' || entry.hash === undefined) continue
      const digest = entry.hash.slice('sha256:'.length)
      const source = join(sourceObjects, digest.slice(0, 2), digest.slice(2))
      const destination = join(experimentRoot, 'objects', digest.slice(0, 2), digest.slice(2))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      try { await copyFile(source, destination, 1) } catch (error) {
        const current = await readFile(destination).catch(() => null)
        if (current === null || sha256Bytes(current) !== entry.hash) throw error
      }
      await chmod(destination, 0o600)
    }
  }

  private async attemptIndexHashes(experiment: ExperimentProjection): Promise<readonly { attemptId: string; hash: Hash }[]> {
    const result: { attemptId: string; hash: Hash }[] = []
    for (const run of experiment.runs) {
      for (const attempt of run.attempts) {
        const path = join(experiment.experimentPath, 'runs', run.runId, 'attempts', `${String(attempt.attemptNo).padStart(3, '0')}-${attempt.attemptId}`, 'archive-index.json')
        result.push({ attemptId: attempt.attemptId, hash: await sha256File(path) })
      }
    }
    return result
  }

  private assertUnder(root: string, candidate: string): string {
    const normalizedRoot = resolve(root)
    const normalized = resolve(candidate)
    const rel = relative(normalizedRoot, normalized)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel === '' && normalized !== normalizedRoot) {
      fail('ARCHIVE_PATH_ESCAPE', 'archive', '归档路径越界', `candidate outside root: ${candidate}`)
    }
    return normalized
  }

  private async ensureNewOwnedDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_PATH_ESCAPE', 'archive', '归档目录不安全', `not an owned directory: ${path}`)
    await chmod(path, 0o700)
  }

  private async writeProbe(): Promise<void> {
    const probe = join(this.layout.control, `.write-probe-${process.pid}-${Date.now()}`)
    await writeFile(probe, 'probe', { flag: 'wx', mode: 0o600 })
    const handle = await open(probe, 'r+')
    await handle.sync()
    await handle.close()
    await rm(probe)
  }
}

async function atomicWrite(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, mode)
  await fsyncDirectory(dirname(path))
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.write(`${canonicalize(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  // Node cannot open directories with a flush-capable handle on Windows. File
  // contents are flushed before each rename; directory fsync remains a Unix
  // durability strengthening step.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function comparisonReportBody(attempt: Attempt | undefined): string {
  if (attempt === undefined) return '没有可展示的结果。'
  const summary = attempt.workspaceSummary
  if (summary?.mode === 'TEXT_FILE' && summary.textFilePath !== null && summary.textContent !== null) {
    return `单文件：\`${escapeMarkdownCode(summary.textFilePath)}\`\n\n${summary.textContent}`
  }
  if (summary?.mode === 'ENGINEERING') {
    const files = summary.files.map(file => `- ${file.changeType} \`${escapeMarkdownCode(file.path)}\``).join('\n')
    const truncated = summary.truncated ? '\n- …其余文件未列出' : ''
    const response = attempt.finalResponse ?? attempt.outputPreview
    return [
      `工程结果：${summary.changedFileCount} 个文件发生变化（新增 ${summary.addedFileCount}、修改 ${summary.modifiedFileCount}、删除 ${summary.deletedFileCount}）`,
      `${files}${truncated}`,
      response.length === 0 ? '' : `模型说明：\n\n${response}`,
    ].filter(section => section.length > 0).join('\n\n')
  }
  return attempt.finalResponse ?? attempt.outputPreview ?? '没有可展示的文本结果。'
}

function escapeMarkdownCode(value: string): string {
  return value.replace(/`/gu, '\\`')
}

async function copyIfPresent(
  source: string,
  destination: string,
  entries: { path: string; hash: Hash; byteLength: number; available: boolean; reason?: string }[],
  relativePath: string,
): Promise<void> {
  try {
    const bytes = await readFile(source)
    await atomicWrite(destination, bytes, 0o600)
    entries.push({ path: relativePath, hash: sha256Bytes(bytes), byteLength: bytes.byteLength, available: true })
  } catch {
    entries.push({ path: relativePath, hash: hashCanonical({ unavailable: true }), byteLength: 0, available: false, reason: 'not-generated' })
  }
}

function optionalForAttempt(attempt: Attempt, path: string): boolean {
  if (path === 'result.md') return attempt.pendingOutcome !== 'SUCCEEDED'
  if (attempt.workspaceSealState === 'QUARANTINED_UNSAFE') return false
  if (attempt.workspacePath === null && [
    'transcript.jsonl',
    'logs.jsonl',
    'events.jsonl',
    'workspace-manifest.json',
    'artifacts/manifest.json',
  ].includes(path)) return true
  return false
}

function safeName(value: string): string {
  return sanitizeFileName(value)
}

function archiveTaskPackage(taskPackage: Experiment['taskPackage']): object {
  return {
    ...taskPackage,
    attachments: taskPackage.attachments.map(({ immutablePath: _immutablePath, ...attachment }) => attachment),
    baseline: taskPackage.baseline === null ? null : {
      ...taskPackage.baseline,
      manifestPath: 'task/baseline/manifest.json',
    },
  }
}
