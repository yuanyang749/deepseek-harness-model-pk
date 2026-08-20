import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Attempt, DraftUpdateRequest, ExperimentProjection, ModelListItem, PreflightSnapshot, Run } from '../contracts/types.js'
import { LIMITS } from '../contracts/constants.js'
import type { ModelPkUiController, UiScreen, UiSnapshot } from './controller.js'
import { MODEL_PK_CSS } from './styles.js'

export function ModelPkSettingsSection({ controller }: { controller: ModelPkUiController }): JSX.Element {
  useEffect(() => {
    void controller.open()
  }, [controller])
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
      <div className="mpk-brand"><span className="mpk-brand-badge">PK</span><span>Model PK</span></div>
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
  const [dragging, setDragging] = useState(false)
  const filtered = useMemo(() => snapshot.models.filter(model => `${model.displayName} ${model.providerDisplayName} ${model.modelId}`.toLowerCase().includes(search.toLowerCase())), [snapshot.models, search])
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
    if (await persist()) await controller.runPreflight()
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
  const blockers = snapshot.capability?.blockers ?? []
  const selectedCount = form.selectedModelConfigIds.length
  const canPreflight = !snapshot.busy && selectedCount >= LIMITS.modelMin && form.prompt.trim() !== '' && draft.baseline !== null && (snapshot.capability?.executionEnabled ?? false)
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
              <h2 className="mpk-section-title">项目起始目录 {requiredMark()}</h2>
              <div className="mpk-baseline-guide">
                <p><strong>已有项目对照</strong>填写现成仓库或落地页目录。系统会完整复制一份快照，各模型从相同文件改起，互不影响，也不会改你的原目录。</p>
                <p><strong>全新项目对照</strong>填写一个空文件夹。各模型从同一空白起点从零生成，例如同时写一个落地页。</p>
                <p>两种情况都必须指定目录后再预检。复制时不应用 .gitignore，目录越大越久。</p>
              </div>
            </div>
            {draft.baseline === null ? (
              <div className="mpk-stack">
                <div className="mpk-actions">
                  <input className="mpk-input" aria-label="项目起始目录" placeholder="已有项目或空目录的绝对路径" value={baselinePath} onChange={event => setBaselinePath(event.target.value)} />
                  <button className="mpk-btn mpk-btn-secondary" type="button" onClick={async () => {
                    const path = await controller.chooseBaselineFolder()
                    if (path !== null) setBaselinePath(path)
                  }}>选择目录</button>
                  <button className="mpk-btn mpk-btn-secondary" disabled={baselinePath.trim() === ''} type="button" onClick={async () => { if (await persist()) await controller.selectBaseline(baselinePath) }}>复制为起始快照</button>
                </div>
                <small className="mpk-meta">可点「选择目录」用系统对话框，或直接粘贴绝对路径，再复制为快照。macOS 与 Windows 都支持。</small>
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
        </div>
        <aside className="mpk-rail">
          <div className="mpk-card mpk-models">
            <div className="mpk-models-head">
              <h2 className="mpk-section-title">模型 <span className="mpk-pill">{selectedCount} / {LIMITS.modelMax}</span></h2>
              <input className="mpk-input" aria-label="搜索模型" placeholder="搜索模型或提供商" value={search} onChange={event => setSearch(event.target.value)} />
            </div>
            <div className="mpk-model-list">{filtered.map(model => <ModelOption key={model.modelConfigId} model={model} checked={form.selectedModelConfigIds.includes(model.modelConfigId)} onChange={() => toggleModel(model)} />)}</div>
            <div className="mpk-rail-foot">
              <label className="mpk-field">
                <span>并发数</span>
                <select className="mpk-select" aria-label="并发数" value={Math.min(form.concurrency, Math.max(1, selectedCount))} onChange={event => setField('concurrency', Number(event.target.value))}>{Array.from({ length: Math.max(1, selectedCount) }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select>
                <small className="mpk-meta">同时执行的路数，默认 min(4, N)。排队不计入 30 分钟时限。</small>
              </label>
              <button className="mpk-btn mpk-btn-block" type="button" disabled={!canPreflight} onClick={() => { void preflight() }}>预检并继续</button>
              <button
                className="mpk-text-btn"
                type="button"
                onClick={() => {
                  if (confirm('清空当前填写的名称、提示词、图片、起始文件和模型选择，重新开始一份对照？已开始的实验不会被删除。')) {
                    void controller.newDraft()
                  }
                }}
              >清空并重新填写</button>
            </div>
          </div>
        </aside>
      </div>
    </section>
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

function ModelOption({ model, checked, onChange }: { model: ModelListItem; checked: boolean; onChange(): void }): JSX.Element {
  const blocked = model.support !== 'SUPPORTED'
  return (
    <label className="mpk-model" data-disabled={blocked} data-checked={checked}>
      <input type="checkbox" checked={checked} disabled={blocked} onChange={onChange} />
      <span className="mpk-model-copy">
        <span className="mpk-model-name">{model.displayName}</span>
        <span className="mpk-model-sub">{model.providerDisplayName} · {model.modelId}</span>
        {model.supportReason ? <span className="mpk-model-sub">{model.supportReason}</span> : null}
      </span>
      {blocked ? <span className="mpk-pill mpk-pill-blocked">不可用</span> : null}
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
          <button className="mpk-btn" type="button" disabled={snapshot.busy || preflight.status === 'BLOCKED' || needsImageConfirm} onClick={() => { void controller.startExperiment() }}>{snapshot.busy ? '正在持久化…' : '开始对照'}</button>
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
  if (experiment === null) return <Loading label="尚未打开 Experiment" />
  const allAttempts = experiment.runs.flatMap(run => run.attempts.map(attempt => ({ run, attempt })))
  const hasRetryableFailure = experiment.runs.some(run => {
    const latest = run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId)
    return latest !== undefined && (
      ['TIMED_OUT', 'STALLED', 'DISCONNECTED'].includes(latest.state)
      || latest.state === 'FAILED' && (latest.error?.retryable ?? false)
    )
  })
  const comparison = compare.map(id => allAttempts.find(item => item.attempt.attemptId === id)).filter((item): item is { run: Run; attempt: Attempt } => item !== undefined)
  const toggleCompare = (attemptId: string): void => setCompare(current => current.includes(attemptId) ? current.filter(id => id !== attemptId) : current.length < 2 ? [...current, attemptId] : [current[1]!, attemptId])
  return <section className="mpk-page"><div className="mpk-titlebar"><div><div className="mpk-kicker">{lifecycleLabel(experiment.lifecycleState)} · {outcomeLabel(experiment.outcome)}</div><h1>{experiment.name}</h1><p>{experiment.experimentId} · 最后事件 {experiment.latestCursor}</p></div><div className="mpk-actions"><button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.openFolder(experiment.experimentId) }}>打开文件夹</button>{experiment.lifecycleState === 'ACTIVE' ? <button className="mpk-btn mpk-btn-danger" type="button" onClick={() => { if (confirm('停止当前实验的全部可取消执行？')) void controller.stopAll() }}>全部停止</button> : null}{hasRetryableFailure ? <button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.retryFailed() }}>重试失败项</button> : null}</div></div><div className="mpk-stack"><div className="mpk-summary-grid"><Stat label="排队" value={String(experiment.counts.queued)} /><Stat label="执行中" value={String(experiment.counts.active)} /><Stat label="收尾中" value={String(experiment.counts.finalizing)} /><Stat label="已完成" value={`${experiment.counts.finished}/${experiment.counts.total}`} /><Stat label="归档" value={archiveLabel(experiment.archiveFreshness, experiment.archiveIntegrity)} /></div>{experiment.recoveryNotice ? <div className="mpk-alert" role="status"><strong>正在恢复</strong>{experiment.recoveryNotice}</div> : null}<div className="mpk-run-grid">{experiment.runs.map(run => <RunCard key={run.runId} run={run} experiment={experiment} events={snapshot.events} selected={compare} onToggleCompare={toggleCompare} controller={controller} />)}</div>{comparison.length > 0 ? <section className="mpk-card"><h2 className="mpk-section-title">原始结果双栏对照 <span className="mpk-pill">不评分 · 不排序</span></h2><div className="mpk-compare">{comparison.map(item => <div className="mpk-compare-pane" key={item.attempt.attemptId}><div className="mpk-model-name" style={{ marginBottom: 8 }}>{item.run.modelConfig.modelName} · Attempt {item.attempt.attemptNo}</div><div className="mpk-output">{(item.attempt.finalResponse ?? item.attempt.outputPreview) || '暂无输出'}</div></div>)}{comparison.length === 1 ? <div className="mpk-empty">再选择一路 Attempt 进行双栏对照</div> : null}</div></section> : null}</div></section>
}

function RunCard(props: { run: Run; experiment: ExperimentProjection; events: UiSnapshot['events']; selected: readonly string[]; onToggleCompare(id: string): void; controller: ModelPkUiController }): JSX.Element {
  const latest = props.run.attempts.find(attempt => attempt.attemptId === props.run.latestAttemptId)!
  const allRunEvents = props.events.filter(event => event.attemptId !== null && props.run.attempts.some(attempt => attempt.attemptId === event.attemptId))
  const runEvents = allRunEvents.slice(-100)
  const cancellable = ['QUEUED', 'PREPARING', 'DISPATCHING', 'RUNNING', 'RECOVERING'].includes(latest.state)
  const retryable = ['TIMED_OUT', 'STALLED', 'DISCONNECTED'].includes(latest.state) || latest.state === 'FAILED' && (latest.error?.retryable ?? false)
  return <article className="mpk-card mpk-run"><div className="mpk-run-head"><div><div className="mpk-kicker">第 {props.run.ordinal + 1} 路</div><h2>{props.run.modelConfig.modelName}</h2><div className="mpk-model-sub">{props.run.modelConfig.providerRoute} · {props.run.modelConfig.protocol}</div></div><span className={`mpk-pill ${stateClass(latest.state)}`}>{attemptStateLabel(latest.state)}</span></div><div className="mpk-output" aria-label={`${props.run.modelConfig.modelName} 原始输出`}>{(latest.finalResponse ?? latest.outputPreview) || '等待输出…'}</div><div className="mpk-actions"><label className="mpk-inline-label"><input type="checkbox" checked={props.selected.includes(latest.attemptId)} onChange={() => props.onToggleCompare(latest.attemptId)} />加入对照</label><span className="mpk-space" />{cancellable ? <button className="mpk-btn mpk-btn-danger mpk-btn-small" type="button" onClick={() => { void props.controller.stopAttempt(latest.attemptId, latest.lifecycleVersion) }}>停止</button> : null}{retryable ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.retry(props.run.runId, latest.attemptId) }}>重试</button> : null}{['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'STALLED', 'DISCONNECTED', 'CANCELLED'].includes(latest.state) ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.openResult(latest.attemptId) }}>打开结果目录</button> : null}{latest.state === 'SUCCEEDED' ? <button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void props.controller.runAgain(props.run.runId, latest.attemptId) }}>再跑一次</button> : null}</div><details><summary className="mpk-section-title">执行历史 ({props.run.attempts.length})</summary><div className="mpk-history">{[...props.run.attempts].reverse().map(attempt => <div className="mpk-history-row" key={attempt.attemptId}><input aria-label={`选择第 ${attempt.attemptNo} 次执行对照`} type="checkbox" checked={props.selected.includes(attempt.attemptId)} onChange={() => props.onToggleCompare(attempt.attemptId)} /><span>#{attempt.attemptNo} · {triggerLabel(attempt.trigger)} · {attemptStateLabel(attempt.state)}<span className="mpk-meta" style={{ display: 'block' }}>{attempt.finalizedAt ?? attempt.queuedAt}</span></span><span className={`mpk-pill ${attempt.archiveCompleteness === 'COMPLETE' ? 'mpk-pill-ready' : 'mpk-pill-warning'}`}>{archiveCompletenessLabel(attempt.archiveCompleteness)}</span></div>)}</div></details><details><summary className="mpk-section-title">日志与事件（最近 {runEvents.length} 条{allRunEvents.length > runEvents.length ? ` / 共 ${allRunEvents.length}` : ''}）</summary><p className="mpk-meta">界面只展示最近 100 条。完整记录在实验目录的 events.jsonl。</p><div className="mpk-event-list">{runEvents.map(event => <div className="mpk-event" key={event.cursor}><span>#{event.cursor}</span><span>{eventKindLabel(event.kind)}</span></div>)}</div></details><details><summary className="mpk-section-title">产物与诊断</summary><p className="mpk-meta">该次执行的全部产物都在结果目录里，不一定只有一个文件。</p><pre className="mpk-mono">{JSON.stringify({ archiveCompleteness: latest.archiveCompleteness, workspaceSealState: latest.workspaceSealState, error: latest.error, archiveError: latest.archiveError, providerRequestId: latest.providerRequestId, fingerprints: { input: latest.inputFingerprint, effectiveInput: latest.effectiveInputHash, harness: latest.resolvedHarnessFingerprint } }, null, 2)}</pre></details></article>
}

function StoragePage({ snapshot, controller }: { snapshot: UiSnapshot; controller: ModelPkUiController }): JSX.Element {
  return <section className="mpk-page mpk-page-narrow"><div className="mpk-titlebar"><div><div className="mpk-kicker">Owner-only local archive</div><h1>本地存储管理</h1><p>仅展示终态实验；数据永久保留，直到手动删除。</p></div><button className="mpk-btn mpk-btn-secondary" type="button" onClick={() => { void controller.loadStorage() }}>刷新</button></div><div className="mpk-card">{snapshot.storage.length === 0 ? <div className="mpk-empty">没有可管理的终态实验</div> : <table className="mpk-table"><thead><tr><th>实验</th><th>状态</th><th>时间</th><th>占用</th><th>操作</th></tr></thead><tbody>{snapshot.storage.map(item => <tr key={item.experimentId}><td><strong>{item.name}</strong><div className="mpk-meta">{item.experimentId}</div></td><td>{item.lifecycleState}<div className="mpk-meta">{item.outcome ?? '—'}</div></td><td>{formatDate(item.settledAt ?? item.createdAt)}</td><td>{formatBytes(item.byteLength)}</td><td><div className="mpk-actions"><button className="mpk-btn mpk-btn-secondary mpk-btn-small" type="button" onClick={() => { void controller.openFolder(item.experimentId) }}>打开</button><button className="mpk-btn mpk-btn-danger mpk-btn-small" disabled={!item.canDelete} title={item.blockedReason ?? ''} type="button" onClick={() => { if (confirm(`永久删除“${item.name}”及全部 Prompt、附件、结果和归档？`)) void controller.deleteExperiment(item.experimentId) }}>删除</button></div></td></tr>)}</tbody></table>}</div></section>
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

function eventKindLabel(kind: string): string {
  return {
    ATTEMPT_RUNTIME_EVENT: '运行事件',
    ATTEMPT_OUTPUT_DELTA: '输出增量',
    ATTEMPT_STATE_CHANGED: '状态变化',
    ATTEMPT_FINALIZED: '执行完成',
    DISPATCH_INTENT_RECORDED: '记录派发',
    DISPATCH_ACK_RECORDED: '派发确认',
  }[kind] ?? kind
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
