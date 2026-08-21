import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Attempt, AuditEvent, ExperimentProjection, Run } from '../src/contracts/types.js'
import { uuid } from '../src/core/ids.js'
import { createExperimentDefinition } from '../src/domain/factory.js'
import { ArchiveManager, dataLayout } from '../src/host/archive.js'
import { NativeHelper, nativeExecutableName } from '../src/native/helper.js'
import { fixturePreflight } from './fixtures.js'

let helper: NativeHelper
let root: string

beforeAll(async () => {
  helper = await NativeHelper.locate({
    explicitPath: resolve('native', 'model-pk-helper', 'target', 'debug', nativeExecutableName(process.platform)),
    allowDevBinary: true,
  })
  root = await realpath(await mkdtemp(join(tmpdir(), 'model-pk-archive-')))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('self-contained archive', () => {
  it('canonicalizes symlinked ancestors before invoking the no-follow helper', async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), 'model-pk-raw-path-'))
    try {
      const canonicalRoot = await realpath(rawRoot)
      const archive = new ArchiveManager(dataLayout(join(rawRoot, 'dsh-home')), helper)
      expect(archive.layout.root).toBe(join(canonicalRoot, 'dsh-home', 'model-pk', 'v1'))
      await archive.initialize()
      const source = join(archive.layout.runtime, 'fixture-workspace')
      const objects = join(archive.layout.experiments, 'fixture-objects')
      const manifest = join(archive.layout.control, 'fixture-manifest.json')
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'answer.txt'), 'canonical path\n')
      await expect(helper.snapshotTo(source, objects, manifest, 1024, 10)).resolves.toMatchObject({
        fileCount: 1,
      })
    } finally {
      await rm(rawRoot, { recursive: true, force: true })
    }
  })

  it('publishes a portable definition, complete attempt evidence, and immutable settled seal', async () => {
    const archive = new ArchiveManager(dataLayout(join(root, 'dsh-home')), helper)
    await archive.initialize()
    const experimentId = uuid()
    const experimentPath = archive.experimentPath(experimentId, 'Portable fixture', new Date('2026-08-18T00:00:00Z'))
    const resultRoot = join(root, 'user-results')
    await mkdir(resultRoot)
    const resultPath = join(resultRoot, 'Portable-fixture-20260818-000000')
    const rawDefinition = createExperimentDefinition({
      preflight: fixturePreflight(),
      experimentId,
      experimentPath,
      resultPath,
      firstQueueSeq: 1,
      now: '2026-08-18T00:00:00.000Z',
    })
    const definition = {
      ...rawDefinition,
      experiment: { ...rawDefinition.experiment, resultPath },
    }
    await archive.publishDefinition(definition.experiment, definition.runs)
    expect(await realpath(resultPath)).toBe(resultPath)

    const archivedDefinition = JSON.parse(await readFile(join(experimentPath, 'experiment.json'), 'utf8')) as Record<string, unknown>
    expect(archivedDefinition.archiveRoot).toBe('.')
    expect(archivedDefinition).not.toHaveProperty('experimentPath')
    expect(JSON.stringify(archivedDefinition)).not.toContain(root)

    const terminalRuns: Run[] = []
    for (const run of definition.runs) {
      const initial = run.attempts[0]!
      const runtime = await archive.createAttemptRuntime(definition.experiment, run, initial)
      await writeFile(join(runtime.workspace, `answer-${run.ordinal}.txt`), `workspace-${run.ordinal}\n`)
      if (run.ordinal === 1) await writeFile(join(runtime.workspace, 'second.txt'), 'second file\n')
      await mkdir(join(runtime.artifacts, 'reports'), { recursive: true })
      await writeFile(join(runtime.artifacts, 'reports', 'result.json'), JSON.stringify({ ordinal: run.ordinal }))
      await archive.appendTranscript(runtime, { type: 'assistant/message', ordinal: run.ordinal })
      await archive.appendTranscript(runtime, {
        type: 'assistant/chunk',
        data: { chunk: { type: 'usage', usage: { inputTokens: 100 + run.ordinal, outputTokens: 20, cacheReadTokens: 5 } } },
      })
      await archive.appendLog(runtime, { level: 'info', message: 'fixture' })
      await archive.appendAttemptEvent(runtime, { kind: 'FIXTURE_PROGRESS' })
      const terminal: Attempt = {
        ...initial,
        state: 'SUCCEEDED',
        lifecycleVersion: 5,
        observedExecutionOutcome: 'SUCCEEDED',
        pendingOutcome: 'SUCCEEDED',
        finalizationId: uuid(),
        finalizationStage: 'CONTROL_COMMITTED',
        executionTerminationConfirmed: true,
        executionReservationState: 'RELEASED',
        workspaceSealState: 'SEALED',
        workspacePath: runtime.workspace,
        artifactPath: runtime.artifacts,
        finalResponse: `result-${run.ordinal}`,
        archiveCompleteness: 'COMPLETE',
        finalizedAt: '2026-08-18T00:01:00.000Z',
      }
      const projectedExperiment: ExperimentProjection = {
        ...definition.experiment,
        counts: { queued: 0, active: 0, finalizing: 0, finished: run.ordinal, total: 2 },
        latestCursor: 0,
        activeActions: [],
        recoveryNotice: null,
      }
      const finalized = await archive.finalizeAttempt({
        experiment: projectedExperiment,
        run,
        attempt: terminal,
        runtime,
        finalResponse: terminal.finalResponse,
        primaryError: null,
        cancelReason: null,
      })
      expect(finalized.completeness).toBe('COMPLETE')
      expect(finalized.workspaceTreeHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(finalized.indexHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(finalized.workspaceSummary).toMatchObject(run.ordinal === 0
        ? { mode: 'TEXT_FILE', changedFileCount: 1, textFilePath: 'answer-0.txt', textContent: 'workspace-0\n' }
        : { mode: 'ENGINEERING', changedFileCount: 2, addedFileCount: 2 })
      expect(finalized.tokenUsage).toEqual({
        requestCount: 1,
        inputTokens: 100 + run.ordinal,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      })
      expect(finalized.resultPath).toBe(join(
        resultPath,
        `${String(run.ordinal + 1).padStart(2, '0')}-${run.modelConfig.modelName}`,
        'attempts',
        `001-${initial.attemptId}`,
        'result.md',
      ))
      terminalRuns.push({
        ...run,
        attempts: [{ ...terminal, workspaceSummary: finalized.workspaceSummary, tokenUsage: finalized.tokenUsage }],
        lastSuccessfulAttemptId: terminal.attemptId,
      })
    }

    const events: AuditEvent[] = terminalRuns.map((run, index) => ({
      cursor: index + 1,
      experimentId,
      attemptId: run.latestAttemptId,
      kind: 'ATTEMPT_FINALIZED',
      payload: { state: 'SUCCEEDED' },
      occurredAt: `2026-08-18T00:0${index + 1}:00.000Z`,
    }))
    const settled: ExperimentProjection = {
      ...definition.experiment,
      lifecycleState: 'SETTLED',
      outcome: 'ALL_SUCCEEDED',
      generation: 2,
      semanticEventCursor: 2,
      auditSequence: 2,
      archiveFreshness: 'STALE',
      archiveIntegrity: 'INCOMPLETE',
      runs: terminalRuns,
      settledAt: '2026-08-18T00:02:00.000Z',
      counts: { queued: 0, active: 0, finalizing: 0, finished: 2, total: 2 },
      latestCursor: 2,
      activeActions: [],
      recoveryNotice: null,
    }
    await archive.writeProjection(settled)
    await archive.exportComparison(settled)
    const comparisonReport = await readFile(join(resultPath, '对照结果.md'), 'utf8')
    expect(comparisonReport).toContain('answer-0.txt')
    expect(comparisonReport).toContain('workspace-0')
    expect(comparisonReport).toContain('工程结果：2 个文件发生变化')
    expect(await readFile(join(resultPath, '01-Model 1', 'result.md'), 'utf8')).toBe('workspace-0\n')
    const exportedWorkspace = await archive.exportAttemptWorkspace(
      settled,
      terminalRuns[0]!,
      terminalRuns[0]!.attempts[0]!,
    )
    expect(await readFile(join(exportedWorkspace.path, 'answer-0.txt'), 'utf8')).toBe('workspace-0\n')
    await expect(archive.exportAttemptWorkspace(
      settled,
      terminalRuns[0]!,
      terminalRuns[0]!.attempts[0]!,
    )).rejects.toMatchObject({
      detail: {
        code: 'CONFLICT',
        userMessage: '工作区导出目录已存在',
      },
    })
    await archive.writeAuditExport(settled, events)
    const seal = await archive.sealExperiment(settled, events)
    await archive.commitSeal(seal.sealPath, uuid(), seal.indexHash)

    expect(await readFile(join(seal.sealPath, 'seal.commit'), 'utf8')).toContain(seal.indexHash)
    expect(await readFile(join(experimentPath, 'events.jsonl'), 'utf8')).toContain('ATTEMPT_FINALIZED')
    const firstAttempt = terminalRuns[0]!.attempts[0]!
    const attemptPath = join(
      experimentPath,
      'runs', terminalRuns[0]!.runId,
      'attempts', `001-${firstAttempt.attemptId}`,
    )
    expect(await readFile(join(attemptPath, 'result.md'), 'utf8')).toBe('result-0')
    expect(await readFile(join(attemptPath, 'transcript.jsonl'), 'utf8')).toContain('assistant/message')
    expect(JSON.parse(await readFile(join(attemptPath, 'metadata.json'), 'utf8'))).toMatchObject({
      archiveCompleteness: 'COMPLETE',
      state: 'SUCCEEDED',
    })
  })
})
