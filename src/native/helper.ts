import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Hash } from '../contracts/types.js'
import { PLUGIN_VERSION } from '../contracts/constants.js'
import { fail } from '../core/error.js'

export interface NativeVersion {
  readonly version: string
  readonly protocolVersion: number
  readonly platform: string
  readonly arch: string
  readonly features: readonly string[]
}

export interface NativeTreeEntry {
  readonly path: string
  readonly kind: 'FILE' | 'DIRECTORY'
  readonly byteLength: number
  readonly mode: number
  readonly hash?: Hash
}

export interface NativeTreeManifest {
  readonly schemaVersion: number
  readonly rootDevice: number
  readonly byteLength: number
  readonly fileCount: number
  readonly directoryCount: number
  readonly entries: readonly NativeTreeEntry[]
  readonly treeHash: Hash
}

export type NativeTreeSummary = Omit<NativeTreeManifest, 'entries'> & { readonly manifestPath: string }

interface HelperResponse<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

export interface NativeHelperProbe {
  readonly path: string
  readonly hash: Hash
  readonly version: NativeVersion
}

export interface NativeSandboxPaths {
  readonly attemptRoot: string
  readonly workspace: string
  readonly home: string
  readonly temp: string
}

export interface NativeSandboxRunResult {
  readonly exitCode: number | null
  readonly signal: null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
}

const SANDBOX_ACL_TIMEOUT_MS = 10 * 60 * 1000

export class NativeHelper {
  private constructor(readonly probe: NativeHelperProbe) {}

  static unavailable(): NativeHelper {
    return new NativeHelper({
      path: '',
      hash: `sha256:${'0'.repeat(64)}`,
      version: { version: '', protocolVersion: 0, platform: process.platform, arch: process.arch, features: [] },
    })
  }

