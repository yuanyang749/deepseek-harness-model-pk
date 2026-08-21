import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Attempt,
  ExperimentProjection,
  Hash,
  ModelPkError,
  Run,
} from '../contracts/types.js'
import { HARNESS_PRESET, LIMITS } from '../contracts/constants.js'
import { ModelPkException, modelPkError } from '../core/error.js'
import { canonicalize, hashCanonical, sha256Bytes } from '../core/jcs.js'
import type { NativeHelper, NativeTreeManifest } from '../native/helper.js'
import type { SandboxRunner } from '../native/sandbox.js'
import type { ArchiveManager, AttemptRuntimePaths } from './archive.js'
import type {
  DshAgentContext,
  DshAgentHandle,
  DshContentBlock,
  DshHostContext,
  DshToolDefinition,
  DshUserMessage,
} from './dsh.js'
import { MODEL_PK_SYSTEM_PROMPT, TOOL_CONTRACTS } from './harness.js'
import type { ModelCatalog } from './model-catalog.js'

export interface PreparedExecution {
  readonly attemptId: string
  readonly sessionId: string
  readonly runtime: AttemptRuntimePaths
  readonly effectiveInputHash: Hash
  dispatch(signal: AbortSignal, observer: ExecutionObserver): Promise<ExecutionResult>
  cancel(): void
  dispose(): Promise<void>
}

export interface ExecutionObserver {
  onDispatchAck(): Promise<void>
  onEvent(event: Readonly<Record<string, unknown>>): void
  onOutput(delta: string): void
  onProgress(): void
}

export interface ExecutionResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  readonly finalResponse: string | null
  readonly error: ModelPkError | null
  readonly providerRequestId: string | null
  readonly executionTerminationConfirmed: boolean
}

interface HarnessBoundary {
  readonly provider: string
  readonly model: string
  readonly initialMessage: DshUserMessage | null
}

export class AttemptExecutor {
  constructor(
    private readonly ctx: DshHostContext,
    private readonly archive: ArchiveManager,
    private readonly helper: NativeHelper,
    private readonly sandbox: SandboxRunner,
    private readonly models: ModelCatalog,
  ) {}

