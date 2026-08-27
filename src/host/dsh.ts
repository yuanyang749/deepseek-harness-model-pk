export interface DshResolvedModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ('text' | 'image')[]
  readonly context?: { readonly contextWindow: number }
  readonly defaultMaxTokens?: number
  readonly reasoning?: Readonly<Record<string, unknown>>
}

export interface DshModelListItem {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ('text' | 'image')[]
}

export interface DshConfigurableProvider {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

export interface DshSettingsDescriptor {
  readonly ns: string
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly revision: number
  readonly secrets?: readonly unknown[]
}

export interface DshToolExecution {
  readonly name: string
  readonly args?: unknown
}

export interface DshToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly timeoutMs?: number
  readonly execute: (args: unknown, context: { readonly signal: AbortSignal }) => Promise<unknown>
}

export interface DshAgentContext {
  readonly agent?: { readonly session: DshSession }
  readonly tools: {
    register(definition: DshToolDefinition): () => void
    restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
    guard(guard: (execution: DshToolExecution) => string | undefined): () => void
  }
  readonly systemPrompt: {
    section(section: { readonly name: string; readonly order: number; readonly text: string; readonly complete?: boolean }): () => void
    suppressRuntimeContext(): () => void
    assemble(context?: Readonly<Record<string, unknown>>): Promise<{
      readonly sections: readonly { readonly name: string; readonly text: string }[]
      readonly contexts: readonly { readonly name: string; readonly text: string }[]
      readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }[]
    }>
  }
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
    options?: { readonly prepend?: boolean; readonly global?: boolean },
  ): () => void
}

export interface DshSession {
  readonly id?: string
  readonly header?: Readonly<Record<string, unknown>>
  readonly firstLiveSeq: number
  readonly events: readonly unknown[]
  append(type: string, data: Readonly<Record<string, unknown>>): unknown
}

export interface DshAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly ctx: DshAgentContext
  readonly session: DshSession
  followup(message: DshUserMessage): void
  cancel(cause: { readonly kind: 'user' | 'parent' | 'disposed' } | { readonly kind: 'hook'; readonly reason: string }, options?: { readonly keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

export interface DshUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly DshContentBlock[]
  readonly source: Readonly<Record<string, unknown>>
}

export type DshContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }

export interface DshAgentHandle {
  readonly agent: DshAgent
  dispose(): Promise<void>
}

export interface DshHostContext {
  readonly connection: {
    readonly rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
        options: { readonly authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
  readonly llm: {
    listProviders(): readonly { readonly id: string; readonly name: string }[]
    listModels(provider: string): Promise<readonly DshModelListItem[]>
    resolveModelInfo(provider: string, model: string): Promise<DshResolvedModelInfo>
    providerRetryPolicy(provider: string): unknown
    listConfigurableProviders(): readonly DshConfigurableProvider[]
  }
  readonly settings?: {
    describe(options: { readonly redactSecrets: true }): readonly DshSettingsDescriptor[]
  }
  readonly attachments?: {
    readonly imageLimits?: {
      readonly maxImageBytes: number
      readonly maxImagesPerMessage: number
      readonly maxMessageImageBytes: number
      readonly maxImagePixels: number
      readonly maxImageDimension: number
      readonly mediaTypes: readonly string[]
    }
    saveImages?(inputs: readonly { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }[]): Promise<readonly unknown[]>
    readImage?(reference: unknown): Promise<{ readonly ref: unknown; readonly data: Uint8Array }>
  }
  readonly agents: {
    create(options: {
      readonly sessionId: string
      readonly meta: { readonly cwd: string; readonly agentPreset: string }
      readonly agentOptions: { readonly provider: string; readonly model: string; readonly maxTokens: number }
      readonly setup: (context: DshAgentContext) => void | Promise<void>
    }): Promise<DshAgentHandle>
    resume?(options: {
      readonly resumeSessionId: string
      readonly agentOptions: { readonly provider: string; readonly model: string; readonly maxTokens: number }
      readonly setup: (context: DshAgentContext) => void | Promise<void>
    }): Promise<DshAgentHandle>
    get?(sessionId: string): DshAgent | undefined
  }
  on(event: string, listener: (...args: unknown[]) => unknown): () => void
  effect?(effect: () => (() => void) | Promise<() => void>, label?: string): () => Promise<void>
}