  static async locate(options: { readonly explicitPath?: string; readonly allowDevBinary?: boolean } = {}): Promise<NativeHelper> {
    const candidates: { path: string; expectedHash?: string }[] = []
    if (options.explicitPath !== undefined) candidates.push({ path: resolve(options.explicitPath) })
    if (process.env.MODEL_PK_HELPER !== undefined) candidates.push({ path: resolve(process.env.MODEL_PK_HELPER) })
    const packageName = nativePackageName(process.platform, process.arch)
    if (packageName !== null) {
      try {
        const require = createRequire(import.meta.url)
        const packageJsonPath = require.resolve(`${packageName}/package.json`)
        const manifest = JSON.parse(await readFile(join(dirname(packageJsonPath), 'manifest.json'), 'utf8')) as { sha256?: unknown }
        candidates.push({
          path: join(dirname(packageJsonPath), 'bin', nativeExecutableName(process.platform)),
          ...(typeof manifest.sha256 === 'string' && manifest.sha256 !== 'UNBUILT' ? { expectedHash: manifest.sha256 } : {}),
        })
      } catch { /* optional package absent */ }
    }
    if (options.allowDevBinary ?? process.env.NODE_ENV !== 'production') {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
      const executable = nativeExecutableName(process.platform)
      candidates.push({ path: join(packageRoot, 'native', 'model-pk-helper', 'target', 'debug', executable) })
      candidates.push({ path: join(packageRoot, 'native', 'model-pk-helper', 'target', 'release', executable) })
      candidates.push({ path: resolve('native', 'model-pk-helper', 'target', 'debug', executable) })
      candidates.push({ path: resolve('native', 'model-pk-helper', 'target', 'release', executable) })
    }
    for (const candidate of candidates) {
      try {
        await access(candidate.path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        const bytes = await readFile(candidate.path)
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (candidate.expectedHash !== undefined && candidate.expectedHash !== digest) continue
        const helper = new NativeHelper({
          path: candidate.path,
          hash: `sha256:${digest}`,
          version: { version: '', protocolVersion: 0, platform: '', arch: '', features: [] },
        })
        const version = await helper.call<NativeVersion>({ command: 'version' })
        if (version.version !== PLUGIN_VERSION || version.protocolVersion !== 1
          || version.platform !== process.platform || version.arch !== process.arch) continue
        return new NativeHelper({ path: candidate.path, hash: `sha256:${digest}`, version })
      } catch { /* try next candidate */ }
    }
    fail('NATIVE_HELPER_UNAVAILABLE', 'native-helper', '原生隔离组件未安装或校验失败', `no valid helper for ${process.platform}/${process.arch}`)
  }

  async reserve(path: string, byteLength: number): Promise<void> {
    await this.call({ command: 'reserve', path, byte_length: byteLength })
  }

  async scan(root: string, maxBytes: number, maxFiles: number): Promise<NativeTreeManifest> {
    return this.call({ command: 'scan', root, max_bytes: maxBytes, max_files: maxFiles })
  }

  async snapshot(sourceRoot: string, objectRoot: string, maxBytes: number, maxFiles: number): Promise<NativeTreeManifest> {
    return this.call({ command: 'snapshot', source_root: sourceRoot, object_root: objectRoot, max_bytes: maxBytes, max_files: maxFiles })
  }

  async scanTo(root: string, manifestPath: string, maxBytes: number, maxFiles: number): Promise<NativeTreeSummary> {
    return this.call({ command: 'scan-to', root, manifest_path: manifestPath, max_bytes: maxBytes, max_files: maxFiles })
  }

  async snapshotTo(sourceRoot: string, objectRoot: string, manifestPath: string, maxBytes: number, maxFiles: number): Promise<NativeTreeSummary> {
    return this.call({
      command: 'snapshot-to',
      source_root: sourceRoot,
      object_root: objectRoot,
      manifest_path: manifestPath,
      max_bytes: maxBytes,
      max_files: maxFiles,
    })
  }

  async materialize(manifestPath: string, objectRoot: string, destinationRoot: string): Promise<{ treeHash: Hash; fileCount: number; byteLength: number }> {
    return this.call({ command: 'materialize', manifest_path: manifestPath, object_root: objectRoot, destination_root: destinationRoot })
  }

  async read(root: string, path: string, maxBytes: number): Promise<{ byteLength: number; hash: Hash; bytesBase64: string }> {
    return this.call({ command: 'read', root, path, max_bytes: maxBytes })
  }

  async write(input: {
    root: string
    path: string
    bytesBase64: string
    executable?: boolean
    leasePath: string
    fencingToken: string
  }): Promise<{ byteLength: number; hash: Hash }> {
    return this.call({
      command: 'write',
      root: input.root,
      path: input.path,
      bytes_base64: input.bytesBase64,
      executable: input.executable ?? false,
      lease_path: input.leasePath,
      fencing_token: input.fencingToken,
    })
  }

  async replace(input: {
    root: string
    path: string
    old: string
    replacement: string
    all?: boolean
    leasePath: string
    fencingToken: string
  }): Promise<{ replacements: number; byteLength: number; hash: Hash }> {
    return this.call({
      command: 'replace',
      root: input.root,
      path: input.path,
      old: input.old,
      new: input.replacement,
      all: input.all ?? false,
      lease_path: input.leasePath,
      fencing_token: input.fencingToken,
    })
  }

  async slotWrite(path: string, generation: number, payload: Uint8Array): Promise<{ generation: number; checksum: Hash }> {
    return this.call({ command: 'slot-write', path, generation, payload_base64: Buffer.from(payload).toString('base64') })
  }

  async slotRead(path: string): Promise<{ generation: number; checksum: Hash; payloadBase64: string }> {
    return this.call({ command: 'slot-read', path })
  }

  async prepareSandbox(paths: NativeSandboxPaths): Promise<void> {
    await this.call({
      command: 'sandbox-prepare',
      attempt_root: paths.attemptRoot,
      writable_roots: [paths.workspace, paths.home, paths.temp],
    }, { timeoutMs: SANDBOX_ACL_TIMEOUT_MS })
  }

  async runSandbox(
    paths: NativeSandboxPaths,
    commandText: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs: number; readonly outputLimit: number; readonly allowNetwork: boolean },
  ): Promise<NativeSandboxRunResult> {
    return this.call({
      command: 'sandbox-run',
      attempt_root: paths.attemptRoot,
      workspace: paths.workspace,
      home: paths.home,
      temp: paths.temp,
      command_text: commandText,
      timeout_ms: options.timeoutMs,
      output_limit: options.outputLimit,
      network_access: options.allowNetwork,
    }, {
      timeoutMs: options.timeoutMs + 15_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  async cleanupSandbox(attemptRoot: string): Promise<void> {
    await this.call({ command: 'sandbox-cleanup', attempt_root: attemptRoot }, { timeoutMs: SANDBOX_ACL_TIMEOUT_MS })
  }

  private call<T>(
    request: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.probe.path.length === 0) {
      fail('NATIVE_HELPER_UNAVAILABLE', 'native-helper', '原生隔离组件未安装或校验失败', `no valid helper for ${process.platform}/${process.arch}`)
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.probe.path, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: nativeHelperEnvironment(),
        windowsHide: true,
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectOnce(new Error('native helper timed out'))
      }, options.timeoutMs ?? 120_000)
      const abort = (): void => {
        child.kill('SIGKILL')
        const error = new Error('native helper aborted')
        error.name = 'AbortError'
        rejectOnce(error)
      }
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        rejectPromise(error)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > 32 * 1024 * 1024) {
          child.kill('SIGKILL')
          rejectOnce(new Error('native helper output exceeded 32 MiB'))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 1024 * 1024) stderr.push(chunk)
      })
      child.stdin.on('error', rejectOnce)
      child.on('error', rejectOnce)
      child.on('close', (code) => {
        if (settled) return
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        try {
          const raw = Buffer.concat(stdout).toString('utf8').trim()
          const response = JSON.parse(raw) as HelperResponse<T>
          if (code !== 0 || !response.ok || response.value === undefined) {
            const diagnostic = response.error?.message ?? Buffer.concat(stderr).toString('utf8')
            fail('NATIVE_HELPER_INVALID', 'native-helper', '原生隔离操作失败', `${response.error?.code ?? code}: ${diagnostic}`)
          }
          settled = true
          resolvePromise(response.value)
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)))
        }
      })
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted === true) abort()
      else child.stdin.end(JSON.stringify(request))
    })
  }
}

export function nativePackageName(platform: NodeJS.Platform, arch: string): string | null {
  if (!['arm64', 'x64'].includes(arch)) return null
  if (platform === 'darwin') return `@yuanyang749/model-pk-native-darwin-${arch}`
  if (platform === 'win32') return `@yuanyang749/model-pk-native-win32-${arch}`
  return null
}

export function nativeExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'model-pk-helper.exe' : 'model-pk-helper'
}

function nativeHelperEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {}
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

export async function initializeCapacitySlots(
  helper: NativeHelper,
  root: string,
  count: number,
  byteLength: number,
): Promise<{ slotId: string; path: string; byteLength: number }[]> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const slots: { slotId: string; path: string; byteLength: number }[] = []
  for (let index = 0; index < count; index += 1) {
    const slotId = `slot-${String(index + 1).padStart(3, '0')}`
    const path = join(root, `${slotId}.journal`)
    await helper.reserve(path, byteLength)
    slots.push({ slotId, path, byteLength })
  }
  return slots
}

export async function writeLease(path: string, fencingToken: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${fencingToken}\n`, { mode: 0o600, flag: 'wx' })
}
