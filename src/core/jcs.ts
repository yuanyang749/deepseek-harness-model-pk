import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Hash } from '../contracts/types.js'

/** RFC 8785 JSON Canonicalization Scheme for I-JSON-compatible values. */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>())
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      assertValidUnicode(value)
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS rejects non-finite numbers')
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'object': {
      if (stack.has(value)) throw new TypeError('JCS rejects cyclic values')
      stack.add(value)
      try {
        if (Array.isArray(value)) {
          return `[${value.map(item => {
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
              throw new TypeError('JCS rejects non-JSON array values')
            }
            return serialize(item, stack)
          }).join(',')}]`
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('JCS accepts only plain JSON objects')
        }
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        const entries: string[] = []
        for (const key of keys) {
          assertValidUnicode(key)
          const item = record[key]
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
            throw new TypeError(`JCS rejects non-JSON object property ${JSON.stringify(key)}`)
          }
          entries.push(`${JSON.stringify(key)}:${serialize(item, stack)}`)
        }
        return `{${entries.join(',')}}`
      } finally {
        stack.delete(value)
      }
    }
    default:
      throw new TypeError(`JCS rejects ${typeof value}`)
  }
}

export function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`invalid unpaired high surrogate at UTF-16 offset ${index}`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`invalid unpaired low surrogate at UTF-16 offset ${index}`)
    }
  }
}

export function sha256Bytes(value: Uint8Array): Hash {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function sha256Text(value: string): Hash {
  assertValidUnicode(value)
  return sha256Bytes(Buffer.from(value, 'utf8'))
}

export function hashCanonical(value: unknown): Hash {
  return sha256Text(canonicalize(value))
}

export async function sha256File(path: string): Promise<Hash> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return `sha256:${hash.digest('hex')}`
}

export function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

