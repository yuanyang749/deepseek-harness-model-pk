import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DSH_COMMIT, DSH_VERSION } from '../src/contracts/constants.js'
import { dataLayoutAtRoot } from '../src/host/archive.js'
import { CompatibilityGate } from '../src/host/compatibility.js'
import { NativeHelper, nativeExecutableName } from '../src/native/helper.js'
import { SandboxRunner } from '../src/native/sandbox.js'

let root: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'model-pk-compatibility-')))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('compatibility gate', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('accepts an isolated workspace with outbound network access', async () => {
    const helper = await NativeHelper.locate({
      explicitPath: resolve('native', 'model-pk-helper', 'target', 'debug', nativeExecutableName(process.platform)),
      allowDevBinary: true,
    })
    const gate = new CompatibilityGate(
      { dshVersion: DSH_VERSION, dshCommit: DSH_COMMIT },
      dataLayoutAtRoot(root),
      helper,
      new SandboxRunner(helper),
    )

    const evidence = await gate.run({
      modelSnapshot: async () => undefined,
      sessionFreshness: async () => undefined,
    })

    expect(evidence.report.executionEnabled).toBe(true)
    expect(evidence.checks.find(check => check.id === 'isolation-sandbox')).toMatchObject({ status: 'PASS' })
  }, process.platform === 'win32' ? 60_000 : 15_000)
})
