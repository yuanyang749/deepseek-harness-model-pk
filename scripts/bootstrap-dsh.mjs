import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'web'
if (typeof profile !== 'string' || !/^[a-z0-9-]+$/u.test(profile)) throw new Error('invalid --profile value')
const skipBuild = args.includes('--skip-build')
const dsh = join(root, 'node_modules/.bin/dsh')

if (!skipBuild) {
  execFileSync('pnpm', ['build:native'], { cwd: root, stdio: 'inherit' })
  execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' })
}
const version = execFileSync(dsh, ['--version'], { cwd: root, encoding: 'utf8' }).trim()
if (version !== '0.1.0-rc.7') throw new Error(`Model PK requires DSH 0.1.0-rc.7, found ${version}`)
execFileSync(dsh, ['plugin', '--profile', profile, 'add', root], { cwd: root, stdio: 'inherit' })

console.log('')
console.log(`Installed dsh-model-pk into DSH profile ${profile}.`)
console.log(`Verify: ${dsh} --profile ${profile} --dump-config`)
console.log(`Launch: ${dsh} --profile ${profile}`)
