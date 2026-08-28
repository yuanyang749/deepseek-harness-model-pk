import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashCanonical } from '../src/core/jcs.js'
import { NativeHelper, nativeExecutableName } from '../src/native/helper.js'
import { createIsolationFixture, SandboxRunner } from '../src/native/sandbox.js'

let helper: NativeHelper
let root: string

beforeAll(async () => {
  helper = await NativeHelper.locate({
    explicitPath: resolve('native', 'model-pk-helper', 'target', 'debug', nativeExecutableName(process.platform)),
    allowDevBinary: true,
  })
  root = await realpath(await mkdtemp(join(tmpdir(), 'model-pk-native-')))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('native helper', () => {
  it('advertises the outbound-network sandbox capability', () => {
    expect(helper.probe.version.features).toContain('sandbox-outbound-network')
  })

  it('streams a deterministic snapshot and restores content/mode', async () => {
    const source = join(root, 'source')
    const objects = join(root, 'objects')
    const destination = join(root, 'destination')
    const manifestPath = join(root, 'manifest.json')
    await mkdir(join(source, 'bin'), { recursive: true })
    await writeFile(join(source, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a))
    await writeFile(join(source, 'bin', 'run'), '#!/bin/sh\necho ok\n')
    await chmod(join(source, 'bin', 'run'), 0o755)
    const summary = await helper.snapshotTo(source, objects, manifestPath, 20 * 1024 * 1024, 10)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: unknown[]; treeHash: string }
    expect(summary.fileCount).toBe(2)
    expect(summary.byteLength).toBeGreaterThan(8 * 1024 * 1024)
    expect(manifest.treeHash).toBe(hashCanonical(manifest.entries))
    const restored = await helper.materialize(manifestPath, objects, destination)
    expect(restored.treeHash).toBe(summary.treeHash)
    expect(await readFile(join(destination, 'bin', 'run'), 'utf8')).toContain('echo ok')
  })

  it('rejects symlinks, hardlinks and path traversal', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'secret')
    const symlinkTree = join(root, 'symlink-tree')
    await mkdir(symlinkTree)
    if (process.platform === 'win32') {
      const outsideDirectory = join(root, 'outside-directory')
      await mkdir(outsideDirectory)
      await symlink(outsideDirectory, join(symlinkTree, 'escape'), 'junction')
    } else {
      await symlink(outside, join(symlinkTree, 'escape'))
    }
    await expect(helper.scan(symlinkTree, 1024, 10)).rejects.toThrow()
    const rootTarget = join(root, 'root-target')
    const rootLink = join(root, 'root-link')
    await mkdir(rootTarget)
    await writeFile(join(rootTarget, 'visible.txt'), 'not-followed')
    await symlink(rootTarget, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(helper.scan(rootLink, 1024, 10)).rejects.toThrow()
    const hardlinkTree = join(root, 'hardlink-tree')
    await mkdir(hardlinkTree)
    await link(outside, join(hardlinkTree, 'linked'))
    await expect(helper.scan(hardlinkTree, 1024, 10)).rejects.toThrow()
    if (process.platform === 'win32') {
      const streamTree = join(root, 'stream-tree')
      const streamFile = join(streamTree, 'plain.txt')
      await mkdir(streamTree)
      await writeFile(streamFile, 'plain')
      await writeFile(`${streamFile}:hidden`, 'hidden')
      await expect(helper.scan(streamTree, 1024, 10)).rejects.toThrow()
    }
    const workspace = join(root, 'write-workspace')
    await mkdir(workspace)
    const lease = join(root, 'lease')
    await writeFile(lease, 'token\n')
    await expect(helper.write({ root: workspace, path: '../escape', bytesBase64: 'eA==', leasePath: lease, fencingToken: 'token' })).rejects.toThrow()
    if (process.platform === 'win32') {
      await expect(helper.write({ root: workspace, path: 'CON.txt', bytesBase64: 'eA==', leasePath: lease, fencingToken: 'token' })).rejects.toThrow()
    }
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

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('denies sibling reads and kills the sandbox process tree', async () => {
    const runner = new SandboxRunner(helper)
    expect(await runner.available()).toBe(true)
    const attemptRoot = join(root, 'sandbox-attempt')
    const paths = await createIsolationFixture(attemptRoot)
    const sibling = join(root, 'sandbox-secret')
    await writeFile(sibling, 'not-visible')
    await runner.prepare(paths)
    try {
      const allowed = join(paths.workspace, 'allowed.txt')
      const allowedCommand = process.platform === 'win32'
        ? `$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText('${allowed.replaceAll("'", "''")}', 'allowed')`
        : `/bin/echo allowed > '${allowed.replaceAll("'", "'\\''")}'`
      expect((await runner.run(paths, allowedCommand, { timeoutMs: 5_000 })).exitCode).toBe(0)
      expect(await readFile(allowed, 'utf8')).toContain('allowed')
      const logicalCommand = process.platform === 'win32'
        ? "$ErrorActionPreference = 'Stop'; [IO.File]::WriteAllText('/workspace/logical.txt', 'logical')"
        : "/bin/echo logical > '/workspace/logical.txt'"
      expect((await runner.run(paths, logicalCommand, { timeoutMs: 5_000 })).exitCode).toBe(0)
      expect(await readFile(join(paths.workspace, 'logical.txt'), 'utf8')).toContain('logical')
      const readCommand = process.platform === 'win32'
        ? `$ErrorActionPreference = 'Stop'; try { [Console]::Out.Write([IO.File]::ReadAllText('${sibling.replaceAll("'", "''")}')); exit 0 } catch { exit 1 }`
        : `/bin/cat '${sibling.replaceAll("'", "'\\''")}'`
      const result = await runner.run(paths, readCommand, { timeoutMs: 5_000 })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('not-visible')
      const orphan = join(paths.workspace, 'orphan.txt')
      const orphanCommand = process.platform === 'win32'
        ? windowsOrphanCommand(orphan)
        : `(/bin/sleep 1; /bin/echo leaked > '${orphan.replaceAll("'", "'\\''")}') & exit 0`
      const orphanResult = await runner.run(paths, orphanCommand, { timeoutMs: 5_000 })
      if (process.platform === 'win32') {
        expect(orphanResult.exitCode).toBe(0)
        expect(orphanResult.stdout).toContain('spawned:')
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
      await expect(readFile(orphan, 'utf8')).rejects.toThrow()
    } finally {
      await runner.cleanup(paths)
    }
  }, process.platform === 'win32' ? 60_000 : 10_000)

  it.runIf(process.platform === 'darwin')('allows outbound network without widening filesystem access', async () => {
    const server = createServer((_request, response) => response.end('sandbox-network-ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test server address')
    const runner = new SandboxRunner(helper)
    const paths = await createIsolationFixture(join(root, 'sandbox-network-attempt'))
    await runner.prepare(paths)
    try {
      const result = await runner.run(paths, `/usr/bin/curl --fail --silent http://127.0.0.1:${address.port}/`, { timeoutMs: 5_000 })
      expect(result, result.stderr).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain('sandbox-network-ok')
    } finally {
      await runner.cleanup(paths)
      server.close()
      await once(server, 'close')
    }
  }, 10_000)
})

function windowsOrphanCommand(target: string): string {
  const childScript = `Start-Sleep -Seconds 1; [IO.File]::WriteAllText('${target.replaceAll("'", "''")}', 'leaked')`
  const encoded = Buffer.from(childScript, 'utf16le').toString('base64')
  return `$ErrorActionPreference = 'Stop'; $shell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $child = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}') -PassThru; Write-Output "spawned:$($child.Id)"`
}
