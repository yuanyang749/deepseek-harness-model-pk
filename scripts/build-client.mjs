import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = await readFile(join(root, '.client-build', 'index.cjs'), 'utf8')
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '',
].join('\n')

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib', 'client.js'), wrapped)
await rm(join(root, '.client-build'), { recursive: true, force: true })

