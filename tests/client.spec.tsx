// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_ENDPOINTS } from '../src/contracts/rpc.js'
import { ModelPkOverlay, ModelPkSettingsSection } from '../src/client/App.js'
import { ModelPkApi } from '../src/client/api.js'
import { ModelPkUiController } from '../src/client/controller.js'
import type { ModelPkClientContext } from '../src/client/context.js'
import type { Draft, ExperimentProjection, ModelListItem } from '../src/contracts/types.js'
import { createExperimentDefinition } from '../src/domain/factory.js'
import { fixtureCapability, fixtureDraft, fixtureModel, fixturePreflight } from './fixtures.js'

function context(models: readonly ModelListItem[] = []): ModelPkClientContext {
  return {
    connection: {
      api: {
        settings: {
          describe: async () => ({ result: { ok: false, error: { code: 'settings-unavailable', message: 'fixture settings unavailable' } } }),
          mutate: async () => ({ result: { ok: false, error: { code: 'settings-unavailable', message: 'fixture settings unavailable' } } }),
        },
      },
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

function adaptiveComparisonExperiment(): ExperimentProjection {
  const definition = createExperimentDefinition({
    preflight: fixturePreflight(),
    experimentId: '00000000-0000-4000-8000-000000000099',
    experimentPath: '/tmp/model-pk-experiment',
    resultPath: '/tmp/model-pk-result',
    firstQueueSeq: 1,
    now: '2026-08-18T00:00:00.000Z',
  })
  const runs = definition.runs.map((run, ordinal) => {
    const initial = run.attempts[0]!
    const workspaceSummary = ordinal === 0
      ? {
          mode: 'TEXT_FILE' as const,
          changedFileCount: 1,
          addedFileCount: 1,
          modifiedFileCount: 0,
          deletedFileCount: 0,
          files: [{ path: 'story.md', changeType: 'ADDED' as const, byteLength: 12 }],
          truncated: false,
          textFilePath: 'story.md',
          textContent: '# 真正的故事',
        }
      : {
          mode: 'ENGINEERING' as const,
          changedFileCount: 2,
          addedFileCount: 2,
          modifiedFileCount: 0,
          deletedFileCount: 0,
          files: [
            { path: 'index.html', changeType: 'ADDED' as const, byteLength: 1200 },
            { path: 'style.css', changeType: 'ADDED' as const, byteLength: 800 },
          ],
          truncated: false,
          textFilePath: null,
          textContent: null,
        }
    const attempt = {
      ...initial,
      state: 'SUCCEEDED' as const,
      lifecycleVersion: 5,
      observedExecutionOutcome: 'SUCCEEDED' as const,
      pendingOutcome: 'SUCCEEDED' as const,
      finalizationId: '00000000-0000-4000-8000-000000000088',
      finalizationStage: 'CONTROL_COMMITTED' as const,
      executionTerminationConfirmed: true,
      executionReservationState: 'RELEASED' as const,
      workspaceSealState: 'SEALED' as const,
      workspacePath: '/workspace',
      artifactPath: '/artifacts',
      resultPath: `/tmp/model-pk-result/${ordinal}`,
      workspaceSummary,
      tokenUsage: { requestCount: 2, inputTokens: 100 + ordinal, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
      finalResponse: ordinal === 0 ? '模型说它写完了故事' : '模型说它生成了网页',
      archiveCompleteness: 'COMPLETE' as const,
      startedAt: '2026-08-18T00:00:00.000Z',
      executionEndedAt: '2026-08-18T00:01:05.000Z',
      finalizedAt: '2026-08-18T00:01:06.000Z',
    }
    return { ...run, attempts: [attempt], lastSuccessfulAttemptId: attempt.attemptId }
  })
  return {
    ...definition.experiment,
    lifecycleState: 'SETTLED',
    outcome: 'ALL_SUCCEEDED',
    runs,
    settledAt: '2026-08-18T00:01:06.000Z',
    counts: { queued: 0, active: 0, finalizing: 0, finished: 2, total: 2 },
    latestCursor: 2,
    activeActions: [],
    recoveryNotice: null,
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
    expect(screen.getByRole('button', { name: '保存目录并预检' })).toBeDisabled()
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
    expect(screen.getByRole('button', { name: '保存目录并预检' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Model 2/u }))
    expect(screen.getByRole('combobox', { name: '并发数' })).toHaveValue('2')
    expect(screen.getByRole('button', { name: '保存目录并预检' })).toBeDisabled()
  })

  it('requires a result directory but allows pure writing to preflight without a baseline', async () => {
    const snapshots = [fixtureModel(1), fixtureModel(2)]
    const models = snapshots.map(model => ({
      modelConfigId: model.modelConfigId,
      providerRoute: model.providerRoute,
      modelId: model.modelId,
      displayName: model.modelName,
      providerDisplayName: model.providerDisplayName,
      inputModalities: model.inputModalities,
      adapterKind: 'deepseek' as const,
      protocol: 'deepseek-chat' as const,
      support: 'SUPPORTED' as const,
    }))
    let draft: Draft = {
      ...fixtureDraft(),
      taskName: '童话小说',
      prompt: '写一篇童话故事',
      selectedModelConfigIds: snapshots.map(model => model.modelConfigId),
      concurrency: 2,
      resultRootPath: null,
    }
    const calls: string[] = []
    const clientContext = context(models)
    clientContext.connection.rpc.call = async (_channel, endpoint, payload) => {
      calls.push(endpoint)
      let value: unknown
      if (endpoint === RPC_ENDPOINTS.capabilitiesGet) value = fixtureCapability()
      else if (endpoint === RPC_ENDPOINTS.modelsList) value = models
      else if (endpoint === RPC_ENDPOINTS.draftCreate) value = draft
      else if (endpoint === RPC_ENDPOINTS.draftUpdate) {
        const patch = (payload as { patch: Partial<typeof draft> }).patch
        draft = { ...draft, ...patch, revision: draft.revision + 1 }
        value = draft
      } else if (endpoint === RPC_ENDPOINTS.resultRootSelect) {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          resultRootPath: '/tmp/model-pk-results',
        }
        value = draft
      } else if (endpoint === RPC_ENDPOINTS.preflightRun) value = fixturePreflight()
      else value = draft
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()
    calls.length = 0
    render(<ModelPkOverlay controller={controller} />)

    expect(screen.getByText('项目起始目录（可选）')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '结果输出目录' }), {
      target: { value: '/tmp/model-pk-results' },
    })
    const action = screen.getByRole('button', { name: '保存目录并预检' })
    expect(action).toBeEnabled()
    fireEvent.click(action)

    await waitFor(() => {
      expect(calls.filter(endpoint => [
        RPC_ENDPOINTS.draftUpdate,
        RPC_ENDPOINTS.resultRootSelect,
        RPC_ENDPOINTS.preflightRun,
      ].includes(endpoint as never))).toEqual([
        RPC_ENDPOINTS.draftUpdate,
        RPC_ENDPOINTS.resultRootSelect,
        RPC_ENDPOINTS.preflightRun,
      ])
    })
    expect(calls).not.toContain(RPC_ENDPOINTS.baselineSelect)
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

  it('marks and disables text-only models when an image is attached', async () => {
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
    const textOnly = fixtureModel(1)
    const vision = { ...fixtureModel(2), inputModalities: ['text', 'image'] as const }
    const models = [textOnly, vision].map(model => ({
      modelConfigId: model.modelConfigId,
      providerRoute: model.providerRoute,
      modelId: model.modelId,
      displayName: model.modelName,
      providerDisplayName: model.providerDisplayName,
      inputModalities: model.inputModalities,
      adapterKind: 'pi-ai' as const,
      protocol: 'openai-completions' as const,
      support: 'SUPPORTED' as const,
    }))
    const clientContext = context(models)
    clientContext.connection.rpc.call = async (_channel, endpoint) => {
      const value = endpoint === RPC_ENDPOINTS.capabilitiesGet
        ? fixtureCapability()
        : endpoint === RPC_ENDPOINTS.modelsList ? models : withImage
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)

    expect(screen.getByRole('checkbox', { name: /Model 1/u })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Model 2/u })).toBeEnabled()
    expect(screen.getByText('仅文本')).toBeInTheDocument()
    expect(screen.getByText('支持图片')).toBeInTheDocument()
  })

  it('lets a novice declare image support in the page and refreshes the model list', async () => {
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
    const source = fixtureModel(1)
    const textOnly = {
      modelConfigId: source.modelConfigId,
      providerRoute: 'gateway',
      modelId: 'vision-model',
      displayName: 'Vision Model',
      providerDisplayName: 'Gateway',
      inputModalities: ['text'] as const,
      adapterKind: 'pi-ai' as const,
      protocol: 'openai-completions' as const,
      support: 'SUPPORTED' as const,
    }
    const vision = { ...textOnly, inputModalities: ['text', 'image'] as const }
    let modelReads = 0
    const clientContext = context([textOnly])
    clientContext.connection.rpc.call = async (_channel, endpoint) => {
      const value = endpoint === RPC_ENDPOINTS.capabilitiesGet
        ? fixtureCapability()
        : endpoint === RPC_ENDPOINTS.modelsList
          ? (modelReads++ === 0 ? [textOnly] : [vision])
          : withImage
      return { ok: true, value: { ok: true, value } }
    }
    clientContext.connection.api.settings.describe = async () => ({
      result: {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [{
            ns: 'llm-pi-ai',
            schema: {},
            value: {},
            user: { providers: { gateway: { models: [{ id: 'vision-model' }] } } },
            applies: 'live',
            secrets: [],
            revision: 4,
          }],
        },
      },
    })
    const mutate = vi.fn(async () => ({
      result: {
        ok: true as const,
        value: {
          ns: 'llm-pi-ai', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 5,
        },
      },
    }))
    clientContext.connection.api.settings.mutate = mutate
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: '配置图片能力' }))
    expect(screen.getByRole('dialog', { name: '配置图片能力' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '声明 Vision Model 支持图片' }))
    fireEvent.click(screen.getByRole('button', { name: '保存图片能力' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      expectedRevision: 4,
      ops: [{
        op: 'set',
        path: ['providers', 'gateway', 'models'],
        value: [{ id: 'vision-model', input: ['text', 'image'] }],
      }],
    }))
    await waitFor(() => expect(screen.getByText('支持图片')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: '配置图片能力' })).not.toBeInTheDocument()
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

  it('switches single-text and multi-file attempts to the appropriate comparison UI', async () => {
    const experiment = adaptiveComparisonExperiment()
    localStorage.setItem('dsh-model-pk:last-experiment-id', experiment.experimentId)
    const clientContext = context()
    clientContext.connection.rpc.call = async (_channel, endpoint, _payload, signal) => {
      let value: unknown
      if (endpoint === RPC_ENDPOINTS.capabilitiesGet) value = fixtureCapability()
      else if (endpoint === RPC_ENDPOINTS.modelsList) value = []
      else if (endpoint === RPC_ENDPOINTS.draftCreate) value = fixtureDraft()
      else if (endpoint === RPC_ENDPOINTS.experimentGet) value = experiment
      else if (endpoint === RPC_ENDPOINTS.experimentPoll) {
        return new Promise(resolve => signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { code: 'ABORTED', message: 'aborted' } })
        }, { once: true }))
      } else value = fixtureDraft()
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()
    render(<ModelPkOverlay controller={controller} />)

    expect(screen.getByText('单文件文本 · story.md')).toBeInTheDocument()
    expect(screen.getByText('# 真正的故事')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '加入 Model 1 第 1 次执行对照' })).toBeEnabled()

    expect(screen.getByText('工程结果')).toBeInTheDocument()
    expect(screen.getByText('2 个文件发生变化')).toBeInTheDocument()
    expect(screen.getByText('index.html')).toBeInTheDocument()
    expect(screen.getByText('style.css')).toBeInTheDocument()
    expect(screen.getByText('验收测试未配置')).toBeInTheDocument()
    expect(screen.getByText('100 输入 · 20 输出')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '加入 Model 2 第 1 次执行对照' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出完整项目' })).toHaveAttribute(
      'title',
      '将该模型生成的全部项目文件导出到结果目录，可直接打开、运行或编辑。',
    )
    expect(screen.getAllByRole('button', { name: '导出完整项目' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '导出工作区' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: '加入 Model 1 第 1 次执行对照' }))
    expect(screen.getByRole('heading', { name: /文本结果双栏对照/u })).toBeInTheDocument()
    controller.close()
  })

  it('keeps legacy attempts readable when adaptive summary fields are absent', async () => {
    const experiment = adaptiveComparisonExperiment()
    const legacyAttempt = experiment.runs[0]!.attempts[0]! as unknown as Record<string, unknown>
    delete legacyAttempt.workspaceSummary
    delete legacyAttempt.tokenUsage
    localStorage.setItem('dsh-model-pk:last-experiment-id', experiment.experimentId)
    const clientContext = context()
    clientContext.connection.rpc.call = async (_channel, endpoint, _payload, signal) => {
      let value: unknown
      if (endpoint === RPC_ENDPOINTS.capabilitiesGet) value = fixtureCapability()
      else if (endpoint === RPC_ENDPOINTS.modelsList) value = []
      else if (endpoint === RPC_ENDPOINTS.draftCreate) value = fixtureDraft()
      else if (endpoint === RPC_ENDPOINTS.experimentGet) value = experiment
      else if (endpoint === RPC_ENDPOINTS.experimentPoll) {
        return new Promise(resolve => signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { code: 'ABORTED', message: 'aborted' } })
        }, { once: true }))
      } else value = fixtureDraft()
      return { ok: true, value: { ok: true, value } }
    }
    const controller = new ModelPkUiController(new ModelPkApi(clientContext))
    await controller.open()

    expect(() => render(<ModelPkOverlay controller={controller} />)).not.toThrow()
    expect(screen.getByText('模型最终回复')).toBeInTheDocument()
    expect(screen.getByText('模型说它写完了故事')).toBeInTheDocument()
    controller.close()
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
