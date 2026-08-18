import {
  NON_TERMINAL_ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
} from '../contracts/constants.js'
import type {
  Attempt,
  AttemptState,
  AttemptTerminalState,
  ExperimentCounts,
  ExperimentOutcome,
  Run,
} from '../contracts/types.js'
import { fail } from './error.js'

const TERMINAL = new Set<AttemptState>(TERMINAL_ATTEMPT_STATES)
const NON_TERMINAL = new Set<AttemptState>(NON_TERMINAL_ATTEMPT_STATES)

const TRANSITIONS: Readonly<Record<AttemptState, ReadonlySet<AttemptState>>> = {
  QUEUED: new Set(['PREPARING', 'FINALIZING']),
  PREPARING: new Set(['DISPATCHING', 'RECOVERING', 'CANCELLING', 'FINALIZING']),
  DISPATCHING: new Set(['RUNNING', 'RECOVERING', 'CANCELLING', 'FINALIZING']),
  RUNNING: new Set(['RECOVERING', 'CANCELLING', 'FINALIZING']),
  RECOVERING: new Set(['PREPARING', 'DISPATCHING', 'RUNNING', 'CANCELLING', 'FINALIZING']),
  CANCELLING: new Set(['RUNNING', 'RECOVERING', 'FINALIZING']),
  FINALIZING: new Set(TERMINAL_ATTEMPT_STATES),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  TIMED_OUT: new Set(),
  STALLED: new Set(),
  DISCONNECTED: new Set(),
  CANCELLED: new Set(),
}

export function isTerminalAttemptState(state: AttemptState): state is AttemptTerminalState {
  return TERMINAL.has(state)
}

export function isNonTerminalAttemptState(state: AttemptState): boolean {
  return NON_TERMINAL.has(state)
}

export function assertAttemptTransition(from: AttemptState, to: AttemptState): void {
  if (!TRANSITIONS[from].has(to)) {
    fail('CONFLICT', 'lifecycle', 'Attempt 状态已变化，请刷新后重试', `illegal attempt transition ${from} -> ${to}`)
  }
}

export function isCancellableState(state: AttemptState): boolean {
  return state === 'QUEUED' || state === 'PREPARING' || state === 'DISPATCHING'
    || state === 'RUNNING' || state === 'RECOVERING'
}

export function isRetryableTerminal(attempt: Pick<Attempt, 'state' | 'error'>): boolean {
  if (attempt.state === 'TIMED_OUT' || attempt.state === 'STALLED' || attempt.state === 'DISCONNECTED') return true
  return attempt.state === 'FAILED' && (attempt.error?.retryable ?? false)
}

export function deriveExperimentOutcome(runs: readonly Pick<Run, 'attempts' | 'latestAttemptId'>[]): ExperimentOutcome {
  if (runs.length === 0) return null
  const latest = runs.map(run => run.attempts.find(attempt => attempt.attemptId === run.latestAttemptId))
  if (latest.some(attempt => attempt === undefined || !isTerminalAttemptState(attempt.state))) return null
  const states = latest.map(attempt => attempt!.state as AttemptTerminalState)
  const succeeded = states.filter(state => state === 'SUCCEEDED').length
  const cancelled = states.filter(state => state === 'CANCELLED').length
  if (succeeded === states.length) return 'ALL_SUCCEEDED'
  if (succeeded > 0) return 'PARTIAL_SUCCESS'
  if (cancelled === states.length) return 'ALL_CANCELLED'
  return 'NONE_SUCCEEDED'
}

export function deriveCounts(attempts: readonly Pick<Attempt, 'state'>[]): ExperimentCounts {
  let queued = 0
  let active = 0
  let finalizing = 0
  let finished = 0
  for (const attempt of attempts) {
    if (attempt.state === 'QUEUED') queued += 1
    else if (attempt.state === 'FINALIZING') finalizing += 1
    else if (isTerminalAttemptState(attempt.state)) finished += 1
    else active += 1
  }
  return { queued, active, finalizing, finished, total: attempts.length }
}

export function attemptStateClass(state: AttemptState): 'queued' | 'active' | 'finalizing' | 'finished' {
  if (state === 'QUEUED') return 'queued'
  if (state === 'FINALIZING') return 'finalizing'
  if (isTerminalAttemptState(state)) return 'finished'
  return 'active'
}

