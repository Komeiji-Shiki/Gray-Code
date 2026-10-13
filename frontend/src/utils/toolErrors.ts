type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR'

function normalizePath(value: string): string {
  if (value.startsWith('file://')) {
    try {
      const uri = new URL(value)
      const path = decodeURIComponent(uri.pathname).replace(/^\/([A-Za-z]:\/)/, '$1')
      return uri.hostname ? `//${uri.hostname}${path}` : path
    } catch { /* 不是文件 URI 时保留工具传入的路径。 */ }
  }
  return value.replace(/\\/g, '/')
}

/** 只生成界面说明；原始错误与工具结果保持原样。 */
export function getToolFileError(code: unknown, pathHint?: string, workspaceUri?: string | null): {
  code: FileErrorCode
  path?: string
} | undefined {
  if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EISDIR') return undefined
  if (!pathHint) return { code }

  const path = normalizePath(pathHint)
  if (!/^(?:[A-Za-z]:\/|\/)/.test(path)) return { code, path: path.replace(/^\.\//, '') }
  const root = workspaceUri ? normalizePath(workspaceUri).replace(/\/$/, '') : undefined
  if (root) {
    const windows = /^[A-Za-z]:\//.test(path) || path.startsWith('//')
    const comparePath = windows ? path.toLowerCase() : path
    const compareRoot = windows ? root.toLowerCase() : root
    if (comparePath === compareRoot) return { code, path: '.' }
    if (comparePath.startsWith(`${compareRoot}/`)) return { code, path: path.slice(root.length + 1) }
  }
  // 无法确定所属工作区时明确省略父目录，不把绝对路径伪装成工作区相对路径。
  return { code, path: `…/${path.split('/').filter(Boolean).at(-1) ?? path}` }
}
