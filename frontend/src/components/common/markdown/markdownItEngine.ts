/**
 * markdown-it 渲染引擎（从 MarkdownRenderer.vue 抽取的纯逻辑）
 *
 * 包含：markdown-it 实例创建与插件注册（KaTeX / 工作区文件链接 / 自定义 fence 渲染）、
 * 仅 LaTeX 渲染、渲染后处理（HTML 净化 / 连续空格保留）。
 * 依赖模块级单例缓存（markdownItCore）与文件引用解析工具（workspaceFileRefs）。
 */
import MarkdownIt from 'markdown-it'
import type { Options } from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type Renderer from 'markdown-it/lib/renderer.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import hljs from 'highlight.js'
import katex from 'katex'
import { t } from '@/i18n'
import { escapeHtml, sanitizeHtml, RENDER_LATEX_ONLY_INLINE_RE, RENDER_LATEX_ONLY_BLOCK_RE, RENDER_LATEX_ONLY_PAREN_INLINE_RE, RENDER_LATEX_ONLY_BRACKET_BLOCK_RE } from '@/components/common/markdownUtils'
import { markdownItMathBlock } from '@/utils/markdownMathBlock'
import { fileExistenceCache, codeHighlightCache, setCachedCodeHighlight } from './markdownItCore'
import {
  WORKSPACE_FILE_REF_FIND_RE,
  parsePositiveInt,
  encodeDataPath,
  normalizeWorkspaceFilePath,
  parseWorkspaceFileRefExact,
  guessHighlightLanguageFromPath,
  type WorkspaceFileRef
} from './workspaceFileRefs'

// 插件导入
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import taskLists from 'markdown-it-task-lists'

export type RenderProfile = 'default' | 'artifactSafe'

/**
 * 将 highlight.js 的 HTML 按“原始换行”安全拆成行，避免拆坏跨行的 <span>
 *
 * highlight.js 的输出主要由文本与 <span ...></span> 组成，且包含换行字符。
 * 我们在遇到换行时：临时关闭所有已打开的 span，结束该行，再在下一行重新打开这些 span。
 */
function splitHighlightedHtmlByNewline(highlightedHtml: string): string[] {
  const html = highlightedHtml.replace(/\r\n/g, '\n')
  const lines: string[] = []

  // 记录“当前打开的 <span ...> 标签”，用于跨行时重开
  const openSpanTags: string[] = []
  let buf = ''

  for (let i = 0; i < html.length; i++) {
    const ch = html[i]

    // 解析标签
    if (ch === '<') {
      const end = html.indexOf('>', i)
      if (end === -1) {
        buf += ch
        continue
      }

      const tag = html.slice(i, end + 1)
      buf += tag

      // 仅处理 span（highlight.js 输出基本只用 span）
      if (tag.startsWith('<span')) {
        openSpanTags.push(tag)
      } else if (tag.startsWith('</span')) {
        openSpanTags.pop()
      }

      i = end
      continue
    }

    // 换行：关闭当前行未闭合的 span，并在下一行重新打开
    if (ch === '\n') {
      for (let k = openSpanTags.length - 1; k >= 0; k--) {
        buf += '</span>'
      }
      lines.push(buf)
      buf = ''
      for (let k = 0; k < openSpanTags.length; k++) {
        buf += openSpanTags[k]
      }
      continue
    }

    buf += ch
  }

  lines.push(buf)
  return lines
}

/**
 * markdown-it 插件：把文本中的“工作区文件引用”转为可点击链接。
 * 注意：仅做 UI/交互增强，是否能打开由扩展侧校验决定。
 */