  async prepare(experiment: ExperimentProjection, run: Run, attempt: Attempt): Promise<PreparedExecution> {
    await this.models.assertNoDrift(run.modelConfig)
    if (experiment.resolvedHarnessFingerprint !== attempt.resolvedHarnessFingerprint) {
      throw new ModelPkException(modelPkError('HARNESS_PROFILE_DRIFT', 'prepare', 'Harness 指纹不一致', `experiment=${experiment.resolvedHarnessFingerprint}; attempt=${attempt.resolvedHarnessFingerprint}`))
    }
    const runtime = await this.archive.createAttemptRuntime(experiment, run, attempt)
    const attachmentRefs = await this.prepareAttachments(experiment)
    const semanticInput = {
      schemaVersion: 'model-pk/effective-input/v1',
      systemPrompt: MODEL_PK_SYSTEM_PROMPT,
      prompt: experiment.taskPackage.prompt,
      attachments: experiment.taskPackage.attachments.map((attachment, ordinal) => ({
        ordinal,
        mediaType: attachment.mimeType,
        byteLength: attachment.byteLength,
        hash: attachment.hash,
      })),
      logicalWorkspace: '/workspace',
      tools: experiment.resolvedHarness.tools,
      providerRoute: run.modelConfig.providerRoute,
      modelId: run.modelConfig.modelId,
      protocol: run.modelConfig.protocol,
    }
    const effectiveInputHash = hashCanonical(semanticInput)
    const message: DshUserMessage = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([
        { type: 'text' as const, text: experiment.taskPackage.prompt },
        ...attachmentRefs.map(reference => ({ type: 'image' as const, attachment: reference })),
      ]),
      source: Object.freeze({ kind: 'plugin', plugin: 'dsh-model-pk' }),
    })
    const evidence = new EvidenceWriter(this.archive, runtime)
    let handle: DshAgentHandle | null = null
    let lastAssistantText = ''
    let executionError: ModelPkError | null = null
    let cancelled = false
    const sessionId = attempt.attemptId
    let activeObserver: ExecutionObserver | null = null
    const offSession = this.ctx.on('session/event', (session: unknown, event: unknown) => {
      if (!isMatchingSession(session, sessionId) || !isRecord(event)) return
      const safeEvent = jsonRecord(event)
      evidence.appendTranscript(safeEvent)
      activeObserver?.onEvent(safeEvent)
      activeObserver?.onProgress()
      if (event.type === 'assistant/chunk' && isRecord(event.data) && isRecord(event.data.chunk)
        && event.data.chunk.type === 'text-delta' && typeof event.data.chunk.text === 'string') {
        activeObserver?.onOutput(event.data.chunk.text)
      }
      if (event.type === 'assistant/message' && isRecord(event.data) && isRecord(event.data.message)
        && Array.isArray(event.data.message.content)) {
        lastAssistantText = event.data.message.content
          .filter(isRecord)
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join('')
      }
    })
    const sandboxPaths = {
      attemptRoot: runtime.attemptRoot,
      workspace: runtime.workspace,
      home: runtime.home,
      temp: runtime.temp,
    }
    try {
      await this.sandbox.prepare(sandboxPaths)
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: runtime.workspace, agentPreset: HARNESS_PRESET },
        agentOptions: {
          provider: run.modelConfig.providerRoute,
          model: run.modelConfig.modelId,
          maxTokens: LIMITS.outputTokens,
        },
        setup: async agentContext => {
          await this.installHarness(agentContext, runtime, attempt, {
            provider: run.modelConfig.providerRoute,
            model: run.modelConfig.modelId,
            initialMessage: message,
          })
        },
      })
      assertFreshSession(handle.agent.session)
      const currentHandle = handle
      let disposed = false
      const prepared: PreparedExecution = {
        attemptId: attempt.attemptId,
        sessionId,
        runtime,
        effectiveInputHash,
        dispatch: async (signal, observer) => {
          activeObserver = observer
          const abort = (): void => {
            cancelled = true
            currentHandle.agent.cancel({ kind: 'user' })
          }
          signal.addEventListener('abort', abort, { once: true })
          const offError = currentHandle.agent.ctx.on('agent/error', (payload: unknown) => {
            if (!isRecord(payload)) return
            executionError = normalizeExecutionError(payload.error)
          })
          try {
            currentHandle.agent.followup(message)
            await observer.onDispatchAck()
            await currentHandle.agent.whenIdle()
            await evidence.flush()
            if (cancelled || signal.aborted) {
              return {
                outcome: 'CANCELLED',
                finalResponse: lastAssistantText || null,
                error: null,
                providerRequestId: null,
                executionTerminationConfirmed: true,
              }
            }
            if (executionError !== null) {
              return {
                outcome: 'FAILED',
                finalResponse: lastAssistantText || null,
                error: executionError,
                providerRequestId: executionError.providerRequestId ?? null,
                executionTerminationConfirmed: true,
              }
            }
            if (lastAssistantText.length === 0) {
              return {
                outcome: 'FAILED',
                finalResponse: null,
                error: modelPkError('EMPTY_RESPONSE', 'execute', '模型没有返回可展示文本', 'session reached idle without assistant text'),
                providerRequestId: null,
                executionTerminationConfirmed: true,
              }
            }
            return {
              outcome: 'SUCCEEDED',
              finalResponse: lastAssistantText,
              error: null,
              providerRequestId: null,
              executionTerminationConfirmed: true,
            }
          } catch (error) {
            const normalized = normalizeExecutionError(error)
            return {
              outcome: signal.aborted ? 'CANCELLED' : 'FAILED',
              finalResponse: lastAssistantText || null,
              error: signal.aborted ? null : normalized,
              providerRequestId: normalized.providerRequestId ?? null,
              executionTerminationConfirmed: true,
            }
          } finally {
            signal.removeEventListener('abort', abort)
            offError()
            activeObserver = null
          }
        },
        cancel: () => {
          cancelled = true
          currentHandle.agent.cancel({ kind: 'user' })
        },
        dispose: async () => {
          if (disposed) return
          disposed = true
          offSession()
          await evidence.flush()
          try {
            await currentHandle.dispose()
          } finally {
            await this.sandbox.cleanup(sandboxPaths)
          }
        },
      }
      return prepared
    } catch (error) {
      offSession()
      await evidence.flush()
      if (handle !== null) await handle.dispose().catch(() => undefined)
      await this.sandbox.cleanup(sandboxPaths).catch(() => undefined)
      throw error
    }
  }

  async probeSession(provider: string, model: string, root: string): Promise<void> {
    const attempt: Attempt = probeAttempt()
    const runtime: AttemptRuntimePaths = {
      attemptRoot: root,
      workspace: join(root, 'workspace'),
      home: join(root, 'home'),
      temp: join(root, 'tmp'),
      artifacts: join(root, 'artifacts'),
      leasePath: join(root, 'lease', 'fencing-token'),
      transcriptPath: join(root, 'evidence', 'transcript.jsonl'),
      logPath: join(root, 'evidence', 'logs.jsonl'),
      eventPath: join(root, 'evidence', 'events.jsonl'),
    }
    for (const path of [runtime.workspace, runtime.home, runtime.temp, runtime.artifacts]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
    await mkdir(join(root, 'lease'), { recursive: true, mode: 0o700 })
    await writeFile(runtime.leasePath, `${attempt.fencingToken}\n`, { mode: 0o600 })
    const sessionId = randomUUID()
    const sandboxPaths = {
      attemptRoot: runtime.attemptRoot,
      workspace: runtime.workspace,
      home: runtime.home,
      temp: runtime.temp,
    }
    let handle: DshAgentHandle | null = null
    try {
      await this.sandbox.prepare(sandboxPaths)
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: runtime.workspace, agentPreset: HARNESS_PRESET },
        agentOptions: { provider, model, maxTokens: LIMITS.outputTokens },
        setup: context => this.installHarness(context, runtime, attempt, { provider, model, initialMessage: null }),
      })
      if (handle.agent.id !== sessionId) throw new Error('agent/session id mismatch')
      assertFreshSession(handle.agent.session)
      if (handle.agent.status !== 'idle') throw new Error('new session is not idle')
    } finally {
      await handle?.dispose().catch(() => undefined)
      await this.sandbox.cleanup(sandboxPaths).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }

  async cleanupRuntime(runtime: AttemptRuntimePaths): Promise<void> {
    await this.sandbox.cleanup({
      attemptRoot: runtime.attemptRoot,
      workspace: runtime.workspace,
      home: runtime.home,
      temp: runtime.temp,
    })
  }

  private async prepareAttachments(experiment: ExperimentProjection): Promise<readonly unknown[]> {
    if (experiment.taskPackage.attachments.length === 0) return []
    const store = this.ctx.attachments
    if (store?.saveImages === undefined || store.readImage === undefined) {
      throw new ModelPkException(modelPkError('ATTACHMENT_TRANSFORM_UNVERIFIED', 'prepare', 'DSH 附件服务缺少无损读回能力', 'saveImages/readImage unavailable'))
    }
    const sources = await Promise.all(experiment.taskPackage.attachments.map(async attachment => {
      const data = await readFile(this.archive.experimentAttachmentPath(experiment, attachment.ordinal, attachment.name))
      if (sha256Bytes(data) !== attachment.hash) {
        throw new ModelPkException(modelPkError('ATTACHMENT_HASH_MISMATCH', 'prepare', '图片哈希不匹配', `attachment=${attachment.attachmentId}`))
      }
      return { data, mediaType: attachment.mimeType, name: attachment.name, expectedHash: attachment.hash }
    }))
    const refs = await store.saveImages(sources.map(({ data, mediaType, name }) => ({ data, mediaType, name })))
    if (refs.length !== sources.length) throw new Error('attachment store changed batch cardinality')
    for (const [index, reference] of refs.entries()) {
      const stored = await store.readImage(reference)
      if (sha256Bytes(stored.data) !== sources[index]!.expectedHash) {
        throw new ModelPkException(modelPkError('ATTACHMENT_CONTENT_TRANSFORMED', 'prepare', '图片在 Adapter 路径中发生变化', `attachment ordinal=${index}`))
      }
    }
    return refs
  }

  private async installHarness(
    context: DshAgentContext,
    runtime: AttemptRuntimePaths,
    attempt: Attempt,
    boundary: HarnessBoundary,
  ): Promise<void> {
    pinSessionControls(context)
    context.tools.restrict({ allow: [] })
    context.systemPrompt.suppressRuntimeContext()
    context.systemPrompt.section({ name: 'model-pk:complete', order: 0, text: MODEL_PK_SYSTEM_PROMPT, complete: true })
    const tools = this.toolDefinitions(runtime, attempt)
    for (const tool of tools) context.tools.register(tool)
    const allowed = new Set<string>(tools.map(tool => tool.name))
    context.tools.guard(execution => allowed.has(execution.name) ? undefined : `Model PK denies tool ${execution.name}`)
    context.on('agent/pre-step', async (payload: unknown, next: unknown) => {
      if (!isRecord(payload) || typeof payload.step !== 'number' || typeof payload.turn !== 'number'
        || typeof next !== 'function') return { kind: 'reject' }
      if (payload.step > LIMITS.maxSteps || payload.turn !== 1) return { kind: 'reject' }
      const decision = await (next as () => Promise<unknown>)()
      assertStepBoundary(decision, payload.step, boundary.initialMessage)
      return decision
    }, { prepend: true })
    context.on('agent/request', async (_payload: unknown, next: unknown) => {
      if (typeof next !== 'function') throw harnessDrift('agent/request waterfall did not provide next()')
      const config = await (next as () => Promise<unknown>)()
      if (!isRecord(config)
        || config.provider !== boundary.provider
        || config.model !== boundary.model
        || config.maxTokens !== LIMITS.outputTokens
        || config.temperature !== undefined
        || config.stop !== undefined) {
        throw harnessDrift(`request config changed: ${canonicalize(config)}`)
      }
      return config
    }, { prepend: true })
    // Short-circuit DSH's provider retry waterfall for this Agent. Model PK
    // records one provider request outcome and leaves retry to a new Attempt.
    context.on('agent/request-error', async () => undefined, { prepend: true })
    const assembly = await context.systemPrompt.assemble({ ...(context.agent === undefined ? {} : { scope: context.agent }) })
    const resolved = {
      sections: assembly.sections,
      contexts: assembly.contexts,
      tools: assembly.tools,
    }
    const expected = {
      sections: [{ name: 'model-pk:complete', text: MODEL_PK_SYSTEM_PROMPT }],
      contexts: [],
      tools: [...TOOL_CONTRACTS]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    }
    if (canonicalize(resolved) !== canonicalize(expected)) {
      throw new ModelPkException(modelPkError('HARNESS_PROFILE_DRIFT', 'harness-assembly', 'DSH 实际 Harness 与冻结配置不一致', `expected=${hashCanonical(expected)}; actual=${hashCanonical(resolved)}`))
    }
  }

  private toolDefinitions(runtime: AttemptRuntimePaths, attempt: Attempt): DshToolDefinition[] {
    const contract = new Map(TOOL_CONTRACTS.map(tool => [tool.name, tool]))
    const definition = (name: typeof TOOL_CONTRACTS[number]['name'], execute: DshToolDefinition['execute']): DshToolDefinition => {
      const item = contract.get(name)
      if (item === undefined) throw new Error(`missing tool contract ${name}`)
      return {
        name,
        description: item.description,
        parameters: item.parameters,
        output: {
          schema: item.output,
          render: (_args, value) => [{ type: 'text', text: canonicalize(value) }],
        },
        timeoutMs: name === 'bash' ? LIMITS.executionTimeoutMs : 60_000,
        execute,
      }
    }
    return [
      definition('bash', async (raw, execution) => {
        const args = argsRecord(raw)
        const command = stringArg(args, 'command')
        const result = await this.sandbox.run({
          attemptRoot: runtime.attemptRoot,
          workspace: runtime.workspace,
          home: runtime.home,
          temp: runtime.temp,
        }, command, { signal: execution.signal, timeoutMs: LIMITS.executionTimeoutMs })
        return { ...result, exitCode: result.exitCode ?? -1 }
      }),
      definition('read', async (raw) => {
        const args = argsRecord(raw)
        const result = await this.helper.read(runtime.workspace, stringArg(args, 'path'), 10 * 1024 * 1024)
        const bytes = Buffer.from(result.bytesBase64, 'base64')
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('file is not valid UTF-8') }
        return { content, byteLength: result.byteLength, hash: result.hash }
      }),
      definition('write', async (raw) => {
        const args = argsRecord(raw)
        return this.helper.write({
          root: runtime.workspace,
          path: stringArg(args, 'path'),
          bytesBase64: Buffer.from(stringArg(args, 'content'), 'utf8').toString('base64'),
          executable: booleanArg(args, 'executable', false),
          leasePath: runtime.leasePath,
          fencingToken: attempt.fencingToken,
        })
      }),
      definition('edit', async (raw) => {
        const args = argsRecord(raw)
        return this.helper.replace({
          root: runtime.workspace,
          path: stringArg(args, 'path'),
          old: stringArg(args, 'old'),
          replacement: stringArg(args, 'replacement'),
          all: booleanArg(args, 'all', false),
          leasePath: runtime.leasePath,
          fencingToken: attempt.fencingToken,
        })
      }),
      definition('glob', async (raw) => {
        const args = argsRecord(raw)
        const pattern = stringArg(args, 'pattern')
        const manifest = await this.helper.scan(runtime.workspace, LIMITS.baselineBytes, LIMITS.baselineFiles)
        const match = globMatcher(pattern)
        return { paths: manifest.entries.map(entry => entry.path).filter(path => path !== '.' && match(path)).slice(0, 10_000) }
      }),
      definition('grep', async (raw) => {
        const args = argsRecord(raw)
        const pattern = stringArg(args, 'pattern')
        const fileGlob = optionalStringArg(args, 'glob') ?? '**/*'
        const regex = booleanArg(args, 'regex', false)
        const expression = regex ? new RegExp(pattern, 'gu') : null
        const manifest = await this.helper.scan(runtime.workspace, LIMITS.baselineBytes, LIMITS.baselineFiles)
        return grepManifest(this.helper, runtime.workspace, manifest, fileGlob, pattern, expression)
      }),
    ]
  }
}

