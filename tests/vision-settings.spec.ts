import { describe, expect, it } from 'vitest'
import { createImageInputMutation } from '../src/client/vision-settings.js'

describe('visual image capability settings', () => {
  it('adds text and image to the selected model without replacing other provider settings', () => {
    const mutation = createImageInputMutation({
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        user: {
          providers: {
            gateway: {
              apiKeyEnv: 'GATEWAY_API_KEY',
              baseURL: 'https://example.invalid/v1',
              models: [
                { id: 'text-model' },
                { id: 'vision-model', name: 'Vision Model' },
              ],
            },
          },
        },
        applies: 'live',
        secrets: [],
        revision: 7,
      }],
    }, [{ providerRoute: 'gateway', modelId: 'vision-model' }])

    expect(mutation).toEqual({
      ns: 'llm-pi-ai',
      expectedRevision: 7,
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models'],
        value: [
          { id: 'text-model' },
          { id: 'vision-model', name: 'Vision Model', input: ['text', 'image'] },
        ],
      }],
    })
  })

  it('refuses to guess when the model is not in the editable user model list', () => {
    expect(() => createImageInputMutation({
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'llm-pi-ai',
        schema: {},
        value: { providers: { gateway: { models: [{ id: 'vision-model' }] } } },
        applies: 'live',
        secrets: [],
        revision: 2,
      }],
    }, [{ providerRoute: 'gateway', modelId: 'vision-model' }])).toThrow('不在可编辑的用户模型列表中')
  })
})