function markdownItWorkspaceFileLinks(md: MarkdownIt) {
  md.core.ruler.push('graycode_workspace_file_links', (state: any) => {
    const TokenCtor = state.Token

    for (const tok of state.tokens as any[]) {
      if (tok.type !== 'inline' || !Array.isArray(tok.children)) continue

      const children = tok.children as any[]
      const out: any[] = []
      let inLink = 0

      for (const child of children) {
        if (child.type === 'link_open') {
          inLink += 1
          out.push(child)
          continue
        }
        if (child.type === 'link_close') {
          inLink = Math.max(0, inLink - 1)
          out.push(child)
          continue
        }

        // 避免在已有链接内嵌套 <a>
        if (inLink > 0) {
          out.push(child)
          continue
        }

        // 行内 code：如果内容“完全等于”一个文件引用，则包一层 <a>
        if (child.type === 'code_inline') {
          const ref = parseWorkspaceFileRefExact(child.content || '')
          if (!ref || fileExistenceCache.get(ref.path) !== true) {
            out.push(child)
            continue
          }

          const linkOpen = new TokenCtor('link_open', 'a', 1)
          linkOpen.attrs = [
            ['href', '#'],
            ['class', 'workspace-file-link'],
            ['data-path', encodeDataPath(ref.path)]
          ]
          if (ref.startLine) linkOpen.attrs.push(['data-start-line', String(ref.startLine)])
          if (ref.endLine) linkOpen.attrs.push(['data-end-line', String(ref.endLine)])

          const linkClose = new TokenCtor('link_close', 'a', -1)

          out.push(linkOpen, child, linkClose)
          continue
        }

        if (child.type !== 'text') {
          out.push(child)
          continue
        }

        const text: string = child.content || ''
        WORKSPACE_FILE_REF_FIND_RE.lastIndex = 0

        let lastIndex = 0
        let found = false
        let m: RegExpExecArray | null

        while ((m = WORKSPACE_FILE_REF_FIND_RE.exec(text))) {
          found = true
          const matchStart = m.index
          const matchAll = m[0] || ''
          const prefix = m[1] || ''
          const rawPath = m[2] || ''

          const startLine = parsePositiveInt(m[3] || m[5])
          const endLine = parsePositiveInt(m[4] || m[6]) ?? startLine

          const path = normalizeWorkspaceFilePath(rawPath)
          const encodedPath = encodeDataPath(path)

          const pathStart = matchStart + prefix.length
          const matchEnd = matchStart + matchAll.length

          // 未确认存在 → 作为纯文本输出，不生成链接
          if (fileExistenceCache.get(path) !== true) {
            const plainText = text.slice(lastIndex, matchEnd)
            if (plainText) {
              const t = new TokenCtor('text', '', 0)
              t.content = plainText
              out.push(t)
            }
            lastIndex = matchEnd
            continue
          }

          // 1) 先输出“匹配前”的文本（包含 prefix）
          if (pathStart > lastIndex) {
            const before = text.slice(lastIndex, pathStart)
            if (before) {
              const t = new TokenCtor('text', '', 0)
              t.content = before
              out.push(t)
            }
          }

          // 2) 输出可点击链接（显示原始文本，不改写样式）
          const displayText = text.slice(pathStart, matchEnd)
          const linkOpen = new TokenCtor('link_open', 'a', 1)
          linkOpen.attrs = [
            ['href', '#'],
            ['class', 'workspace-file-link'],
            ['data-path', encodedPath]
          ]
          if (startLine) linkOpen.attrs.push(['data-start-line', String(startLine)])
          if (endLine) linkOpen.attrs.push(['data-end-line', String(endLine)])

          const linkText = new TokenCtor('text', '', 0)
          linkText.content = displayText

          const linkClose = new TokenCtor('link_close', 'a', -1)

          out.push(linkOpen, linkText, linkClose)

          lastIndex = matchEnd
        }

        if (!found) {
          out.push(child)
          continue
        }

        // 3) 输出剩余文本
        const rest = text.slice(lastIndex)
        if (rest) {
          const t = new TokenCtor('text', '', 0)
          t.content = rest
          out.push(t)
        }
      }

      tok.children = out
    }
  })
}

/**
 * 创建并配置 markdown-it 实例
 */
