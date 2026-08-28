import { describe, expect, it } from 'vitest'
import type { NativeTreeManifest } from '../src/native/helper.js'
import { buildWorkspaceSummary, summarizeTokenUsage } from '../src/host/workspace-summary.js'

function manifest(files: Readonly<Record<string, { readonly hash: `sha256:${string}`; readonly content: string }>>): NativeTreeManifest {
  const entries = Object.entries(files).map(([path, value]) => ({
    path,
    kind: 'FILE' as const,
    byteLength: Buffer.byteLength(value.content),
    mode: 0o600,
    hash: value.hash,
  }))
  return {
    schemaVersion: 1,
    rootDevice: 1,
    byteLength: entries.reduce((total, entry) => total + entry.byteLength, 0),
    fileCount: entries.length,
    directoryCount: 0,
    entries,
    treeHash: `sha256:${'0'.repeat(64)}`,
  }
}

const empty = manifest({})

describe('adaptive workspace comparison', () => {
  it('uses the final response when the workspace has no user file changes', async () => {
    const summary = await buildWorkspaceSummary(empty, manifest({
      '.model-pk-ready': { hash: 'sha256:ready', content: 'ready\n' },
    }), async () => { throw new Error('should not read an internal file') })

    expect(summary).toMatchObject({
      mode: 'TEXT_RESPONSE',
      changedFileCount: 0,
      addedFileCount: 0,
      modifiedFileCount: 0,
      deletedFileCount: 0,
      textFilePath: null,
      textContent: null,
    })
  })

  it('uses the real UTF-8 content when exactly one file is added', async () => {
    const summary = await buildWorkspaceSummary(empty, manifest({
      'story.md': { hash: 'sha256:story', content: '# 故事\n' },
    }), async path => {
      expect(path).toBe('story.md')
      return Buffer.from('# 故事\n')
    })

    expect(summary).toMatchObject({
      mode: 'TEXT_FILE',
      changedFileCount: 1,
      addedFileCount: 1,
      textFilePath: 'story.md',
      textContent: '# 故事\n',
      files: [{ path: 'story.md', changeType: 'ADDED' }],
    })
  })

  it('uses engineering comparison for multiple, deleted, or binary files', async () => {
    const baseline = manifest({
      'old.txt': { hash: 'sha256:old', content: 'old' },
    })
    const multiple = await buildWorkspaceSummary(baseline, manifest({
      'index.html': { hash: 'sha256:html', content: '<main />' },
      'style.css': { hash: 'sha256:css', content: 'main{}' },
    }), async () => { throw new Error('multi-file summaries must not load contents') })
    expect(multiple).toMatchObject({
      mode: 'ENGINEERING',
      changedFileCount: 3,
      addedFileCount: 2,
      deletedFileCount: 1,
    })

    const binary = await buildWorkspaceSummary(empty, manifest({
      'cover.bin': { hash: 'sha256:binary', content: 'placeholder' },
    }), async () => Buffer.from([0xff, 0xfe, 0xfd]))
    expect(binary).toMatchObject({ mode: 'ENGINEERING', changedFileCount: 1 })
  })

  it('aggregates usage chunks without double-counting assistant messages', () => {
    const transcript = [
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 } } } },
      { type: 'assistant/message', data: { message: { usage: { inputTokens: 100, outputTokens: 20 } } } },
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 15, outputTokens: 5, cacheWriteTokens: 3 } } } },
    ].map(value => JSON.stringify(value)).join('\n')

    expect(summarizeTokenUsage(transcript)).toEqual({
      requestCount: 2,
      inputTokens: 115,
      outputTokens: 25,
      cacheReadTokens: 40,
      cacheReadTokensReported: true,
      cacheWriteTokens: 3,
    })
    expect(summarizeTokenUsage('{"type":"assistant/message"}\n')).toBeNull()
  })

  it('distinguishes an omitted cache-read metric from an explicit zero', () => {
    const withoutCacheMetric = JSON.stringify({
      type: 'assistant/chunk',
      data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } },
    })
    const explicitCacheMiss = JSON.stringify({
      type: 'assistant/chunk',
      data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } },
    })

    expect(summarizeTokenUsage(withoutCacheMetric)).toMatchObject({
      cacheReadTokens: null,
      cacheReadTokensReported: false,
    })
    expect(summarizeTokenUsage(explicitCacheMiss)).toMatchObject({
      cacheReadTokens: 0,
      cacheReadTokensReported: true,
    })
  })
})
