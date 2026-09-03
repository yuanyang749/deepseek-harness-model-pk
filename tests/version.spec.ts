import { describe, expect, it } from 'vitest'
import { DSH_BUILD_COMMIT, DSH_BUILD_VERSION } from '../src/contracts/constants.js'

describe('validated DSH build baseline', () => {
  it('records the DSH release covered by build-time fixtures', () => {
    expect(DSH_BUILD_VERSION).toBe('0.1.1-rc.2')
    expect(DSH_BUILD_COMMIT).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
  })
})