function createMarkdownIt(options: { allowHtml: boolean }) {
  const md = new MarkdownIt({
    html: options.allowHtml,
    xhtmlOut: false,
    breaks: true,         // 换行转 <br>
    linkify: true,        // 自动检测链接
    typographer: true,    // 启用智能引号等排版功能
  })
  
  // 加载插件
  md.use(footnote)       // 脚注支持
  md.use(deflist)        // 定义列表支持
  md.use(taskLists, {    // 任务列表支持
    enabled: true,
    label: true,
    labelAfter: true
  })
  // LaTeX (KaTeX) 支持：通过 markdown-it 规则解析 $...$ / $$...$$ 与 \\(...\\) / \\[...\\]，避免 regex + 占位符的二次渲染问题
  md.use(markdownItKatex)
  // 工作区文件引用：把路径/行号变成可点击链接
  md.use(markdownItWorkspaceFileLinks)
  
  // 自定义链接渲染 - 外部链接在新标签页打开
  const defaultLinkRender = md.renderer.rules.link_open || function(
    tokens: Token[],
    idx: number,
    options: Options,
    _env: StateCore,
    self: Renderer
  ) {
    return self.renderToken(tokens, idx, options)
  }
  
  md.renderer.rules.link_open = function(
    tokens: Token[],
    idx: number,
    options: Options,
    env: StateCore,
    self: Renderer
  ) {
    const token = tokens[idx]
    const href = token.attrGet('href') || ''
    
    // 检查是否是外部链接
    if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    
    return defaultLinkRender(tokens, idx, options, env, self)
  }
  
  // 自定义图片渲染 - 支持相对路径
  md.renderer.rules.image = function(tokens: Token[], idx: number) {
    const token = tokens[idx]
    const src = token.attrGet('src') || ''
    const alt = token.content || ''
    const title = token.attrGet('title') || ''
    
    // 检查是否是绝对 URL
    const isAbsoluteUrl = /^(https?:\/\/|data:)/i.test(src)
    
    if (isAbsoluteUrl) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${src}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy">`
    } else {
      // 相对路径，使用占位符，稍后异步加载
      const encodedPath = btoa(encodeURIComponent(src))
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img class="workspace-image" data-path="${encodedPath}" alt="${escapeHtml(alt)}"${titleAttr} src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" loading="lazy">`
    }
  }

  // 自定义代码块渲染：工具栏（复制/换行）放在滚动容器外，避免随内容滚动
  md.renderer.rules.fence = function(tokens: Token[], idx: number, _options: Options, env: any, _self: Renderer) {
    const token = tokens[idx]
    const info = (token.info || '').trim()
    const firstWord = info ? info.split(/\s+/g)[0] : ''
    const code = token.content || ''

    // 识别 “start:end:path” 的代码引用格式（用于在代码块标题处提供点击跳转）
    const codeRefMatch = info.match(/^(\d+):(\d+):(.+)$/)
    const codeRef: WorkspaceFileRef | null = codeRefMatch
      ? {
          path: normalizeWorkspaceFilePath(codeRefMatch[3] || ''),
          startLine: parsePositiveInt(codeRefMatch[1]),
          endLine: parsePositiveInt(codeRefMatch[2])
        }
      : null

    const lang = codeRef?.path ? (guessHighlightLanguageFromPath(codeRef.path) || '') : firstWord

    // 为同一次 render 分配稳定序号（相同内容的多次渲染：顺序不变则 id 不变）
    if (!env.__grayCode) env.__grayCode = { codeBlockSeq: 0 }
    env.__grayCode.codeBlockSeq = (env.__grayCode.codeBlockSeq || 0) + 1
    const blockId = String(env.__grayCode.codeBlockSeq)

    // Mermaid：保留 .mermaid-wrapper/.mermaid 结构，继续支持点击放大与 mermaid.run()
    if (lang === 'mermaid') {
      const encodedCode = btoa(encodeURIComponent(code))
      const titleCopy = t('components.common.markdownRenderer.mermaid.copyCode')
      return `<div class="mermaid-block-container" data-block-id="${blockId}"><div class="code-block-header"><span class="code-block-title">mermaid</span><div class="code-block-toolbar"><button class="code-tool-btn code-copy-btn" data-code="${encodedCode}" title="${escapeHtml(titleCopy)}"><span class="copy-icon codicon codicon-copy"></span><span class="check-icon codicon codicon-check"></span></button></div></div><div class="mermaid-wrapper"><div class="mermaid">${escapeHtml(code)}</div></div></div>`
    }

    // 代码高亮
    // #64：无语言标注的代码块跳过 highlightAuto（避免流式期间遍历 192 种语法卡顿主线程）
    // 有标注但 hljs 不识别的语言仍会尝试 highlightAuto，但结果加入 codeHighlightCache
    let highlighted: string
    let langClass = ''
    if (lang && hljs.getLanguage(lang)) {
      // 已知语言路径复用与 auto 相同的模块级有界缓存：流式期间同一段增长中的代码
      // 每帧重复高亮，缓存命中直接取上次结果（键为 lang + 代码全文）
      const cacheKey = `${lang}:${code}`
      const cached = codeHighlightCache.get(cacheKey)
      if (cached !== undefined) {
        highlighted = cached
      } else {
        try {
          highlighted = hljs.highlight(code, { language: lang }).value
          setCachedCodeHighlight(codeHighlightCache, cacheKey, highlighted)
        } catch {
          highlighted = escapeHtml(code)
        }
      }
      langClass = `language-${lang}`
    } else if (lang) {
      // 标注了语言但 hljs 不识别的，尝试 auto + 缓存
      const cacheKey = `auto:${code}`
      const cached = codeHighlightCache.get(cacheKey)
      if (cached !== undefined) {
        highlighted = cached
      } else {
        highlighted = hljs.highlightAuto(code).value
        setCachedCodeHighlight(codeHighlightCache, cacheKey, highlighted)
      }
    } else {
      // 完全无标注：跳过 auto，仅转义原文
      highlighted = escapeHtml(code)
    }

    const encodedCode = btoa(encodeURIComponent(code))
    const titleCopy = t('components.common.markdown.copyCode')
    const titleWrapEnable = t('components.common.markdown.wrapEnable')    // 自动换行
    const titleWrapDisable = t('components.common.markdown.wrapDisable')  // 不换行

    // 行号：只反映“原始换行”，用于区分软换行/真实换行（软换行不会增加行号）
    const highlightedLines = splitHighlightedHtmlByNewline(highlighted)
    // 根据最大行号位数自适应行号列宽度（避免固定宽度导致留白过多）
    const lineNumberDigits = Math.max(1, String(highlightedLines.length || 1).length)

    const linesHtml = highlightedLines.map((line, i) => {
      const lineHtml = line === '' ? '&nbsp;' : line
      return `<span class="code-line"><span class="code-line-number">${i + 1}</span><span class="code-line-content">${lineHtml}</span></span>`
    }).join('')

    const titleLabel = escapeHtml(lang || 'code')
    const titleHtml = codeRef?.path
      ? (() => {
          // 未确认存在 → 不生成链接，仅显示普通标题
          if (fileExistenceCache.get(codeRef.path) !== true) {
            return `<span class="code-block-title">${escapeHtml(`${codeRef.path}`)}</span>`
          }
          const encodedPath = encodeDataPath(codeRef.path)
          const startLine = codeRef.startLine
          const endLine = codeRef.endLine ?? codeRef.startLine
          const lineText = startLine ? `:L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}` : ''
          const display = escapeHtml(`${codeRef.path}${lineText}`)
          const attrs = [
            `href="#"`,
            `class="code-block-title workspace-file-link"`,
            `data-path="${encodedPath}"`
          ]
          if (startLine) attrs.push(`data-start-line="${startLine}"`)
          if (endLine) attrs.push(`data-end-line="${endLine}"`)
          return `<a ${attrs.join(' ')}>${display}</a>`
        })()
      : `<span class="code-block-title">${titleLabel}</span>`

    // 默认：自动换行；按钮 title 表示“点击后要切换到的模式”
    return `<div class="code-block-container" data-block-id="${blockId}"><div class="code-block-header">${titleHtml}<div class="code-block-toolbar"><button class="code-tool-btn code-wrap-btn" data-action="toggle-wrap" data-title-nowrap="${escapeHtml(titleWrapEnable)}" data-title-wrap="${escapeHtml(titleWrapDisable)}" title="${escapeHtml(titleWrapDisable)}"><span class="wrap-icon">↩</span><span class="nowrap-icon">↔</span></button><button class="code-tool-btn code-copy-btn" data-code="${encodedCode}" title="${escapeHtml(titleCopy)}"><span class="copy-icon codicon codicon-copy"></span><span class="check-icon codicon codicon-check"></span></button></div></div><pre class="hljs code-block-wrapper"><code class="code-with-lines ${escapeHtml(langClass)}" style="--line-number-digits: ${lineNumberDigits};">${linesHtml}</code></pre></div>`
  }
  
  return md
}

