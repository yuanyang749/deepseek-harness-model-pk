import type { Attempt, ExperimentProjection } from '../contracts/types.js'

export interface ExperimentReportRow {
  readonly runId: string
  readonly rank: number
  readonly modelName: string
  readonly providerName: string
  readonly state: Attempt['state']
  readonly durationMs: number | null
  readonly firstResponseMs: number | null
  readonly requestCount: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly totalTokens: number | null
  readonly changedFileCount: number | null
  readonly attemptCount: number
}

export interface ExperimentReport {
  readonly experimentId: string
  readonly name: string
  readonly taskType: string
  readonly outcome: ExperimentProjection['outcome']
  readonly completedAt: string
  readonly rows: readonly ExperimentReportRow[]
  readonly rankingLabel: string
}

const RANKING_KEY_PREFIX = 'dsh-model-pk:quality-ranking:'

export function qualityRankingStorageKey(experimentId: string): string {
  return `${RANKING_KEY_PREFIX}${experimentId}`
}

export function normalizeQualityRanking(experiment: ExperimentProjection, ranking: readonly string[]): string[] {
  const available = new Set(experiment.runs.map(run => run.runId))
  const normalized: string[] = []
  for (const runId of ranking) {
    if (!available.has(runId) || normalized.includes(runId)) continue
    normalized.push(runId)
  }
  for (const run of [...experiment.runs].sort((left, right) => left.ordinal - right.ordinal)) {
    if (!normalized.includes(run.runId)) normalized.push(run.runId)
  }
  return normalized
}

export function loadQualityRanking(experiment: ExperimentProjection): string[] {
  const fallback = normalizeQualityRanking(experiment, [])
  try {
    const raw = localStorage.getItem(qualityRankingStorageKey(experiment.experimentId))
    if (raw === null) return fallback
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return fallback
    return normalizeQualityRanking(experiment, value)
  } catch {
    return fallback
  }
}

export function saveQualityRanking(experiment: ExperimentProjection, ranking: readonly string[]): string[] {
  const normalized = normalizeQualityRanking(experiment, ranking)
  localStorage.setItem(qualityRankingStorageKey(experiment.experimentId), JSON.stringify(normalized))
  return normalized
}

export function buildExperimentReport(experiment: ExperimentProjection, ranking: readonly string[]): ExperimentReport {
  const normalized = normalizeQualityRanking(experiment, ranking)
  const runs = new Map(experiment.runs.map(run => [run.runId, run]))
  const rows = normalized.map((runId, index): ExperimentReportRow => {
    const run = runs.get(runId)
    if (run === undefined) throw new Error(`报告排名包含未知 Run：${runId}`)
    const attempt = run.attempts.find(item => item.attemptId === run.latestAttemptId) ?? run.attempts.at(-1)
    if (attempt === undefined) throw new Error(`Run 没有可统计的 Attempt：${runId}`)
    const tokenUsage = attempt.tokenUsage
    return {
      runId,
      rank: index + 1,
      modelName: run.modelConfig.modelName,
      providerName: run.modelConfig.providerDisplayName,
      state: attempt.state,
      durationMs: elapsedMilliseconds(attempt.startedAt, attempt.executionEndedAt ?? attempt.finalizedAt),
      firstResponseMs: elapsedMilliseconds(attempt.startedAt, attempt.firstOutputAt),
      requestCount: tokenUsage?.requestCount ?? null,
      inputTokens: tokenUsage?.inputTokens ?? null,
      outputTokens: tokenUsage?.outputTokens ?? null,
      cacheReadTokens: tokenUsage?.cacheReadTokens ?? null,
      cacheWriteTokens: tokenUsage?.cacheWriteTokens ?? null,
      totalTokens: tokenUsage === null ? null : tokenUsage.inputTokens + tokenUsage.outputTokens,
      changedFileCount: attempt.workspaceSummary?.changedFileCount ?? null,
      attemptCount: run.attemptCount,
    }
  })
  return {
    experimentId: experiment.experimentId,
    name: experiment.name,
    taskType: experiment.taskType,
    outcome: experiment.outcome,
    completedAt: experiment.settledAt ?? experiment.createdAt,
    rows,
    rankingLabel: rows.map(row => row.modelName).join(' ＞ '),
  }
}

