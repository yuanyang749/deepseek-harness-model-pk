// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RPC_ENDPOINTS } from '../src/contracts/rpc.js'
import { ModelPkOverlay } from '../src/client/App.js'
import { ModelPkApi } from '../src/client/api.js'
import { ModelPkUiController } from '../src/client/controller.js'
import type { ModelPkClientContext } from '../src/client/context.js'
import type { ModelListItem } from '../src/contracts/types.js'
import { fixtureCapability, fixtureDraft, fixtureModel } from './fixtures.js'

function context(models: readonly ModelListItem[] = []): ModelPkClientContext {
  return {
    connection: {
      rpc: {
        call: async (_channel, endpoint) => {
          const value = endpoint === RPC_ENDPOINTS.capabilitiesGet
            ? fixtureCapability()
            : endpoint === RPC_ENDPOINTS.modelsList ? models : fixtureDraft()
          return { ok: true, value: { ok: true, value } }
        },
      },
    },
    slots: { inject: () => () => undefined, register: () => () => undefined },
    effect: () => async () => undefined,
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe('formal product UI', () => {
  it('loads Host state and renders the create surface', async () => {
    const controller = new ModelPkUiController(new ModelPkApi(context()))
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)
    expect(screen.getByRole('dialog', { name: 'Model PK' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '创建对照实验' })).toBeInTheDocument()
    expect(screen.getByText('执行环境 READY')).toBeInTheDocument()
  })

  it('defaults concurrency to min(4, N) when model selection changes', async () => {
    const models = [1, 2].map(ordinal => {
      const model = fixtureModel(ordinal)
      return {
        modelConfigId: model.modelConfigId,
        providerRoute: model.providerRoute,
        modelId: model.modelId,
        displayName: model.modelName,
        providerDisplayName: model.providerDisplayName,
        inputModalities: model.inputModalities,
        adapterKind: 'deepseek',
        protocol: 'deepseek-chat',
        support: 'SUPPORTED',
      } satisfies ModelListItem
    })
    const controller = new ModelPkUiController(new ModelPkApi(context(models)))
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Model 1/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Model 2/u }))
    expect(screen.getByRole('combobox', { name: 'Concurrency' })).toHaveValue('2')
  })

  it('cancels the live poll before deleting the currently viewed experiment', async () => {
    const experimentId = '00000000-0000-4000-8000-000000000099'
    localStorage.setItem('dsh-model-pk:last-experiment-id', experimentId)
    let pollWasAborted = false
    const clientContext = context()
    clientContext.connection.rpc.call = async (_channel, endpoint, _payload, signal) => {
      let value: unknown
      if (endpoint === RPC_ENDPOINTS.capabilitiesGet) value = fixtureCapability()
      else if (endpoint === RPC_ENDPOINTS.modelsList) value = []
      else if (endpoint === RPC_ENDPOINTS.draftCreate) value = fixtureDraft()
      else if (endpoint === RPC_ENDPOINTS.experimentGet) value = { experimentId }
      else if (endpoint === RPC_ENDPOINTS.experimentDelete) value = { deleted: true }
      else if (endpoint === RPC_ENDPOINTS.storageListForDeletion) value = []
      else if (endpoint === RPC_ENDPOINTS.experimentPoll) {
        return new Promise(resolve => {
          signal?.addEventListener('abort', () => {
            pollWasAborted = true
            resolve({ ok: false, error: { code: 'ABORTED', message: 'aborted' } })
          }, { once: true })
        })
      } else value = fixtureDraft()
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()
    await controller.deleteExperiment(experimentId)
    await Promise.resolve()
    expect(pollWasAborted).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ experiment: null, error: null, storage: [] })
    expect(localStorage.getItem('dsh-model-pk:last-experiment-id')).toBeNull()
  })
})