// markdown-it 实例：模块级懒初始化，跨消息块复用
// 首次组件挂载时通过 getMarkdownItInstance 触发初始化
let _defaultMd: MarkdownIt | null = null
let _artifactSafeMd: MarkdownIt | null = null

export function getMarkdownItInstance(renderProfile: RenderProfile): MarkdownIt {
  if (renderProfile === 'artifactSafe') {
    if (!_artifactSafeMd) _artifactSafeMd = createMarkdownIt({ allowHtml: false })
    return _artifactSafeMd
  }
  if (!_defaultMd) _defaultMd = createMarkdownIt({ allowHtml: true })
  return _defaultMd
}

/**
 * 仅渲染 LaTeX（保留原始文本格式）
 * 用于用户消息：保持原始文本，只渲染 LaTeX 公式，保留换行和空格。
 * 支持 `$...$` / `$$...$$` 与 `\\(...\\)` / `\\[...\\]`。
 */
function renderLatexOnly(content: string): string {
  if (!content) return ''

  // 存储 LaTeX 公式及其位置
  const formulas: { placeholder: string; rendered: string }[] = []
  let processed = content

  const renderFormula = (match: string, formula: string, displayMode: boolean): string => {
    const placeholder = `MS_LATEX_${displayMode ? 'BLOCK' : 'INLINE'}_${formulas.length}`
    try {
      formulas.push({
        placeholder,
        rendered: displayMode
          ? `<div class="katex-block">${katex.renderToString(formula.trim(), {
              displayMode: true,
              throwOnError: false,
              output: 'html'
            })}</div>`
          : katex.renderToString(formula.trim(), {
              displayMode: false,
              throwOnError: false,
              output: 'html'
            })
      })
    } catch (e) {
      console.warn(`KaTeX ${displayMode ? 'block' : 'inline'} render error:`, e)
      formulas.push({
        placeholder,
        rendered: displayMode
          ? `<div class="katex-error">${escapeHtml(match)}</div>`
          : `<span class="katex-error">${escapeHtml(match)}</span>`
      })
    }
    return placeholder
  }

  // 先提取块级公式，避免其内部的内容再次被行内定界符处理。
  processed = processed.replace(RENDER_LATEX_ONLY_BLOCK_RE, (match, formula) => (
    renderFormula(match, formula, true)
  ))
  processed = processed.replace(RENDER_LATEX_ONLY_BRACKET_BLOCK_RE, (match, formula) => (
    renderFormula(match, formula, true)
  ))

  // 再提取行内公式。美元定界符保留金额误判护栏，\\(...\\) 允许跨行内容。
  processed = processed.replace(RENDER_LATEX_ONLY_INLINE_RE, (match, formula) => (
    renderFormula(match, formula, false)
  ))
  processed = processed.replace(RENDER_LATEX_ONLY_PAREN_INLINE_RE, (match, formula) => (
    renderFormula(match, formula, false)
  ))

  // 转义 HTML 特殊字符（保持原始文本）
  processed = escapeHtml(processed)

  // 还原 LaTeX 公式
  for (const { placeholder, rendered } of formulas) {
    processed = processed.replace(placeholder, rendered)
  }

  // 保留换行
  processed = processed.replace(/\n/g, '<br>')

  // 保留多个连续空格
  processed = processed.replace(/ {2,}/g, (match) => '&nbsp;'.repeat(match.length))

  // 保留行首空格
  processed = processed.replace(/(^|<br>)( +)/g, (_match, prefix, spaces) => {
    return prefix + '&nbsp;'.repeat(spaces.length)
  })

  return processed
}

