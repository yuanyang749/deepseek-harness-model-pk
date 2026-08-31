import { createServer } from 'node:net'
import { link, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSH_COMMIT, DSH_VERSION, LIMITS, PLUGIN_VERSION } from '../contracts/constants.js'
import type { CapabilityReport, ModelPkError } from '../contracts/types.js'
import { modelPkError, normalizeError } from '../core/error.js'
import type { NativeHelper } from '../native/helper.js'
import {
  assertSandboxProbeCompleted,
  createIsolationFixture,
  sandboxProbeTimeoutMs,
  type SandboxRunner,
} from '../native/sandbox.js'
import type { DataLayout } from './archive.js'

export interface HostRuntimeIdentity {
  readonly dshVersion: string | null
  readonly dshCommit: string | null
}

export interface CompatibilityEvidence {
  readonly report: CapabilityReport
  readonly checks: readonly {
    readonly id: string
    readonly status: 'PASS' | 'BLOCKED'
    readonly summary: string
    readonly diagnostics?: Readonly<Record<string, unknown>>
  }[]
}

export interface CompatibilityProbes {
  readonly modelSnapshot?: () => Promise<void>
  readonly sessionFreshness?: () => Promise<void>
}

export class CompatibilityGate {
  constructor(
    private readonly identity: HostRuntimeIdentity,
    private readonly layout: DataLayout,
    private readonly helper: NativeHelper,
    private readonly sandbox: SandboxRunner,
  ) {}

