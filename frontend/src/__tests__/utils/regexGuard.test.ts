import { describe, expect } from 'vitest'
import { createSafeUiRegex, MAX_UI_REGEX_SOURCE_LENGTH, validateRegexPattern } from '../../utils/regexGuard'

describe('browser regex guard（单一来源：与后端判定一致）', () => {
  test('rejects nested quantifiers and oversized patterns', () => {
    expect(createSafeUiRegex('(a+)+', 'gi')).toBeNull()
    expect(createSafeUiRegex('a'.repeat(MAX_UI_REGEX_SOURCE_LENGTH + 1), 'gi')).toBeNull()
  })

  test('rejects invalid patterns and preserves valid flags', () => {
    expect(createSafeUiRegex('([broken', 'gi')).toBeNull()
    const regex = createSafeUiRegex('foo\\d+', 'gi')
    expect(regex?.test('FOO123')).toBe(true)
    expect(regex?.flags).toContain('g')
  })

  // 4 误报：简化版曾拦截、后端完整版放行——合并后前端与后端（同一函数实例）一致放行
  test.each(['\\(a+\\\)+', '([a+])+', '(a{2}){2}', '(a+){2}'])('消除误报 %s（与后端一致放行）', (pattern) => {
    expect(validateRegexPattern(pattern).ok).toBe(true)
    expect(createSafeUiRegex(pattern, 'gi')).not.toBeNull()
  })

  // 2 漏报：简化版曾放行、后端完整版拦截——合并后前端与后端（同一函数实例）一致拦截
  test.each(['(a?)+', '(?:a+|(?:ab))+'])('修复漏报 %s（与后端一致拦截）', (pattern) => {
    expect(validateRegexPattern(pattern).ok).toBe(false)
    expect(createSafeUiRegex(pattern, 'gi')).toBeNull()
  })
})