/**
 * markdown-it KaTeX 插件：解析 $...$ / $$...$$ 与 \\(...\\) / \\[...\\]
 * - 由 markdown-it 的 token 体系处理，可天然避开 code block / inline code
 * - 解决 KaTeX 产物（含 svg/path）在 markdown 二次处理时被破坏的问题
 */
function markdownItKatex(md: MarkdownIt) {
  const isEscaped = (source: string, index: number): boolean => {
    let backslashCount = 0
    for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) {
      backslashCount++
    }
    return backslashCount % 2 === 1
  }

  const renderFormula = (formula: string, displayMode: boolean, markup: string) => {
    try {
      return katex.renderToString(formula.trim(), {
        displayMode,
        throwOnError: false,
        output: 'html'
      })
    } catch {
      const raw = markup === '\\['
        ? `\\[${formula}\\]`
        : markup === '\\('
          ? `\\(${formula}\\)`
          : displayMode
            ? `$$${formula}$$`
            : `$${formula}$`
      return `<span class="katex-error">${escapeHtml(raw)}</span>`
    }
  }

  // 行内公式：$...$ 与 \\(...\\)
  const mathInline = (state: any, silent: boolean) => {
    const start = state.pos
    const src: string = state.src
    let opener: '$' | '\\('
    let closer: '$' | '\\)'
    let contentStart: number

    if (src.startsWith('\\(', start)) {
      // 转义的 \\( 不作为公式开头；否则 markdown-it 的 escape 规则会先吞掉它。
      if (isEscaped(src, start)) return false
      opener = '\\('
      closer = '\\)'
      contentStart = start + 2
    } else {
      if (src[start] !== '$' || isEscaped(src, start)) return false
      // $$...$$ 交给 block 规则处理
      if (src[start + 1] === '$') return false
      // "$ " 这种不算公式
      if (src[start + 1] === ' ' || src[start + 1] === '\n') return false
      opener = '$'
      closer = '$'
      contentStart = start + 1
    }

    let closePos = contentStart
    while (closePos < state.posMax) {
      closePos = src.indexOf(closer, closePos)
      if (closePos === -1) return false
      if (isEscaped(src, closePos)) {
        closePos += closer.length
        continue
      }

      const content = src.slice(contentStart, closePos)
      // 美元定界符首尾空格通常表示普通文本；\\(...\\) 交给 KaTeX trim。
      if (!content || (opener === '$' && (content.startsWith(' ') || content.endsWith(' ')))) {
        closePos += closer.length
        continue
      }

      if (!silent) {
        const token = state.push('math_inline', 'span', 0)
        token.markup = opener
        token.content = content
      }

      state.pos = closePos + closer.length
      return true
    }

    return false
  }

  // 必须位于 escape 之前，否则 \\( 会先被 Markdown 普通转义规则消费。
  md.inline.ruler.before('escape', 'math_inline', mathInline)
  md.block.ruler.after('fence', 'math_block', markdownItMathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })

  md.renderer.rules.math_inline = (tokens: any, idx: number) => {
    return renderFormula(tokens[idx].content, false, tokens[idx].markup)
  }
  md.renderer.rules.math_block = (tokens: any, idx: number) => {
    return `<div class="katex-block">${renderFormula(tokens[idx].content, true, tokens[idx].markup)}</div>`
  }
}

