import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { DSH_VERSION, LIMITS } from '../contracts/constants.js'
import type { Hash, ModelConfigSnapshot, ModelListItem } from '../contracts/types.js'
import { fail } from '../core/error.js'
import { hashCanonical } from '../core/jcs.js'
import type {
  DshConfigurableProvider,
  DshHostContext,
  DshModelListItem,
  DshSettingsDescriptor,
} from './dsh.js'

const SUPPORTED_PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
const PI_AI_DEFAULT_MAX_TOKENS = 32_768
const PI_AI_BUILTIN_MODELS = builtinModels()

interface PiAiBuiltinModelFacts {
  readonly protocol: string
  readonly outputTokenCapacity: number
}

/**
 * Protocols whose exact rc.7 Adapter/serializer wire shape is covered by the
 * byte-preservation fixtures in tests/adapter-fixtures.spec.ts.
 */
export const BUILTIN_IMAGE_LOSSLESS_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const)

export interface AdapterEvidence {
  readonly piAiProtocolByModel?: Readonly<Record<string, string>>
  readonly imageLosslessProtocols?: readonly string[]
}

export class ModelCatalog {
  private readonly items = new Map<Hash, ModelListItem>()
  private readonly raw = new Map<Hash, DshModelListItem>()

  constructor(private readonly ctx: DshHostContext, private readonly evidence: AdapterEvidence = {}) {}

  async list(): Promise<readonly ModelListItem[]> {
    this.items.clear()
    this.raw.clear()
    const routes = new Map(this.ctx.llm.listConfigurableProviders().map(route => [route.provider, route]))
    const providers = this.ctx.llm.listProviders()
    const output: ModelListItem[] = []
    for (const provider of providers) {
      let models: readonly DshModelListItem[]
      try {
        models = await this.ctx.llm.listModels(provider.id)
      } catch {
        continue
      }
      const route = routes.get(provider.id)
      for (const model of models) {
        const modelConfigIdValue = modelConfigId(provider.id, model.id)
        const adapter = adapterInfo(route, provider.id)
        const protocol = this.resolveProtocol(route, model.id)
        const supported = adapter.kind === 'deepseek'
          || adapter.kind === 'pi-ai' && protocol !== undefined && SUPPORTED_PROTOCOLS.has(protocol)
        const modalities = adapter.kind === 'deepseek' ? ['text'] as const : normalizeModalities(model.inputModalities)
        const item: ModelListItem = {
          modelConfigId: modelConfigIdValue,
          providerRoute: provider.id,
          modelId: model.id,
          displayName: model.name,
          providerDisplayName: route?.displayName ?? provider.name,
          inputModalities: modalities,
          adapterKind: adapter.kind,
          ...(protocol === undefined ? {} : { protocol: protocol as NonNullable<ModelListItem['protocol']> }),
          support: supported ? 'SUPPORTED' : 'BLOCKED',
          ...(supported ? {} : { supportReason: adapter.kind === 'unknown' ? '未知 Adapter' : '无法证明实际 wire protocol' }),
        }
        output.push(item)
        this.items.set(modelConfigIdValue, item)
        this.raw.set(modelConfigIdValue, model)
      }
    }
    return output
  }

