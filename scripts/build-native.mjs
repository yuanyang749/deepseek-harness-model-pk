import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const arch = process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`native release packages support darwin arm64/x64, got ${process.platform}/${arch}`)
}
execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', join(root, 'native/model-pk-helper/Cargo.toml')], {
  cwd: root,
  stdio: 'inherit',
})
const source = join(root, 'native/model-pk-helper/target/release/model-pk-helper')
const packageRoot = join(root, `packages/native-darwin-${arch}`)
const destination = join(packageRoot, 'bin/model-pk-helper')
await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
await chmod(destination, 0o755)
const bytes = await readFile(destination)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  target,
  version: '0.1.0',
  sha256,
}, null, 2)}\n`)
console.log(`built ${destination} (${sha256})`)

