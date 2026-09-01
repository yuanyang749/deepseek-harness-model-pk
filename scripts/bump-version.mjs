import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

function parseSemver(v) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(v)
  if (!match) throw new Error(`Invalid semver version: ${v}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

function bumpVersion(current, type) {
  const parsed = parseSemver(current)
  if (type === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  if (type === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
  if (type === 'major') return `${parsed.major + 1}.0.0`
  // Explicit version string
  parseSemver(type)
  return type
}

const typeOrVersion = process.argv[2] || 'patch'
const rootPkgPath = join(root, 'package.json')
const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8'))
const currentVersion = rootPkg.version
const nextVersion = bumpVersion(currentVersion, typeOrVersion)

console.log(`Bumping version: ${currentVersion} -> ${nextVersion}`)

// 1. Root package.json
rootPkg.version = nextVersion
await writeFile(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`)

// 2. src/contracts/constants.ts
const constantsPath = join(root, 'src/contracts/constants.ts')
let constantsContent = await readFile(constantsPath, 'utf8')
constantsContent = constantsContent.replace(
  /export const PLUGIN_VERSION = '[^']+'/u,
  `export const PLUGIN_VERSION = '${nextVersion}'`
)
await writeFile(constantsPath, constantsContent)

// 3. native/model-pk-helper/Cargo.toml
const cargoTomlPath = join(root, 'native/model-pk-helper/Cargo.toml')
let cargoToml = await readFile(cargoTomlPath, 'utf8')
cargoToml = cargoToml.replace(
  /^version = "[^"]+"/mu,
  `version = "${nextVersion}"`
)
await writeFile(cargoTomlPath, cargoToml)

// 4. native/model-pk-helper/Cargo.lock
const cargoLockPath = join(root, 'native/model-pk-helper/Cargo.lock')
try {
  let cargoLock = await readFile(cargoLockPath, 'utf8')
  cargoLock = cargoLock.replace(
    /(\[\[package\]\]\r?\nname = "model-pk-helper"\r?\nversion = ")[^"]+(")/u,
    `$1${nextVersion}$2`
  )
  await writeFile(cargoLockPath, cargoLock)
} catch {
  // Ignore if Cargo.lock does not exist
}

// 5. 4 platform packages (package.json & manifest.json)
const platforms = [
  'native-darwin-arm64',
  'native-darwin-x64',
  'native-win32-arm64',
  'native-win32-x64',
]

for (const p of platforms) {
  const pkgJsonPath = join(root, 'packages', p, 'package.json')
  try {
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
    pkg.version = nextVersion
    await writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  } catch {
    // ignore
  }

  const manifestPath = join(root, 'packages', p, 'manifest.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = nextVersion
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch {
    // ignore
  }
}

console.log(`\nSuccessfully synchronized all packages to version ${nextVersion}!`)
console.log(`Next steps:`)
console.log(`  1. pnpm build:native && pnpm build`)
console.log(`  2. pnpm publish --access public`)
