import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Attempt, DraftUpdateRequest, ExperimentProjection, ModelListItem, PreflightSnapshot, Run } from '../contracts/types.js'
import { LIMITS } from '../contracts/constants.js'
import type { ModelPkUiController, UiScreen, UiSnapshot } from './controller.js'
import {
  buildExperimentReport,
  exportExperimentReportPng,
  formatReportDuration,
  formatReportNumber,
  loadQualityRanking,
  saveQualityRanking,
  type ExperimentReportRow,
} from './report.js'
import { MODEL_PK_CSS } from './styles.js'

export function ModelPkSettingsSection({ controller, close }: { controller: ModelPkUiController; close?: (() => void) | undefined }): JSX.Element {
  useEffect(() => {
    void controller.open()
  }, [controller])
  useEffect(() => {
    if (close === undefined) return undefined
    return controller.bindSettingsPanelClose(close)
  }, [close, controller])
  return (
    <section className="mpk-launch-card" aria-label="Model PK 入口">
      <style>{MODEL_PK_CSS}</style>
      <h2>Model PK</h2>
      <p>对照实验在全屏界面中运行，避免挤进设置面板。关闭全屏后可再次打开。</p>
      <button className="mpk-btn" type="button" onClick={() => { void controller.open() }}>打开全屏</button>
    </section>
  )
}

export function ModelPkOverlay({ controller }: { controller: ModelPkUiController }): JSX.Element | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => {
    if (!snapshot.open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller, snapshot.open])
  if (!snapshot.open || typeof document === 'undefined') return null
  return createPortal(
    <div className="mpk-shell" role="dialog" aria-modal="true" aria-label="Model PK">
      <style>{MODEL_PK_CSS}</style>
      <Header
        screen={snapshot.screen}
        onNavigate={screen => controller.show(screen)}
        onClose={() => controller.close()}
        hasExperiment={snapshot.experiment !== null}
        ready={snapshot.capability?.executionEnabled ?? false}
        envDetail={`DSH ${snapshot.capability?.expectedDshVersion ?? '—'} · ${snapshot.capability?.hostPlatform ?? '—'}/${snapshot.capability?.hostArch ?? '—'}`}
      />
      {snapshot.error === null ? null : <ErrorBanner snapshot={snapshot} onClose={() => controller.clearError()} />}
      <main className="mpk-content">
        {snapshot.screen === 'create' ? <CreatePage key={snapshot.draft?.draftId ?? 'loading'} snapshot={snapshot} controller={controller} /> : null}
        {snapshot.screen === 'preflight' ? <PreflightPage snapshot={snapshot} controller={controller} /> : null}
        {snapshot.screen === 'experiment' ? <ExperimentPage snapshot={snapshot} controller={controller} /> : null}
        {snapshot.screen === 'storage' ? <StoragePage snapshot={snapshot} controller={controller} /> : null}
      </main>
      {snapshot.busy ? <div className="mpk-busy" role="status" aria-live="polite">{snapshot.busyLabel}</div> : null}
    </div>,
    document.body,
  )
}

function Header(props: {
  screen: UiScreen
  onNavigate(screen: UiScreen): void
  onClose(): void
  hasExperiment: boolean
  ready: boolean
  envDetail: string
}): JSX.Element {
  const tabs: readonly [UiScreen, string][] = [
    ['create', '创建'],
    ['preflight', '预检'],
    ['experiment', '实验'],
    ['storage', '本地存储'],
  ]
  return (
    <header className="mpk-header">
      <div className="mpk-brand">
        <svg className="mpk-brand-mark" viewBox="0 0 32 32" role="img" aria-label="Model PK 双轨对决标志" focusable="false">
          <rect className="mpk-brand-frame" x="1" y="1" width="30" height="30" rx="9" />
          <path className="mpk-brand-rail" d="M13 8H9.5A2.5 2.5 0 0 0 7 10.5v11A2.5 2.5 0 0 0 9.5 24H13M11 12l4 4-4 4" />
          <path className="mpk-brand-rail" d="M19 8h3.5a2.5 2.5 0 0 1 2.5 2.5v11a2.5 2.5 0 0 1-2.5 2.5H19M21 12l-4 4 4 4" />
          <rect className="mpk-brand-axis" x="15.25" y="7" width="1.5" height="18" rx=".75" />
        </svg>
        <span className="mpk-brand-name">Model PK</span>
      </div>
      <nav className="mpk-nav" aria-label="Model PK 页面">
        {tabs.map(([screen, label]) => (
          <button key={screen} type="button" aria-current={props.screen === screen ? 'page' : undefined}
            disabled={screen === 'experiment' && !props.hasExperiment}
            onClick={() => props.onNavigate(screen)}>{label}</button>
        ))}
      </nav>
      <div className="mpk-header-end">
        <div className="mpk-env" data-ready={props.ready} title={props.envDetail}>
          <span className="mpk-env-dot" aria-hidden="true" />
          <span className="mpk-env-label">{props.ready ? '执行环境就绪' : '执行入口已阻断'}</span>
          <span className="mpk-env-detail">{props.envDetail}</span>
        </div>
        <button className="mpk-close" type="button" onClick={props.onClose} aria-label="关闭 Model PK">×</button>
      </div>
    </header>
  )
}

function ErrorBanner({ snapshot, onClose }: { snapshot: UiSnapshot; onClose(): void }): JSX.Element {
  const error = snapshot.error!
  return (
    <div className="mpk-alert" role="alert">
      <button className="mpk-btn mpk-btn-secondary mpk-btn-small" style={{ float: 'right' }} type="button" onClick={onClose}>关闭</button>
      <strong>{error.code} · {error.userMessage}</strong>
      <span>{error.retryable ? '可重试' : '需修正输入或环境后重试'} · {error.phase}</span>
      <details><summary>技术详情</summary><pre className="mpk-mono">{error.technicalMessage}{error.providerRequestId ? `\nrequest: ${error.providerRequestId}` : ''}</pre></details>
    </div>
  )
}

const TASK_TYPE_PRESETS = [
  { value: 'Coding', label: '编程' },
  { value: 'Reasoning', label: '推理' },
  { value: 'Writing', label: '写作' },
  { value: 'Analysis', label: '分析' },
] as const
const TASK_TYPE_CUSTOM = 'Other'
const TASK_TYPE_PRESET_VALUES = new Set<string>(TASK_TYPE_PRESETS.map(item => item.value))

function requiredMark(): JSX.Element {
  return <span className="mpk-required" aria-hidden="true">*</span>
}

interface DraftForm {
  taskName: string
  taskType: string
  prompt: string
  selectedModelConfigIds: string[]
  concurrency: number
}