  async snapshot(modelConfigIdValue: Hash): Promise<ModelConfigSnapshot> {
    if (!this.items.has(modelConfigIdValue)) await this.list()
    const item = this.items.get(modelConfigIdValue)
    const raw = this.raw.get(modelConfigIdValue)
    if (item === undefined || raw === undefined) {
      fail('MODEL_CONFIG_NOT_FOUND', 'model-snapshot', '模型配置不存在', `modelConfigId=${modelConfigIdValue}`)
    }
    if (item.support !== 'SUPPORTED') {
      fail('ADAPTER_VERSION_DRIFT', 'model-snapshot', '模型 Adapter 不在 V1 支持矩阵中', item.supportReason ?? 'unsupported adapter')
    }
    const route = this.ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === item.providerRoute)
    if (route === undefined) fail('PROVIDER_NOT_CONFIGURED', 'model-snapshot', 'Provider 未配置', `route=${item.providerRoute}`)
    const resolved = await this.ctx.llm.resolveModelInfo(item.providerRoute, item.modelId)
      .catch((error: unknown) => fail('MODEL_UNAVAILABLE', 'model-snapshot', '模型当前不可解析', String(error)))
    const adapter = adapterInfo(route, item.providerRoute)
    const protocol = item.protocol ?? (adapter.kind === 'deepseek' ? 'deepseek-chat' : undefined)
    if (protocol === undefined) fail('ADAPTER_VERSION_DRIFT', 'model-snapshot', '模型协议无法确定', `route=${item.providerRoute}; model=${item.modelId}`)
    const settings = this.settingsSnapshot(route)
    const profile = this.settingsValue(route)
    const retry = toJsonRecord(this.ctx.llm.providerRetryPolicy(item.providerRoute))
    const outputTokenCapacity = resolveOutputTokenCapacity({
      adapterKind: adapter.kind,
      providerRoute: item.providerRoute,
      modelId: item.modelId,
      resolvedDefaultMaxTokens: resolved.defaultMaxTokens,
      profile,
    })
    if (outputTokenCapacity === null || outputTokenCapacity < LIMITS.outputTokens) {
      fail(
        'PARAMETER_UNSUPPORTED',
        'model-snapshot',
        '模型不支持公共 8192 token 输出上限',
        `outputTokenCapacity=${String(outputTokenCapacity)}`,
      )
    }
    const base = {
      schemaVersion: 'model-pk/model-config/v1' as const,
      modelConfigId: item.modelConfigId,
      providerRoute: item.providerRoute,
      providerProfileId: hashCanonical({
        schemaVersion: 'model-pk/provider-profile-id/v1',
        providerRoute: item.providerRoute,
        settingsNs: route.settingsNs,
        settingsPath: route.settingsPath,
      }),
      providerDisplayName: item.providerDisplayName,
      modelId: item.modelId,
      modelName: resolved.name,
      adapterPackage: adapter.packageName,
      adapterVersion: DSH_VERSION,
      protocol,
      revision: 'unresolved',
      inputModalities: adapter.kind === 'deepseek' ? ['text'] as const : normalizeModalities(resolved.inputModalities),
      contextWindow: resolved.context?.contextWindow ?? null,
      defaultMaxTokens: resolved.defaultMaxTokens ?? null,
      outputTokenCapacity,
      maxOutputTokens: LIMITS.outputTokens,
      reasoning: resolved.reasoning === undefined ? null : true,
      nonSensitiveSettings: settings,
      retryPolicy: retry,
      serializerDependencies: adapter.kind === 'pi-ai'
        ? { '@earendil-works/pi-ai': '0.82.1' }
        : { 'eventsource-parser': '3.1.1' },
    }
    return Object.freeze({ ...base, fingerprint: hashCanonical(base) })
  }

  async assertNoDrift(snapshot: ModelConfigSnapshot): Promise<void> {
    await this.list()
    const current = await this.snapshot(snapshot.modelConfigId)
    if (current.fingerprint !== snapshot.fingerprint) {
      fail('MODEL_CONFIG_DRIFT', 'model-drift', '模型配置已变化，请重新创建实验', `expected=${snapshot.fingerprint}; actual=${current.fingerprint}`)
    }
  }

  isImagePathVerified(snapshot: ModelConfigSnapshot): boolean {
    if (!snapshot.inputModalities.includes('image')) return false
    return (this.evidence.imageLosslessProtocols ?? BUILTIN_IMAGE_LOSSLESS_PROTOCOLS)
      .includes(snapshot.protocol)
  }

  private resolveProtocol(route: DshConfigurableProvider | undefined, modelId: string): string | undefined {
    if (route?.settingsNs === 'llm-deepseek') return 'deepseek-chat'
    if (route?.settingsNs !== 'llm-pi-ai') return undefined
    const explicit = this.settingsValue(route)?.api
    if (typeof explicit === 'string') return explicit
    return this.evidence.piAiProtocolByModel?.[`${route.provider}\0${modelId}`]
      ?? piAiBuiltinModelFacts(route.provider, modelId)?.protocol
  }

  private settingsValue(route: DshConfigurableProvider): Readonly<Record<string, unknown>> | undefined {
    const descriptor = this.ctx.settings?.describe({ redactSecrets: true }).find(candidate => candidate.ns === route.settingsNs)
    return asRecord(descriptor === undefined ? undefined : atPath(descriptor.value, route.settingsPath))
  }

  private settingsSnapshot(route: DshConfigurableProvider): Readonly<Record<string, unknown>> {
    const descriptor = this.ctx.settings?.describe({ redactSecrets: true }).find(candidate => candidate.ns === route.settingsNs)
    if (descriptor === undefined) return Object.freeze({ settingsUnavailable: true })
    const value = atPath(descriptor.value, route.settingsPath)
    return Object.freeze({
      revision: descriptor.revision,
      value: toJsonValue(value),
      settingsNs: route.settingsNs,
      settingsPath: [...route.settingsPath],
      secretPositions: descriptor.secrets?.length ?? 0,
    })
  }
}

