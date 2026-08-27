import { describe, expect, it } from 'vitest'
import { DSH_COMMIT, DSH_VERSION } from '../src/contracts/constants.js'

describe('locked DSH runtime', () => {
  it('targets the latest coherent DSH release', () => {
    expect(DSH_VERSION).toBe('0.1.1-rc.2')
    expect(DSH_COMMIT).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
  })
})
