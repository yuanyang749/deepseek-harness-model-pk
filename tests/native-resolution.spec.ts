import { describe, expect, it } from 'vitest'
import { nativeExecutableName, nativePackageName } from '../src/native/helper.js'

describe('native package resolution', () => {
  it('maps supported macOS and Windows hosts to architecture packages', () => {
    expect(nativePackageName('darwin', 'arm64')).toBe('@model-pk/native-darwin-arm64')
    expect(nativePackageName('darwin', 'x64')).toBe('@model-pk/native-darwin-x64')
    expect(nativePackageName('win32', 'arm64')).toBe('@model-pk/native-win32-arm64')
    expect(nativePackageName('win32', 'x64')).toBe('@model-pk/native-win32-x64')
    expect(nativePackageName('linux', 'x64')).toBeNull()
    expect(nativePackageName('win32', 'ia32')).toBeNull()
  })

  it('uses the Windows executable suffix only on Windows', () => {
    expect(nativeExecutableName('win32')).toBe('model-pk-helper.exe')
    expect(nativeExecutableName('darwin')).toBe('model-pk-helper')
  })
})
