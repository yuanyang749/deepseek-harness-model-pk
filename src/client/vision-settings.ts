export interface SettingsNamespaceView {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
}

export interface SettingsDescribeValue {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly SettingsNamespaceView[]
}

export interface ImageInputTarget {
  readonly providerRoute: string
  readonly modelId: string
}

export interface SettingsMutationRequest {
  readonly ns: 'llm-pi-ai'
  readonly ops: readonly {
    readonly op: 'set'
    readonly path: readonly string[]
    readonly value: unknown
  }[]
  readonly expectedRevision: number
}

const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'

export class VisionSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisionSettingsError'
  }
}

/**
 * Build the smallest safe settings write for explicit per-model image support.
 * Arrays cannot be addressed one entry at a time by settings.mutate, so each
 * affected provider's user-owned model list is replaced as one CAS-protected
 * field while every entry and unrelated provider field is preserved.
 */
export function createImageInputMutation(
  settings: SettingsDescribeValue,
  targets: readonly ImageInputTarget[],
): SettingsMutationRequest {
  if (!settings.writable) throw new VisionSettingsError('当前 DSH 设置为只读，无法在页面内保存图片能力。')
  if (targets.length === 0) throw new VisionSettingsError('请至少选择一个需要声明图片能力的模型。')
  const view = settings.namespaces.find(candidate => candidate.ns === PI_AI_SETTINGS_NAMESPACE)
  if (view === undefined) throw new VisionSettingsError('当前 DSH 没有提供 llm-pi-ai 设置，无法配置这些模型。')
  const user = asRecord(view.user)
  const providers = asRecord(user?.providers)
  if (providers === null) throw new VisionSettingsError('所选模型不在可编辑的用户模型列表中，请使用 DSH 模型设置检查 Provider。')

  const targetsByProvider = new Map<string, Set<string>>()
  for (const target of targets) {
    const models = targetsByProvider.get(target.providerRoute) ?? new Set<string>()
    models.add(target.modelId)
    targetsByProvider.set(target.providerRoute, models)
  }

  const ops: SettingsMutationRequest['ops'][number][] = []
  for (const [providerRoute, targetModelIds] of targetsByProvider) {
    const profile = Object.hasOwn(providers, providerRoute) ? asRecord(providers[providerRoute]) : null
    const models = profile === null ? null : profile.models
    if (!Array.isArray(models)) {
      throw new VisionSettingsError(`Provider ${providerRoute} 的模型不在可编辑的用户模型列表中，请使用 DSH 模型设置检查配置。`)
    }
    const found = new Set<string>()
    const nextModels = models.map(entry => {
      const model = asRecord(entry)
      if (model === null || typeof model.id !== 'string' || !targetModelIds.has(model.id)) return entry
      found.add(model.id)
      return { ...model, input: ['text', 'image'] }
    })
    const missing = [...targetModelIds].filter(modelId => !found.has(modelId))
    if (missing.length > 0) {
      throw new VisionSettingsError(`模型 ${missing.join('、')} 不在可编辑的用户模型列表中，请刷新后重试。`)
    }
    ops.push({
      op: 'set',
      path: ['providers', providerRoute, 'models'],
      value: nextModels,
    })
  }

  return {
    ns: PI_AI_SETTINGS_NAMESPACE,
    ops,
    expectedRevision: view.revision,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