export function piAiBuiltinModelFacts(providerRoute: string, modelId: string): PiAiBuiltinModelFacts | undefined {
  const model = PI_AI_BUILTIN_MODELS.getModel(providerRoute, modelId)
  if (model === undefined) return undefined
  return Object.freeze({ protocol: model.api, outputTokenCapacity: model.maxTokens })
}

export function modelConfigId(providerRoute: string, modelId: string): Hash {
  return hashCanonical({
    schemaVersion: 'model-pk/model-config-id/v1',
    providerRoute,
    modelId,
  })
}

function adapterInfo(route: DshConfigurableProvider | undefined, provider: string): {
  kind: 'deepseek' | 'pi-ai' | 'unknown'
  packageName: string
} {
  if (route?.settingsNs === 'llm-deepseek' && provider === 'deepseek-official') {
    return { kind: 'deepseek', packageName: '@deepseek-ai/dsh-llm-deepseek' }
  }
  if (route?.settingsNs === 'llm-pi-ai') return { kind: 'pi-ai', packageName: '@deepseek-ai/dsh-llm-pi-ai' }
  return { kind: 'unknown', packageName: 'unknown' }
}

function normalizeModalities(value: readonly ('text' | 'image')[] | undefined): readonly ('text' | 'image')[] {
  if (value === undefined || value.length === 0) return ['text']
  return [...new Set(value)].sort()
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function resolveOutputTokenCapacity(input: {
  readonly adapterKind: 'deepseek' | 'pi-ai' | 'unknown'
  readonly providerRoute: string
  readonly modelId: string
  readonly resolvedDefaultMaxTokens: number | undefined
  readonly profile: Readonly<Record<string, unknown>> | undefined
}): number | null {
  if (isPositiveInteger(input.resolvedDefaultMaxTokens)) return input.resolvedDefaultMaxTokens
  if (input.adapterKind === 'deepseek') return null
  if (input.adapterKind !== 'pi-ai') return null

  const builtin = piAiBuiltinModelFacts(input.providerRoute, input.modelId)
  if (builtin !== undefined) return builtin.outputTokenCapacity

  const configuredModel = findConfiguredModel(input.profile?.models, input.modelId)
  if (isPositiveInteger(configuredModel?.maxTokens)) return configuredModel.maxTokens
  const override = asRecord(asRecord(input.profile?.modelOverrides)?.[input.modelId])
  if (isPositiveInteger(override?.maxTokens)) return override.maxTokens
  if (isPositiveInteger(input.profile?.defaultMaxTokens)) return input.profile.defaultMaxTokens

  // dsh-llm-pi-ai@0.1.0-rc.7 materializes this exact capability for a
  // configured non-catalog model when neither the entry nor profile sets it.
  return PI_AI_DEFAULT_MAX_TOKENS
}

function findConfiguredModel(value: unknown, modelId: string): Readonly<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(asRecord).find(model => model?.id === modelId)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function toJsonValue(value: unknown): unknown {
  try {
    if (value === undefined) return null
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return { unobservable: true }
  }
}

function toJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  const converted = toJsonValue(value)
  return converted !== null && typeof converted === 'object' && !Array.isArray(converted)
    ? converted as Record<string, unknown>
    : { value: converted }
}

void (null as unknown as DshSettingsDescriptor)
