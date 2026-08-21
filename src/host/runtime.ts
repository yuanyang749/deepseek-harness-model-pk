import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { canonicalize } from '../core/jcs.js'
import { LIMITS } from '../contracts/constants.js'
import type { CapabilityReport } from '../contracts/types.js'
import { ArchiveManager, dataLayout, dataLayoutAtRoot } from './archive.js'
import { CompatibilityGate, type CompatibilityEvidence } from './compatibility.js'
import { Coordinator } from './coordinator.js'
import { DraftService } from './drafts.js'
import type { DshHostContext } from './dsh.js'
import { AttemptExecutor } from './executor.js'
import { ModelCatalog, type AdapterEvidence } from './model-catalog.js'
import { PreflightService } from './preflight.js'
import { createBusinessRpcHandler, createNativeRpcHandler } from './rpc-router.js'
import { Scheduler } from './scheduler.js'
import { NativeHelper, initializeCapacitySlots } from '../native/helper.js'
import { SandboxRunner } from '../native/sandbox.js'
import { ControlStore } from '../storage/store.js'

export interface Config {
  readonly dshHome?: string
  readonly dataRoot?: string
  readonly dshCommit?: string
  readonly nativeHelperPath?: string
  readonly allowDevNative?: boolean
  readonly controlSlotCount?: number
  readonly adapterEvidence?: AdapterEvidence
}

export class ModelPkRuntime {
  private cleanupTimer: NodeJS.Timeout | null = null

  private constructor(
    readonly store: ControlStore,
    readonly archive: ArchiveManager,
    readonly drafts: DraftService,
    readonly models: ModelCatalog,
    readonly preflight: PreflightService,
    readonly scheduler: Scheduler,
    readonly coordinator: Coordinator,
    readonly compatibility: CompatibilityEvidence,
    private readonly disposeBusinessRpc: () => Promise<void>,
    private readonly disposeNativeRpc: () => Promise<void>,
    private readonly disposeEventExport: () => void,
    private readonly auditQueue: { current: Promise<void> },
  ) {}

