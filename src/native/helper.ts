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
    const packageName = process.arch === 'arm64'
      ? '@model-pk/native-darwin-arm64'
      : '@model-pk/native-darwin-x64'
    try {
      const require = createRequire(import.meta.url)
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const manifest = JSON.parse(await readFile(join(dirname(packageJsonPath), 'manifest.json'), 'utf8')) as { sha256?: unknown }
      candidates.push({
        path: join(dirname(packageJsonPath), 'bin/model-pk-helper'),
        ...(typeof manifest.sha256 === 'string' && manifest.sha256 !== 'UNBUILT' ? { expectedHash: manifest.sha256 } : {}),
      })
    } catch { /* optional package absent */ }
    if (options.allowDevBinary ?? process.env.NODE_ENV !== 'production') {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
      candidates.push({ path: join(packageRoot, 'native/model-pk-helper/target/debug/model-pk-helper') })
      candidates.push({ path: join(packageRoot, 'native/model-pk-helper/target/release/model-pk-helper') })
      candidates.push({ path: resolve('native/model-pk-helper/target/debug/model-pk-helper') })
      candidates.push({ path: resolve('native/model-pk-helper/target/release/model-pk-helper') })
    }
    for (const candidate of candidates) {
      try {
        await access(candidate.path, fsConstants.X_OK)
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

  private call<T>(request: Readonly<Record<string, unknown>>, timeoutMs = 120_000): Promise<T> {
    if (this.probe.path.length === 0) {
      fail('NATIVE_HELPER_UNAVAILABLE', 'native-helper', '原生隔离组件未安装或校验失败', `no valid helper for ${process.platform}/${process.arch}`)
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.probe.path, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectOnce(new Error('native helper timed out'))
      }, timeoutMs)
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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
      child.on('error', rejectOnce)
      child.on('close', (code) => {
        if (settled) return
        clearTimeout(timer)
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
      child.stdin.end(JSON.stringify(request))
    })
  }
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
