import { describe, expect, it } from 'vitest'
import {
  assertSandboxProbeCompleted,
  sandboxProbeTimeoutMs,
  type SandboxRunResult,
} from '../src/native/sandbox.js'

const timedOutResult: SandboxRunResult = {
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: true,
  truncated: false,
}

describe('sandbox compatibility probe policy', () => {
  it('allows a longer startup budget for Windows AppContainer probes', () => {
    expect(sandboxProbeTimeoutMs('win32')).toBe(30_000)
    expect(sandboxProbeTimeoutMs('darwin')).toBe(5_000)
  })

  it('reports the probe stage and timeout budget when a sandbox command times out', () => {
    expect(() => assertSandboxProbeCompleted('workspace-write', timedOutResult, 30_000))
      .toThrow('sandbox probe workspace-write timed out after 30000ms')
  })
})