/**
 * 保留块级元素（p/li/td/th/dd/dt）内的多个连续空格
 *
 * 不能用 [\s\S]*? 非贪婪直接配对：遇到嵌套同名标签（如 <li> 内再嵌 <li>）时，
 * 非贪婪会错配到内层同名闭合标签，外层闭合标签前的空格段被留在匹配之外，
 * nbsp 替换分组随之错位。这里逐标签扫描 + 深度计数配对：嵌套同名 open 深度 +1，
 * 只有深度归零的同名闭合标签才是真正配对的结束位置，整段内容统一做空格保留
 * （转换对 &nbsp; 幂等，内层元素文本随外层整段处理即可）。
 */
function preserveSpacesInBlocks(html: string): string {
  const convertSpaces = (content: string): string => {
    let processed = content.replace(/(<br\s*\/?>)( +)/g, (_m: string, br: string, spaces: string) => {
      return br + '&nbsp;'.repeat(spaces.length)
    })
    processed = processed.replace(/^( +)/, (spaces: string) => {
      return '&nbsp;'.repeat(spaces.length)
    })
    processed = processed.replace(/ {2,}/g, (spaces: string) => {
      return '&nbsp;'.repeat(spaces.length)
    })
    return processed
  }

  // 块级标签 open/close（open 允许属性、close 无属性，与原正则一致）
  const blockTagRe = /<(\/?)(p|li|td|th|dd|dt)(?:\s[^>]*)?>/g
  const parts: string[] = []
  // 栈：记录尚未配对的块级 open 标签及其区间
  const stack: Array<{ tag: string; openStart: number; contentStart: number }> = []
  let segmentStart = 0
  let match: RegExpExecArray | null

  while ((match = blockTagRe.exec(html)) !== null) {
    const tag = match[2]

    if (!match[1]) {
      // open 标签：入栈，等待同名闭合配对
      stack.push({ tag, openStart: match.index, contentStart: blockTagRe.lastIndex })
      continue
    }

    // close 标签：仅与栈顶同名标签配对（非同名或孤立的 close 原样保留）
    const top = stack[stack.length - 1]
    if (!top || top.tag !== tag) continue

    stack.pop()
    if (stack.length > 0) continue // 内层元素：随外层整段一起处理

    // 顶层元素闭合：整段做空格保留后重组
    const openTag = html.slice(top.openStart, top.contentStart)
    const content = html.slice(top.contentStart, match.index)
    const closeTag = match[0]
    parts.push(html.slice(segmentStart, top.openStart))
    parts.push(openTag + convertSpaces(content) + closeTag)
    segmentStart = blockTagRe.lastIndex
  }

  // 剩余未闭合片段（或普通文本）原样保留
  if (segmentStart < html.length) {
    parts.push(html.slice(segmentStart))
  }
  return parts.join('')
}

/**
 * 渲染 Markdown 和 LaTeX
 */
export function renderContent(content: string, latexOnly: boolean, renderProfile: RenderProfile): string {
  if (!content) return ''
  
  // 仅 LaTeX 模式（用户消息）
  if (latexOnly) {
    return renderLatexOnly(content)
  }

  const markdownIt = getMarkdownItInstance(renderProfile)
  
  // 完整 Markdown 模式：LaTeX 由 markdown-it 插件解析（$...$ / $$...$$）
  // 每次渲染传入独立 env，保证 code block 的序号从 1 开始
  let html = markdownIt.render(content, {})

  // #66：html:true 模式下净化产物，避免模型正文中的原始 HTML（script/on*）在 webview 执行
  // artifactSafe 模式已使用 html:false，无需重复净化
  if (renderProfile !== 'artifactSafe') {
    html = sanitizeHtml(html)
  }
  
  // 保留多个连续空格（在段落内容中）
  html = preserveSpacesInBlocks(html)
  
  return html
}
