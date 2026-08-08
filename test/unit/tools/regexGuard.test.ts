/**
 * regexGuard 防护行为测试
 *
 * 覆盖两类行为：
 * 1. 危险模式必须被拦截（灾难性回溯家族：嵌套量词 / 歧义分支 / 可变范围量词）
 * 2. 合法模式不得被误伤（尤其 (?:ab)+ 这类组前缀 ? 的净化处理，见 sanitizePatternForHeuristic）
 */
import { validateRegexPattern, hasNestedQuantifiedGroups } from '../../../backend/tools/search/regexGuard'

describe('regexGuard', () => {
  describe('危险模式拦截', () => {
    const dangerousPatterns = [
      '(a+)+',
      '(a*)*',
      '(a|a)+',
      '(a{2,})*',
      '((a+)+)+',
      '(?:a+|(?:ab))+',
      '(a?)+',
      '(a+){2,}',
      '((a+)+){2}',
      '(a|aa)+'
    ]

    it.each(dangerousPatterns)('拒绝 %s', (pattern) => {
      const result = validateRegexPattern(pattern)
      expect(result.ok).toBe(false)
    })
  })

  describe('合法模式不误伤', () => {
    const safePatterns = [
      '(abc)+',
      '(foo)*',
      '(a{2}){2}',
      '([a+])+',
      '\\(a+\\)+',
      '[a|b]+',
      '(abc)?',
      '(a+)?',
      '(?:ab)+',
      '(?=a)b',
      '(?!a)b',
      '(?<=a)b',
      'a{2,3}',
      '(foo){2}',
      '(ab|cd)'
    ]

    it.each(safePatterns)('接受 %s', (pattern) => {
      const result = validateRegexPattern(pattern)
      expect(result.ok).toBe(true)
    })
  })

  describe('扫描式检测与正则启发式一致放行的安全边界', () => {
    it('(?:ab)+ 不被扫描式检测拦截', () => {
      expect(hasNestedQuantifiedGroups('(?:ab)+')).toBe(false)
    })

    it('(a+)+ 被扫描式检测拦截', () => {
      expect(hasNestedQuantifiedGroups('(a+)+')).toBe(true)
    })
  })
})