  async run(probes: CompatibilityProbes = {}): Promise<CompatibilityEvidence> {
    const checks: CompatibilityEvidence['checks'][number][] = []
    const blockers: ModelPkError[] = []
    const check = async (id: string, summary: string, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation()
        checks.push({ id, status: 'PASS', summary })
      } catch (error) {
        const normalized = normalizeError(error, `compatibility:${id}`)
        const blocker = id.startsWith('session')
          ? { ...normalized, code: 'SESSION_ISOLATION_UNSUPPORTED' as const, retryable: false, userMessage: '无法证明 Attempt session 独立' }
          : id.startsWith('native') || id.startsWith('isolation')
            ? { ...normalized, code: 'EXECUTION_ISOLATION_UNSUPPORTED' as const, retryable: false, userMessage: '无法证明 Attempt 执行隔离' }
            : normalized
        blockers.push(blocker)
        checks.push({ id, status: 'BLOCKED', summary: blocker.userMessage, diagnostics: { code: blocker.code, technicalMessage: blocker.technicalMessage } })
      }
    }
    if (this.identity.dshVersion !== DSH_VERSION || this.identity.dshCommit !== DSH_COMMIT) {
      const error = modelPkError(
        'DSH_VERSION_UNSUPPORTED',
        'compatibility:dsh-version',
        'DSH 版本与 Model PK V1 锁定版本不一致',
        `expected ${DSH_VERSION}/${DSH_COMMIT}; got ${this.identity.dshVersion ?? 'unknown'}/${this.identity.dshCommit ?? 'unknown'}`,
      )
      blockers.push(error)
      checks.push({ id: 'dsh-version', status: 'BLOCKED', summary: error.userMessage, diagnostics: { expectedVersion: DSH_VERSION, expectedCommit: DSH_COMMIT } })
    } else {
      checks.push({ id: 'dsh-version', status: 'PASS', summary: `DSH ${DSH_VERSION} (${DSH_COMMIT.slice(0, 12)})` })
    }
    await check('native-helper', '原生 helper 版本、架构与 hash 已验证', async () => {
      if (this.helper.probe.version.version !== PLUGIN_VERSION || this.helper.probe.version.protocolVersion !== 1) throw new Error('native helper protocol mismatch')
    })
    await check('native-capacity-slot', '物理控制 slot 可预分配并双缓冲校验', () => this.proveCapacitySlot())
    await check(
      'native-nofollow',
      process.platform === 'win32'
        ? '原生 no-follow 拒绝 reparse point、hardlink 与 Windows ADS'
        : '原生 no-follow 拒绝 symlink 与 hardlink',
      () => this.proveNoFollow(),
    )
    await check('isolation-sandbox', `${sandboxEngineName()} 允许 Attempt workspace 与网络，且拒绝兄弟读取、共享 temp、秘密环境与孤儿进程`, () => this.proveSandbox())
    if (probes.modelSnapshot !== undefined) await check('model-snapshot', '模型与非敏感 Provider 配置可冻结并重新解析', probes.modelSnapshot)
    else {
      const error = modelPkError('MODEL_CONFIG_NOT_FOUND', 'compatibility:model-snapshot', '没有可用于冻结验证的受支持模型', 'model snapshot probe was not supplied')
      blockers.push(error)
      checks.push({ id: 'model-snapshot', status: 'BLOCKED', summary: error.userMessage })
    }
    if (probes.sessionFreshness !== undefined) {
      await check(
        'session-freshness',
        '全新 DSH session 无 replay seed，仅含固定控制事件并可销毁',
        probes.sessionFreshness,
      )
    }
    else {
      const error = modelPkError('SESSION_ISOLATION_UNSUPPORTED', 'compatibility:session', '尚未完成 DSH session 新鲜度证明', 'session probe was not supplied')
      blockers.push(error)
      checks.push({ id: 'session-freshness', status: 'BLOCKED', summary: error.userMessage })
    }
    const report: CapabilityReport = {
      pluginVersion: PLUGIN_VERSION,
      expectedDshVersion: DSH_VERSION,
      expectedDshCommit: DSH_COMMIT,
      hostPlatform: process.platform,
      hostArch: process.arch,
      dataRoot: this.layout.root,
      nativeHelper: {
        status: blockers.some(error => error.code === 'EXECUTION_ISOLATION_UNSUPPORTED' || error.code === 'NATIVE_HELPER_INVALID') ? 'BLOCKED' : 'READY',
        path: this.helper.probe.path || null,
        version: this.helper.probe.version.version || null,
        hash: this.helper.probe.path.length === 0 ? null : this.helper.probe.hash,
        reason: this.helper.probe.path.length === 0 ? 'native helper unavailable' : null,
      },
      executionEnabled: blockers.length === 0,
      blockers,
    }
    return { report, checks }
  }

  private async proveCapacitySlot(): Promise<void> {
    const root = join(this.layout.control, 'compatibility-capacity')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, 'slot.journal')
    await this.helper.reserve(path, LIMITS.controlSlotBytes)
    const first = Buffer.from(JSON.stringify({ generation: 1, outcome: 'FAILED' }))
    await this.helper.slotWrite(path, 1, first)
    const second = Buffer.from(JSON.stringify({ generation: 2, outcome: 'SUCCEEDED' }))
    await this.helper.slotWrite(path, 2, second)
    const read = await this.helper.slotRead(path)
    if (read.generation !== 2 || !Buffer.from(read.payloadBase64, 'base64').equals(second)) {
      throw new Error('capacity slot did not return latest valid generation')
    }
    await rm(root, { recursive: true, force: true })
  }

  private async proveNoFollow(): Promise<void> {
    const root = join(this.layout.control, 'compatibility-nofollow')
    await rm(root, { recursive: true, force: true })
    try {
      const tree = join(root, 'tree')
      const outsideFile = join(root, 'outside')
      await mkdir(tree, { recursive: true, mode: 0o700 })
      await writeFile(outsideFile, 'secret', { mode: 0o600 })
      if (process.platform === 'win32') {
        const outsideDirectory = join(root, 'outside-directory')
        await mkdir(outsideDirectory, { mode: 0o700 })
        await writeFile(join(outsideDirectory, 'secret'), 'secret', { mode: 0o600 })
        await symlink(outsideDirectory, join(tree, 'reparse'), 'junction')
      } else {
        await symlink(outsideFile, join(tree, 'reparse'))
      }
      let reparseRejected = false
      try { await this.helper.scan(tree, 1024, 10) } catch { reparseRejected = true }
      await unlink(join(tree, 'reparse'))
      await link(outsideFile, join(tree, 'hardlink'))
      let hardlinkRejected = false
      try { await this.helper.scan(tree, 1024, 10) } catch { hardlinkRejected = true }
      if (!reparseRejected || !hardlinkRejected) {
        throw new Error(`nofollow proof failed: reparse=${reparseRejected}; hardlink=${hardlinkRejected}`)
      }
      if (process.platform === 'win32') {
        await unlink(join(tree, 'hardlink'))
        const streamFile = join(tree, 'stream-file')
        await writeFile(streamFile, 'plain', { mode: 0o600 })
        let streamCreated = true
        try { await writeFile(`${streamFile}:model-pk-hidden`, 'hidden') } catch { streamCreated = false }
        if (streamCreated) {
          let streamRejected = false
          try { await this.helper.scan(tree, 1024, 10) } catch { streamRejected = true }
          if (!streamRejected) throw new Error('nofollow proof accepted a Windows alternate data stream')
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  private async proveSandbox(): Promise<void> {
    if (!(await this.sandbox.available())) throw new Error(`${sandboxEngineName()} unavailable`)
    const root = join(this.layout.control, 'compatibility-sandbox')
    await rm(root, { recursive: true, force: true })
    const attemptRoot = join(root, 'attempt')
    const paths = await createIsolationFixture(attemptRoot)
    const sibling = join(root, 'sibling-secret')
    const sharedTemp = join(tmpdir(), `model-pk-${process.pid}-${Date.now()}`)
    const secret = `secret-${Date.now()}`
    const probeTimeoutMs = sandboxProbeTimeoutMs(process.platform)
    await writeFile(sibling, secret, { mode: 0o600 })
    try {
      await this.sandbox.prepare(paths)
      const allowedTarget = join(paths.workspace, 'sandbox-write-proof')
      const allowedCommand = process.platform === 'win32'
        ? powershellTry(`[IO.File]::WriteAllText(${powershellQuote(allowedTarget)}, 'allowed')`)
        : `/bin/echo allowed > ${shellQuote(allowedTarget)}`
      const allowedAttempt = await this.sandbox.run(paths, allowedCommand, { timeoutMs: probeTimeoutMs })
      assertSandboxProbeCompleted('workspace-write', allowedAttempt, probeTimeoutMs)
      const allowedContent = await readFile(allowedTarget, 'utf8').catch(() => '')
      if (allowedAttempt.exitCode !== 0 || allowedContent.trim() !== 'allowed') {
        throw new Error('sandbox could not write its workspace')
      }
      const readCommand = process.platform === 'win32'
        ? powershellTry(`[Console]::Out.Write([IO.File]::ReadAllText(${powershellQuote(sibling)}))`)
        : `/bin/cat ${shellQuote(sibling)}`
      const readAttempt = await this.sandbox.run(paths, readCommand, { timeoutMs: probeTimeoutMs })
      assertSandboxProbeCompleted('sibling-read-denial', readAttempt, probeTimeoutMs)
      if (readAttempt.exitCode === 0 || readAttempt.stdout.includes(secret)) throw new Error('sandbox read sibling file')
      const tempCommand = process.platform === 'win32'
        ? powershellTry(`[IO.File]::WriteAllText(${powershellQuote(sharedTemp)}, 'leak')`)
        : `/usr/bin/touch ${shellQuote(sharedTemp)}`
      const tempAttempt = await this.sandbox.run(paths, tempCommand, { timeoutMs: probeTimeoutMs })
      assertSandboxProbeCompleted('shared-temp-denial', tempAttempt, probeTimeoutMs)
      if (tempAttempt.exitCode === 0) throw new Error('sandbox wrote shared temp')
      const envCommand = process.platform === 'win32'
        ? 'Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'
        : '/usr/bin/env'
      const previousSecret = process.env.MODEL_PK_COMPAT_SECRET
      process.env.MODEL_PK_COMPAT_SECRET = secret
      let envAttempt: Awaited<ReturnType<SandboxRunner['run']>>
      try {
        envAttempt = await this.sandbox.run(paths, envCommand, { timeoutMs: probeTimeoutMs })
      } finally {
        if (previousSecret === undefined) delete process.env.MODEL_PK_COMPAT_SECRET
        else process.env.MODEL_PK_COMPAT_SECRET = previousSecret
      }
      assertSandboxProbeCompleted('secret-environment-denial', envAttempt, probeTimeoutMs)
      if (envAttempt.stdout.includes('MODEL_PK_COMPAT_SECRET')) throw new Error('sandbox inherited secret environment')

      const server = createServer(socket => socket.end())
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise)
        server.listen(0, '127.0.0.1', () => resolvePromise())
      })
      try {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('network probe address unavailable')
        const networkCommand = process.platform === 'win32'
          ? powershellTry(`$client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', ${address.port}); $client.Dispose()`)
          : `/usr/bin/nc -z 127.0.0.1 ${address.port}`
        const networkAttempt = await this.sandbox.run(paths, networkCommand, { timeoutMs: probeTimeoutMs })
        assertSandboxProbeCompleted('loopback-network', networkAttempt, probeTimeoutMs)
        if (networkAttempt.exitCode !== 0) throw new Error('sandbox could not reach loopback network')
      } finally {
        await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
      }

      const orphanTarget = join(paths.workspace, 'orphan-leak')
      const orphanCommand = process.platform === 'win32'
        ? windowsOrphanCommand(orphanTarget)
        : `(/bin/sleep 1; /bin/echo leaked > ${shellQuote(orphanTarget)}) & exit 0`
      const orphanTimeoutMs = process.platform === 'win32' ? probeTimeoutMs : 4_000
      const orphanAttempt = await this.sandbox.run(paths, orphanCommand, { timeoutMs: orphanTimeoutMs })
      assertSandboxProbeCompleted('orphan-process', orphanAttempt, orphanTimeoutMs)
      if (process.platform === 'win32' && (orphanAttempt.exitCode !== 0
        || !orphanAttempt.stdout.includes('spawned:'))) {
        throw new Error('sandbox could not launch the orphan-process probe')
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
      const leaked = await readFile(orphanTarget, 'utf8').catch(() => '')
      if (leaked.length > 0) throw new Error('sandbox left an orphan process running')
    } finally {
      try {
        await this.sandbox.cleanup(paths)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(sharedTemp, { force: true })
      }
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function powershellTry(body: string): string {
  return `$ErrorActionPreference = 'Stop'; try { ${body}; exit 0 } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }`
}

function windowsOrphanCommand(target: string): string {
  const childScript = `Start-Sleep -Seconds 1; [IO.File]::WriteAllText(${powershellQuote(target)}, 'leaked')`
  const encoded = Buffer.from(childScript, 'utf16le').toString('base64')
  return `$ErrorActionPreference = 'Stop'; $shell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $child = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}') -PassThru; Write-Output "spawned:$($child.Id)"`
}

function sandboxEngineName(): string {
  return process.platform === 'win32' ? 'Windows AppContainer/Job Object' : 'macOS Seatbelt'
}