function CreatePage({ snapshot, controller }: { snapshot: UiSnapshot; controller: ModelPkUiController }): JSX.Element {
  const draft = snapshot.draft
  if (draft === null) return <Loading label="正在加载 Draft…" />
  const [form, setForm] = useState<DraftForm>({
    taskName: draft.taskName,
    taskType: draft.taskType,
    prompt: draft.prompt,
    selectedModelConfigIds: [...draft.selectedModelConfigIds],
    concurrency: draft.concurrency,
  })
  const [search, setSearch] = useState('')
  const [baselinePath, setBaselinePath] = useState('')
  const [resultRootPath, setResultRootPath] = useState('')
  const [dragging, setDragging] = useState(false)
  const [visionDialogOpen, setVisionDialogOpen] = useState(false)
  const [visionSelection, setVisionSelection] = useState<string[]>([])
  const filtered = useMemo(() => snapshot.models.filter(model => `${model.displayName} ${model.providerDisplayName} ${model.modelId}`.toLowerCase().includes(search.toLowerCase())), [snapshot.models, search])
  const configurableTextOnlyModels = useMemo(() => snapshot.models.filter(model => (
    model.support === 'SUPPORTED'
    && model.adapterKind === 'pi-ai'
    && !model.inputModalities.includes('image')
  )), [snapshot.models])
  const setField = <K extends keyof DraftForm>(key: K, value: DraftForm[K]): void => setForm(current => ({ ...current, [key]: value }))
  const persistedPatch = (): DraftUpdateRequest['patch'] => ({
    taskName: form.taskName,
    taskType: form.taskType,
    prompt: form.prompt,
    selectedModelConfigIds: form.selectedModelConfigIds as `sha256:${string}`[],
    concurrency: Math.min(Math.max(1, form.concurrency), Math.max(1, form.selectedModelConfigIds.length)),
  })
  const persist = (): Promise<boolean> => controller.saveDraftSafely(persistedPatch())
  const preflight = async (): Promise<void> => {
    if (!await persist()) return
    if (controller.getSnapshot().draft?.resultRootPath === null) {
      await controller.selectResultRoot(resultRootPath.trim())
      if (controller.getSnapshot().draft?.resultRootPath === null) return
    }
    if (controller.getSnapshot().draft?.baseline === null && baselinePath.trim() !== '') {
      await controller.selectBaseline(baselinePath.trim())
      if (controller.getSnapshot().draft?.baseline === null) return
    }
    await controller.runPreflight()
  }
  const upload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    if (await persist()) await controller.uploadFiles(files)
  }
  const toggleModel = (model: ModelListItem): void => {
    if (model.support !== 'SUPPORTED') return
    const selected = form.selectedModelConfigIds.includes(model.modelConfigId)
      ? form.selectedModelConfigIds.filter(id => id !== model.modelConfigId)
      : form.selectedModelConfigIds.length >= LIMITS.modelMax ? form.selectedModelConfigIds : [...form.selectedModelConfigIds, model.modelConfigId]
    setForm(current => ({
      ...current,
      selectedModelConfigIds: selected,
      concurrency: Math.min(LIMITS.defaultConcurrencyCap, Math.max(1, selected.length)),
    }))
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault(); setDragging(false); void upload([...event.dataTransfer.files])
  }
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const files = [...event.clipboardData.files]
    if (files.length > 0) { event.preventDefault(); void upload(files) }
  }
  const saveVisionCapabilities = async (): Promise<void> => {
    const selected = configurableTextOnlyModels.filter(model => visionSelection.includes(model.modelConfigId))
    const saved = await controller.declareImageSupport(selected.map(model => ({
      providerRoute: model.providerRoute,
      modelId: model.modelId,
    })))
    if (saved) {
      setVisionDialogOpen(false)
      setVisionSelection([])
    }
  }
  const blockers = snapshot.capability?.blockers ?? []
  const selectedCount = form.selectedModelConfigIds.length
  const needsResultRoot = draft.resultRootPath === null
  const canPreflight = !snapshot.busy
    && selectedCount >= LIMITS.modelMin
    && form.taskName.trim() !== ''
    && form.prompt.trim() !== ''
    && (!needsResultRoot || resultRootPath.trim() !== '')
    && (snapshot.capability?.executionEnabled ?? false)
  return (
    <section className="mpk-page">
      {blockers.length > 0 ? (
        <details className="mpk-env-blockers">
          <summary>{blockers.length} 个阻断项</summary>
          <ul>{blockers.map(blocker => <li key={`${blocker.code}:${blocker.phase}`}>{blocker.code}: {blocker.userMessage}</li>)}</ul>
        </details>
      ) : null}
      <div className="mpk-grid">
        <div className="mpk-stack">
          <div className="mpk-card mpk-stack">
            <div className="mpk-field-row">
              <label className="mpk-field">
                <span>任务名称 {requiredMark()}</span>
                <input className="mpk-input" maxLength={120} value={form.taskName} onChange={event => setField('taskName', event.target.value)} />
                <small className="mpk-meta">用于归档目录命名。{[...form.taskName].length} / 120</small>
              </label>
              <TaskTypeField value={form.taskType} onChange={value => setField('taskType', value)} />
            </div>
            <label className="mpk-field">
              <span>提示词 {requiredMark()}</span>
              <textarea className="mpk-textarea" value={form.prompt} onChange={event => setField('prompt', event.target.value)} />
              <small className="mpk-meta">所有模型收到同一份原文。当前 {formatBytes(new TextEncoder().encode(form.prompt).byteLength)} / 1 MiB。</small>
            </label>
          </div>
          <div className="mpk-card mpk-stack">
            <div><h2 className="mpk-section-title">图片输入</h2><div className="mpk-meta">PNG / JPEG / WebP · 最多 10 张 · 保留用户顺序和原始字节</div></div>
            <div className="mpk-drop" data-drag={dragging} tabIndex={0} onPaste={onPaste} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              拖拽或粘贴图片到这里，或 <label><strong style={{ cursor: 'pointer' }}>选择文件<input hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>) => { void upload([...(event.target.files ?? [])]); event.target.value = '' }} /></strong></label>
            </div>
            <AttachmentList draft={draft} controller={controller} />
          </div>
          <div className="mpk-card mpk-stack">
            <div>
              <h2 className="mpk-section-title">项目起始目录（可选）</h2>
              <div className="mpk-baseline-guide">
                <p><strong>已有项目对照</strong>填写现成仓库或落地页目录。系统会完整复制一份快照，各模型从相同文件改起，互不影响，也不会改你的原目录。</p>
                <p><strong>纯写作或全新任务</strong>可以不选择，系统会为每个模型创建相同的内部空白工作区。</p>
                <p>选择已有项目时不应用 .gitignore，目录越大复制越久。</p>
              </div>
            </div>
            {draft.baseline === null ? (
              <div className="mpk-stack">
                <div className="mpk-actions">
                  <input className="mpk-input" aria-label="项目起始目录" placeholder="已有项目或空目录的绝对路径" value={baselinePath} onChange={event => setBaselinePath(event.target.value)} />
                  <button className="mpk-btn mpk-btn-secondary" type="button" onClick={async () => {
                    const path = await controller.chooseBaselineFolder()
                    if (path !== null) setBaselinePath(path)
                  }}>选择起始目录</button>
                </div>
                <small className="mpk-meta">不需要现有文件时可留空；选择后会冻结快照，但绝不会写回这个目录。</small>
              </div>
            ) : (
              <div className="mpk-stack">
                <div>
                  <strong>{draft.baseline.fileCount === 0 ? '全新项目对照' : '已有项目对照'} · {draft.baseline.fileCount.toLocaleString()} 个文件 · {formatBytes(draft.baseline.byteLength)}</strong>
                  <div className="mpk-meta">{draft.baseline.fileCount === 0 ? '各模型将从同一空白目录从零生成。' : '各模型将从这份相同文件改起，不会写入原目录。'}</div>
                  <div className="mpk-hash" title={draft.baseline.objectHash}>{maskHash(draft.baseline.objectHash)}</div>
                  <div className="mpk-path">{draft.baseline.sourcePath}</div>
                </div>
                <div><button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void controller.clearBaseline() }}>更换起始目录</button></div>
              </div>
            )}
          </div>
          <div className="mpk-card mpk-stack">
            <div>
              <h2 className="mpk-section-title">结果输出目录 {requiredMark()}</h2>
              <p className="mpk-meta">每次实验会创建独立子目录，直接保存各模型的文本结果；插件内部归档不会暴露在这里。</p>
            </div>
            {draft.resultRootPath === null ? (
              <div className="mpk-stack">
                <div className="mpk-actions">
                  <input className="mpk-input" aria-label="结果输出目录" placeholder="结果保存位置的绝对路径" value={resultRootPath} onChange={event => setResultRootPath(event.target.value)} />
                  <button className="mpk-btn mpk-btn-secondary" type="button" onClick={async () => {
                    const path = await controller.chooseResultFolder()
                    if (path !== null) setResultRootPath(path)
                  }}>选择输出目录</button>
                </div>
                <small className="mpk-meta">模型结果会按任务和模型分目录保存，不覆盖已有文件。</small>
              </div>
            ) : (
              <div className="mpk-stack">
                <div><strong>结果将保存到</strong><div className="mpk-path">{draft.resultRootPath}</div></div>
                <div><button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void controller.clearResultRoot() }}>更换输出目录</button></div>
              </div>
            )}
          </div>
        </div>
        <aside className="mpk-rail">
          <div className="mpk-card mpk-models">
            <div className="mpk-models-head">
              <h2 className="mpk-section-title">模型 <span className="mpk-pill">{selectedCount} / {LIMITS.modelMax}</span></h2>
              <input className="mpk-input" aria-label="搜索模型" placeholder="搜索模型或提供商" value={search} onChange={event => setSearch(event.target.value)} />
            </div>
            <div className="mpk-model-list">{filtered.map(model => <ModelOption key={model.modelConfigId} model={model} checked={form.selectedModelConfigIds.includes(model.modelConfigId)} requiresImage={draft.attachments.length > 0} onChange={() => toggleModel(model)} />)}</div>
            {draft.attachments.length > 0 && configurableTextOnlyModels.length > 0 ? (
              <div className="mpk-vision-guide" role="note">
                <strong>有模型尚未声明图片能力</strong>
                <span>无需查找配置文件，可直接在这里为实际支持图片的模型开启。</span>
                <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => {
                  setVisionSelection([])
                  setVisionDialogOpen(true)
                }}>配置图片能力</button>
              </div>
            ) : null}
            <div className="mpk-rail-foot">
              <label className="mpk-field">
                <span>并发数</span>
                <select className="mpk-select" aria-label="并发数" value={Math.min(form.concurrency, Math.max(1, selectedCount))} onChange={event => setField('concurrency', Number(event.target.value))}>{Array.from({ length: Math.max(1, selectedCount) }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select>
                <small className="mpk-meta">同时执行的路数，默认 min(4, N)。排队不计入 30 分钟时限。</small>
              </label>
              <div className="mpk-rail-actions">
                <button
                  className="mpk-btn mpk-btn-secondary"
                  type="button"
                  onClick={() => {
                    if (confirm('清空当前填写的名称、提示词、图片、起始文件和模型选择，重新开始一份对照？已开始的实验不会被删除。')) {
                      void controller.newDraft()
                    }
                  }}
                >清空并重新填写</button>
                <button className="mpk-btn" type="button" disabled={!canPreflight} onClick={() => { void preflight() }}>{needsResultRoot ? '保存目录并预检' : '预检并继续'}</button>
              </div>
            </div>
          </div>
        </aside>
      </div>
      {visionDialogOpen ? (
        <VisionCapabilityDialog
          models={configurableTextOnlyModels}
          selected={visionSelection}
          busy={snapshot.busy}
          onToggle={modelConfigId => setVisionSelection(current => current.includes(modelConfigId)
            ? current.filter(value => value !== modelConfigId)
            : [...current, modelConfigId])}
          onCancel={() => {
            setVisionDialogOpen(false)
            setVisionSelection([])
          }}
          onSave={() => { void saveVisionCapabilities() }}
        />
      ) : null}
    </section>
  )
}

