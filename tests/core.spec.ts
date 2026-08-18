import { describe, expect, it } from 'vitest'
import { canonicalize, hashCanonical, sha256Text } from '../src/core/jcs.js'
import { assertAttemptTransition, deriveExperimentOutcome, isRetryableTerminal } from '../src/core/state-machine.js'
import { validatePrompt, validateTaskName } from '../src/core/validation.js'

describe('JCS and hashes', () => {
  it('orders UTF-16 keys and normalizes ECMAScript numbers', () => {
    expect(canonicalize({ z: 1, a: -0, nested: { b: true, a: null } }))
      .toBe('{"a":0,"nested":{"a":null,"b":true},"z":1}')
    expect(canonicalize([333333333.33333329, 1e+30, 4.5, 2e-3, 1e-27]))
      .toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27]')
    expect(hashCanonical({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(sha256Text('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('rejects non-I-JSON input', () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/non-finite/u)
    expect(() => canonicalize('\ud800')).toThrow(/surrogate/u)
    expect(() => canonicalize({ value: undefined })).toThrow(/non-JSON/u)
  })
})

describe('validation and lifecycle', () => {
  it('enforces prompt and Unicode boundaries', () => {
    expect(() => validatePrompt('  \n')).toThrow(/whitespace-only/u)
    expect(() => validateTaskName('x'.repeat(121))).toThrow(/121/u)
    expect(() => validatePrompt('ok')).not.toThrow()
  })

  it('rejects illegal state edges and derives outcomes from latest attempts', () => {
    expect(() => assertAttemptTransition('QUEUED', 'RUNNING')).toThrow(/illegal attempt transition/u)
    expect(() => assertAttemptTransition('QUEUED', 'PREPARING')).not.toThrow()
    expect(isRetryableTerminal({ state: 'FAILED', error: null })).toBe(false)
    expect(isRetryableTerminal({ state: 'STALLED', error: null })).toBe(true)
    expect(deriveExperimentOutcome([
      { latestAttemptId: 'a', attempts: [{ attemptId: 'a', state: 'SUCCEEDED' }] },
      { latestAttemptId: 'b', attempts: [{ attemptId: 'b', state: 'FAILED' }] },
    ] as never)).toBe('PARTIAL_SUCCESS')
  })
})
