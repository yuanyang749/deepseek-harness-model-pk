import type { ModelTokenUsage, WorkspaceFileChange, WorkspaceSummary } from '../contracts/types.js'
import type { NativeTreeEntry, NativeTreeManifest } from '../native/helper.js'

const MAX_TEXT_COMPARISON_BYTES = 1024 * 1024
const MAX_LISTED_CHANGES = 200

export async function buildWorkspaceSummary(
  baseline: Pick<NativeTreeManifest, 'entries'>,
  final: Pick<NativeTreeManifest, 'entries'>,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<WorkspaceSummary> {
  const baselineFiles = fileMap(baseline.entries)
  const finalFiles = fileMap(final.entries)
  const changes: WorkspaceFileChange[] = []

  for (const [path, entry] of finalFiles) {
    const previous = baselineFiles.get(path)
    if (previous === undefined) {
      changes.push({ path, changeType: 'ADDED', byteLength: entry.byteLength })
    } else if (!sameFile(previous, entry)) {
      changes.push({ path, changeType: 'MODIFIED', byteLength: entry.byteLength })
    }
  }
  for (const [path] of baselineFiles) {
    if (!finalFiles.has(path)) changes.push({ path, changeType: 'DELETED', byteLength: null })
  }
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

  const addedFileCount = changes.filter(item => item.changeType === 'ADDED').length
  const modifiedFileCount = changes.filter(item => item.changeType === 'MODIFIED').length
  const deletedFileCount = changes.filter(item => item.changeType === 'DELETED').length
  const files = changes.slice(0, MAX_LISTED_CHANGES)
  const common = {
    changedFileCount: changes.length,
    addedFileCount,
    modifiedFileCount,
    deletedFileCount,
    files,
    truncated: changes.length > files.length,
  }

  if (changes.length === 0) {
    return { ...common, mode: 'TEXT_RESPONSE', textFilePath: null, textContent: null }
  }
  const only = changes[0]!
  if (changes.length !== 1 || only.changeType === 'DELETED' || (only.byteLength ?? 0) > MAX_TEXT_COMPARISON_BYTES) {
    return { ...common, mode: 'ENGINEERING', textFilePath: null, textContent: null }
  }
  try {
    const bytes = await readFile(only.path)
    if (bytes.byteLength > MAX_TEXT_COMPARISON_BYTES) {
      return { ...common, mode: 'ENGINEERING', textFilePath: null, textContent: null }
    }
    const textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ...common, mode: 'TEXT_FILE', textFilePath: only.path, textContent }
  } catch {
    return { ...common, mode: 'ENGINEERING', textFilePath: null, textContent: null }
  }
}

export function summarizeTokenUsage(transcript: string): ModelTokenUsage | null {
  const total: { requestCount: number; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheReadTokensReported: boolean; cacheWriteTokens: number } = {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheReadTokensReported: false,
    cacheWriteTokens: 0,
  }
  for (const line of transcript.split('\n')) {
    if (line.length === 0) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!isRecord(event) || event.type !== 'assistant/chunk' || !isRecord(event.data)
      || !isRecord(event.data.chunk) || event.data.chunk.type !== 'usage' || !isRecord(event.data.chunk.usage)) continue
    const usage = event.data.chunk.usage
    total.requestCount += 1
    total.inputTokens += tokenCount(usage.inputTokens)
    total.outputTokens += tokenCount(usage.outputTokens)
    const cacheReadTokens = reportedTokenCount(usage.cacheReadTokens)
    if (cacheReadTokens !== null) {
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + cacheReadTokens
      total.cacheReadTokensReported = true
    }
    total.cacheWriteTokens += tokenCount(usage.cacheWriteTokens)
  }
  return total.requestCount === 0 ? null : total
}

function fileMap(entries: readonly NativeTreeEntry[]): Map<string, NativeTreeEntry> {
  return new Map(entries
    .filter(entry => entry.kind === 'FILE' && !isInternalPath(entry.path))
    .map(entry => [entry.path, entry]))
}

function isInternalPath(path: string): boolean {
  return path === '.model-pk-ready' || path === '.model-pk-artifacts' || path.startsWith('.model-pk-artifacts/')
}

function sameFile(left: NativeTreeEntry, right: NativeTreeEntry): boolean {
  if (left.hash !== undefined || right.hash !== undefined) return left.hash === right.hash
  return left.byteLength === right.byteLength && left.mode === right.mode
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function reportedTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
