import { createServer } from 'node:net'
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_COMMIT, DSH_VERSION, LIMITS, PLUGIN_VERSION } from '../contracts/constants.js'
import type { CapabilityReport, ModelPkError } from '../contracts/types.js'
import { modelPkError, normalizeError } from '../core/error.js'
import type { NativeHelper } from '../native/helper.js'
import { createIsolationFixture, type SeatbeltRunner } from '../native/seatbelt.js'
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
    private readonly seatbelt: SeatbeltRunner,
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
    await check('native-nofollow', 'fd-relative no-follow 拒绝 symlink 与 hardlink', () => this.proveNoFollow())
    await check('isolation-seatbelt', 'Seatbelt 拒绝兄弟读取、共享 temp、网络与秘密环境', () => this.proveSeatbelt())
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
    await mkdir(join(root, 'tree'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'outside'), 'secret', { mode: 0o600 })
    await symlink(join(root, 'outside'), join(root, 'tree', 'symlink'))
    let symlinkRejected = false
    try { await this.helper.scan(join(root, 'tree'), 1024, 10) } catch { symlinkRejected = true }
    await rm(join(root, 'tree', 'symlink'))
    await link(join(root, 'outside'), join(root, 'tree', 'hardlink'))
    let hardlinkRejected = false
    try { await this.helper.scan(join(root, 'tree'), 1024, 10) } catch { hardlinkRejected = true }
    await rm(root, { recursive: true, force: true })
    if (!symlinkRejected || !hardlinkRejected) throw new Error(`nofollow proof failed: symlink=${symlinkRejected}; hardlink=${hardlinkRejected}`)
  }

  private async proveSeatbelt(): Promise<void> {
    if (!(await this.seatbelt.available())) throw new Error('sandbox-exec unavailable')
    const root = join(this.layout.control, 'compatibility-seatbelt')
    await rm(root, { recursive: true, force: true })
    const attemptRoot = join(root, 'attempt')
    const paths = await createIsolationFixture(attemptRoot)
    const sibling = join(root, 'sibling-secret')
    const sharedTemp = `/tmp/model-pk-${process.pid}-${Date.now()}`
    const secret = `secret-${Date.now()}`
    await writeFile(sibling, secret, { mode: 0o600 })
    const readAttempt = await this.seatbelt.run(paths, `/bin/cat ${shellQuote(sibling)}`, { timeoutMs: 5_000 })
    if (readAttempt.exitCode === 0 || readAttempt.stdout.includes(secret)) throw new Error('sandbox read sibling file')
    const tempAttempt = await this.seatbelt.run(paths, `/usr/bin/touch ${shellQuote(sharedTemp)}`, { timeoutMs: 5_000 })
    if (tempAttempt.exitCode === 0) throw new Error('sandbox wrote shared temp')
    const envAttempt = await this.seatbelt.run(paths, '/usr/bin/env', { timeoutMs: 5_000 })
    if (envAttempt.stdout.includes('MODEL_PK_COMPAT_SECRET')) throw new Error('sandbox inherited secret environment')
    const server = createServer(socket => socket.end())
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('network probe address unavailable')
      const networkAttempt = await this.seatbelt.run(paths, `/usr/bin/nc -z 127.0.0.1 ${address.port}`, { timeoutMs: 5_000 })
      if (networkAttempt.exitCode === 0) throw new Error('sandbox reached loopback network')
    } finally {
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
    }
    const orphanTarget = join(paths.workspace, 'orphan-leak')
    await this.seatbelt.run(paths, `(/bin/sleep 1; /bin/cat ${shellQuote(sibling)} > ${shellQuote(orphanTarget)}) & exit 0`, { timeoutMs: 4_000 })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
    const leaked = await readFile(orphanTarget, 'utf8').catch(() => '')
    await rm(root, { recursive: true, force: true })
    await rm(sharedTemp, { force: true })
    if (leaked.includes(secret)) throw new Error('orphan read sibling file')
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
