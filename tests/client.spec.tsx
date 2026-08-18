// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_ENDPOINTS } from '../src/contracts/rpc.js'
import { ModelPkOverlay, ModelPkSettingsSection } from '../src/client/App.js'
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
    expect(screen.getByRole('button', { name: '预检并继续' })).toBeDisabled()
    expect(screen.queryByText('请先填写提示词。')).not.toBeInTheDocument()
    expect(screen.getByText('执行环境就绪')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '任务类型' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '任务类型' }), { target: { value: 'Other' } })
    expect(screen.getByPlaceholderText('例如：代码审查、文档改写')).toBeInTheDocument()
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
    fireEvent.change(screen.getByRole('textbox', { name: /提示词/u }), { target: { value: '比较这两个模型' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Model 1/u }))
    expect(screen.getByRole('button', { name: '预检并继续' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Model 2/u }))
    expect(screen.getByRole('combobox', { name: '并发数' })).toHaveValue('2')
    expect(screen.getByRole('button', { name: '预检并继续' })).toBeEnabled()
  })

  it('shows a thumbnail after an image is uploaded', async () => {
    const draft = fixtureDraft()
    const withImage = {
      ...draft,
      attachments: [{
        attachmentId: '00000000-0000-4000-8000-000000000010',
        draftId: draft.draftId,
        ordinal: 0,
        name: 'cover.png',
        mimeType: 'image/png' as const,
        byteLength: 4,
        hash: 'sha256:preview' as const,
        state: 'READY' as const,
      }],
    }
    const clientContext = context()
    clientContext.connection.rpc.call = async (_channel, endpoint) => {
      const value = endpoint === RPC_ENDPOINTS.capabilitiesGet
        ? fixtureCapability()
        : endpoint === RPC_ENDPOINTS.modelsList ? [] : withImage
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    vi.spyOn(controller, 'previewUrl').mockReturnValue('blob:preview')
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)
    expect(screen.getByRole('img', { name: 'cover.png' })).toHaveAttribute('src', 'blob:preview')
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

  it('opens the fullscreen overlay from the settings entry', async () => {
    const controller = new ModelPkUiController(new ModelPkApi(context()))
    render(
      <>
        <ModelPkSettingsSection controller={controller} />
        <ModelPkOverlay controller={controller} />
      </>,
    )
    expect(await screen.findByRole('dialog', { name: 'Model PK' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭 Model PK' }))
    expect(screen.queryByRole('dialog', { name: 'Model PK' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开全屏' }))
    expect(screen.getByRole('dialog', { name: 'Model PK' })).toBeInTheDocument()
  })
})
