/**
 * 基础语法检查（纯前端、轻量）
 *
 * 用途：变更查看面板 / 代码查看面板在渲染代码时提供“基础语法报错”能力。
 *
 * 定位：不做完整编译。覆盖常见语言的括号/字符串/注释/标签平衡检查，以及
 *       JSON 的真实解析错误。对大文件（超过 MAX_CHECK_LENGTH）跳过检查，
 *       避免阻塞 webview 渲染线程。
 *
 * 语言 id 与 languageFromPath.ts 保持一致（Monaco/VSCode 风格）。
 */

export interface SyntaxIssue {
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  message: string
  severity: 'error' | 'warning'
}

/** 检查长度上限：超过则跳过（返回空数组），避免大文件卡死渲染线程 */
const MAX_CHECK_LENGTH = 512 * 1024
/** 行数上限：超过则跳过（渲染与逐行检查都是 O(n)） */
const MAX_CHECK_LINES = 20000

/** 逐字符扫描前需要跳过的内容长度（用于 JS 正则匹配位置） */
interface Offset {
  line: number
  column: number
}

function offsetAt(text: string, index: number): Offset {
  let line = 1
  let column = 1
  const max = Math.min(index, text.length)
  for (let i = 0; i < max; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

// ============ JSON ============

function checkJson(code: string): SyntaxIssue[] {
  try {
    JSON.parse(code)
    return []
  } catch (error: any) {
    // V8 的 JSON.parse 错误消息形如 "Unexpected token } in JSON at position 12"
    const match = /position (\d+)/.exec(String(error?.message || ''))
    const pos = match ? parseInt(match[1], 10) : 0
    const { line, column } = offsetAt(code, pos)
    return [{
      line,
      column,
      message: error?.message || 'Invalid JSON',
      severity: 'error'
    }]
  }
}

// ============ C 系语言括号/字符串平衡 ============

const BRACKET_PAIRS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{'
}

const CLOSING_NAMES: Record<string, string> = {
  ')': '右括号 )',
  ']': '右方括号 ]',
  '}': '右花括号 }'
}

/**
 * C 系语言（JS/TS/Java/C/C++/C#/Go/Rust 等）的括号 + 字符串 + 注释平衡扫描。
 * 字符串内嵌的反斜杠转义、模板字符串 ${} 嵌套、行/块注释都会被正确跳过。
 */
function checkBracketBalance(code: string, _lang: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  const stack: Array<{ char: string; index: number }> = []
  const n = code.length

  let i = 0
  while (i < n) {
    const ch = code[i]
    const next = i + 1 < n ? code[i + 1] : ''

    // 行注释
    if (ch === '/' && next === '/') {
      i += 2
      while (i < n && code[i] !== '\n') i++
      continue
    }

    // 块注释
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }

    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      const stringStart = i
      i++
      let closed = false
      // 模板字符串内部嵌套 ${...}：递归匹配括号时跳过其中的括号
      while (i < n) {
        const c = code[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) {
          i++
          closed = true
          break
        }
        if (quote === '`' && c === '$' && code[i + 1] === '{') {
          // 模板插值：跳过到配对的 }（内部视为普通字符，
          // 不参与外层括号栈，避免 `}` 被误判为闭合外层）
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++
            else if (code[i] === '}') depth--
            i++
          }
          continue
        }
        i++
      }
      if (!closed) {
        const { line, column } = offsetAt(code, stringStart)
        issues.push({ line, column, message: `字符串未闭合（缺少 ${quote}）`, severity: 'error' })
      }
      continue
    }

    // 括号
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, index: i })
      i++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const expected = BRACKET_PAIRS[ch]
      const top = stack.pop()
      if (!top) {
        const { line, column } = offsetAt(code, i)
        issues.push({ line, column, message: `多余的${CLOSING_NAMES[ch]}（没有与之配对的${expected === '(' ? '左括号' : expected === '[' ? '左方括号' : '左花括号'}）`, severity: 'error' })
      } else if (top.char !== expected) {
        const { line, column } = offsetAt(code, i)
        issues.push({
          line,
          column,
          message: `括号不匹配：${CLOSING_NAMES[ch]} 与 ${top.char === '(' ? '左括号 (' : top.char === '[' ? '左方括号 [' : '左花括号 {'} 配对`,
          severity: 'error'
        })
        stack.push(top)
      }
      i++
      continue
    }

    i++
  }

  // 未闭合的括号
  for (const { char, index } of stack) {
    const { line, column } = offsetAt(code, index)
    issues.push({
      line,
      column,
      message: `括号未闭合（缺少 ${char === '(' ? ')' : char === '[' ? ']' : '}'}）`,
      severity: 'error'
    })
  }

  return issues
}

