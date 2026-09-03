import { describe, expect, it } from 'vitest'
import { resolveHarness } from '../src/host/harness.js'
import { NativeHelper } from '../src/native/helper.js'
import { SandboxRunner } from '../src/native/sandbox.js'

describe('Model PK workspace capability policy', () => {
  it('allows outbound network while keeping the attempt workspace boundary', () => {
    const sandbox = new SandboxRunner(NativeHelper.unavailable())
    const harness = resolveHarness(sandbox, { dshVersion: '0.1.1-rc.2', dshCommit: 'fixture' })

    expect(harness.permissions).toMatchObject({
      filesystem: 'attempt-root-only',
      network: 'allowed',
      dshSessionSandboxMode: 'workspace-write',
      dshSessionApprovalPolicy: 'never',
      dshSessionPermissionPreset: 'model-pk-workspace',
    })
    expect(harness.sandbox).toMatchObject({ network: 'outbound-allowed' })
    expect(sandbox.contractVersion()).toMatch(/-v2$/u)
    expect(harness.systemPrompt).toContain('You may use the network')
    expect(harness.systemPrompt).not.toContain('the network, other attempts')
  })
})
