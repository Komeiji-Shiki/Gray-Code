/** 诊断复制保留错误上下文，清除常见授权头、密钥字段和 URL 凭据。 */
export function redactDiagnostic(text: string): string {
  return text.replace(/^(\s*(?:authorization|cookie|set-cookie)\s*:).+$/gim, '$1 [REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
