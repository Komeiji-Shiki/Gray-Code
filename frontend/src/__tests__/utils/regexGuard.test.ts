import { describe, expect, it } from 'vitest'
import { createSafeUiRegex, MAX_UI_REGEX_SOURCE_LENGTH } from '../../utils/regexGuard'

describe('browser regex guard', () => {
  it('rejects nested quantifiers and oversized patterns', () => {
    expect(createSafeUiRegex('(a+)+', 'gi')).toBeNull()
    expect(createSafeUiRegex('a'.repeat(MAX_UI_REGEX_SOURCE_LENGTH + 1), 'gi')).toBeNull()
  })

  it('rejects invalid patterns and preserves valid flags', () => {
    expect(createSafeUiRegex('([broken', 'gi')).toBeNull()
    const regex = createSafeUiRegex('foo\\d+', 'gi')
    expect(regex?.test('FOO123')).toBe(true)
    expect(regex?.flags).toContain('g')
  })
})