class EvidenceWriter {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly archive: ArchiveManager, private readonly runtime: AttemptRuntimePaths) {}

  appendTranscript(value: unknown): void {
    this.tail = this.tail.then(() => this.archive.appendTranscript(this.runtime, value))
  }

  async flush(): Promise<void> {
    await this.tail
  }
}

async function grepManifest(
  helper: NativeHelper,
  workspace: string,
  manifest: NativeTreeManifest,
  fileGlob: string,
  literal: string,
  expression: RegExp | null,
): Promise<{ matches: readonly { path: string; line: number; text: string }[]; truncated: boolean }> {
  const matchPath = globMatcher(fileGlob)
  const matches: { path: string; line: number; text: string }[] = []
  let truncated = false
  for (const entry of manifest.entries) {
    if (entry.kind !== 'FILE' || entry.byteLength > 10 * 1024 * 1024 || !matchPath(entry.path)) continue
    let text: string
    try {
      const result = await helper.read(workspace, entry.path, 10 * 1024 * 1024)
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.bytesBase64, 'base64'))
    } catch { continue }
    const lines = text.split(/\r?\n/u)
    for (const [index, line] of lines.entries()) {
      if (expression !== null) expression.lastIndex = 0
      if (expression?.test(line) || expression === null && line.includes(literal)) {
        matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 2000) })
        if (matches.length >= 1000) { truncated = true; break }
      }
    }
    if (truncated) break
  }
  return { matches, truncated }
}

