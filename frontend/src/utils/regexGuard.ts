/**
 * 浏览器侧正则护栏（单一来源：复用后端完整逻辑）
 *
 * 方案 A 合并后，本文件不再维护简化副本——核心判定全部来自 shared/regexGuard
 * （长度上限 500 + 净化 sanitize + 扁平启发式 + 扫描式 hasNestedQuantifiedGroups
 * + 构造异常捕获），与后端为同一函数实例，杜绝双实现分叉。
 *
 * 行为变化（预期且被接受）：
 * - 消除 4 误报：`\(a+\)+`、`([a+])+`、`(a{2}){2}`、`(a+){2}`（此前前端拦、后端放行）
 * - 修复 2 漏报：`(a?)+`、`(?:a+|(?:ab))+`（此前前端放行、后端拦截；后者有渲染线程
 *   灾难性回溯挂死风险）
 */
import { validateRegexPattern, MAX_REGEX_SOURCE_LENGTH } from '@shared/regexGuard'

// 与后端/ shared 完全同一实例的完整逻辑（供 parity 断言导出面一致）
export { validateRegexPattern, hasNestedQuantifiedGroups, MAX_REGEX_SOURCE_LENGTH } from '@shared/regexGuard'

/** 与后端共享的长度上限常量（单一来源；别名保持既有导出名不破） */
export const MAX_UI_REGEX_SOURCE_LENGTH = MAX_REGEX_SOURCE_LENGTH

/**
 * 构造 UI 高亮安全正则；危险/超长/非法一律返回 null（调用方 history_search.vue 零改动）。
 */
export function createSafeUiRegex(pattern: string, flags?: string): RegExp | null {
  const result = validateRegexPattern(pattern, flags)
  return result.ok ? result.regex : null
}