// ============ Python ============

function checkPython(code: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  const stack: Array<{ char: string; index: number }> = []
  const n = code.length
  let i = 0

  while (i < n) {
    const ch = code[i]
    const next = i + 1 < n ? code[i + 1] : ''

    if (ch === '#') {
      while (i < n && code[i] !== '\n') i++
      continue
    }

    // 三引号字符串
    if ((ch === '"' && next === '"' && code[i + 2] === '"') ||
        (ch === "'" && next === "'" && code[i + 2] === "'")) {
      const triple = code.slice(i, i + 3)
      i += 3
      while (i < n && code.slice(i, i + 3) !== triple) i++
      i += 3
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < n) {
        const c = code[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === quote) {
          i++
          break
        }
        i++
      }
      if (i > n) {
        const { line, column } = offsetAt(code, i - 1)
        issues.push({ line, column, message: `字符串未闭合（缺少 ${quote}）`, severity: 'error' })
      }
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, index: i })
      i++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const expected = BRACKET_PAIRS[ch]
      const top = stack.pop()
      if (!top) {
        const { line, column } = offsetAt(code, i)
        issues.push({ line, column, message: `多余的${CLOSING_NAMES[ch]}`, severity: 'error' })
      } else if (top.char !== expected) {
        const { line, column } = offsetAt(code, i)
        issues.push({ line, column, message: '括号不匹配', severity: 'error' })
        stack.push(top)
      }
      i++
      continue
    }

    i++
  }

  for (const { char, index } of stack) {
    const { line, column } = offsetAt(code, index)
    issues.push({
      line,
      column,
      message: `括号未闭合（缺少 ${char === '(' ? ')' : char === '[' ? ']' : '}'}）`,
      severity: 'error'
    })
  }

  return issues
}

// ============ XML / HTML / Vue ============

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])

function checkMarkup(code: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  const stack: Array<{ tag: string; index: number }> = []
  const n = code.length
  let i = 0

  const skipTag = (start: number): { name: string; selfClosing: boolean; next: number } | null => {
    // start 指向 '<' 之后
    let j = start
    let inQuote: string | null = null
    let name = ''
    let nameDone = false
    let selfClosing = false
    while (j < n) {
      const c = code[j]
      if (inQuote) {
        if (c === inQuote) inQuote = null
        j++
        continue
      }
      if (c === '"' || c === "'") {
        inQuote = c
        j++
        continue
      }
      if (c === '/' && code[j + 1] === '>') {
        selfClosing = true
        j += 2
        break
      }
      if (c === '>') {
        j++
        break
      }
      if (!nameDone) {
        if (/\s/.test(c)) {
          // 标签名结束，进入属性区
          nameDone = true
        } else if (/[\w-]/.test(c)) {
          name += c
        } else {
          // 非名称字符（. # @ 等）也视为名称结束
          nameDone = true
        }
      }
      j++
    }
    return { name: name.toLowerCase(), selfClosing, next: j }
  }

  while (i < n) {
    const lt = code.indexOf('<', i)
    if (lt === -1) break

    const after = code[lt + 1]

    // 注释
    if (code.slice(lt, lt + 4) === '<!--') {
      const end = code.indexOf('-->', lt + 4)
      if (end === -1) {
        const { line, column } = offsetAt(code, lt)
        issues.push({ line, column, message: 'HTML 注释未闭合（缺少 -->）', severity: 'error' })
        break
      }
      i = end + 3
      continue
    }

    // 结束标签 </tag>
    if (after === '/') {
      const parsed = skipTag(lt + 2)
      if (!parsed) {
        i = lt + 2
        continue
      }
      const top = stack.pop()
      if (!top) {
        const { line, column } = offsetAt(code, lt)
        issues.push({ line, column, message: `多余的结束标签 </${parsed.name}>`, severity: 'error' })
      } else if (top.tag !== parsed.name) {
        const { line, column } = offsetAt(code, lt)
        issues.push({
          line,
          column,
          message: `标签不匹配：</${parsed.name}> 与 <${top.tag}> 配对`,
          severity: 'error'
        })
        stack.push(top)
      }
      i = parsed.next
      continue
    }

    // 开始标签
    if (after && /[a-zA-Z]/.test(after)) {
      const parsed = skipTag(lt + 1)
      if (!parsed) {
        i = lt + 1
        continue
      }
      if (!parsed.selfClosing && !VOID_TAGS.has(parsed.name)) {
        stack.push({ tag: parsed.name, index: lt })
      }
      i = parsed.next
      continue
    }

    // 声明 / DOCTYPE / CDATA / 处理指令
    i = lt + 1
  }

  for (const { tag, index } of stack) {
    const { line, column } = offsetAt(code, index)
    issues.push({ line, column, message: `标签 <${tag}> 未闭合（缺少 </${tag}>）`, severity: 'error' })
  }

  return issues
}

