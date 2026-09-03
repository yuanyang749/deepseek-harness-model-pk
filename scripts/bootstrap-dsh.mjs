import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { nodeCliInvocation, packageManagerEntry } from './bootstrap-command.mjs'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'web'
if (typeof profile !== 'string' || !/^[a-z0-9-]+$/u.test(profile)) throw new Error('invalid --profile value')
const skipBuild = args.includes('--skip-build')
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshEntry = join(dirname(dshPackage), 'lib', 'bin.js')
const commandOptions = { cwd: root, stdio: 'inherit', windowsHide: true }

function runNodeCli(entry, cliArgs, options = commandOptions) {
  const invocation = nodeCliInvocation(process.execPath, entry, cliArgs)
  return execFileSync(invocation.file, invocation.args, options)
}

if (!skipBuild) {
  const pnpmEntry = packageManagerEntry(process.env.npm_execpath)
  runNodeCli(pnpmEntry, ['build:native'])
  runNodeCli(pnpmEntry, ['build'])
}
const version = runNodeCli(dshEntry, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
runNodeCli(dshEntry, ['plugin', '--profile', profile, 'add', root])

console.log('')
console.log(`Installed dsh-model-pk into DSH ${version} profile ${profile}.`)
console.log(`Verify: dsh --profile ${profile} --dump-config`)
console.log(`Launch: dsh --profile ${profile}`)