function globMatcher(pattern: string): (path: string) => boolean {
  if (pattern.startsWith('/') || pattern.split('/').includes('..') || pattern.includes('\0')) throw new Error('glob pattern must be workspace-relative')
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?' } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
  }
  const expression = new RegExp(`${source}$`, 'u')
  return path => expression.test(path)
}

function normalizeExecutionError(error: unknown): ModelPkError {
  if (error instanceof ModelPkException) return error.detail
  const record = isRecord(error) ? error : null
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (/rate.?limit|429/iu.test(`${code} ${message}`)) return modelPkError('PROVIDER_RATE_LIMITED', 'execute', 'Provider 限流', message, { retryable: true })
  if (/auth|credential|401|403/iu.test(`${code} ${message}`)) return modelPkError('PROVIDER_AUTH_FAILED', 'execute', 'Provider 鉴权失败', message)
  if (/5\d\d|unavailable/iu.test(`${code} ${message}`)) return modelPkError('PROVIDER_5XX', 'execute', 'Provider 服务异常', message, { retryable: true })
  if (/content.?policy/iu.test(`${code} ${message}`)) return modelPkError('CONTENT_POLICY_REJECTED', 'execute', 'Provider 拒绝了请求内容', message)
  return modelPkError('PROVIDER_ERROR', 'execute', '模型执行失败', message, { retryable: true })
}

