/**
 * 工作区文件引用解析工具（从 MarkdownRenderer.vue 抽取的纯函数）
 *
 * 供 markdown-it 插件（markdownItEngine）、链接点击处理（workspaceAssets）与
 * 渲染前预校验（workspaceAssets）共享，避免每处重复定义正则与解析逻辑。
 */

export type WorkspaceFileRef = {
  path: string
  startLine?: number
  endLine?: number
}

/**
 * 允许识别为“文件”的扩展名列表（避免把域名 example.com 误判为文件）
 */
const WORKSPACE_FILE_EXT_RE =
  '(?:ts|tsx|js|jsx|mjs|cjs|vue|json|md|css|scss|sass|less|py|go|rs|java|cs|cpp|c|h|hpp|yml|yaml|xml|txt|html|sql|sh|bat|ps1)'

/**
 * 路径段字符：ASCII + Unicode 字母/数字 + 常见符号
 * 使用 \p{L}\p{N} 支持中日韩等非 ASCII 字符的文件/目录名
 */
const _PS = String.raw`[\w\p{L}\p{N}@.+\-]`

export const WORKSPACE_FILE_REF_FIND_RE = new RegExp(
  String.raw`(^|[^\w\p{L}\p{N}/\\.\-])(` +
    String.raw`(?:[A-Za-z]:[\\/]|/)?(?:${_PS}+[\\/])*${_PS}+\.` +
    WORKSPACE_FILE_EXT_RE +
    String.raw`)` +
    String.raw`(?:(?::(\d+)(?:-(\d+))?)|(?:#L(\d+)(?:-L(\d+))?))?` +
    String.raw`(?![\w\p{L}\p{N}])`,
  'gu'
)

const WORKSPACE_FILE_REF_EXACT_RE = new RegExp(
  String.raw`^(` +
    String.raw`(?:[A-Za-z]:[\\/]|/)?(?:${_PS}+[\\/])*${_PS}+\.` +
    WORKSPACE_FILE_EXT_RE +
    String.raw`)` +
    String.raw`(?:(?::(\d+)(?:-(\d+))?)|(?:#L(\d+)(?:-L(\d+))?))?$`,
  'iu'
)

export function parsePositiveInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  if (!/^\d+$/.test(value)) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

export function decodeDataPath(encoded: string): string {
  try {
    return decodeURIComponent(atob(encoded))
  } catch {
    return encoded
  }
}

export function encodeDataPath(raw: string): string {
  return btoa(encodeURIComponent(raw))
}

export function normalizeWorkspaceFilePath(raw: string): string {
  let p = (raw || '').trim()

  // 去掉常见的包裹符号（例如括号/引号）
  p = p.replace(/^["'`]+/, '').replace(/["'`]+$/, '')

  // 仅对“相对路径”将反斜杠转为正斜杠（绝对盘符路径保持原样）
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^(file:\/\/|vscode-remote:\/\/)/i.test(p)) {
    p = p.replace(/\\/g, '/')
  }

  // 去掉相对路径前缀 ./ 或 .\
  p = p.replace(/^(?:\.\/|\.\\)/, '')

  return p
}

export function parseWorkspaceFileRefExact(input: string): WorkspaceFileRef | null {
  const raw = (input || '').trim()
  const m = raw.match(WORKSPACE_FILE_REF_EXACT_RE)
  if (!m) return null

  const path = normalizeWorkspaceFilePath(m[1] || '')

  const startLine = parsePositiveInt(m[2] || m[4])
  const endLine = parsePositiveInt(m[3] || m[5]) ?? startLine

  return {
    path,
    startLine,
    endLine
  }
}

export function guessHighlightLanguageFromPath(filePath: string): string {
  const p = filePath.toLowerCase()
  if (p.endsWith('.ts') || p.endsWith('.tsx')) return 'typescript'
  if (p.endsWith('.js') || p.endsWith('.jsx') || p.endsWith('.mjs') || p.endsWith('.cjs')) return 'javascript'
  if (p.endsWith('.vue')) return 'vue'
  if (p.endsWith('.json')) return 'json'
  if (p.endsWith('.md')) return 'markdown'
  if (p.endsWith('.css') || p.endsWith('.scss') || p.endsWith('.sass') || p.endsWith('.less')) return 'css'
  if (p.endsWith('.py')) return 'python'
  if (p.endsWith('.go')) return 'go'
  if (p.endsWith('.rs')) return 'rust'
  if (p.endsWith('.java')) return 'java'
  if (p.endsWith('.cs')) return 'csharp'
  if (p.endsWith('.cpp') || p.endsWith('.hpp') || p.endsWith('.h') || p.endsWith('.c')) return 'cpp'
  if (p.endsWith('.yml') || p.endsWith('.yaml')) return 'yaml'
  if (p.endsWith('.xml')) return 'xml'
  if (p.endsWith('.html')) return 'xml'
  if (p.endsWith('.sql')) return 'sql'
  if (p.endsWith('.sh') || p.endsWith('.bat') || p.endsWith('.ps1')) return 'bash'
  return ''
}

/**
 * 从原始 Markdown 内容中提取所有可能的工作区文件路径
 */
export function extractPotentialFilePaths(content: string): string[] {
  const paths = new Set<string>()

  // 1) 正文中的文件引用（与 markdownItWorkspaceFileLinks 同正则）
  WORKSPACE_FILE_REF_FIND_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORKSPACE_FILE_REF_FIND_RE.exec(content))) {
    const rawPath = m[2] || ''
    if (rawPath) paths.add(normalizeWorkspaceFilePath(rawPath))
  }

  // 2) 行内 code `path.ts` / `path.ts:12`
  const inlineCodeRe = /`([^`]+)`/g
  while ((m = inlineCodeRe.exec(content))) {
    const ref = parseWorkspaceFileRefExact(m[1] || '')
    if (ref) paths.add(ref.path)
  }

  // 3) 代码块标题中的引用格式 ```start:end:path
  const fenceRefRe = /^```(\d+):(\d+):(.+)/gm
  while ((m = fenceRefRe.exec(content))) {
    const rawPath = (m[3] || '').trim()
    if (rawPath) paths.add(normalizeWorkspaceFilePath(rawPath))
  }

  return Array.from(paths)
}
