import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttempt, createExperimentDefinition } from '../src/domain/factory.js'
import { hashCanonical } from '../src/core/jcs.js'
import { uuid } from '../src/core/ids.js'
import { ControlStore } from '../src/storage/store.js'
import { fixturePreflight } from './fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createStore(): Promise<ControlStore> {
  const root = await mkdtemp(join(tmpdir(), 'model-pk-store-'))
  roots.push(root)
  const store = new ControlStore(join(root, 'control.sqlite'))
  store.registerCapacitySlots(Array.from({ length: 12 }, (_, index) => ({
    slotId: `slot-${index}`,
    path: join(root, `slot-${index}`),
    byteLength: 262_144,
  })))
  return store
}

describe('ControlStore', () => {
  it('atomically creates Experiment/Run/Attempt and settles latest attempts', async () => {
    const store = await createStore()
    const definition = createExperimentDefinition({
      preflight: fixturePreflight(),
      experimentPath: join(roots[0]!, 'experiment'),
      experimentId: uuid(),
      firstQueueSeq: store.nextQueueSequence(),
      now: '2026-08-18T00:00:00.000Z',
    })
    const actionId = uuid()
    const requestHash = hashCanonical({ start: 1 })
    const action = store.createExperiment({ ...definition, actionId, requestHash })
    expect(action.state).toBe('APPLIED')
    expect(store.createExperiment({ ...definition, actionId, requestHash }).actionId).toBe(actionId)
    expect(store.freeCapacitySlotCount()).toBe(10)
    expect(store.activateExperiment(definition.experiment.experimentId).lifecycleState).toBe('ACTIVE')

    for (const initial of definition.attempts) {
      const current = store.getAttemptRequired(initial.attemptId)
      const finalizing = store.transitionAttempt(current.attemptId, {
        expectedVersion: current.lifecycleVersion,
        to: 'FINALIZING',
        patch: {
          pendingOutcome: 'CANCELLED',
          observedExecutionOutcome: 'CANCELLED',
          finalizationId: uuid(),
          finalizationStage: 'CONTROL_COMMITTED',
          finalizationStartedAt: '2026-08-18T00:01:00.000Z',
          executionEndedAt: '2026-08-18T00:01:00.000Z',
          executionTerminationConfirmed: true,
          executionReservationState: 'RELEASED',
          workspaceSealState: 'SEALED',
          archiveCompleteness: 'COMPLETE',
          cancelReason: 'USER_CANCELLED',
        },
      })
      store.transitionAttempt(finalizing.attemptId, {
        expectedVersion: finalizing.lifecycleVersion,
        to: 'CANCELLED',
        patch: { finalizedAt: '2026-08-18T00:01:01.000Z' },
      })
    }
    const settled = store.getExperimentRequired(definition.experiment.experimentId)
    expect(settled.lifecycleState).toBe('SETTLED')
    expect(settled.outcome).toBe('ALL_CANCELLED')
    expect(store.freeCapacitySlotCount()).toBe(12)
    expect(settled.latestCursor).toBeGreaterThan(0)

    const nextDefinition = createExperimentDefinition({
      preflight: fixturePreflight(),
      experimentPath: join(roots[0]!, 'experiment-2'),
      experimentId: uuid(),
      firstQueueSeq: store.nextQueueSequence(),
      now: '2026-08-18T00:02:00.000Z',
    })
    expect(store.createExperiment({
      ...nextDefinition,
      actionId: uuid(),
      requestHash: hashCanonical({ start: 2 }),
    }).state).toBe('APPLIED')
    expect(store.freeCapacitySlotCount()).toBe(10)
    store.close()
  })

  it('migrates the v1 control-slot uniqueness constraint for existing databases', async () => {
    const store = await createStore()
    const databasePath = store.path
    store.close()

    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec('CREATE UNIQUE INDEX legacy_attempt_control_slot_unique ON attempts(control_slot_id)')
    legacyDatabase.prepare('UPDATE meta SET value=? WHERE key=?').run('1', 'schema_version')
    legacyDatabase.close()

    const migrated = new ControlStore(databasePath)
    const uniqueIndexes = migrated.db.prepare(`
      SELECT name FROM pragma_index_list('attempts') WHERE "unique"=1
    `).all() as { name: string }[]
    const stillUnique = uniqueIndexes.some(index => {
      const columns = migrated.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name) as { name: string }[]
      return columns.length === 1 && columns[0]?.name === 'control_slot_id'
    })
    expect(stillUnique).toBe(false)
    expect(migrated.getMeta('schema_version')).toBe('2')
    migrated.close()
  })

  it('enforces operation identity and only one nonterminal attempt per run', async () => {
    const store = await createStore()
    const definition = createExperimentDefinition({
      preflight: fixturePreflight(), experimentPath: join(roots[0]!, 'e'), firstQueueSeq: 1,
    })
    const actionId = uuid()
    store.createExperiment({ ...definition, actionId, requestHash: hashCanonical({ value: 1 }) })
    expect(() => store.claimAction(actionId, 'START', definition.experiment.experimentId, hashCanonical({ value: 2 })))
      .toThrow(/action conflict/u)
    const run = definition.runs[0]!
    const attempt = createAttempt({
      runId: run.runId,
      attemptNo: 2,
      trigger: 'RETRY',
      batchActionId: null,
      model: run.modelConfig,
      taskPackage: definition.experiment.taskPackage,
      taskPackageHash: definition.experiment.taskPackageHash,
      harness: definition.experiment.resolvedHarness,
      executionConditions: definition.experiment.executionConditions,
      executionConditionsHash: definition.experiment.executionConditionsHash,
      queueSeq: 100,
    })
    expect(() => store.createAttempt({
      attempt,
      actionId: uuid(),
      actionKind: 'RETRY',
      requestHash: hashCanonical({ retry: 1 }),
      expectedLatestAttemptId: run.latestAttemptId,
    })).toThrow()
    store.close()
  })
})
