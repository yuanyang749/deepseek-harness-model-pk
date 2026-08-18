import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { resolve } from 'node:path'
import { LIMITS } from '../contracts/constants.js'
import { fail } from '../core/error.js'

export interface SandboxPaths {
  readonly attemptRoot: string
  readonly workspace: string
  readonly home: string
  readonly temp: string
}

export interface SandboxRunResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
}

const OUTPUT_LIMIT = 2 * 1024 * 1024

export class SeatbeltRunner {
  readonly executable = '/usr/bin/sandbox-exec'

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    try {
      await access(this.executable, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }

  normalizedPolicy(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      engine: 'macos-seatbelt',
      default: 'deny',
      network: 'deny-all',
      process: 'allow-child-processes',
      readable: ['$ATTEMPT_ROOT', '/System', '/usr', '/bin', '/sbin', '/Library/Apple'],
      writable: ['$WORKSPACE', '$PRIVATE_HOME', '$PRIVATE_TMP'],
      sharedTemp: 'denied',
      secretsEnvironment: 'empty-allowlist',
    })
  }

  async run(
    paths: SandboxPaths,
    command: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<SandboxRunResult> {
    if (!(await this.available())) {
      fail('EXECUTION_ISOLATION_UNSUPPORTED', 'sandbox', '当前系统不支持固定执行隔离', 'sandbox-exec is not available')
    }
    for (const path of [paths.attemptRoot, paths.workspace, paths.home, paths.temp]) {
      if (!resolve(path).startsWith(`${resolve(paths.attemptRoot)}/`) && resolve(path) !== resolve(paths.attemptRoot)) {
        fail('ARCHIVE_PATH_ESCAPE', 'sandbox', 'Attempt 路径越界', `sandbox path outside attempt root: ${path}`)
      }
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
    const policy = seatbeltPolicy(paths)
    const rewrittenCommand = command.replaceAll('/workspace', paths.workspace)
    const child = spawn(this.executable, [
      '-p', policy,
      '/bin/bash', '--noprofile', '--norc', '-c', rewrittenCommand,
    ], {
      cwd: paths.workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: paths.home,
        TMPDIR: `${paths.temp}/`,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        MODEL_PK_WORKSPACE: '/workspace',
      },
    })
    return collect(child, paths, options.signal, options.timeoutMs ?? LIMITS.executionTimeoutMs)
  }
}

function seatbeltPolicy(paths: SandboxPaths): string {
  const attempt = quoteSeatbelt(resolve(paths.attemptRoot))
  const workspace = quoteSeatbelt(resolve(paths.workspace))
  const home = quoteSeatbelt(resolve(paths.home))
  const temp = quoteSeatbelt(resolve(paths.temp))
  return `
(version 1)
(deny default)
(allow process*)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*
  (subpath ${attempt})
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library/Apple")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/random"))
(allow file-write*
  (subpath ${workspace})
  (subpath ${home})
  (subpath ${temp})
  (literal "/dev/null"))
(deny network*)
`
}

function quoteSeatbelt(value: string): string {
  return JSON.stringify(value)
}

function collect(
  child: ChildProcess,
  paths: SandboxPaths,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SandboxRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let finished = false
    const append = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= OUTPUT_LIMIT) { truncated = true; return current }
      const remaining = OUTPUT_LIMIT - current
      target.push(chunk.subarray(0, remaining))
      if (chunk.byteLength > remaining) truncated = true
      return current + Math.min(chunk.byteLength, remaining)
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes) })
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes) })
    const terminate = (): void => {
      if (child.pid === undefined || finished) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      setTimeout(() => {
        if (finished || child.pid === undefined) return
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }, LIMITS.cancelGraceMs).unref()
    }
    const timeout = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
    timeout.unref()
    const abort = (): void => { terminate() }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      rejectPromise(error)
    })
    child.on('close', (code, closeSignal) => {
      const pid = child.pid
      if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* process group already exited */ }
      }
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      const redact = (value: string): string => value
        .replaceAll(paths.workspace, '/workspace')
        .replaceAll(paths.attemptRoot, '/workspace')
        .replaceAll(paths.home, '/workspace/.model-pk-home')
        .replaceAll(paths.temp, '/workspace/.model-pk-tmp')
      resolvePromise({
        exitCode: code,
        signal: closeSignal,
        stdout: redact(Buffer.concat(stdout).toString('utf8')),
        stderr: redact(Buffer.concat(stderr).toString('utf8')),
        timedOut,
        truncated,
      })
    })
  })
}

export async function createIsolationFixture(root: string): Promise<SandboxPaths> {
  const attemptRoot = resolve(root)
  const paths = {
    attemptRoot,
    workspace: resolve(attemptRoot, 'workspace'),
    home: resolve(attemptRoot, 'home'),
    temp: resolve(attemptRoot, 'tmp'),
  }
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await mkdir(paths.temp, { recursive: true, mode: 0o700 })
  await writeFile(resolve(paths.workspace, '.model-pk-ready'), 'ready\n', { mode: 0o600 })
  return paths
}
