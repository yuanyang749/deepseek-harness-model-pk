import { realpathSync } from 'node:fs'
import { extname } from 'node:path'

export function nodeCliInvocation(nodeExecutable, entry, args) {
  return { file: nodeExecutable, args: [entry, ...args] }
}

export function packageManagerEntry(value) {
  if (value === undefined) {
    throw new Error('pnpm JavaScript entry is unavailable; run this command through pnpm or use --skip-build')
  }
  const javaScriptExtensions = ['.js', '.cjs', '.mjs']
  if (javaScriptExtensions.includes(extname(value).toLowerCase())) return value
  if (extname(value) === '') {
    try {
      const resolved = realpathSync(value)
      if (javaScriptExtensions.includes(extname(resolved).toLowerCase())) return resolved
    } catch {
      // Report the stable package-manager error below.
    }
  }
  throw new Error(`pnpm must expose a JavaScript entry, got ${value}`)
}
