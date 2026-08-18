import { describe, expect, it } from 'vitest'
import { RPC_ENDPOINTS } from '../src/contracts/rpc.js'
import { createBusinessRpcHandler } from '../src/host/rpc-router.js'
import { fixtureCapability, fixtureDraft } from './fixtures.js'

function services(): Parameters<typeof createBusinessRpcHandler>[0] {
  return {
    compatibility: () => ({ report: fixtureCapability(), checks: [] }),
    drafts: {
      create: async () => fixtureDraft(),
      get: () => fixtureDraft(),
    } as never,
    preflight: {} as never,
    models: { list: async () => [] } as never,
    coordinator: {} as never,
  }
}

describe('RPC boundary', () => {
  it('returns nested application results through the DSH transport envelope', async () => {
    const handler = createBusinessRpcHandler(services())
    const response = await handler(RPC_ENDPOINTS.capabilitiesGet, {}, new AbortController().signal)
    expect(response.ok).toBe(true)
    expect(response.value.ok).toBe(true)
    if (response.value.ok) expect(response.value.value).toMatchObject({ executionEnabled: true })
  })

  it('rejects unknown fields and unsupported endpoints without throwing across transport', async () => {
    const handler = createBusinessRpcHandler(services())
    const invalid = await handler(RPC_ENDPOINTS.draftGet, { draftId: fixtureDraft().draftId, extra: true }, new AbortController().signal)
    expect(invalid.value.ok).toBe(false)
    if (!invalid.value.ok) expect(invalid.value.error.code).toBe('VALIDATION_ERROR')
    const unsupported = await handler('v1/not-real', {}, new AbortController().signal)
    expect(unsupported.value.ok).toBe(false)
  })
})
