/** 浏览器侧正则护栏；与后端搜索护栏保持同一限制，避免高亮阻塞 Webview 渲染线程。 */
export const MAX_UI_REGEX_SOURCE_LENGTH = 500

const DANGEROUS_GROUP_QUANTIFIER = /\([^()]*(?:[+*]|\|[^()]*|\{[^}]*\})[^()]*\)(?:[+*]|\{[^}]*\})/

export function createSafeUiRegex(pattern: string, flags?: string): RegExp | null {
  if (pattern.length > MAX_UI_REGEX_SOURCE_LENGTH || DANGEROUS_GROUP_QUANTIFIER.test(pattern)) {
    return null
  }
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}
