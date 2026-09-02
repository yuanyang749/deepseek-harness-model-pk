import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const repository = 'https://github.com/yuanyang749/deepseek-harness-model-pk.git'
const registry = 'https://registry.npmjs.org/'
const targets = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
] as const

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('release metadata', () => {
  it('ships the public project documents and npm metadata', async () => {
    await expect(readFile('LICENSE', 'utf8')).resolves.toContain('MIT License')
    await expect(readFile('CHANGELOG.md', 'utf8')).resolves.toContain('0.1.2')
    await expect(readFile('SECURITY.md', 'utf8')).resolves.toContain('Security')
    await expect(readFile('CONTRIBUTING.md', 'utf8')).resolves.toContain('Contributing')

    const root = await json('package.json')
    expect(root).toMatchObject({
      name: '@yuanyang749/dsh-model-pk',
      version: '0.1.2',
      license: 'MIT',
      author: 'yuanyang749',
      repository: { type: 'git', url: repository },
      homepage: 'https://github.com/yuanyang749/deepseek-harness-model-pk#readme',
      bugs: { url: 'https://github.com/yuanyang749/deepseek-harness-model-pk/issues' },
      publishConfig: { access: 'public', registry },
    })
    expect(root.keywords).toEqual(expect.arrayContaining(['deepseek-harness', 'dsh-plugin', 'model-comparison']))
  })

  it('publishes four platform packages from the yuanyang749 scope', async () => {
    const root = await json('package.json')
    const optionalDependencies = root.optionalDependencies as Record<string, string>
    const expectedDependencies: Record<string, string> = {}

    for (const [platform, arch] of targets) {
      const packageName = `@yuanyang749/model-pk-native-${platform}-${arch}`
      expectedDependencies[packageName] = 'workspace:*'
      await expect(json(`packages/native-${platform}-${arch}/package.json`)).resolves.toMatchObject({
        name: packageName,
        version: root.version,
        license: 'MIT',
        os: [platform],
        cpu: [arch],
        bin: { 'model-pk-helper': platform === 'win32' ? 'bin/model-pk-helper.exe' : 'bin/model-pk-helper' },
        repository: { type: 'git', url: repository },
        publishConfig: { access: 'public', registry },
      })
    }

    expect(optionalDependencies).toEqual(expectedDependencies)
  })

  it('defines a four-runner artifact workflow for native release packages', async () => {
    const workflow = await readFile('.github/workflows/release-artifacts.yml', 'utf8')
    for (const runner of ['macos-15', 'macos-15-intel', 'windows-2025', 'windows-11-arm']) {
      expect(workflow).toContain(runner)
    }
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).toContain(' pack --pack-destination')
    expect(workflow).toContain("tags:")
    expect(workflow).toContain('npm publish')
    expect(workflow).toContain('pnpm publish --access public --no-git-checks')
  })
})
