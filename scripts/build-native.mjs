import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const arch = process.arch
const platform = process.platform
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`native release packages support macOS/Windows arm64/x64, got ${platform}/${arch}`)
}
execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', join(root, 'native', 'model-pk-helper', 'Cargo.toml')], {
  cwd: root,
  stdio: 'inherit',
})
const executable = platform === 'win32' ? 'model-pk-helper.exe' : 'model-pk-helper'
const packagePlatform = platform === 'win32' ? 'win32' : 'darwin'
const source = join(root, 'native', 'model-pk-helper', 'target', 'release', executable)
const packageRoot = join(root, `packages/native-${packagePlatform}-${arch}`)
const destination = join(packageRoot, 'bin', executable)
await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
if (platform !== 'win32') await chmod(destination, 0o755)
const probe = JSON.parse(execFileSync(destination, [], {
  input: '{"command":"version"}',
  encoding: 'utf8',
  windowsHide: true,
}))
if (probe?.ok !== true || probe.value?.version !== '0.1.0'
  || probe.value?.platform !== platform || probe.value?.arch !== arch) {
  throw new Error(`native helper identity mismatch for ${platform}/${arch}`)
}
const bytes = await readFile(destination)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const target = platform === 'darwin'
  ? arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  target,
  version: '0.1.0',
  sha256,
}, null, 2)}\n`)
console.log(`built ${destination} (${sha256})`)
