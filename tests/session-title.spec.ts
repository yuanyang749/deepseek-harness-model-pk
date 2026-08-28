import { describe, expect, it, vi } from 'vitest'
import { inject } from '../src/index.js'
import { readFileSync } from 'node:fs'
import { releasePkSession, setPkSessionPermission, setPkSessionTitle } from '../src/host/executor.js'
import type { DshAgentHandle, DshSession } from '../src/host/dsh.js'

describe('PK Agent session title', () => {
  it('declares the DSH session-title service as a host dependency', () => {
    expect(inject).toContain('sessionTitle')
  })

  it('pins a descriptive title containing the experiment and model names', () => {
    const rename = vi.fn()
    const session = {
      id: 'attempt-1',
      firstLiveSeq: 0,
      events: [],
      append: vi.fn(),
    } satisfies DshSession

    setPkSessionTitle({ sessionTitle: { rename } }, session, '童话故事', 'grok-4.6')

    expect(rename).toHaveBeenCalledOnce()
    expect(rename).toHaveBeenCalledWith(session, 'PK · 童话故事 · grok-4.6')
  })
})

describe('PK Agent session retention', () => {
  it('keeps a completed PK session attached so it remains in the DSH sidebar', async () => {
    const dispose = vi.fn(async () => undefined)

    await releasePkSession({ dispose } as unknown as DshAgentHandle, true)

    expect(dispose).not.toHaveBeenCalled()
  })

  it('disposes an empty or interrupted session that never reached idle', async () => {
    const dispose = vi.fn(async () => undefined)

    await releasePkSession({ dispose } as unknown as DshAgentHandle, false)

    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('PK Agent permission preset', () => {
  it('declares and selects a named workspace-only preset without approval prompts', () => {
    expect(inject).toContain('permissionPresets')
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('model-pk-workspace:')
    expect(patch).toContain('name: Model PK 工作区')
    expect(patch).toMatch(/model-pk-workspace:[\s\S]*sandbox: workspace-write[\s\S]*approval: never/u)

    const resolve = vi.fn(() => ({ sandbox: 'workspace-write' as const, approval: 'never' as const }))
    const session = {
      id: 'attempt-1',
      firstLiveSeq: 0,
      events: [],
      append: vi.fn(),
    } satisfies DshSession

    setPkSessionPermission({ permissionPresets: { resolve } }, session)

    expect(resolve).toHaveBeenCalledWith('model-pk-workspace')
    expect(session.append).toHaveBeenNthCalledWith(1, 'permission/preset', { preset: 'model-pk-workspace' })
    expect(session.append).toHaveBeenNthCalledWith(2, 'sandbox/mode', { mode: 'workspace-write' })
    expect(session.append).toHaveBeenNthCalledWith(3, 'approval/policy', { policy: 'never' })
  })
})
