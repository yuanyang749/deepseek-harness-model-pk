import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeCliInvocation, packageManagerEntry } from '../scripts/bootstrap-command.mjs'

describe('bootstrap command invocation', () => {
  it('passes shell metacharacters as opaque Node CLI arguments', () => {
    const node = String.raw`C:\Program Files\nodejs\node.exe`
    const entry = String.raw`C:\repo & fixtures\node_modules\@deepseek-ai\dsh\lib\bin.js`
    const root = String.raw`C:\repo & fixtures`

    expect(nodeCliInvocation(node, entry, ['plugin', 'add', root])).toEqual({
      file: node,
      args: [entry, 'plugin', 'add', root],
    })
  })

  it('requires a JavaScript package-manager entry instead of a command shim', () => {
    expect(packageManagerEntry(String.raw`C:\pnpm\pnpm.cjs`)).toBe(String.raw`C:\pnpm\pnpm.cjs`)
    expect(() => packageManagerEntry(String.raw`C:\pnpm\pnpm.cmd`)).toThrow(/JavaScript entry/u)
    expect(() => packageManagerEntry(undefined)).toThrow(/pnpm/u)
  })

  it('resolves an extensionless package-manager symlink to its JavaScript entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-pk-pnpm-'))
    const entry = join(directory, 'pnpm.mjs')
    const shim = join(directory, 'pnpm')
    try {
      writeFileSync(entry, '')
      symlinkSync(entry, shim)
      expect(packageManagerEntry(shim)).toBe(realpathSync(entry))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
