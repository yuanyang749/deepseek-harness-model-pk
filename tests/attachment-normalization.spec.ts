import { describe, expect, it } from 'vitest'
import { assertCanonicalAttachmentReadback } from '../src/host/executor.js'

const REFERENCE = Object.freeze({
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
})

describe('canonical attachment verification', () => {
  it('accepts DSH-normalized bytes when the durable reference is unchanged', () => {
    expect(() => assertCanonicalAttachmentReadback(REFERENCE, {
      ref: REFERENCE,
      data: Uint8Array.of(1, 2, 3, 4),
    })).not.toThrow()
  })

  it('rejects a readback that resolves to a different durable reference', () => {
    expect(() => assertCanonicalAttachmentReadback(REFERENCE, {
      ref: { ...REFERENCE, attachmentId: `sha256:${'b'.repeat(64)}` },
      data: Uint8Array.of(1, 2, 3, 4),
    })).toThrow(/reference changed/u)
  })
})
