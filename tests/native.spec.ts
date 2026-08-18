import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashCanonical } from '../src/core/jcs.js'
import { NativeHelper } from '../src/native/helper.js'
import { createIsolationFixture, SeatbeltRunner } from '../src/native/seatbelt.js'

let helper: NativeHelper
let root: string

beforeAll(async () => {
  helper = await NativeHelper.locate({
    explicitPath: resolve('native/model-pk-helper/target/debug/model-pk-helper'),
    allowDevBinary: true,
  })
  root = await realpath(await mkdtemp(join(tmpdir(), 'model-pk-native-')))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('native helper', () => {
  it('streams a deterministic snapshot and restores content/mode', async () => {
    const source = join(root, 'source')
    const objects = join(root, 'objects')
    const destination = join(root, 'destination')
    const manifestPath = join(root, 'manifest.json')
    await mkdir(join(source, 'bin'), { recursive: true })
    await writeFile(join(source, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a))
    await writeFile(join(source, 'bin/run'), '#!/bin/sh\necho ok\n')
    await chmod(join(source, 'bin/run'), 0o755)
    const summary = await helper.snapshotTo(source, objects, manifestPath, 20 * 1024 * 1024, 10)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: unknown[]; treeHash: string }
    expect(summary.fileCount).toBe(2)
    expect(summary.byteLength).toBeGreaterThan(8 * 1024 * 1024)
    expect(manifest.treeHash).toBe(hashCanonical(manifest.entries))
    const restored = await helper.materialize(manifestPath, objects, destination)
    expect(restored.treeHash).toBe(summary.treeHash)
    expect(await readFile(join(destination, 'bin/run'), 'utf8')).toContain('echo ok')
  })

  it('rejects symlinks, hardlinks and path traversal', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'secret')
    const symlinkTree = join(root, 'symlink-tree')
    await mkdir(symlinkTree)
    await symlink(outside, join(symlinkTree, 'escape'))
    await expect(helper.scan(symlinkTree, 1024, 10)).rejects.toThrow()
    const hardlinkTree = join(root, 'hardlink-tree')
    await mkdir(hardlinkTree)
    await link(outside, join(hardlinkTree, 'linked'))
    await expect(helper.scan(hardlinkTree, 1024, 10)).rejects.toThrow()
    const workspace = join(root, 'write-workspace')
    await mkdir(workspace)
    const lease = join(root, 'lease')
    await writeFile(lease, 'token\n')
    await expect(helper.write({ root: workspace, path: '../escape', bytesBase64: 'eA==', leasePath: lease, fencingToken: 'token' })).rejects.toThrow()
  })

  it('uses fencing tokens and double-buffered capacity generations', async () => {
    const workspace = join(root, 'fenced-workspace')
    await mkdir(workspace)
    const lease = join(root, 'fenced-lease')
    await writeFile(lease, 'token-a\n')
    await helper.write({ root: workspace, path: 'ok.txt', bytesBase64: 'b2s=', leasePath: lease, fencingToken: 'token-a' })
    await writeFile(lease, 'revoked\n')
    await expect(helper.write({ root: workspace, path: 'late.txt', bytesBase64: 'bm8=', leasePath: lease, fencingToken: 'token-a' })).rejects.toThrow()
    const slot = join(root, 'slot.journal')
    await helper.reserve(slot, 256 * 1024)
    await helper.slotWrite(slot, 1, Buffer.from('one'))
    await helper.slotWrite(slot, 2, Buffer.from('two'))
    const current = await helper.slotRead(slot)
    expect(current.generation).toBe(2)
    expect(Buffer.from(current.payloadBase64, 'base64').toString()).toBe('two')
  })

  it.runIf(process.platform === 'darwin')('denies sibling reads and kills the process group', async () => {
    const runner = new SeatbeltRunner()
    expect(await runner.available()).toBe(true)
    const attemptRoot = join(root, 'seatbelt-attempt')
    const paths = await createIsolationFixture(attemptRoot)
    const sibling = join(root, 'seatbelt-secret')
    await writeFile(sibling, 'not-visible')
    const result = await runner.run(paths, `/bin/cat '${sibling}'`, { timeoutMs: 5_000 })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('not-visible')
    const orphan = join(paths.workspace, 'orphan.txt')
    await runner.run(paths, `(/bin/sleep 1; /bin/echo leaked > '${orphan}') & exit 0`, { timeoutMs: 5_000 })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
    await expect(readFile(orphan, 'utf8')).rejects.toThrow()
  })
})