function isMatchingSession(value: unknown, sessionId: string): boolean {
  if (!isRecord(value)) return false
  if (value.id === sessionId) return true
  return isRecord(value.header) && value.header.id === sessionId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function summarizeSessionEvents(events: readonly unknown[]): string {
  return events.map((event, index) => {
    if (!isRecord(event)) return `${index}:unknown`
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    const source = isRecord(event.data) && isRecord(event.data.source) && typeof event.data.source.kind === 'string'
      ? `:${event.data.source.kind}`
      : ''
    return `${index}:${type}${source}`
  }).join(',')
}

function pinSessionControls(context: DshAgentContext): void {
  const session = context.agent?.session
  if (session === undefined) throw harnessDrift('unpublished Agent context has no session')
  if (session.firstLiveSeq !== 0 || session.events.length !== 0) {
    throw harnessDrift(`session was not fresh before setup: firstLiveSeq=${session.firstLiveSeq}; events=${summarizeSessionEvents(session.events)}`)
  }
  session.append('sandbox/mode', { mode: 'read-only' })
  session.append('approval/policy', { policy: 'never' })
}

function assertFreshSession(session: { readonly firstLiveSeq: number; readonly events: readonly unknown[] }): void {
  if (session.firstLiveSeq !== 0) {
    throw new Error(`new session contains a replay seed: firstLiveSeq=${session.firstLiveSeq}`)
  }
  const expected = [
    { type: 'sandbox/mode', data: { mode: 'read-only' } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ]
  const actual = session.events.map((event) => {
    if (!isRecord(event)) return event
    return { type: event.type, data: event.data }
  })
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new Error(`new session bootstrap drift: ${summarizeSessionEvents(session.events)}`)
  }
}

function assertStepBoundary(decision: unknown, step: number, initialMessage: DshUserMessage | null): void {
  if (!isRecord(decision) || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
    if (isRecord(decision) && decision.kind === 'reject') return
    throw harnessDrift('agent/pre-step returned an invalid decision')
  }
  if (step === 1) {
    if (initialMessage === null) throw harnessDrift('session probe unexpectedly entered a model step')
    if (decision.messages.length !== 1 || canonicalize(decision.messages[0]) !== canonicalize(initialMessage)) {
      throw harnessDrift(`first-step input changed: ${summarizeMessages(decision.messages)}`)
    }
    return
  }
  if (!decision.messages.every(message => isRecord(message)
    && isRecord(message.source)
    && message.source.kind === 'tool')) {
    throw harnessDrift(`non-tool context entered a continuation step: ${summarizeMessages(decision.messages)}`)
  }
}

function summarizeMessages(messages: readonly unknown[]): string {
  return messages.map((message, index) => {
    if (!isRecord(message)) return `${index}:unknown`
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const source = isRecord(message.source) && typeof message.source.kind === 'string' ? message.source.kind : 'unknown'
    return `${index}:${role}:${source}`
  }).join(',')
}

function harnessDrift(technicalMessage: string): ModelPkException {
  return new ModelPkException(modelPkError(
    'HARNESS_PROFILE_DRIFT',
    'harness-boundary',
    'DSH 实际 Harness 与冻结配置不一致',
    technicalMessage,
  ))
}

function jsonRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('tool arguments must be an object')
  return value
}

