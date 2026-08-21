import { LIMITS, IMAGE_MIME_TYPES } from '../contracts/constants.js'
import type { Hash } from '../contracts/types.js'
import { fail } from './error.js'
import { assertValidUnicode, isHash } from './jcs.js'

export function assertRecord(value: unknown, label = '请求'): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('VALIDATION_ERROR', 'validation', `${label}格式无效`, `${label} must be an object`)
  }
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') fail('VALIDATION_ERROR', 'validation', `${key} 格式无效`, `${key} must be a string`)
  validateUnicode(value, key)
  return value
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail('VALIDATION_ERROR', 'validation', `${key} 格式无效`, `${key} must be a string`)
  validateUnicode(value, key)
  return value
}

export function requiredInteger(record: Record<string, unknown>, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('VALIDATION_ERROR', 'validation', `${key} 格式无效`, `${key} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

export function requiredHash(record: Record<string, unknown>, key: string): Hash {
  const value = record[key]
  if (!isHash(value)) fail('VALIDATION_ERROR', 'validation', `${key} 格式无效`, `${key} must be a lowercase sha256 hash`)
  return value
}

export function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    fail('VALIDATION_ERROR', 'validation', `${key} 格式无效`, `${key} must be a string array`)
  }
  for (const item of value) validateUnicode(item, key)
  return [...value]
}

export function validateTaskName(value: string): void {
  validateUnicode(value, 'taskName')
  const length = [...value].length
  if (value.trim().length === 0 || length > LIMITS.taskNameCodePoints) {
    fail('VALIDATION_ERROR', 'draft', 'Task Name 必填且最多 120 个字符', `taskName code point length=${length}`)
  }
}

export function validateTaskType(value: string): void {
  validateUnicode(value, 'taskType')
  const length = [...value].length
  if (length > LIMITS.taskTypeCodePoints) {
    fail('VALIDATION_ERROR', 'draft', 'Task Type 最多 64 个字符', `taskType code point length=${length}`)
  }
}

export function validatePrompt(value: string): void {
  validateUnicode(value, 'prompt')
  if (value.trim().length === 0) fail('VALIDATION_ERROR', 'draft', 'Prompt 不能为空', 'prompt is whitespace-only')
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (byteLength > LIMITS.promptBytes) {
    fail('INPUT_TOO_LARGE', 'draft', 'Prompt 超过 1 MiB', `prompt byteLength=${byteLength}`)
  }
}

export function validateModelSelection(ids: readonly string[]): asserts ids is readonly Hash[] {
  if (ids.length < LIMITS.modelMin || ids.length > LIMITS.modelMax) {
    fail('VALIDATION_ERROR', 'draft', '请选择 2–10 个模型', `selected model count=${ids.length}`)
  }
  if (!ids.every(isHash)) fail('VALIDATION_ERROR', 'draft', '模型配置 ID 无效', 'selected modelConfigId is invalid')
  if (new Set(ids).size !== ids.length) fail('VALIDATION_ERROR', 'draft', '模型选择不能重复', 'duplicate modelConfigId')
}

export function validateConcurrency(value: number, modelCount: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > Math.max(1, modelCount)) {
    fail('VALIDATION_ERROR', 'draft', '并发数必须介于 1 和模型数之间', `concurrency=${value}; modelCount=${modelCount}`)
  }
}

export function validateAttachmentMetadata(
  mimeType: string,
  byteLength: number,
  currentCount: number,
  currentTotal: number,
): asserts mimeType is typeof IMAGE_MIME_TYPES[number] {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    fail('ATTACHMENT_INVALID', 'attachment', '仅支持 PNG、JPEG 和 WebP 图片', `unsupported mimeType=${mimeType}`)
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > LIMITS.imageBytes) {
    fail('ATTACHMENT_INVALID', 'attachment', '单张图片必须小于等于 20 MiB', `image byteLength=${byteLength}`)
  }
  if (currentCount >= LIMITS.imageCount) {
    fail('ATTACHMENT_INVALID', 'attachment', '图片最多 10 张', `image count would exceed ${LIMITS.imageCount}`)
  }
  if (currentTotal + byteLength > LIMITS.imageTotalBytes) {
    fail('ATTACHMENT_INVALID', 'attachment', '图片总大小不能超过 50 MiB', `image total would be ${currentTotal + byteLength}`)
  }
}

export function validateUnicode(value: string, field: string): void {
  try {
    assertValidUnicode(value)
  } catch (error) {
    fail('INPUT_ENCODING_INVALID', 'validation', `${field} 包含非法 Unicode`, error instanceof Error ? error.message : String(error))
  }
}

export function sanitizeFileName(value: string): string {
  validateUnicode(value, 'fileName')
  let portable = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
  portable = /^\.+$/u.test(portable) ? '_' : portable.replace(/[ .]+$/gu, '')
  let base = ''
  for (const character of portable) {
    if (base.length + character.length > 180) break
    base += character
  }
  base = base.replace(/[ .]+$/gu, '')
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(base)) base = `_${base}`
  return base.length > 0 ? base : 'attachment'
}

export function assertNoUnknownKeys(record: Record<string, unknown>, keys: readonly string[], label = 'request'): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(record).filter(key => !allowed.has(key))
  if (unknown.length > 0) {
    fail('VALIDATION_ERROR', 'validation', `${label} 包含未知字段`, `unknown keys: ${unknown.join(', ')}`)
  }
}
