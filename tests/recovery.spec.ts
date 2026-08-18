import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExperimentDefinition } from '../src/domain/factory.js'
import { hashCanonical } from '../src/core/jcs.js'
import { uuid } from '../src/core/ids.js'
import { Scheduler } from '../src/host/scheduler.js'
import type { ArchiveManager } from '../src/host/archive.js'
import type { AttemptExecutor } from '../src/host/executor.js'
import type { NativeHelper } from '../src/native/helper.js'
import { ControlStore } from '../src/storage/store.js'
import { fixturePreflight } from './fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Scheduler crash recovery', () => {
  it('keeps queued work queued and moves an uncertain running request to RECOVERING without redispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-pk-recovery-'))
    roots.push(root)
    const store = new ControlStore(join(root, 'control.sqlite'))
    store.registerCapacitySlots(Array.from({ length: 12 }, (_, index) => ({
      slotId: `slot-${index}`,
      path: join(root, `slot-${index}.journal`),
      byteLength: 262_144,
    })))
    const definition = createExperimentDefinition({
      preflight: fixturePreflight(),
      experimentPath: join(root, 'experiment'),
      firstQueueSeq: store.nextQueueSequence(),
    })
    store.createExperiment({
      ...definition,
      actionId: uuid(),
      requestHash: hashCanonical({ operation: 'start' }),
    })
    store.activateExperiment(definition.experiment.experimentId)
    const interrupted = definition.attempts[0]!
    const untouched = definition.attempts[1]!
    let current = store.claimReservation(
      interrupted.attemptId,
      '2026-08-18T00:00:01.000Z',
      '2026-08-18T00:01:01.000Z',
      '2026-08-18T00:01:11.000Z',
    )
    current = store.transitionAttempt(current.attemptId, {
      expectedVersion: current.lifecycleVersion,
      to: 'DISPATCHING',
      patch: {
        dispatchIntentId: uuid(),
        dispatchIntentAt: '2026-08-18T00:00:02.000Z',
        dshSessionId: interrupted.attemptId,
      },
    })
    current = store.transitionAttempt(current.attemptId, {
      expectedVersion: current.lifecycleVersion,
      to: 'RUNNING',
      patch: {
        dispatchAckAt: '2026-08-18T00:00:03.000Z',
        startedAt: '2026-08-18T00:00:03.000Z',
        executionDeadlineAt: '2026-08-18T00:30:03.000Z',
      },
    })

    const prepare = vi.fn(() => { throw new Error('recovery must not redispatch') })
    const scheduler = new Scheduler(
      store,
      {} as ArchiveManager,
      {} as NativeHelper,
      { prepare } as unknown as AttemptExecutor,
    )
    const recover = (scheduler as unknown as { recoverOnStartup(): Promise<void> }).recoverOnStartup.bind(scheduler)
    await recover()

    const recovering = store.getAttemptRequired(current.attemptId)
    expect(recovering.state).toBe('RECOVERING')
    expect(recovering.error?.code).toBe('DISPATCH_UNCERTAIN')
    expect(recovering.recoveryDeadlineAt).not.toBeNull()
    expect(store.getAttemptRequired(untouched.attemptId).state).toBe('QUEUED')
    expect(prepare).not.toHaveBeenCalled()

    const originalDeadline = recovering.recoveryDeadlineAt
    await recover()
    expect(store.getAttemptRequired(current.attemptId).recoveryDeadlineAt).toBe(originalDeadline)
    expect(prepare).not.toHaveBeenCalled()
    store.close()
  })
})
