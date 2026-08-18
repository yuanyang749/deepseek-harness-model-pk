import { randomBytes, randomUUID } from 'node:crypto'
import type { UUID } from '../contracts/types.js'

export function uuid(): UUID {
  return randomUUID()
}

export function fencingToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sessionIdForAttempt(attemptId: UUID): string {
  return attemptId
}

