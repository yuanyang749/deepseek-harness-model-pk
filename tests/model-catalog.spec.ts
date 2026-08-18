import { describe, expect, it } from 'vitest'
import type { DshHostContext, DshResolvedModelInfo } from '../src/host/dsh.js'
import { ModelCatalog, piAiBuiltinModelFacts } from '../src/host/model-catalog.js'

describe('model catalog snapshots', () => {
  it('resolves an omitted pi-ai API and output capability from the pinned built-in catalog', async () => {
    const catalog = new ModelCatalog(contextFor({
      providerRoute: 'openai',
      model: {
        provider: 'openai',
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 1_047_576 },
      },
      profile: { apiKeyEnv: '[REDACTED]' },
    }))

    const [item] = await catalog.list()
    expect(item).toMatchObject({
      providerRoute: 'openai',
      modelId: 'gpt-4.1',
      protocol: 'openai-responses',
      support: 'SUPPORTED',
    })
    if (item === undefined) throw new Error('fixture model missing')
    const snapshot = await catalog.snapshot(item.modelConfigId)
    expect(snapshot.defaultMaxTokens).toBeNull()
    expect(snapshot.outputTokenCapacity).toBe(32_768)
    expect(snapshot.maxOutputTokens).toBe(8192)
    expect(snapshot.serializerDependencies).toEqual({ '@earendil-works/pi-ai': '0.82.1' })
  })

  it('reads explicit route protocol and default capacity from the nested settings profile', async () => {
    const catalog = new ModelCatalog(contextFor({
      providerRoute: 'fixture-gateway',
      model: {
        provider: 'fixture-gateway',
        id: 'fixture-model',
        name: 'Fixture Model',
        inputModalities: ['text'],
        context: { contextWindow: 65_536 },
      },
      profile: {
        api: 'anthropic-messages',
        baseURL: 'https://fixture.invalid',
        defaultMaxTokens: 16_384,
        models: [{ id: 'fixture-model' }],
      },
    }))

    const [item] = await catalog.list()
    expect(item).toMatchObject({ protocol: 'anthropic-messages', support: 'SUPPORTED' })
    if (item === undefined) throw new Error('fixture model missing')
    const snapshot = await catalog.snapshot(item.modelConfigId)
    expect(snapshot.outputTokenCapacity).toBe(16_384)
  })

  it('blocks a catalog model whose real output capability is below the common cap', async () => {
    const catalog = new ModelCatalog(contextFor({
      providerRoute: 'openai',
      model: {
        provider: 'openai',
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 128_000 },
      },
      profile: {},
    }))

    const [item] = await catalog.list()
    if (item === undefined) throw new Error('fixture model missing')
    await expect(catalog.snapshot(item.modelConfigId)).rejects.toMatchObject({
      detail: { code: 'PARAMETER_UNSUPPORTED', phase: 'model-snapshot' },
    })
  })

  it('exposes immutable facts from the exact pinned pi-ai catalog', () => {
    expect(piAiBuiltinModelFacts('anthropic', 'claude-haiku-4-5')).toEqual({
      protocol: 'anthropic-messages',
      outputTokenCapacity: 64_000,
    })
    expect(piAiBuiltinModelFacts('not-a-provider', 'not-a-model')).toBeUndefined()
  })
})

function contextFor(input: {
  readonly providerRoute: string
  readonly model: DshResolvedModelInfo
  readonly profile: Readonly<Record<string, unknown>>
}): DshHostContext {
  return {
    llm: {
      listConfigurableProviders: () => [{
        provider: input.providerRoute,
        displayName: input.providerRoute,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', input.providerRoute],
      }],
      listProviders: () => [{ id: input.providerRoute, name: input.providerRoute }],
      listModels: () => Promise.resolve([{
        provider: input.providerRoute,
        id: input.model.id,
        name: input.model.name,
        inputModalities: input.model.inputModalities,
      }]),
      resolveModelInfo: () => Promise.resolve(input.model),
      providerRetryPolicy: () => ({ mode: 'none' }),
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 7,
        value: { providers: { [input.providerRoute]: input.profile } },
        secrets: [],
      }],
    },
  } as unknown as DshHostContext
}