export function formatReportDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  const seconds = Math.max(1, Math.round(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}秒`
  return `${minutes}分${seconds % 60}秒`
}

export function formatReportNumber(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN').format(value)
}

export async function exportExperimentReportPng(report: ExperimentReport): Promise<void> {
  const scale = 2
  const width = 1320
  const rowHeight = 70
  const tableTop = 318
  const footerHeight = 196
  const height = tableTop + 48 + report.rows.length * rowHeight + footerHeight
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('当前浏览器无法创建图片画布')
  context.scale(scale, scale)
  context.textBaseline = 'middle'

  context.fillStyle = '#f3f0e8'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#171714'
  context.fillRect(0, 0, width, 244)
  context.fillStyle = '#c9ff54'
  context.fillRect(60, 42, 10, 34)
  context.font = '700 16px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText('MODEL PK  /  EVALUATION LEDGER', 88, 59)
  context.fillStyle = '#f8f7f0'
  context.font = '800 40px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  drawFittedText(context, report.name, 60, 116, 820)
  context.fillStyle = '#aaa99e'
  context.font = '500 16px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(`${report.taskType} · ${formatReportDate(report.completedAt)}`, 62, 161)

  const totalTokens = report.rows.reduce<number | null>((sum, row) => row.totalTokens === null ? sum : (sum ?? 0) + row.totalTokens, null)
  const fastest = report.rows.filter(row => row.durationMs !== null).sort((left, right) => (left.durationMs ?? 0) - (right.durationMs ?? 0))[0]
  drawHeaderMetric(context, 910, 64, '参与模型', `${report.rows.length}`)
  drawHeaderMetric(context, 1035, 64, '总 Token', formatReportNumber(totalTokens))
  drawHeaderMetric(context, 1160, 64, '最快完成', fastest === undefined ? '—' : formatReportDuration(fastest.durationMs))
  context.fillStyle = '#e1e1d8'
  context.font = '600 14px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(`结果：${outcomeLabel(report.outcome)}`, 912, 160)

  context.fillStyle = '#5f5d55'
  context.font = '700 13px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText('执行指标明细', 60, 280)
  context.fillStyle = '#77756d'
  context.font = '500 12px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText('Token 缺失时显示“—”，质量排名由用户人工评定', 935, 280)

  const columns = [
    { label: '排名', x: 60, width: 70 },
    { label: '模型', x: 130, width: 300 },
    { label: '状态', x: 430, width: 92 },
    { label: '用时', x: 522, width: 112 },
    { label: '首次响应', x: 634, width: 116 },
    { label: '输入', x: 750, width: 104 },
    { label: '输出', x: 854, width: 104 },
    { label: '总 Token', x: 958, width: 116 },
    { label: '产物', x: 1074, width: 96 },
    { label: '执行', x: 1170, width: 90 },
  ] as const
  context.fillStyle = '#dedbd2'
  context.fillRect(60, tableTop, 1200, 48)
  context.font = '700 12px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillStyle = '#5c5a52'
  for (const column of columns) context.fillText(column.label, column.x + 12, tableTop + 24)

  report.rows.forEach((row, index) => {
    const y = tableTop + 48 + index * rowHeight
    context.fillStyle = index % 2 === 0 ? '#fbfaf5' : '#eeebe3'
    context.fillRect(60, y, 1200, rowHeight - 1)
    drawRank(context, row.rank, 95, y + rowHeight / 2)
    context.fillStyle = '#1c1c18'
    context.font = '700 15px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    drawFittedText(context, row.modelName, 142, y + 28, 270)
    context.fillStyle = '#77756d'
    context.font = '500 11px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    drawFittedText(context, row.providerName, 142, y + 49, 270)
    context.fillStyle = row.state === 'SUCCEEDED' ? '#275c31' : '#8e2c25'
    context.font = '700 12px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(attemptStateLabel(row.state), 442, y + rowHeight / 2)
    context.fillStyle = '#34332e'
    context.font = '600 13px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(formatReportDuration(row.durationMs), 534, y + rowHeight / 2)
    context.fillText(formatReportDuration(row.firstResponseMs), 646, y + rowHeight / 2)
    context.fillText(formatReportNumber(row.inputTokens), 762, y + rowHeight / 2)
    context.fillText(formatReportNumber(row.outputTokens), 866, y + rowHeight / 2)
    context.font = '750 13px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(formatReportNumber(row.totalTokens), 970, y + rowHeight / 2)
    context.font = '600 13px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
    context.fillText(row.changedFileCount === null ? '—' : `${row.changedFileCount} 文件`, 1086, y + rowHeight / 2)
    context.fillText(`${row.attemptCount} 次`, 1182, y + rowHeight / 2)
  })

  const rankingTop = tableTop + 48 + report.rows.length * rowHeight + 42
  context.fillStyle = '#171714'
  roundedRect(context, 60, rankingTop, 1200, 112, 16)
  context.fillStyle = '#c9ff54'
  context.font = '700 12px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText('MODEL OUTPUT QUALITY', 84, rankingTop + 29)
  context.fillStyle = '#f8f7f0'
  context.font = '800 24px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  drawFittedText(context, report.rankingLabel, 84, rankingTop + 68, 1135)
  context.fillStyle = '#7a786f'
  context.font = '500 11px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(`Model PK · ${formatReportDate(new Date().toISOString())} 生成`, 60, height - 28)

  const blob = await canvasBlob(canvas)
  const href = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `${safeFilename(report.name)}-实验报告.png`
    anchor.click()
  } finally {
    URL.revokeObjectURL(href)
  }
}

function elapsedMilliseconds(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function formatReportDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function outcomeLabel(value: ExperimentProjection['outcome']): string {
  if (value === null) return '进行中'
  return { ALL_SUCCEEDED: '全部成功', PARTIAL_SUCCESS: '部分成功', NONE_SUCCEEDED: '全部失败', ALL_CANCELLED: '全部取消' }[value]
}

function attemptStateLabel(value: Attempt['state']): string {
  return {
    QUEUED: '排队', PREPARING: '准备', DISPATCHING: '派发', RUNNING: '运行', RECOVERING: '恢复', CANCELLING: '取消中',
    FINALIZING: '收尾', SUCCEEDED: '成功', FAILED: '失败', TIMED_OUT: '超时', STALLED: '停滞', DISCONNECTED: '断线', CANCELLED: '取消',
  }[value]
}

function drawHeaderMetric(context: CanvasRenderingContext2D, x: number, y: number, label: string, value: string): void {
  context.fillStyle = '#8d8c82'
  context.font = '600 11px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.fillText(label, x, y)
  context.fillStyle = '#f8f7f0'
  context.font = '800 20px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  drawFittedText(context, value, x, y + 28, 110)
}

function drawRank(context: CanvasRenderingContext2D, rank: number, x: number, y: number): void {
  const colors = ['#c9ff54', '#d9d9d2', '#d79558']
  context.beginPath()
  context.arc(x, y, 17, 0, Math.PI * 2)
  context.fillStyle = colors[rank - 1] ?? '#e3e0d7'
  context.fill()
  context.fillStyle = '#171714'
  context.font = '800 13px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif'
  context.textAlign = 'center'
  context.fillText(String(rank), x, y + 1)
  context.textAlign = 'left'
}

function drawFittedText(context: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number): void {
  if (context.measureText(value).width <= maxWidth) {
    context.fillText(value, x, y)
    return
  }
  let fitted = value
  while (fitted.length > 1 && context.measureText(`${fitted}…`).width > maxWidth) fitted = fitted.slice(0, -1)
  context.fillText(`${fitted}…`, x, y)
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fill()
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob === null ? reject(new Error('实验报告图片生成失败')) : resolve(blob), 'image/png')
  })
}

function safeFilename(value: string): string {
  const result = value.replace(/[\\/:*?"<>|]/g, '-').trim()
  return result.length === 0 ? 'Model-PK' : result
}