// ============ CSS ============

function checkCss(code: string): SyntaxIssue[] {
  // 与 C 系共享括号平衡；额外做注释检查（CSS 只有块注释）
  const issues = checkBracketBalance(code, 'css')
  // 未闭合的块注释
  const open = code.indexOf('/*')
  if (open !== -1 && code.indexOf('*/', open + 2) === -1) {
    const { line, column } = offsetAt(code, open)
    issues.push({ line, column, message: 'CSS 注释未闭合（缺少 */）', severity: 'error' })
  }
  return issues
}

// ============ Shell ============

function checkShell(code: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  const n = code.length
  let i = 0
  while (i < n) {
    const ch = code[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\' && quote === '"') {
          j += 2
          continue
        }
        if (code[j] === quote) break
        j++
      }
      if (j >= n) {
        const { line, column } = offsetAt(code, i)
        issues.push({ line, column, message: `字符串未闭合（缺少 ${quote}）`, severity: 'error' })
      }
      i = j + 1
      continue
    }
    i++
  }
  return issues
}

// ============ 分发 ============

const C_LIKE_LANGUAGES = new Set([
  'javascript', 'typescript', 'javascriptreact', 'typescriptreact',
  'vue', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'kotlin',
  'swift', 'php', 'ruby', 'scala', 'dart', 'objectivec', 'groovy',
  'perl', 'lua', 'coffeescript', 'handlebars', 'hbs'
])

const MARKUP_LANGUAGES = new Set(['xml', 'html', 'htm', 'vue'])

/** 该语言是否支持基础语法检查（区分“检查通过”与“未检查”） */
export function supportsSyntaxCheck(lang: string): boolean {
  const normalizedLang = (lang || '').toLowerCase()
  return normalizedLang === 'json' || normalizedLang === 'jsonc' ||
    normalizedLang === 'python' || normalizedLang === 'css' ||
    normalizedLang === 'scss' || normalizedLang === 'less' ||
    normalizedLang === 'shellscript' || normalizedLang === 'powershell' ||
    normalizedLang === 'bash' ||
    MARKUP_LANGUAGES.has(normalizedLang) ||
    C_LIKE_LANGUAGES.has(normalizedLang)
}

export function checkSyntax(code: string, lang: string): SyntaxIssue[] {
  if (!code) return []
  if (code.length > MAX_CHECK_LENGTH) return []
  if (code.split('\n').length > MAX_CHECK_LINES) return []

  const normalizedLang = (lang || '').toLowerCase()

  if (normalizedLang === 'json' || normalizedLang === 'jsonc') {
    // JSONC 允许注释，退化为括号平衡
    if (normalizedLang === 'json') return checkJson(code)
    return checkBracketBalance(code, 'jsonc')
  }
  if (normalizedLang === 'python') return checkPython(code)
  if (normalizedLang === 'css' || normalizedLang === 'scss' || normalizedLang === 'less') {
    return checkCss(code)
  }
  if (normalizedLang === 'shellscript' || normalizedLang === 'powershell' || normalizedLang === 'bash') {
    return checkShell(code)
  }
  if (MARKUP_LANGUAGES.has(normalizedLang)) return checkMarkup(code)
  if (C_LIKE_LANGUAGES.has(normalizedLang)) return checkBracketBalance(code, normalizedLang)

  // 其他语言不做基础检查
  return []
}

/** 按行聚合：某行是否存在错误（供编辑器行内标记） */
export function issuesByLine(issues: SyntaxIssue[]): Map<number, SyntaxIssue[]> {
  const map = new Map<number, SyntaxIssue[]>()
  for (const issue of issues) {
    const list = map.get(issue.line)
    if (list) {
      list.push(issue)
    } else {
      map.set(issue.line, [issue])
    }
  }
  return map
}