function stringArg(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function optionalStringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function booleanArg(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function probeAttempt(): Attempt {
  const now = new Date().toISOString()
  const hash = hashCanonical({ probe: true })
  return {
    attemptId: randomUUID(), runId: randomUUID(), attemptNo: 1, trigger: 'INITIAL', batchActionId: null,
    state: 'PREPARING', lifecycleVersion: 1, observedExecutionOutcome: null, pendingOutcome: null,
    finalizationId: null, finalizationStage: null, finalizationDeadlineAt: null,
    taskPackageHash: hash, resolvedHarnessFingerprint: hash, executionConditionsHash: hash,
    modelConfigFingerprint: hash, inputFingerprint: hash, effectiveInputHash: null, dispatchIntentId: null,
    idempotencyKey: String(hash), dshSessionId: null, providerRequestId: null, queueSeq: 0, queuedAt: now,
    preparingAt: now, preparingDeadlineAt: now, dispatchIntentAt: null, dispatchAckAt: null, startedAt: null,
    executionDeadlineAt: null, executionEndedAt: null, finalizationStartedAt: null, finalizedAt: null,
    firstOutputAt: null, lastProgressAt: null, workerHeartbeatAt: null, recoveryDeadlineAt: null,
    executionLeaseId: randomUUID(), fencingToken: randomUUID(), executionTerminationConfirmed: false,
    executionReservationState: 'HELD', reservationAcquiredAt: now, reservationReleaseDeadline: now,
    orphanedExecution: false, orphanedAt: null, workspaceSealState: 'OPEN', workspacePath: null,
    artifactPath: null, resultPath: null, resultExportError: null,
    workspaceSummary: null, tokenUsage: null,
    finalResponse: null, outputPreview: '', archiveCompleteness: 'INCOMPLETE',
    error: null, archiveError: null, cancelReason: null, healthFlags: [],
  }
}

void (null as unknown as DshContentBlock)