function VisionCapabilityDialog(props: {
  models: readonly ModelListItem[]
  selected: readonly string[]
  busy: boolean
  onToggle(modelConfigId: string): void
  onCancel(): void
  onSave(): void
}): JSX.Element {
  return (
    <div className="mpk-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) props.onCancel()
    }}>
      <section className="mpk-modal mpk-stack" role="dialog" aria-modal="true" aria-label="配置图片能力">
        <div>
          <div className="mpk-kicker">DSH 模型设置</div>
          <h2>配置图片能力</h2>
          <p className="mpk-hint">选择已经确认能够接收图片的模型。保存后会自动更新 DSH 配置和当前模型列表。</p>
        </div>
        <div className="mpk-capability-list">
          {props.models.map(model => (
            <label className="mpk-capability-option" key={model.modelConfigId}>
              <input
                type="checkbox"
                aria-label={`声明 ${model.displayName} 支持图片`}
                checked={props.selected.includes(model.modelConfigId)}
                onChange={() => props.onToggle(model.modelConfigId)}
              />
              <span>
                <strong>{model.displayName}</strong>
                <span className="mpk-model-sub">{model.providerDisplayName} · {model.modelId}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mpk-capability-warning" role="note">
          <strong>请勿凭模型名称猜测</strong>
          <span>此操作只声明能力，不会探测上游接口。若模型或网关实际不支持图片，执行时仍会被上游拒绝。</span>
        </div>
        <div className="mpk-actions">
          <button className="mpk-btn mpk-btn-secondary" type="button" disabled={props.busy} onClick={props.onCancel}>取消</button>
          <span className="mpk-space" />
          <button className="mpk-btn" type="button" disabled={props.busy || props.selected.length === 0} onClick={props.onSave}>保存图片能力</button>
        </div>
      </section>
    </div>
  )
}

function TaskTypeField({ value, onChange }: { value: string; onChange(value: string): void }): JSX.Element {
  const selectValue = value === '' || TASK_TYPE_PRESET_VALUES.has(value) || value === TASK_TYPE_CUSTOM
    ? value
    : TASK_TYPE_CUSTOM
  return (
    <label className="mpk-field">
      <span>任务类型</span>
      <select
        className="mpk-select"
        aria-label="任务类型"
        value={selectValue}
        onChange={event => {
          onChange(event.target.value)
        }}
      >
        <option value="">不指定</option>
        {TASK_TYPE_PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        <option value={TASK_TYPE_CUSTOM}>自定义</option>
      </select>
      {selectValue === TASK_TYPE_CUSTOM ? (
        <input
          className="mpk-input"
          maxLength={64}
          placeholder="例如：代码审查、文档改写"
          value={value === TASK_TYPE_CUSTOM ? '' : value}
          onChange={event => onChange(event.target.value)}
        />
      ) : null}
      <small className="mpk-meta">只作分类标签，不会改变提示词、工具或执行策略。</small>
    </label>
  )
}

function ModelOption({ model, checked, requiresImage, onChange }: { model: ModelListItem; checked: boolean; requiresImage: boolean; onChange(): void }): JSX.Element {
  const blocked = model.support !== 'SUPPORTED'
  const imageCapable = model.inputModalities.includes('image')
  const imageBlocked = requiresImage && !imageCapable
  return (
    <label className="mpk-model" data-disabled={blocked || imageBlocked} data-checked={checked}>
      <input type="checkbox" checked={checked} disabled={blocked || imageBlocked && !checked} onChange={onChange} />
      <span className="mpk-model-copy">
        <span className="mpk-model-name">{model.displayName}</span>
        <span className="mpk-model-sub">{model.providerDisplayName} · {model.modelId}</span>
        {model.supportReason ? <span className="mpk-model-sub">{model.supportReason}</span> : null}
      </span>
      {blocked
        ? <span className="mpk-pill mpk-pill-blocked">不可用</span>
        : requiresImage
          ? <span className={`mpk-pill ${imageCapable ? 'mpk-pill-ready' : 'mpk-pill-blocked'}`}>{imageCapable ? '支持图片' : '仅文本'}</span>
          : null}
    </label>
  )
}

function AttachmentList({ draft, controller }: { draft: UiSnapshot['draft'] & {}; controller: ModelPkUiController }): JSX.Element | null {
  if (draft.attachments.length === 0) return null
  const move = (from: number, direction: -1 | 1): void => {
    const next = [...draft.attachments.map(item => item.attachmentId)]
    const to = from + direction
    if (to < 0 || to >= next.length) return
    const item = next[from]!
    next[from] = next[to]!
    next[to] = item
    void controller.reorderAttachments(next)
  }
  return (
    <div className="mpk-attachment-list">
      {draft.attachments.map((attachment, index) => {
        const preview = controller.previewUrl(attachment.hash) ?? controller.previewUrl(attachment.name)
        return (
          <div className="mpk-attachment" key={attachment.attachmentId}>
            <span className="mpk-order">{index + 1}</span>
            {preview === null
              ? <span className="mpk-thumb" aria-hidden="true">{attachment.name.slice(0, 1).toUpperCase()}</span>
              : <img className="mpk-thumb" src={preview} alt={attachment.name} />}
            <span>
              <strong style={{ fontSize: 12 }}>{attachment.name}</strong>
              <span className="mpk-meta" style={{ display: 'block' }}>{attachment.mimeType} · {formatBytes(attachment.byteLength)}</span>
              <span className="mpk-hash" title={attachment.hash}>{maskHash(attachment.hash)}</span>
            </span>
            <span className="mpk-actions">
              <button className="mpk-btn mpk-btn-secondary mpk-btn-small" aria-label="上移" disabled={index === 0} type="button" onClick={() => move(index, -1)}>↑</button>
              <button className="mpk-btn mpk-btn-secondary mpk-btn-small" aria-label="下移" disabled={index === draft.attachments.length - 1} type="button" onClick={() => move(index, 1)}>↓</button>
              <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void controller.removeAttachment(attachment.attachmentId) }}>移除</button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function PreflightPage({ snapshot, controller }: { snapshot: UiSnapshot; controller: ModelPkUiController }): JSX.Element {
  const preflight = snapshot.preflight
  if (preflight === null) return <section className="mpk-page mpk-page-narrow"><Loading label="尚未生成 Preflight 快照" /><div className="mpk-actions"><button className="mpk-btn mpk-btn-secondary" onClick={() => controller.show('create')}>返回创建页</button></div></section>
  const confirmed = preflight.confirmedSnapshotHash === preflight.snapshotHash
  const needsImageConfirm = preflight.checks.some(check => check.id === 'modalities' && check.status === 'WARNING') && !confirmed
  const headline = preflight.status === 'BLOCKED' ? '已阻断' : needsImageConfirm ? '需确认' : '通过'
  return (
    <section className="mpk-page mpk-page-narrow">
      <div className="mpk-titlebar">
        <div>
          <div className="mpk-kicker">已冻结快照</div>
          <h1>预检 · {headline}</h1>
          <p>{preflight.taskPackage.taskName} · {preflight.models.length} 个模型 · 并发 {preflight.executionConditions.concurrency}</p>
        </div>
        <span className={`mpk-pill ${headline === '通过' ? 'mpk-pill-ready' : headline === '需确认' ? 'mpk-pill-warning' : 'mpk-pill-blocked'}`}>{headline}</span>
      </div>
      <div className="mpk-stack">
        <PreflightSummary value={preflight} />
        <div className="mpk-card">
          {preflight.checks.map(check => (
            <div className="mpk-check" key={check.id}>
              <span className={`mpk-pill ${checkBadge(check, confirmed).tone}`}>{checkBadge(check, confirmed).label}</span>
              <div>
                <div className="mpk-check-title">{check.label}</div>
                <div className="mpk-check-summary">{check.id === 'modalities' && check.status === 'WARNING' && confirmed ? '已由你确认这些模型支持图片。' : check.summary}</div>
                {checkTable(check).rows.length > 0 ? (
                  <table className="mpk-mini-table">
                    <thead><tr>{checkTable(check).headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
                    <tbody>{checkTable(check).rows.map(row => <tr key={row[0]}>{row.map(cell => <td key={cell}>{cell}</td>)}</tr>)}</tbody>
                  </table>
                ) : null}
              </div>
              <span className="mpk-meta">{check.id}</span>
              {check.status === 'BLOCKED' && (check.error || check.diagnostics) && checkTable(check).rows.length === 0 ? <details><summary>诊断</summary><pre className="mpk-mono">{JSON.stringify(check.diagnostics ?? check.error, null, 2)}</pre></details> : null}
            </div>
          ))}
        </div>
        {needsImageConfirm ? (
          <div className="mpk-card mpk-stack">
            <strong>需要你确认图片能力</strong>
            <p className="mpk-meta">上表中的模型未收录在锁定目录里。确认它们能识别图片后再继续。</p>
            <button className="mpk-btn" type="button" onClick={() => { void controller.confirmWarning() }}>我确认这些模型支持图片</button>
          </div>
        ) : null}
        <div className="mpk-card mpk-actions">
          <button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => controller.show('create')}>返回修改</button>
          <span className="mpk-space" />
          <button className="mpk-btn" type="button" disabled={snapshot.busy || preflight.status === 'BLOCKED' || needsImageConfirm} onClick={() => { void controller.startExperiment() }}>{snapshot.busy ? '正在持久化…' : '开始 PK'}</button>
        </div>
      </div>
    </section>
  )
}

function PreflightSummary({ value }: { value: PreflightSnapshot }): JSX.Element {
  return <div className="mpk-card mpk-stack"><div className="mpk-summary-grid"><Stat label="模型" value={String(value.models.length)} /><Stat label="图片" value={String(value.taskPackage.attachments.length)} /><Stat label="起始目录" value={value.taskPackage.baseline === null ? '未指定' : value.taskPackage.baseline.fileCount === 0 ? '全新空白' : formatBytes(value.taskPackage.baseline.byteLength)} /><Stat label="并发数" value={String(value.executionConditions.concurrency)} /><Stat label="容量估算" value={formatBytes(value.capacityEstimateBytes)} /></div><details className="mpk-diagnostics"><summary>指纹、Adapter 与权限诊断</summary><pre className="mpk-mono">{JSON.stringify({ snapshotHash: value.snapshotHash, taskPackageHash: value.taskPackageHash, resolvedHarnessFingerprint: value.resolvedHarnessFingerprint, executionConditionsHash: value.executionConditionsHash, models: value.models.map(model => ({ model: model.modelName, adapter: `${model.adapterPackage}@${model.adapterVersion}`, protocol: model.protocol, contextWindow: model.contextWindow, outputTokenCapacity: model.outputTokenCapacity, maxOutputTokens: model.maxOutputTokens, revision: model.revision, serializers: model.serializerDependencies, fingerprint: model.fingerprint })), permissions: value.resolvedHarness.permissions }, null, 2)}</pre></details></div>
}

function ExperimentPage({ snapshot, controller }: { snapshot: UiSnapshot; controller: ModelPkUiController }): JSX.Element {
  const experiment = snapshot.experiment
  const [compare, setCompare] = useState<string[]>([])
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  if (experiment === null) return <Loading label="尚未打开 Experiment" />
  const allAttempts = experiment.runs.flatMap(run => run.attempts.map(attempt => ({ run, attempt })))
  const sessionTargets = experiment.runs.flatMap(run => [...run.attempts].reverse().flatMap(attempt => attempt.dshSessionId === null ? [] : [{
    sessionId: attempt.dshSessionId,
    modelName: run.modelConfig.modelName,
    attemptNo: attempt.attemptNo,
    state: attempt.state,
  }]))
  const hasRetryableFailure = experiment.runs.some(run => {
    const latest = run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId)
    return latest !== undefined && (
      ['TIMED_OUT', 'STALLED', 'DISCONNECTED'].includes(latest.state)
      || latest.state === 'FAILED' && (latest.error?.retryable ?? false)
    )
  })
  const comparison = compare
    .map(id => allAttempts.find(item => item.attempt.attemptId === id))
    .filter((item): item is { run: Run; attempt: Attempt } => item !== undefined && isTextComparable(item.attempt))
  const toggleCompare = (attemptId: string): void => setCompare(current => current.includes(attemptId) ? current.filter(id => id !== attemptId) : current.length < 2 ? [...current, attemptId] : [current[1]!, attemptId])
  return (
    <section className="mpk-page">
      <div className="mpk-titlebar">
        <div>
          <div className="mpk-kicker">{lifecycleLabel(experiment.lifecycleState)} · {outcomeLabel(experiment.outcome)}</div>
          <h1>{experiment.name}</h1>
          <p>{experiment.experimentId} · 最后事件 {experiment.latestCursor}</p>
        </div>
        <div className="mpk-actions">
          <button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.openFolder(experiment.experimentId) }}>打开结果文件夹</button>
          {sessionTargets.length > 0 ? (
            <div className="mpk-session-picker">
              <button className="mpk-btn mpk-btn-secondary mpk-session-trigger" type="button" aria-haspopup="menu" aria-expanded={sessionMenuOpen} onClick={() => setSessionMenuOpen(open => !open)}>
                查看执行会话 <span aria-hidden="true">↗</span>
              </button>
              {sessionMenuOpen ? (
                <div className="mpk-session-menu" role="menu" aria-label="DeepSeek 执行会话">
                  <div className="mpk-session-menu-head"><span>DEEPSEEK HARNESS</span><strong>选择执行会话</strong></div>
                  <div className="mpk-session-menu-list">{sessionTargets.map(target => {
                    const label = `${target.modelName} · 第 ${target.attemptNo} 次 · ${attemptStateLabel(target.state)}`
                    return (
                      <button key={target.sessionId} type="button" role="menuitem" aria-label={label} onClick={() => {
                        setSessionMenuOpen(false)
                        void controller.openDshSession(target.sessionId)
                      }}>
                        <span className={`mpk-session-dot ${stateClass(target.state)}`} aria-hidden="true" />
                        <span className="mpk-session-menu-copy"><strong>{target.modelName}</strong><span>Attempt {target.attemptNo} · {attemptStateLabel(target.state)}</span></span>
                        <span className="mpk-session-arrow" aria-hidden="true">→</span>
                      </button>
                    )
                  })}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          {experiment.lifecycleState === 'ACTIVE' ? <button className="mpk-btn mpk-btn-danger" type="button" onClick={() => { if (confirm('停止当前实验的全部可取消执行？')) void controller.stopAll() }}>全部停止</button> : null}
          {hasRetryableFailure ? <button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.retryFailed() }}>重试失败项</button> : null}
        </div>
      </div>
      <div className="mpk-stack">
        <div className="mpk-summary-grid">
          <Stat label="排队" value={String(experiment.counts.queued)} />
          <Stat label="执行中" value={String(experiment.counts.active)} />
          <Stat label="收尾中" value={String(experiment.counts.finalizing)} />
          <Stat label="已完成" value={`${experiment.counts.finished}/${experiment.counts.total}`} />
          <Stat label="归档" value={archiveLabel(experiment.archiveFreshness, experiment.archiveIntegrity)} />
        </div>
        <div className="mpk-mode-guide" role="note">
          <strong>结果视图会自动适配产物</strong>
          <span>纯文本或单个文本文件可双栏对照；多文件、删除或二进制产物显示工程变更摘要。</span>
        </div>
        {experiment.recoveryNotice ? <div className="mpk-alert" role="status"><strong>正在恢复</strong>{experiment.recoveryNotice}</div> : null}
        <div className="mpk-run-grid">{experiment.runs.map(run => <RunCard key={run.runId} run={run} experiment={experiment} selected={compare} onToggleCompare={toggleCompare} controller={controller} />)}</div>
        {comparison.length > 0 ? (
          <section className="mpk-card">
            <h2 className="mpk-section-title">文本结果双栏对照 <span className="mpk-pill">不评分 · 不排序</span></h2>
            <div className="mpk-compare">
              {comparison.map(item => (
                <div className="mpk-compare-pane" key={item.attempt.attemptId}>
                  <div className="mpk-model-name" style={{ marginBottom: 8 }}>{item.run.modelConfig.modelName} · Attempt {item.attempt.attemptNo}</div>
                  <div className="mpk-meta" style={{ marginBottom: 8 }}>{comparisonSourceLabel(item.attempt)}</div>
                  <div className="mpk-output">{comparisonText(item.attempt) || '暂无输出'}</div>
                </div>
              ))}
              {comparison.length === 1 ? <div className="mpk-empty">再选择一路文本结果进行双栏对照</div> : null}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  )
}

function RunCard(props: { run: Run; experiment: ExperimentProjection; selected: readonly string[]; onToggleCompare(id: string): void; controller: ModelPkUiController }): JSX.Element {
  const latest = props.run.attempts.find(attempt => attempt.attemptId === props.run.latestAttemptId)!
  const cancellable = ['QUEUED', 'PREPARING', 'DISPATCHING', 'RUNNING', 'RECOVERING'].includes(latest.state)
  const retryable = ['TIMED_OUT', 'STALLED', 'DISCONNECTED'].includes(latest.state) || latest.state === 'FAILED' && (latest.error?.retryable ?? false)
  return (
    <article className="mpk-card mpk-run">
      <div className="mpk-run-head">
        <div><div className="mpk-kicker">第 {props.run.ordinal + 1} 路</div><h2>{props.run.modelConfig.modelName}</h2><div className="mpk-model-sub">{props.run.modelConfig.providerRoute} · {props.run.modelConfig.protocol}</div></div>
        <span className={`mpk-pill ${stateClass(latest.state)}`}>{attemptStateLabel(latest.state)}</span>
      </div>
      <AttemptResult attempt={latest} modelName={props.run.modelConfig.modelName} />
      {latest.resultExportError !== null ? <div className="mpk-alert" role="alert"><strong>结果导出失败</strong><span>{latest.resultExportError.userMessage}</span></div> : null}
      <div className="mpk-actions">
        {isTextComparable(latest) ? (
          <label className="mpk-inline-label">
            <input aria-label={`加入 ${props.run.modelConfig.modelName} 第 ${latest.attemptNo} 次执行对照`} type="checkbox" checked={props.selected.includes(latest.attemptId)} onChange={() => props.onToggleCompare(latest.attemptId)} />
            加入文本对照
          </label>
        ) : null}
        <span className="mpk-space" />
        {cancellable ? <button className="mpk-btn mpk-btn-danger mpk-btn-small" type="button" onClick={() => { void props.controller.stopAttempt(latest.attemptId, latest.lifecycleVersion) }}>停止</button> : null}
        {retryable ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.retry(props.run.runId, latest.attemptId) }}>重试</button> : null}
        {['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'STALLED', 'DISCONNECTED', 'CANCELLED'].includes(latest.state) ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.openResult(latest.attemptId) }}>打开结果目录</button> : null}
        {canExportProject(latest) ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" title="将该模型生成的全部项目文件导出到结果目录，可直接打开、运行或编辑。" onClick={() => { void props.controller.exportWorkspace(latest.attemptId) }}>导出完整项目</button> : null}
        {latest.state === 'SUCCEEDED' ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.runAgain(props.run.runId, latest.attemptId) }}>再跑一次</button> : null}
      </div>
      <details>
        <summary className="mpk-section-title">执行历史 ({props.run.attempts.length})</summary>
        <div className="mpk-history">{[...props.run.attempts].reverse().map(attempt => (
          <div className="mpk-history-row" key={attempt.attemptId}>
            {isTextComparable(attempt)
              ? <input aria-label={`选择 ${props.run.modelConfig.modelName} 第 ${attempt.attemptNo} 次执行文本对照`} type="checkbox" checked={props.selected.includes(attempt.attemptId)} onChange={() => props.onToggleCompare(attempt.attemptId)} />
              : <span className="mpk-pill">工程</span>}
            <span>#{attempt.attemptNo} · {triggerLabel(attempt.trigger)} · {attemptStateLabel(attempt.state)}<span className="mpk-meta" style={{ display: 'block' }}>{attempt.finalizedAt ?? attempt.queuedAt}</span></span>
            <span className={`mpk-pill ${attempt.archiveCompleteness === 'COMPLETE' ? 'mpk-pill-ready' : 'mpk-pill-warning'}`}>{archiveCompletenessLabel(attempt.archiveCompleteness)}</span>
          </div>
        ))}</div>
      </details>
      <details><summary className="mpk-section-title">产物与诊断</summary><p className="mpk-meta">文本结果会自动导出；完整工作区按需导出，避免重复占用磁盘。</p><pre className="mpk-mono">{JSON.stringify({ archiveCompleteness: latest.archiveCompleteness, workspaceSealState: latest.workspaceSealState, workspaceSummary: latest.workspaceSummary, tokenUsage: latest.tokenUsage, resultPath: latest.resultPath, resultExportError: latest.resultExportError, error: latest.error, archiveError: latest.archiveError, providerRequestId: latest.providerRequestId, fingerprints: { input: latest.inputFingerprint, effectiveInput: latest.effectiveInputHash, harness: latest.resolvedHarnessFingerprint } }, null, 2)}</pre></details>
    </article>
  )
}

function AttemptResult({ attempt, modelName }: { attempt: Attempt; modelName: string }): JSX.Element {
  const summary = attempt.workspaceSummary
  if (summary?.mode === 'ENGINEERING') {
    return (
      <section className="mpk-engineering" aria-label={`${modelName} 工程结果`}>
        <div className="mpk-engineering-head"><span className="mpk-pill">工程结果</span><strong>{summary.changedFileCount} 个文件发生变化</strong></div>
        <div className="mpk-change-counts">
          <span>新增 {summary.addedFileCount}</span><span>修改 {summary.modifiedFileCount}</span><span>删除 {summary.deletedFileCount}</span>
        </div>
        <div className="mpk-file-list">{summary.files.map(file => (
          <div className="mpk-file-row" key={`${file.changeType}:${file.path}`}><span className={`mpk-change-kind mpk-change-${file.changeType.toLowerCase()}`}>{fileChangeLabel(file.changeType)}</span><code>{file.path}</code><span>{file.byteLength === null ? '—' : formatBytes(file.byteLength)}</span></div>
        ))}</div>
        {summary.truncated ? <p className="mpk-meta">文件较多，仅展示前 {summary.files.length} 项。</p> : null}
        <div className="mpk-acceptance"><strong>验收测试未配置</strong><span>当前仅展示确定性的工作区变化，不会自动猜测并执行命令。</span></div>
        <AttemptMetrics attempt={attempt} />
        {(attempt.finalResponse ?? attempt.outputPreview).length > 0 ? <details><summary>查看模型说明</summary><div className="mpk-output mpk-output-compact">{attempt.finalResponse ?? attempt.outputPreview}</div></details> : null}
      </section>
    )
  }
  return (
    <section className="mpk-text-result">
      <div className="mpk-result-label">{comparisonSourceLabel(attempt)}</div>
      <div className="mpk-output" aria-label={`${modelName} 文本结果`}>{comparisonText(attempt) || '等待输出…'}</div>
      <AttemptMetrics attempt={attempt} />
    </section>
  )
}

function AttemptMetrics({ attempt }: { attempt: Attempt }): JSX.Element | null {
  const duration = attemptDuration(attempt)
  const tokenUsage = attempt.tokenUsage ?? null
  if (duration === null && tokenUsage === null) return null
  return (
    <div className="mpk-result-metrics">
      {duration === null ? null : <span>耗时 {duration}</span>}
      {tokenUsage === null ? <span>Token 暂无统计</span> : <span>{tokenUsage.inputTokens} 输入 · {tokenUsage.outputTokens} 输出</span>}
      {tokenUsage !== null && (tokenUsage.cacheReadTokens ?? 0) > 0 ? <span>缓存读取 {tokenUsage.cacheReadTokens}</span> : null}
    </div>
  )
}

function isTextComparable(attempt: Attempt): boolean {
  return attempt.workspaceSummary?.mode !== 'ENGINEERING' && comparisonText(attempt).length > 0
}

function canExportProject(attempt: Attempt): boolean {
  return attempt.state === 'SUCCEEDED'
    && (attempt.workspaceSummary == null || attempt.workspaceSummary.mode === 'ENGINEERING')
}

function comparisonText(attempt: Attempt): string {
  if (attempt.workspaceSummary?.mode === 'TEXT_FILE' && attempt.workspaceSummary.textContent !== null) return attempt.workspaceSummary.textContent
  return attempt.finalResponse ?? attempt.outputPreview
}

function comparisonSourceLabel(attempt: Attempt): string {
  if (attempt.workspaceSummary?.mode === 'TEXT_FILE' && attempt.workspaceSummary.textFilePath !== null) return `单文件文本 · ${attempt.workspaceSummary.textFilePath}`
  if (attempt.workspaceSummary?.mode === 'TEXT_RESPONSE') return '纯文本回复'
  return '模型最终回复'
}

function attemptDuration(attempt: Attempt): string | null {
  if (attempt.startedAt === null) return null
  const end = attempt.executionEndedAt ?? attempt.finalizedAt
  if (end === null) return null
  const milliseconds = Date.parse(end) - Date.parse(attempt.startedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  const seconds = Math.max(1, Math.round(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}秒` : `${minutes}分 ${seconds % 60}秒`
}

function fileChangeLabel(value: 'ADDED' | 'MODIFIED' | 'DELETED'): string {
  return { ADDED: '新增', MODIFIED: '修改', DELETED: '删除' }[value]
}

function StoragePage({ snapshot, controller }: { snapshot: UiSnapshot; controller: ModelPkUiController }): JSX.Element {
  const [reportExperiment, setReportExperiment] = useState<ExperimentProjection | null>(null)
  const openReport = async (experimentId: string): Promise<void> => {
    const experiment = await controller.loadExperimentReport(experimentId)
    if (experiment !== null) setReportExperiment(experiment)
  }
  return (
    <section className="mpk-page mpk-page-narrow">
      <div className="mpk-titlebar">
        <div><div className="mpk-kicker">Owner-only local archive</div><h1>本地存储管理</h1><p>这里管理插件内部归档；删除归档不会删除已经导出到用户目录的结果。</p></div>
        <button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.loadStorage() }}>刷新</button>
      </div>
      <div className="mpk-card">
        {snapshot.storage.length === 0 ? <div className="mpk-empty">没有可管理的终态实验</div> : (
          <table className="mpk-table mpk-storage-table">
            <thead><tr><th>实验</th><th>状态</th><th>时间</th><th>占用</th><th>操作</th></tr></thead>
            <tbody>{snapshot.storage.map(item => (
              <tr key={item.experimentId}>
                <td><strong>{item.name}</strong><div className="mpk-meta">{item.experimentId}</div></td>
                <td>{item.lifecycleState}<div className="mpk-meta">{item.outcome ?? '—'}</div></td>
                <td>{formatDate(item.settledAt ?? item.createdAt)}</td>
                <td>{formatBytes(item.byteLength)}</td>
                <td><div className="mpk-actions mpk-storage-actions">
                  <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void controller.openFolder(item.experimentId) }}>打开结果</button>
                  <button className="mpk-btn mpk-btn-small mpk-btn-report" type="button" aria-label={`生成“${item.name}”的实验报告`} onClick={() => { void openReport(item.experimentId) }}>实验报告</button>
                  <button className="mpk-btn mpk-btn-danger mpk-btn-small" disabled={!item.canDelete} title={item.blockedReason ?? ''} type="button" onClick={() => { if (confirm(`永久删除“${item.name}”的插件内部 Prompt、附件、证据和归档？已导出的用户结果会保留。`)) void controller.deleteExperiment(item.experimentId) }}>删除内部归档</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {reportExperiment === null ? null : <ExperimentReportDialog key={reportExperiment.experimentId} experiment={reportExperiment} onClose={() => setReportExperiment(null)} />}
    </section>
  )
}

function ExperimentReportDialog({ experiment, onClose }: { experiment: ExperimentProjection; onClose(): void }): JSX.Element {
  const [ranking, setRanking] = useState<readonly string[]>(() => loadQualityRanking(experiment))
  const [draggedRunId, setDraggedRunId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const report = useMemo(() => buildExperimentReport(experiment, ranking), [experiment, ranking])

  const move = (runId: string, offset: -1 | 1): void => {
    setFeedback(null)
    setRanking(current => {
      const next = [...current]
      const from = next.indexOf(runId)
      const to = from + offset
      if (from < 0 || to < 0 || to >= next.length) return current
      next.splice(from, 1)
      next.splice(to, 0, runId)
      return next
    })
  }
  const dropBefore = (targetRunId: string): void => {
    if (draggedRunId === null || draggedRunId === targetRunId) return
    setFeedback(null)
    setRanking(current => {
      const next = current.filter(runId => runId !== draggedRunId)
      const targetIndex = next.indexOf(targetRunId)
      next.splice(targetIndex < 0 ? next.length : targetIndex, 0, draggedRunId)
      return next
    })
    setDraggedRunId(null)
  }
  const save = (): void => {
    setRanking(saveQualityRanking(experiment, ranking))
    setFeedback('排名已保存')
  }
  const exportPng = async (): Promise<void> => {
    setExporting(true)
    setFeedback(null)
    try {
      const saved = saveQualityRanking(experiment, ranking)
      setRanking(saved)
      await exportExperimentReportPng(buildExperimentReport(experiment, saved))
      setFeedback('PNG 报告已导出')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'PNG 报告导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="mpk-modal-backdrop mpk-report-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="mpk-report-modal" role="dialog" aria-modal="true" aria-label={`实验报告 · ${experiment.name}`}>
        <header className="mpk-report-header">
          <div>
            <div className="mpk-report-eyebrow">MODEL PK / EVALUATION LEDGER</div>
            <h2>{experiment.name}</h2>
            <p>{formatDate(experiment.settledAt ?? experiment.createdAt)} · {report.rows.length} 个模型 · {outcomeLabel(experiment.outcome)}</p>
          </div>
          <button className="mpk-report-close" type="button" onClick={onClose} aria-label="关闭实验报告">×</button>
        </header>

        <div className="mpk-report-intro">
          <div><strong>人工质量排名</strong><span>拖拽整行，或使用上下箭头调整模型输出质量顺序。</span></div>
          <div className="mpk-report-facts"><span>{report.rows.filter(row => row.state === 'SUCCEEDED').length} 个成功</span><span>{formatReportNumber(sumReportTokens(report.rows))} Token</span></div>
        </div>

        <div className="mpk-report-table-wrap">
          <table className="mpk-report-table">
            <thead><tr><th>排名</th><th>模型</th><th>状态</th><th>用时</th><th>首次响应</th><th>请求</th><th>输入 Token</th><th>输出 Token</th><th>缓存读取</th><th>总 Token</th><th>产物</th><th>重试</th><th aria-label="排序操作" /></tr></thead>
            <tbody>{report.rows.map(row => (
              <tr key={row.runId} draggable onDragStart={() => setDraggedRunId(row.runId)} onDragEnd={() => setDraggedRunId(null)} onDragOver={event => event.preventDefault()} onDrop={() => dropBefore(row.runId)} data-dragged={draggedRunId === row.runId}>
                <td><span className={`mpk-rank mpk-rank-${Math.min(row.rank, 4)}`}>{row.rank}</span></td>
                <td><strong>{row.modelName}</strong><span className="mpk-report-provider">{row.providerName}</span></td>
                <td><span className={`mpk-report-state mpk-report-state-${row.state === 'SUCCEEDED' ? 'ok' : 'bad'}`}>{attemptStateLabel(row.state)}</span></td>
                <td>{formatReportDuration(row.durationMs)}</td>
                <td>{formatReportDuration(row.firstResponseMs)}</td>
                <td>{formatReportNumber(row.requestCount)}</td>
                <td>{formatReportNumber(row.inputTokens)}</td>
                <td>{formatReportNumber(row.outputTokens)}</td>
                <td>{formatReportNumber(row.cacheReadTokens)}</td>
                <td><strong>{formatReportNumber(row.totalTokens)}</strong></td>
                <td>{row.changedFileCount === null ? '—' : `${row.changedFileCount} 文件`}</td>
                <td>{Math.max(0, row.attemptCount - 1)}</td>
                <td><div className="mpk-rank-actions">
                  <span className="mpk-drag-handle" aria-hidden="true">⠿</span>
                  <button type="button" disabled={row.rank === 1} onClick={() => move(row.runId, -1)} aria-label={`将 ${row.modelName} 上移`}>↑</button>
                  <button type="button" disabled={row.rank === report.rows.length} onClick={() => move(row.runId, 1)} aria-label={`将 ${row.modelName} 下移`}>↓</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        <div className="mpk-ranking-preview">
          <span>模型输出质量优先级</span>
          <strong>{report.rankingLabel}</strong>
          <small>由用户根据实际输出人工评定，不代表平台自动评分。</small>
        </div>

        <footer className="mpk-report-footer">
          <div className="mpk-report-feedback" role="status">{feedback ?? 'PNG 将以 2× 清晰度导出，适合保存和分享。'}</div>
          <div className="mpk-actions">
            <button className="mpk-btn mpk-btn-secondary" type="button" onClick={onClose}>取消</button>
            <button className="mpk-btn mpk-btn-secondary" type="button" onClick={save}>保存排名</button>
            <button className="mpk-btn mpk-btn-report" type="button" disabled={exporting} onClick={() => { void exportPng() }}>{exporting ? '正在生成…' : '导出 PNG 报告'}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function sumReportTokens(rows: readonly ExperimentReportRow[]): number | null {
  return rows.reduce<number | null>((sum, row) => row.totalTokens === null ? sum : (sum ?? 0) + row.totalTokens, null)
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="mpk-stat"><div className="mpk-stat-value">{value}</div><div className="mpk-stat-label">{label}</div></div>
}

function Loading({ label }: { label: string }): JSX.Element {
  return <div className="mpk-empty" role="status">{label}</div>
}

function lifecycleLabel(state: ExperimentProjection['lifecycleState']): string {
  return { STARTING: '启动中', ACTIVE: '进行中', START_FAILED: '启动失败', SETTLED: '已结束' }[state]
}

function outcomeLabel(outcome: ExperimentProjection['outcome']): string {
  if (outcome === null) return '进行中'
  return { ALL_SUCCEEDED: '全部成功', PARTIAL_SUCCESS: '部分成功', NONE_SUCCEEDED: '全部失败', ALL_CANCELLED: '全部取消' }[outcome]
}

function archiveLabel(freshness: ExperimentProjection['archiveFreshness'], integrity: ExperimentProjection['archiveIntegrity']): string {
  const freshnessText = freshness === 'CURRENT' ? '最新' : '过期'
  const integrityText = integrity === 'COMPLETE' ? '完整' : integrity === 'PARTIAL' ? '部分完整' : '不完整'
  return `${freshnessText} / ${integrityText}`
}

function archiveCompletenessLabel(value: Attempt['archiveCompleteness']): string {
  return value === 'COMPLETE' ? '完整' : value === 'PARTIAL' ? '部分完整' : '不完整'
}

function attemptStateLabel(state: Attempt['state']): string {
  return {
    QUEUED: '排队', PREPARING: '准备中', DISPATCHING: '派发中', RUNNING: '执行中', RECOVERING: '恢复中',
    CANCELLING: '取消中', FINALIZING: '收尾中', SUCCEEDED: '成功', FAILED: '失败', TIMED_OUT: '超时',
    STALLED: '停滞', DISCONNECTED: '断线', CANCELLED: '已取消',
  }[state]
}

function triggerLabel(trigger: Attempt['trigger']): string {
  return { INITIAL: '首次', RETRY: '重试', RUN_AGAIN: '再跑', RETRY_FAILED: '批量重试' }[trigger]
}

function checkTable(check: { readonly id: string; readonly diagnostics?: Readonly<Record<string, unknown>>; readonly error?: { readonly details?: Readonly<Record<string, unknown>> } }): { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  if (check.id === 'modalities') {
    const rows = asObjectRows(check.diagnostics?.unverifiedModels)
    return {
      headers: ['模型', '原因'],
      rows: rows.flatMap(row => typeof row.model === 'string' && typeof row.reason === 'string' ? [[row.model, row.reason]] : []),
    }
  }
  if (check.id === 'models') {
    const rows = asObjectRows(check.diagnostics?.models ?? check.error?.details?.models)
    return {
      headers: ['模型', 'ID'],
      rows: rows.flatMap(row => typeof row.model === 'string' && typeof row.detail === 'string' ? [[row.model, row.detail]] : []),
    }
  }
  return { headers: [], rows: [] }
}

function asObjectRows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
}

function checkBadge(check: { readonly id: string; readonly status: string }, confirmed: boolean): { readonly label: string; readonly tone: string } {
  if (check.id === 'modalities' && check.status === 'WARNING' && confirmed) {
    return { label: '已确认', tone: 'mpk-pill-ready' }
  }
  if (check.status === 'PASS') return { label: '通过', tone: 'mpk-pill-ready' }
  if (check.status === 'WARNING') return { label: '需确认', tone: 'mpk-pill-warning' }
  return { label: '已阻断', tone: 'mpk-pill-blocked' }
}

function stateClass(state: string): string {
  return state === 'SUCCEEDED' ? 'mpk-pill-ready' : ['FAILED', 'TIMED_OUT', 'STALLED', 'DISCONNECTED'].includes(state) ? 'mpk-pill-failed' : state === 'CANCELLED' ? '' : 'mpk-pill-warning'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function maskHash(value: string): string {
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  if (digest.length <= 12) return value
  return `${value.startsWith('sha256:') ? 'sha256:' : ''}${digest.slice(0, 6)}******${digest.slice(-6)}`
}
