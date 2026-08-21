import { describe, expect, it } from 'vitest'
import { assertImageInputSupported } from '../src/host/preflight.js'
import { fixtureModel } from './fixtures.js'

describe('image preflight', () => {
  it('blocks a model that DSH has not declared as image-capable', () => {
    let thrown: unknown
    try {
      assertImageInputSupported(fixtureModel(1), {
        status: 'unverified',
        source: 'missing',
        modalities: ['text'],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      detail: {
        code: 'IMAGE_INPUT_UNSUPPORTED',
        phase: 'preflight',
        userMessage: expect.stringContaining('input: [text, image]'),
      },
    })
  })

  it('accepts a model whose image capability is declared', () => {
    expect(() => assertImageInputSupported(fixtureModel(1), {
      status: 'declared',
      source: 'dsh-model-info',
      modalities: ['image', 'text'],
    })).not.toThrow()
  })
})