  static async create(ctx: DshHostContext, config: Config = {}): Promise<ModelPkRuntime> {
    const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    const layout = config.dataRoot === undefined
      ? dataLayout(dshHome)
      : dataLayoutAtRoot(resolve(config.dataRoot))
    const helper = await NativeHelper.locate({
      ...(config.nativeHelperPath === undefined ? {} : { explicitPath: config.nativeHelperPath }),
      allowDevBinary: config.allowDevNative ?? false,
    }).catch(() => NativeHelper.unavailable())
    const archive = new ArchiveManager(layout, helper)
    await archive.initialize()
    const store = new ControlStore(join(layout.control, 'control.sqlite'))
    let scheduler: Scheduler | null = null
    let coordinator: Coordinator | null = null
    let disposeEventExport: (() => void) | null = null
    let disposeBusinessRpc: (() => Promise<void>) | null = null
    let disposeNativeRpc: (() => Promise<void>) | null = null
    const auditQueue = { current: Promise.resolve() }
    try {
      if (helper.probe.path.length > 0) {
        const slots = await initializeCapacitySlots(
          helper,
          layout.capacity,
          boundedSlotCount(config.controlSlotCount),
          LIMITS.controlSlotBytes,
        )
        store.registerCapacitySlots(slots)
      }
      const sandbox = new SandboxRunner(helper)
      const models = new ModelCatalog(ctx, config.adapterEvidence ?? {})
      const executor = new AttemptExecutor(ctx, archive, helper, sandbox, models)
      const gate = new CompatibilityGate({
        dshVersion: installedDshVersion(),
        dshCommit: config.dshCommit ?? process.env.DSH_SOURCE_COMMIT ?? null,
      }, layout, helper, sandbox)
      const modelItems = await models.list().catch(() => [])
      const probeModel = modelItems.find(item => item.support === 'SUPPORTED')
      const compatibility = await gate.run(probeModel === undefined ? {} : {
        modelSnapshot: async () => { await models.snapshot(probeModel.modelConfigId) },
        sessionFreshness: async () => {
          const root = join(layout.control, `session-probe-${crypto.randomUUID()}`)
          await executor.probeSession(probeModel.providerRoute, probeModel.modelId, root)
        },
      })
      await writeCompatibilityReport(layout.control, compatibility.report, compatibility.checks)
      const drafts = new DraftService(store, archive, helper)
      const preflight = new PreflightService(ctx, store, archive, helper, sandbox, models, () => compatibility)
      scheduler = new Scheduler(store, archive, helper, executor)
      coordinator = new Coordinator(store, archive, preflight, models, scheduler)
      disposeEventExport = store.onEvent(event => {
        const experiment = store.getExperiment(event.experimentId)
        if (experiment === null) return
        auditQueue.current = auditQueue.current
          .catch(() => undefined)
          .then(() => archive.appendAuditExport(experiment, event))
      })
      await coordinator.recoverStartingExperiments()
      await coordinator.recoverPendingDeletes()
      // Rebuild the portable audit stream before dispatch begins. This covers
      // events committed before a previous Host process crashed, while the
      // listener above continues to append every newly committed event.
      await auditQueue.current
      for (const experiment of store.experimentsInState(['STARTING', 'ACTIVE', 'START_FAILED', 'SETTLED'])) {
        await archive.writeAuditExport(
          experiment,
          store.allEventsThrough(experiment.experimentId, experiment.latestCursor),
        )
      }
      await scheduler.start()
      const services = { compatibility: () => compatibility, drafts, preflight, models, coordinator }
      disposeBusinessRpc = ctx.connection.rpc.handle('/model-pk', createBusinessRpcHandler(services), { authority: 'loopback' })
      disposeNativeRpc = ctx.connection.rpc.handle('/model-pk-native', createNativeRpcHandler(services), { authority: 'loopback' })
      const runtime = new ModelPkRuntime(
        store,
        archive,
        drafts,
        models,
        preflight,
        scheduler,
        coordinator,
        compatibility,
        disposeBusinessRpc,
        disposeNativeRpc,
        disposeEventExport,
        auditQueue,
      )
      runtime.cleanupTimer = setInterval(() => { void drafts.cleanupExpired() }, 60 * 60 * 1000)
      runtime.cleanupTimer.unref()
      return runtime
    } catch (error) {
      await Promise.allSettled([
        disposeBusinessRpc?.(),
        disposeNativeRpc?.(),
      ].filter((value): value is Promise<void> => value !== undefined))
      disposeEventExport?.()
      coordinator?.dispose()
      await scheduler?.stop().catch(() => undefined)
      await auditQueue.current.catch(() => undefined)
      store.close()
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer !== null) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    await Promise.allSettled([this.disposeBusinessRpc(), this.disposeNativeRpc()])
    this.disposeEventExport()
    this.coordinator.dispose()
    await this.scheduler.stop()
    await this.auditQueue.current.catch(() => undefined)
    this.store.close()
  }
}

function boundedSlotCount(value: number | undefined): number {
  const count = value ?? 16
  if (!Number.isSafeInteger(count) || count < LIMITS.modelMax || count > 128) {
    throw new Error(`controlSlotCount must be an integer between ${LIMITS.modelMax} and 128`)
  }
  return count
}

function installedDshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

async function writeCompatibilityReport(
  controlRoot: string,
  report: CapabilityReport,
  checks: CompatibilityEvidence['checks'],
): Promise<void> {
  await mkdir(controlRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(controlRoot, 'compatibility-report.json'), `${canonicalize({ report, checks })}\n`, { mode: 0o600 })
  const lines = [
    '# Model PK Compatibility Report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- DSH contract: ${report.expectedDshVersion} / ${report.expectedDshCommit}`,
    `- Host: ${report.hostPlatform}/${report.hostArch}`,
    `- Execution: ${report.executionEnabled ? 'READY' : 'BLOCKED'}`,
    '',
    '## Checks',
    '',
    ...checks.map(check => `- **${check.status}** \`${check.id}\`: ${check.summary}`),
    '',
  ]
  await writeFile(join(controlRoot, 'compatibility-report.md'), lines.join('\n'), { mode: 0o600 })
}
