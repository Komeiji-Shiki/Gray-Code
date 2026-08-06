<script lang="ts">
/**
 * 模块级单例（跨消息块共享）
 *
 * 文件存在性缓存 / 图片缓存 / 代码高亮缓存 / Mermaid 渲染队列 / markdown-it 实例
 * 必须是真正的模块级状态：消息列表会同时挂载多个 MarkdownRenderer 实例，若这些状态
 * 声明在 <script setup> 顶层，会随每个组件实例重新执行一遍（缓存失效、Mermaid 并发
 * 渲染、重复创建 markdown-it 实例）。
 *
 * 因此这里用普通 <script> 块承载（每模块只执行一次），<script setup> 内仅引用。
 */
import MarkdownIt from 'markdown-it'
import type { Options } from 'markdown-it'

/** 工作区文件存在性缓存：路径 → 是否存在 */
const fileExistenceCache = new Map<string, boolean>()

/** 工作区图片 data URL 缓存：路径 → data: URL */
const imageCache = new Map<string, string>()

/** highlightAuto 结果缓存：避免相同无标注代码块重复遍历 192 种语法 */
const codeHighlightCache = new Map<string, string>()

/** 有界缓存写入：容量超限时淘汰最旧条目（FIFO），防止长会话无界增长 */
const CACHE_MAX_SIZE = 500
function setCached<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value)
  if (map.size > CACHE_MAX_SIZE) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      map.delete(oldestKey)
    }
  }
}

/**
 * 图片缓存字节预算（估算驻留内存）：base64 data URL 单条可达数 MB，
 * 仅按条数限界会让叠加缓存膨胀到数百 MB；超限时按 FIFO 淘汰最旧条目。
 * 字节数按 UTF-16 字符串驻留内存估算（length * 2）。
 */
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** 单张图片文件大小上限：超过则直接显示不缓存，避免单条击穿预算并连带淘汰整批小图 */
const IMAGE_CACHE_MAX_SINGLE_BYTES = 1024 * 1024

/** 估算 data URL 的驻留字节数（UTF-16，每字符 2 字节） */
function estimateDataUrlBytes(dataUrl: string): number {
  return dataUrl.length * 2
}

/** 估算 data URL 编码前的原始图片文件字节数（base64 载荷 ≈ 原始字节 * 4/3） */
function estimateImageFileBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  const base64Len = commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length
  return Math.ceil(base64Len * 0.75)
}

/** 图片缓存写入：带总字节预算 + 单张大小上限 + 条数上限 */
let imageCacheBytes = 0
function setCachedImage(path: string, dataUrl: string): void {
  // 单张超大图片直接显示不缓存（调用方仍会设置 src，仅跳过缓存写入）
  if (estimateImageFileBytes(dataUrl) > IMAGE_CACHE_MAX_SINGLE_BYTES) {
    return
  }
  const bytes = estimateDataUrlBytes(dataUrl)
  const existing = imageCache.get(path)
  if (existing !== undefined) {
    imageCacheBytes -= estimateDataUrlBytes(existing)
  }
  imageCache.set(path, dataUrl)
  imageCacheBytes += bytes
  // 字节预算超限：按 FIFO 淘汰最旧条目，直到回到预算内（单张 ≤1MB 上限保证不会全部被清空）
  while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size > 1) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = imageCache.get(oldestKey)!
    imageCache.delete(oldestKey)
    imageCacheBytes -= estimateDataUrlBytes(oldest)
  }
  // 条数上限兜底（与其它缓存一致）
  if (imageCache.size > CACHE_MAX_SIZE) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey !== undefined) {
      const oldest = imageCache.get(oldestKey)!
      imageCache.delete(oldestKey)
      imageCacheBytes -= estimateDataUrlBytes(oldest)
    }
  }
}

/** Mermaid 渲染串行队列（替代布尔锁 isMermaidRendering，防止并发竞争） */
let mermaidQueue: Promise<void> = Promise.resolve()

/** markdown-it 实例模块级懒初始化单例 */
let _defaultMd: MarkdownIt | null = null
let _artifactSafeMd: MarkdownIt | null = null

/**
 * Mermaid 按需加载：mermaid 体积很大，静态导入会拖慢 webview 首屏加载。
 * 只有内容中真的出现 mermaid 代码块时才动态加载，首次加载后复用同一实例。
 * 主题相关配置在每次 renderMermaid 时通过 initialize 重新应用，无需顶层初始化。
 */
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => m.default)
  }
  return mermaidPromise
}
</script>

<script setup lang="ts">
/**
 * MarkdownRenderer - Markdown 和 LaTeX 渲染组件
 *
 * 使用 markdown-it 作为渲染引擎，支持：
 * - 完整 GFM 语法
 * - 脚注
 * - 定义列表
 * - 任务列表
 * - 代码高亮
 * - LaTeX 数学公式
 */

import { ref, shallowRef, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type Token from 'markdown-it/lib/token.mjs'
import type Renderer from 'markdown-it/lib/renderer.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import hljs from 'highlight.js'
import katex from 'katex'
import { sendToExtension, showNotification } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { escapeHtml, sanitizeHtml, RENDER_LATEX_ONLY_INLINE_RE, RENDER_LATEX_ONLY_BLOCK_RE } from './markdownUtils'

// 插件导入
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import taskLists from 'markdown-it-task-lists'

type RenderProfile = 'default' | 'artifactSafe'

const props = withDefaults(defineProps<{
  content: string
  latexOnly?: boolean  // 仅渲染 LaTeX，不渲染 Markdown（用于用户消息）
  renderProfile?: RenderProfile
  /**
   * 是否处于流式更新中
   *
   * 用于节流渲染并跳过重操作（Mermaid/工作区图片），但仍保持实时 Markdown/LaTeX 输出。
   */
  isStreaming?: boolean
}>(), {
  latexOnly: false,
  renderProfile: 'default',
  isStreaming: false
})

const { t, actualLanguage } = useI18n()

// 容器引用
const containerRef = ref<HTMLElement | null>(null)

// 代码块换行状态（同一条消息内尽量保持；key 为 data-block-id）
const codeWrapOverrides = new Map<string, boolean>() // true => nowrap

// 流式期间“超高”代码块（自然高度超过折叠阈值，流式结束恢复 max-height 后会塌缩）：
// 结束/中断时为这些块保留展开态（keep-expanded），避免布局跳动丢失阅读位置；
// 用户点击换行按钮或滚动离开该块后恢复正常高度限制。
const CODE_BLOCK_COLLAPSE_HEIGHT = 400
const streamingOverHeightBlockIds = new Set<string>()

// 复制按钮状态计时器存储
const copyTimers = new Map<HTMLButtonElement, number>()

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

// 放大查看状态
const isZoomModalVisible = ref(false)
const zoomedContent = ref('')
const zoomTitle = ref('')

// 缩放与平移状态
const zoomScale = ref(1)
const panOffset = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const startPos = ref({ x: 0, y: 0 })

/**
 * 缩放控制
 */
function handleZoomIn() {
  zoomScale.value = Math.min(zoomScale.value + 0.2, 5)
}

function handleZoomOut() {
  zoomScale.value = Math.max(zoomScale.value - 0.2, 0.2)
}

function resetZoom() {
  zoomScale.value = 1
  panOffset.value = { x: 0, y: 0 }
}

/**
 * 滚轮缩放
 */
function handleWheel(event: WheelEvent) {
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.1 : 0.1
  const newScale = Math.min(Math.max(zoomScale.value + delta, 0.1), 10)
  zoomScale.value = newScale
}

/**
 * 鼠标拖拽平移
 */
function handleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return // 仅左键拖拽
  isDragging.value = true
  startPos.value = { x: event.clientX - panOffset.value.x, y: event.clientY - panOffset.value.y }
  
  // 防止文本选中
  event.preventDefault()
}

function handleMouseMove(event: MouseEvent) {
  if (!isDragging.value) return
  panOffset.value = {
    x: event.clientX - startPos.value.x,
    y: event.clientY - startPos.value.y
  }
}

function handleMouseUp() {
  isDragging.value = false
}

// 监听全局鼠标松开，防止在外部松开后还在拖拽
onMounted(() => {
  window.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  window.removeEventListener('mouseup', handleMouseUp)
})

/**
 * 渲染 Mermaid 图表
 *
 * 使用 promise 串行队列（替代布尔锁），避免并发 renderMermaid
 * 导致 isMermaidRendering 提前返回后图片/mermaid 永久不渲染。
 * doRender 内部 await 后重新 querySelectorAll 并过滤 !node.isConnected，
 * 跳过已被 Vue 移除的 DOM 节点。
 */
async function renderMermaid() {
  mermaidQueue = mermaidQueue.then(async () => {
    if (!containerRef.value) return

    await nextTick()

    const mermaidElements = Array.from(
      containerRef.value.querySelectorAll('.mermaid')
    ).filter(node => node.isConnected && !node.querySelector('svg'))

    if (mermaidElements.length === 0) return

    // 检查当前主题
    const isDark = document.body.classList.contains('vscode-dark') ||
                   document.body.classList.contains('vscode-high-contrast')

    try {
      const mermaid = await loadMermaid()
      // 重新初始化以应用可能的颜色变化
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        themeVariables: isDark ? {
          background: 'transparent',
          mainBkg: '#2d2d30',
          sequenceNumberColor: '#fff',
          lineColor: '#858585',
          textColor: '#cccccc',
        } : {},
        flowchart: {
          htmlLabels: true,
          curve: 'basis',
          useMaxWidth: true
        },
        securityLevel: 'strict',
        fontFamily: 'var(--vscode-editor-font-family, "Segoe UI", sans-serif)'
      })

      await mermaid.run({
        nodes: mermaidElements as HTMLElement[]
      })
    } catch (error) {
      console.error('Mermaid 渲染失败:', error)
    }
  }).catch(() => { /* 吞掉队列中的错误，避免阻塞后续调用 */ })

  return mermaidQueue
}

// ===================== 工作区文件引用（可点击跳转） =====================

type WorkspaceFileRef = {
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
 * 查找文本中的文件引用（路径 + 可选行号/范围）
 * - 支持：path:12 / path:12-34 / path#L12 / path#L12-L34
 * - 只处理“看起来像工作区路径/文件名”的字符串；最终仍由扩展侧校验是否在工作区内
 */
/**
 * 路径段字符：ASCII + Unicode 字母/数字 + 常见符号
 * 使用 \p{L}\p{N} 支持中日韩等非 ASCII 字符的文件/目录名
 */
const _PS = String.raw`[\w\p{L}\p{N}@.+\-]`

const WORKSPACE_FILE_REF_FIND_RE = new RegExp(
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

function parsePositiveInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  if (!/^\d+$/.test(value)) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

function decodeDataPath(encoded: string): string {
  try {
    return decodeURIComponent(atob(encoded))
  } catch {
    return encoded
  }
}

function encodeDataPath(raw: string): string {
  return btoa(encodeURIComponent(raw))
}

function normalizeWorkspaceFilePath(raw: string): string {
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

function parseWorkspaceFileRefExact(input: string): WorkspaceFileRef | null {
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

function guessHighlightLanguageFromPath(filePath: string): string {
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
  // LaTeX (KaTeX) 支持：通过 markdown-it 规则解析 $...$ / $$...$$，避免 regex + 占位符的二次渲染问题
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
          setCached(codeHighlightCache, cacheKey, highlighted)
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
        setCached(codeHighlightCache, cacheKey, highlighted)
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
function getMarkdownItInstance(renderProfile: RenderProfile): MarkdownIt {
  if (renderProfile === 'artifactSafe') {
    if (!_artifactSafeMd) _artifactSafeMd = createMarkdownIt({ allowHtml: false })
    return _artifactSafeMd
  }
  if (!_defaultMd) _defaultMd = createMarkdownIt({ allowHtml: true })
  return _defaultMd
}

/**
 * 仅渲染 LaTeX（保留原始文本格式）
 * 用于用户消息：保持原始文本，只渲染 LaTeX 公式，保留换行和空格
 */
function renderLatexOnly(content: string): string {
  if (!content) return ''
  
  // 存储 LaTeX 公式及其位置
  const formulas: { placeholder: string; rendered: string }[] = []
  let processed = content
  
  // 提取并渲染块级公式 $$...$$
  processed = processed.replace(RENDER_LATEX_ONLY_BLOCK_RE, (match, formula) => {
    const placeholder = `MS_LATEX_BLOCK_${formulas.length}`
    try {
      formulas.push({
        placeholder,
        rendered: `<div class="katex-block">${katex.renderToString(formula.trim(), {
          displayMode: true,
          throwOnError: false,
          output: 'html'
        })}</div>`
      })
    } catch (e) {
      console.warn('KaTeX block render error:', e)
      formulas.push({
        placeholder,
        rendered: `<div class="katex-error">${escapeHtml(match)}</div>`
      })
    }
    return placeholder
  })
  
  // 提取并渲染行内公式 $...$
  // #69：添加空格护栏 (?!\s)/(?<!\s) 避免货币金额 $100 误判为公式
  processed = processed.replace(RENDER_LATEX_ONLY_INLINE_RE, (match, formula) => {
    const placeholder = `MS_LATEX_INLINE_${formulas.length}`
    try {
      formulas.push({
        placeholder,
        rendered: katex.renderToString(formula.trim(), {
          displayMode: false,
          throwOnError: false,
          output: 'html'
        })
      })
    } catch (e) {
      console.warn('KaTeX inline render error:', e)
      formulas.push({
        placeholder,
        rendered: `<span class="katex-error">${escapeHtml(match)}</span>`
      })
    }
    return placeholder
  })
  
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
 * markdown-it KaTeX 插件：解析 $...$（行内）与 $$...$$（块级）
 * - 由 markdown-it 的 token 体系处理，可天然避开 code block / inline code
 * - 解决 KaTeX 产物（含 svg/path）在 markdown 二次处理时被破坏的问题
 */
function markdownItKatex(md: MarkdownIt) {
  const renderFormula = (formula: string, displayMode: boolean) => {
    try {
      return katex.renderToString(formula.trim(), {
        displayMode,
        throwOnError: false,
        output: 'html'
      })
    } catch {
      const raw = displayMode ? `$$${formula}$$` : `$${formula}$`
      return `<span class="katex-error">${escapeHtml(raw)}</span>`
    }
  }

  // 行内公式：$...$
  const mathInline = (state: any, silent: boolean) => {
    const start = state.pos
    const src: string = state.src

    if (src[start] !== '$') return false
    // $$...$$ 交给 block 规则处理
    if (src[start + 1] === '$') return false
    // 转义 \$ 不处理
    if (start > 0 && src[start - 1] === '\\') return false
    // "$ " 这种不算公式
    if (src[start + 1] === ' ' || src[start + 1] === '\n') return false

    let pos = start + 1
    while (pos < state.posMax) {
      pos = src.indexOf('$', pos)
      if (pos === -1) return false

      // 跳过转义的 \$
      if (src[pos - 1] === '\\') {
        pos += 1
        continue
      }

      const content = src.slice(start + 1, pos)
      // 首尾空格不允许，减少误判（例如 $ 100）
      if (!content || content.startsWith(' ') || content.endsWith(' ')) {
        pos += 1
        continue
      }

      if (!silent) {
        const token = state.push('math_inline', 'span', 0)
        token.markup = '$'
        token.content = content
      }

      state.pos = pos + 1
      return true
    }

    return false
  }

  // 块级公式：$$...$$
  const mathBlock = (state: any, startLine: number, endLine: number, silent: boolean) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine]
    let max = state.eMarks[startLine]

    if (pos + 2 > max) return false
    if (state.src.slice(pos, pos + 2) !== '$$') return false

    if (silent) return true

    // 同一行结束的 $$...$$
    const firstLine = state.src.slice(pos + 2, max)
    if (firstLine.trim().endsWith('$$')) {
      const content = firstLine.trim().slice(0, -2)
      const token = state.push('math_block', 'div', 0)
      token.block = true
      token.markup = '$$'
      token.map = [startLine, startLine + 1]
      token.content = content
      state.line = startLine + 1
      return true
    }

    // 多行块级公式：向下寻找结尾 $$
    let nextLine = startLine + 1
    let content = firstLine

    while (nextLine < endLine) {
      pos = state.bMarks[nextLine] + state.tShift[nextLine]
      max = state.eMarks[nextLine]

      const line = state.src.slice(pos, max)
      const endPos = line.indexOf('$$')
      if (endPos !== -1) {
        content += `\n${line.slice(0, endPos)}`

        const token = state.push('math_block', 'div', 0)
        token.block = true
        token.markup = '$$'
        token.map = [startLine, nextLine + 1]
        token.content = content
        state.line = nextLine + 1
        return true
      }

      content += `\n${line}`
      nextLine += 1
    }

    return false
  }

  md.inline.ruler.after('backticks', 'math_inline', mathInline)
  md.block.ruler.after('fence', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })

  md.renderer.rules.math_inline = (tokens: any, idx: number) => {
    return renderFormula(tokens[idx].content, false)
  }
  md.renderer.rules.math_block = (tokens: any, idx: number) => {
    return `<div class="katex-block">${renderFormula(tokens[idx].content, true)}</div>`
  }
}

/**
 * 渲染 Markdown 和 LaTeX
 */
function renderContent(content: string, latexOnly: boolean, renderProfile: RenderProfile): string {
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
  html = html.replace(/(<(?:p|li|td|th|dd|dt)[^>]*>)([\s\S]*?)(<\/(?:p|li|td|th|dd|dt)>)/g,
    (_match: string, openTag: string, content: string, closeTag: string) => {
      let processedContent = content.replace(/(<br\s*\/?>)( +)/g, (_m: string, br: string, spaces: string) => {
        return br + '&nbsp;'.repeat(spaces.length)
      })
      processedContent = processedContent.replace(/^( +)/, (spaces: string) => {
        return '&nbsp;'.repeat(spaces.length)
      })
      processedContent = processedContent.replace(/ {2,}/g, (spaces: string) => {
        return '&nbsp;'.repeat(spaces.length)
      })
      return openTag + processedContent + closeTag
    }
  )
  
  return html
}

// ===================== 渲染节流（流式性能优化） =====================

// 渲染结果（用 shallowRef 而不是 computed，便于在流式阶段节流，且保持已完成消息的 HTML 引用稳定）
const renderedContent = shallowRef('')

// 流式类的“滞后副本”：isStreaming 变 false 时先保留 is-streaming 类，
// 等完成态渲染把 keep-expanded 应用到超高块后再解除，使过渡原子化（无塌缩跳变）。
const isStreamingClassActive = ref(props.isStreaming)

const STREAM_RENDER_DEBOUNCE_MS = 120
const STREAM_RENDER_MAX_WAIT_MS = 180
/**
 * 为什么要加完成态渲染缓存：消息列表在 store 变化时会重新走父级渲染流程，
 * 已完成消息即使内容不变，也可能再次进入 MarkdownRenderer。
 *
 * 怎么改：对“非 streaming”消息按内容/渲染配置/工作区文件存在性签名做 LRU memoization，
 * 命中时直接复用已生成的 HTML，避免重复 markdown-it.render。
 *
 * 目的：把重渲染成本收敛到“活跃流式消息”和“内容真正变化的已完成消息”。
 */
const COMPLETED_RENDER_CACHE_LIMIT = 128
const completedRenderCache = new Map<string, string>()

let renderTimer: number | null = null
/** 上一次实际渲染时使用的内容快照，用于跳过无变化的重渲染 */
let lastRenderedSource = ''
let lastRenderedProfile: RenderProfile = 'default'
let lastRenderedLatexOnly = false
let lastRenderedLanguage = ''
let lastRenderedMode: 'streaming' | 'completed' | '' = ''
let lastCompletedRenderCacheKey = ''
/** 上一次流式阶段实际 render 的时间，用于把纯 debounce 升级为 leading + max-wait 节流。 */
let lastStreamingRenderAt = 0
/** 后处理（图片/Mermaid/链接校验）是否已对当前内容完成 */
let postProcessedSource = ''
let postProcessedProfile: RenderProfile = 'default'

function buildCompletedRenderCacheKey(content: string, latexOnly: boolean, renderProfile: RenderProfile): string {
  return `${actualLanguage.value}\u0000${latexOnly ? '1' : '0'}\u0000${renderProfile}\u0000${buildWorkspaceFileExistenceSignature(content)}\u0000${content}`
}

function buildWorkspaceFileExistenceSignature(content: string): string {
  const paths = extractPotentialFilePaths(content)
  if (paths.length === 0) return ''

  return paths
    .slice()
    .sort()
    .map((path) => {
      if (!fileExistenceCache.has(path)) return `${path}:?`
      return `${path}:${fileExistenceCache.get(path) === true ? '1' : '0'}`
    })
    .join('|')
}

function getMemoizedCompletedRender(cacheKey: string, content: string, latexOnly: boolean, renderProfile: RenderProfile): string {
  const cached = completedRenderCache.get(cacheKey)
  if (cached !== undefined) {
    // LRU：命中时刷新顺序，尽量保留最近使用的已完成消息 HTML。
    completedRenderCache.delete(cacheKey)
    completedRenderCache.set(cacheKey, cached)
    return cached
  }

  const html = renderContent(content, latexOnly, renderProfile)
  completedRenderCache.set(cacheKey, html)

  if (completedRenderCache.size > COMPLETED_RENDER_CACHE_LIMIT) {
    const oldestKey = completedRenderCache.keys().next().value
    if (typeof oldestKey === 'string') {
      completedRenderCache.delete(oldestKey)
    }
  }

  return html
}

function renderCurrentContent(): boolean {
  if (!props.content) {
    const changed = renderedContent.value !== ''
    renderedContent.value = ''
    lastRenderedSource = ''
    lastRenderedProfile = props.renderProfile
    lastRenderedLatexOnly = props.latexOnly
    lastRenderedLanguage = actualLanguage.value
    lastRenderedMode = props.isStreaming ? 'streaming' : 'completed'
    lastCompletedRenderCacheKey = ''
    return changed
  }

  if (props.isStreaming) {
    const unchanged = (
      lastRenderedMode === 'streaming' &&
      props.content === lastRenderedSource &&
      props.latexOnly === lastRenderedLatexOnly &&
      props.renderProfile === lastRenderedProfile &&
      actualLanguage.value === lastRenderedLanguage &&
      renderedContent.value !== ''
    )

    if (unchanged) return false

    lastRenderedSource = props.content
    lastRenderedLatexOnly = props.latexOnly
    lastRenderedProfile = props.renderProfile
    lastRenderedLanguage = actualLanguage.value
    lastRenderedMode = 'streaming'
    lastCompletedRenderCacheKey = ''
    renderedContent.value = renderContent(props.content, props.latexOnly, props.renderProfile)
    return true
  }

  const cacheKey = buildCompletedRenderCacheKey(props.content, props.latexOnly, props.renderProfile)
  const unchanged = (
    lastRenderedMode === 'completed' &&
    lastCompletedRenderCacheKey === cacheKey &&
    renderedContent.value !== ''
  )

  if (unchanged) return false

  lastRenderedSource = props.content
  lastRenderedLatexOnly = props.latexOnly
  lastRenderedProfile = props.renderProfile
  lastRenderedLanguage = actualLanguage.value
  lastRenderedMode = 'completed'
  lastCompletedRenderCacheKey = cacheKey
  renderedContent.value = getMemoizedCompletedRender(cacheKey, props.content, props.latexOnly, props.renderProfile)
  return true
}

function clearRenderTimer() {
  if (renderTimer !== null) {
    window.clearTimeout(renderTimer)
    renderTimer = null
  }
}

async function applyPostRenderDomState(rendered: boolean, needsPostProcess = false): Promise<void> {
  if (rendered || needsPostProcess) {
    // Mermaid / workspace images 需要基于最新 DOM 执行；流式阶段只回填轻量代码块状态。
    await nextTick()
    applyCodeBlockWrapStates()
  }
}

async function renderStreamingNow(): Promise<void> {
  const rendered = renderCurrentContent()
  if (rendered) {
    lastStreamingRenderAt = Date.now()
  }
  await applyPostRenderDomState(rendered)
}

function scheduleRender() {
  clearRenderTimer()

  if (props.isStreaming) {
    // 新流开始：激活流式类并清空上一轮的展开态记录（超高块会在每次渲染后重新测量记录）
    if (!isStreamingClassActive.value) {
      isStreamingClassActive.value = true
      streamingOverHeightBlockIds.clear()
    }
    const now = Date.now()
    const shouldRenderLeading = !!props.content && renderedContent.value === ''
    const shouldRenderByMaxWait = !!props.content && now - lastStreamingRenderAt >= STREAM_RENDER_MAX_WAIT_MS

    // 修改原因：纯 debounce 在流式高频更新时会一直推迟渲染；若组件新实例初始 HTML 为空，还会造成正文闪白。
    // 修改方式：流式阶段采用 leading + trailing + max-wait：首个非空内容立即渲染，持续输出最多等待固定窗口，尾部再补一次。
    // 修改目的：保留 50ms chunk 批处理的性能收益，同时让旧 HTML 在新 HTML 准备好前持续可见，不再闪烁或长时间滞后。
    if (shouldRenderLeading || shouldRenderByMaxWait) {
      void renderStreamingNow()
    }

    renderTimer = window.setTimeout(() => {
      void renderStreamingNow()
    }, STREAM_RENDER_DEBOUNCE_MS)
    return
  }

  lastStreamingRenderAt = 0

  // 非流式 + 首次渲染：同步执行 render，让组件挂载瞬间就有内容（消除切换对话闪白）
  if (renderedContent.value === '') {
    renderCurrentContent()

    // 后处理（图片/Mermaid/链接校验、代码块换行状态）仍异步执行
    // #67：回调开头捕获 source/profile，await 后比对再写 postProcessed，防止并发更新时覆盖
    renderTimer = window.setTimeout(async () => {
      const source = props.content
      const profile = props.renderProfile
      await nextTick()
      applyCodeBlockWrapStates()
      if (
        postProcessedSource !== source ||
        postProcessedProfile !== profile
      ) {
        await prevalidateFilePaths(source)

        // 为什么这里要在预校验后再尝试一次 render：
        // 首次同步渲染时，工作区文件存在性缓存可能还是未知状态，
        // 预校验完成后需要让”是否生成文件链接”这个边界重新收敛一次。
        const rerenderedAfterPrevalidate = renderCurrentContent()
        if (rerenderedAfterPrevalidate) {
          await nextTick()
          applyCodeBlockWrapStates()
        }

        await loadWorkspaceImages()
        await renderMermaid()
        postProcessedSource = source
        postProcessedProfile = profile
      }
    }, 0)
    return
  }

  renderTimer = window.setTimeout(async () => {
    // #67：回调开头捕获 source/profile，await 后比对再写 postProcessed，防止并发更新时覆盖
    const source = props.content
    const profile = props.renderProfile
    // 非流式阶段：渲染前预校验文件路径，写入缓存供 markdown-it 插件查询。
    // 这样 memoized render 也能感知”文件是否存在”这个渲染边界，不会把未知状态缓存成最终结果。
    await prevalidateFilePaths(source)

    const rendered = renderCurrentContent()

    // 需要后处理（图片/Mermaid）且尚未完成
    const needsPostProcess = (
      postProcessedSource !== source ||
      postProcessedProfile !== profile
    )

    await applyPostRenderDomState(rendered, needsPostProcess)

    if (!rendered && !needsPostProcess) return

    await loadWorkspaceImages()
    await renderMermaid()

    postProcessedSource = source
    postProcessedProfile = profile
  }, 0)
}

/**
 * 回填代码块的换行状态与按钮提示；同时维护流式保留展开态（B-M1）：
 * - 流式期间/收尾窗口（is-streaming 类尚未解除，pre 仍为自然高度）测量并记录超高块；
 * - 非流式时按记录恢复 keep-expanded（is-streaming 类负责流式期间的放开）；
 * - 收尾窗口记录完毕后解除流式类，使过渡原子化。
 */
function applyCodeBlockWrapStates() {
  if (!containerRef.value) return

  const blocks = containerRef.value.querySelectorAll<HTMLElement>('.code-block-container[data-block-id]')
  // 记录窗口：流式期间，或“流式类尚未解除”的收尾窗口（此时 pre 仍为自然高度，可测 scrollHeight）
  const recording = props.isStreaming || isStreamingClassActive.value

  blocks.forEach((block) => {
    const blockId = block.getAttribute('data-block-id') || ''
    const isNoWrap = codeWrapOverrides.get(blockId) === true

    block.classList.toggle('is-nowrap', isNoWrap)

    if (recording) {
      const pre = block.querySelector<HTMLElement>('pre.code-block-wrapper')
      if (pre && pre.scrollHeight > CODE_BLOCK_COLLAPSE_HEIGHT) {
        streamingOverHeightBlockIds.add(blockId)
      }
    }
    // 非流式时按记录恢复展开态（流式期间由 is-streaming 类放开高度，无需 keep-expanded）
    block.classList.toggle('keep-expanded', !props.isStreaming && streamingOverHeightBlockIds.has(blockId))

    const wrapBtn = block.querySelector<HTMLButtonElement>('.code-wrap-btn')
    if (wrapBtn) {
      const titleNoWrap = wrapBtn.getAttribute('data-title-wrap') || ''
      const titleWrap = wrapBtn.getAttribute('data-title-nowrap') || ''

      // title 表示“点击后将切换到的模式”
      wrapBtn.title = isNoWrap ? titleWrap : titleNoWrap
      wrapBtn.setAttribute('aria-pressed', String(isNoWrap))
    }
  })

  // 流式结束：keep-expanded 已就位后解除流式类（过渡原子化，无塌缩跳变）
  if (!props.isStreaming && isStreamingClassActive.value) {
    isStreamingClassActive.value = false
  }

  // 用户滚动离开后恢复正常高度限制（IntersectionObserver 观察 keep-expanded 块）
  observeKeepExpandedBlocks(blocks)
}

let keepExpandedObserver: IntersectionObserver | null = null
const keepExpandedObservedBlocks = new Set<HTMLElement>()

/**
 * 释放某个代码块的流式保留展开态：恢复正常高度限制并停止观察。
 * 触发时机：用户点击换行按钮，或该块滚动离开视口（IntersectionObserver）。
 */
function releaseKeepExpandedBlock(block: HTMLElement, blockId: string) {
  streamingOverHeightBlockIds.delete(blockId)
  block.classList.remove('keep-expanded')
  keepExpandedObserver?.unobserve(block)
  keepExpandedObservedBlocks.delete(block)
}

/** 观察 keep-expanded 块：一旦滚出视口即恢复正常高度限制 */
function observeKeepExpandedBlocks(blocks: NodeListOf<HTMLElement>) {
  // jsdom 等无 IntersectionObserver 的环境直接跳过（保留展开态直到用户点击换行按钮）
  if (typeof IntersectionObserver === 'undefined') return

  // 修剪已从 DOM 移除的观察目标（v-html 重建后旧元素失效）
  for (const block of Array.from(keepExpandedObservedBlocks)) {
    if (!block.isConnected) {
      keepExpandedObserver?.unobserve(block)
      keepExpandedObservedBlocks.delete(block)
    }
  }

  if (!keepExpandedObserver) {
    keepExpandedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) continue
        const block = entry.target as HTMLElement
        releaseKeepExpandedBlock(block, block.getAttribute('data-block-id') || '')
      }
    })
  }

  for (const block of blocks) {
    if (!block.classList.contains('keep-expanded')) continue
    if (keepExpandedObservedBlocks.has(block)) continue
    keepExpandedObservedBlocks.add(block)
    keepExpandedObserver.observe(block)
  }
}

/**
 * 处理代码块工具栏点击（复制 / 换行切换）
 */
function handleCodeToolbarClick(event: Event) {
  const target = event.target as HTMLElement

  const wrapBtn = target.closest('.code-wrap-btn') as HTMLButtonElement | null
  if (wrapBtn) {
    event.stopPropagation()

    const block = wrapBtn.closest('.code-block-container') as HTMLElement | null
    const blockId = block?.getAttribute('data-block-id') || ''
    if (!block || !blockId) return

    const currentlyNoWrap = block.classList.contains('is-nowrap')
    if (currentlyNoWrap) {
      codeWrapOverrides.delete(blockId)
    } else {
      codeWrapOverrides.set(blockId, true)
    }

    // 手动点击换行按钮视为用户已接管该块的展示：清除流式保留展开态，恢复正常高度限制（B-M1）
    releaseKeepExpandedBlock(block, blockId)

    applyCodeBlockWrapStates()
    return
  }

  const copyBtn = target.closest('.code-copy-btn') as HTMLButtonElement | null
  if (!copyBtn) return

  // 阻止冒泡，避免触发 Mermaid 放大等
  event.stopPropagation()

  const encodedCode = copyBtn.getAttribute('data-code')
  if (!encodedCode) return

  const code = decodeURIComponent(atob(encodedCode))

  navigator.clipboard.writeText(code).then(() => {
    const existingTimer = copyTimers.get(copyBtn)
    if (existingTimer) {
      window.clearTimeout(existingTimer)
    }

    copyBtn.classList.add('copied')

    const timer = window.setTimeout(() => {
      copyBtn.classList.remove('copied')
      copyTimers.delete(copyBtn)
    }, 1000)

    copyTimers.set(copyBtn, timer)
  }).catch(err => {
    console.error('复制失败:', err)
  })
}

/**
 * 文件存在性缓存 & 预校验
 *
 * 在 markdown-it 渲染之前，从原始内容中提取所有可能的文件路径，
 * 批量请求后端校验，结果写入缓存。
 * 渲染时，markdown-it 插件 / fence 渲染器查缓存决定是否生成 <a> 标签。
 * 不存在（或未缓存）的路径直接输出为纯文本，无任何闪烁。
 */

/**
 * 从原始 Markdown 内容中提取所有可能的工作区文件路径
 */
function extractPotentialFilePaths(content: string): string[] {
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

/**
 * 渲染前预校验：批量检查未缓存的路径是否存在
 */
async function prevalidateFilePaths(content: string) {
  const allPaths = extractPotentialFilePaths(content)
  const unchecked = allPaths.filter(p => !fileExistenceCache.has(p))
  if (unchecked.length === 0) return

  try {
    const resp = await sendToExtension<{ results: Record<string, boolean> }>(
      'checkWorkspaceFilesExist',
      { paths: unchecked }
    )
    if (resp?.results) {
      for (const [p, exists] of Object.entries(resp.results)) {
        setCached(fileExistenceCache, p, exists)
      }
    }
  } catch (err) {
    console.warn('Failed to prevalidate workspace file paths:', err)
  }
}

/**
 * 加载工作区图片
 */
async function loadWorkspaceImages() {
  if (!containerRef.value) return
  
  const images = containerRef.value.querySelectorAll('img.workspace-image[data-path]')
  
  for (const img of images) {
    const encodedPath = img.getAttribute('data-path')
    if (!encodedPath) continue
    
    try {
      const imgPath = decodeURIComponent(atob(encodedPath))
      
      if (imageCache.has(imgPath)) {
        img.setAttribute('src', imageCache.get(imgPath)!)
        img.classList.remove('workspace-image')
        img.classList.add('loaded-image')
        img.setAttribute('data-image-path', imgPath)
        continue
      }
      
      const response = await sendToExtension<{
        success: boolean;
        data?: string;
        mimeType?: string;
        error?: string;
      }>('readWorkspaceImage', { path: imgPath })
      
      if (response?.success && response.data) {
        const dataUrl = `data:${response.mimeType || 'image/png'};base64,${response.data}`
        // 带字节预算写入缓存；超大图片跳过缓存但下方仍直接设置 src 显示
        setCachedImage(imgPath, dataUrl)
        img.setAttribute('src', dataUrl)
        img.classList.remove('workspace-image')
        img.classList.add('loaded-image')
        img.setAttribute('data-image-path', imgPath)
      } else {
        img.classList.add('image-error')
        img.setAttribute('title', response?.error || '无法加载图片')
      }
    } catch (error) {
      console.error('加载图片失败:', error)
      img.classList.add('image-error')
    }
  }
}

/**
 * 处理图片点击
 */
async function handleImageClick(event: Event) {
  const target = event.target as HTMLElement
  
  if (target.tagName === 'IMG' && target.classList.contains('loaded-image')) {
    const imgPath = target.getAttribute('data-image-path')
    if (imgPath) {
      await sendToExtension('openWorkspaceFile', { path: imgPath })
    }
  }
}

/**
 * 处理工作区文件链接点击（路径/行号 -> 打开文件并定位/高亮）
 */
async function handleWorkspaceFileLinkClick(event: Event) {
  const target = event.target as HTMLElement

  // 1) 优先处理我们生成的 workspace-file-link
  const fileLink = target.closest('a.workspace-file-link') as HTMLAnchorElement | null

  // 2) fallback：处理普通 <a href="relative/path.ts:12"> 这类 Markdown 链接，避免 webview 内导航
  const link = (fileLink || target.closest('a')) as HTMLAnchorElement | null
  if (!link) return

  let ref: WorkspaceFileRef | null = null

  if (fileLink) {
    const encoded = fileLink.getAttribute('data-path')
    if (encoded) {
      const path = normalizeWorkspaceFilePath(decodeDataPath(encoded))
      const startLine = parsePositiveInt(fileLink.getAttribute('data-start-line'))
      const endLine = parsePositiveInt(fileLink.getAttribute('data-end-line')) ?? startLine
      if (path) {
        ref = { path, startLine, endLine }
      }
    }
  }

  if (!ref) {
    let href = (link.getAttribute('href') || '').trim()
    if (!href || href === '#' || href.startsWith('#')) return
    if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) return

    // markdown-it 会对非 ASCII 字符做 percent-encode，先还原再解析
    try { href = decodeURIComponent(href) } catch { /* ignore malformed */ }

    // 先解析 href；不行再解析链接文本
    ref = parseWorkspaceFileRefExact(href) || parseWorkspaceFileRefExact((link.textContent || '').trim())
  }

  if (!ref) return

  event.preventDefault()
  event.stopPropagation()

  try {
    await sendToExtension('openWorkspaceFileAt', {
      path: ref.path,
      startLine: ref.startLine,
      endLine: ref.endLine,
      highlight: true
    })
  } catch (err: any) {
    const msg = typeof err?.message === 'string' && err.message.trim()
      ? err.message
      : '打开文件失败'
    await showNotification(msg, 'error')
  }
}

/**
 * 处理 Mermaid 图表点击放大
 */
function handleMermaidClick(event: Event) {
  const target = event.target as HTMLElement
  const wrapper = target.closest('.mermaid-wrapper')
  
  // 如果点击的是复制按钮，不触发放大
  if (target.closest('.code-copy-btn')) return
  
  if (wrapper) {
    const mermaidDiv = wrapper.querySelector('.mermaid')
    if (mermaidDiv) {
      zoomedContent.value = mermaidDiv.innerHTML
      zoomTitle.value = t('components.common.markdownRenderer.mermaid.title')
      resetZoom() // 每次打开重置缩放状态
      isZoomModalVisible.value = true
    }
  }
}

onMounted(() => {
  if (containerRef.value) {
    containerRef.value.addEventListener('click', handleCodeToolbarClick)
    containerRef.value.addEventListener('click', handleWorkspaceFileLinkClick)
    containerRef.value.addEventListener('click', handleImageClick)
    containerRef.value.addEventListener('click', handleMermaidClick)
  }
})

watch(
  // 为什么把语言也纳入依赖：复制按钮/换行按钮标题等 HTML 文案由 i18n 决定，
  // 完成态缓存必须随语言切换失效，否则会把旧语言的工具栏文案错误复用到新语言界面。
  // 怎么改：将 actualLanguage 与原有 props 一起作为渲染触发源。
  // 目的：在不改 DOM/CSS 的前提下保持 memoized render 与现有国际化语义一致。
  () => [props.content, props.latexOnly, props.renderProfile, props.isStreaming, actualLanguage.value] as const,
  () => {
    scheduleRender()
  },
  { immediate: true }
)

onUnmounted(()=> {
  clearRenderTimer()
  if (containerRef.value) {
    containerRef.value.removeEventListener('click', handleCodeToolbarClick)
    containerRef.value.removeEventListener('click', handleWorkspaceFileLinkClick)
    containerRef.value.removeEventListener('click', handleImageClick)
    containerRef.value.removeEventListener('click', handleMermaidClick)
  }
  copyTimers.forEach((timer) => {
    window.clearTimeout(timer)
  })
  copyTimers.clear()
  keepExpandedObserver?.disconnect()
  keepExpandedObserver = null
  keepExpandedObservedBlocks.clear()
})
</script>

<template>
  <div ref="containerRef" class="markdown-content" :class="{ 'is-streaming': isStreamingClassActive }" v-html="renderedContent"></div>

  <!-- 沉浸式全屏查看 -->
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="isZoomModalVisible" class="mermaid-zoom-overlay">
        <!-- 悬浮关闭按钮 -->
        <button class="zoom-floating-close" @click="isZoomModalVisible = false" :title="t('components.common.markdownRenderer.mermaid.closePreview')">
          <i class="codicon codicon-close"></i>
        </button>

        <!-- 内容区 -->
        <div 
          class="zoom-body" 
          @wheel="handleWheel"
          @mousedown="handleMouseDown"
          @mousemove="handleMouseMove"
          :style="{ cursor: isDragging ? 'grabbing' : 'grab' }"
        >
          <div 
            class="zoomed-mermaid-content" 
            v-html="zoomedContent" 
            :style="{ 
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`
            }"
          ></div>
        </div>

        <!-- 悬浮控制栏 -->
        <div class="zoom-controls">
          <div class="zoom-actions">
            <div class="zoom-btn-group">
              <button class="zoom-action-btn icon-only" @click="handleZoomOut" :title="t('components.common.markdownRenderer.mermaid.zoomOut')">
                <i class="codicon codicon-zoom-out"></i>
              </button>
              <button class="zoom-action-btn text-btn" @click="resetZoom" :title="t('components.common.markdownRenderer.mermaid.resetZoom')">
                {{ Math.round(zoomScale * 100) }}%
              </button>
              <button class="zoom-action-btn icon-only" @click="handleZoomIn" :title="t('components.common.markdownRenderer.mermaid.zoomIn')">
                <i class="codicon codicon-zoom-in"></i>
              </button>
            </div>
            <div class="zoom-divider"></div>
            <span class="zoom-status-tip">{{ t('components.common.markdownRenderer.mermaid.tip') }}</span>
            <div class="zoom-divider"></div>
            <button class="zoom-action-btn close-btn" @click="isZoomModalVisible = false" :title="t('components.common.markdownRenderer.mermaid.closePreview')">
              <i class="codicon codicon-close"></i>
              {{ t('components.common.markdownRenderer.mermaid.closePreview') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 基础样式 */
.markdown-content {
  /*
   * 允许外部通过 CSS 变量覆写，以便在“思考内容”等场景使用不同的颜色/斜体/字号。
   * 默认值保持与原先一致。
   */
  font-size: var(--lim-md-font-size, 13px);
  line-height: var(--lim-md-line-height, 1.6);
  color: var(--lim-md-color, var(--vscode-foreground));
  font-style: var(--lim-md-font-style, normal);

  word-break: break-word;
}

/* 段落 */
.markdown-content :deep(p) {
  margin: 0 0 0.8em 0;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* 移除空段落 */
.markdown-content :deep(p:empty) {
  display: none;
}

/* 代码块前后的段落减少间距 */
.markdown-content :deep(p + .code-block-container),
.markdown-content :deep(.code-block-container + p),
.markdown-content :deep(p + .mermaid-block-container),
.markdown-content :deep(.mermaid-block-container + p) {
  margin-top: 0;
}

/* 标题 */
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 1em 0 0.5em 0;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-content :deep(h1) { font-size: 1.5em; }
.markdown-content :deep(h2) { font-size: 1.3em; }
.markdown-content :deep(h3) { font-size: 1.15em; }
.markdown-content :deep(h4) { font-size: 1em; }

/* 列表 */
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.markdown-content :deep(li) {
  margin: 0.25em 0;
}

/* 任务列表 */
.markdown-content :deep(.task-list-item) {
  list-style: none;
  margin-left: -1.5em;
}

.markdown-content :deep(.task-list-item-checkbox) {
  margin-right: 0.5em;
  pointer-events: none;
}

/* 引用 */
.markdown-content :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-foreground);
  opacity: 0.9;
}

/* 嵌套引用 */
.markdown-content :deep(blockquote blockquote) {
  border-left-color: var(--vscode-textLink-foreground);
}

/* 定义列表 */
.markdown-content :deep(dl) {
  margin: 0.8em 0;
}

.markdown-content :deep(dt) {
  font-weight: 600;
  margin-top: 0.5em;
}

.markdown-content :deep(dd) {
  margin-left: 1.5em;
  margin-bottom: 0.5em;
}

/* 代码块外层容器（工具栏固定在右上角） */
.markdown-content :deep(.code-block-container) {
  position: relative;
  margin: 0.5em 0;
}

.markdown-content :deep(.mermaid-block-container) {
  position: relative;
  margin: 1em 0;
}

/* 标题栏：区分标题区/内容区（标题栏更“白”一点） */
.markdown-content :deep(.code-block-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  background: rgba(255, 255, 255, 0.06);
}

.markdown-content :deep(.code-block-title) {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vscode-foreground);
  opacity: 0.9;
  text-transform: none;
}

/* 工具栏：放在标题栏内，避免随内容滚动 */
.markdown-content :deep(.code-block-toolbar) {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.75;
  transition: opacity 0.15s;
}

.markdown-content :deep(.code-block-container:hover .code-block-toolbar),
.markdown-content :deep(.mermaid-block-container:hover .code-block-toolbar),
.markdown-content :deep(.code-block-toolbar:hover) {
  opacity: 1 !important;
}

/* 工具栏按钮（复制 / 换行） */
.markdown-content :deep(.code-tool-btn) {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  color: var(--vscode-foreground);
}

.markdown-content :deep(.code-tool-btn:hover) {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
}

/* 换行按钮图标：默认（自动换行）显示“切到不换行”；不换行时显示“切到自动换行” */
.markdown-content :deep(.code-wrap-btn .wrap-icon),
.markdown-content :deep(.code-wrap-btn .nowrap-icon) {
  font-size: 13px;
  line-height: 1;
  display: inline-block;
}

.markdown-content :deep(.code-wrap-btn .wrap-icon) {
  display: none;
}

.markdown-content :deep(.code-block-container.is-nowrap .code-wrap-btn .wrap-icon) {
  display: inline-block;
}

.markdown-content :deep(.code-block-container.is-nowrap .code-wrap-btn .nowrap-icon) {
  display: none;
}

.markdown-content :deep(.code-copy-btn .copy-icon) {
  font-size: 14px;
  color: var(--vscode-foreground);
  display: block;
}

.markdown-content :deep(.code-copy-btn .check-icon) {
  font-size: 14px;
  color: var(--vscode-foreground);
  display: none;
}

.markdown-content :deep(.code-copy-btn.copied) {
  opacity: 1 !important;
}

.markdown-content :deep(.code-copy-btn.copied .copy-icon) {
  display: none;
}

.markdown-content :deep(.code-copy-btn.copied .check-icon) {
  display: block;
}

/* 代码块内的 pre（滚动容器） */
.markdown-content :deep(.code-block-container pre.code-block-wrapper) {
  margin: 0;
  padding: 12px;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-top: none;
  border-radius: 0 0 4px 4px;
  max-height: 400px;
  overflow-y: auto;
  overflow-x: hidden; /* 默认：自动换行，避免横向滚动条 */
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(100, 100, 100, 0.4)) transparent;
}

/* 流式期间长代码块不限制高度（自然展开，用户跟随输出阅读）：
 * v-html 每次内容更新会整体重建 DOM，pre.code-block-wrapper 作为内部滚动容器会被销毁重建，
 * scrollTop 因此被重置为 0——流式输出中长代码块一旦出现滚动条就无法滚动。
 * 流式期间去掉 max-height 让代码块随输出自然增高。
 * 注意：这里用 overflow: visible（同时声明两轴）。若只声明 overflow-y: visible，
 * 与基础规则的 overflow-x: hidden 并存时，计算值会变成 overflow-y: auto（声明无效）；
 * 换行开关（.is-nowrap 的 overflow-x: auto）在本规则之后声明，同优先级按源码顺序覆盖生效。 */
.markdown-content.is-streaming :deep(.code-block-container pre.code-block-wrapper) {
  max-height: none;
  overflow: visible;
}

.markdown-content :deep(.code-block-container.is-nowrap pre.code-block-wrapper) {
  /* 不换行时开启横向滚动（置于流式规则之后：同优先级按源码顺序覆盖其 overflow-x） */
  overflow-x: auto;
}

/* 流式结束/中断：对“流式期间超高”的代码块保留展开态（keep-expanded），
 * 避免 is-streaming 类移除瞬间高度从自然高度塌缩回 400px、视口上移丢失阅读位置；
 * 用户点击换行按钮或滚动离开该块后恢复正常限制（见 applyCodeBlockWrapStates）。 */
.markdown-content :deep(.code-block-container.keep-expanded pre.code-block-wrapper) {
  max-height: none;
}

/* 代码块内的 code */
.markdown-content :deep(.code-block-container pre.code-block-wrapper code) {
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
  font-size: 12px;
  line-height: 1.5;
  display: block;
}

/* 行号布局：每个“原始行”一行号；软换行在同一行号内折行 */
.markdown-content :deep(.code-with-lines) {
  counter-reset: none;
}

.markdown-content :deep(.code-with-lines .code-line) {
  display: flex;
  align-items: flex-start;
}

.markdown-content :deep(.code-with-lines .code-line-number) {
  /* 按代码块最大行号位数自适应宽度（由 --line-number-digits 提供） */
  width: calc(var(--line-number-digits, 2) * 1ch + 4px);
  padding-right: 6px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
  color: var(--vscode-descriptionForeground);
  opacity: 0.65;
  flex: 0 0 auto;
}

.markdown-content :deep(.code-with-lines .code-line-content) {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap; /* 默认：自动换行 */
  overflow-wrap: anywhere;
}

.markdown-content :deep(.code-block-container.is-nowrap .code-with-lines .code-line-content) {
  white-space: pre; /* 不换行 */
  overflow-wrap: normal;
}

/* 行内代码 */
.markdown-content :deep(code:not(.hljs)) {
  padding: 2px 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
  font-size: 0.9em;
  font-style: normal; /* 避免外层（如思考块）设置斜体后影响代码 */
}

/* 代码块/键盘按键等保持非斜体 */
.markdown-content :deep(pre),
.markdown-content :deep(code),
.markdown-content :deep(kbd),
.markdown-content :deep(samp) {
  font-style: normal;
}

/* 链接 */
.markdown-content :deep(a) {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(a[target="_blank"])::after {
  content: " ↗";
  font-size: 0.8em;
  opacity: 0.7;
}


/* 分隔线 */
.markdown-content :deep(hr) {
  margin: 1em 0;
  border: none;
  border-top: 1px solid var(--vscode-panel-border);
}

/* 表格 */
.markdown-content :deep(table) {
  margin: 0.8em 0;
  border-collapse: collapse;
  width: 100%;
  display: block;
  overflow-x: auto;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--vscode-panel-border);
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--vscode-textBlockQuote-background);
  font-weight: 600;
}

.markdown-content :deep(tbody tr:hover) {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1));
}

/* 粗体和斜体 */
.markdown-content :deep(strong) {
  font-weight: 600;
}

.markdown-content :deep(em) {
  font-style: italic;
}

/* 删除线 */
.markdown-content :deep(del),
.markdown-content :deep(s) {
  text-decoration: line-through;
  opacity: 0.7;
}

/* 脚注 */
.markdown-content :deep(.footnotes) {
  margin-top: 2em;
  padding-top: 1em;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 0.9em;
}

.markdown-content :deep(.footnotes-sep) {
  display: none;
}

.markdown-content :deep(.footnote-ref) {
  font-size: 0.8em;
  vertical-align: super;
}

.markdown-content :deep(.footnote-backref) {
  text-decoration: none;
}

/* 缩写 */
.markdown-content :deep(abbr) {
  text-decoration: underline dotted;
  cursor: help;
}

/* 键盘按键 */
.markdown-content :deep(kbd) {
  display: inline-block;
  padding: 2px 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.85em;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  box-shadow: 0 1px 0 var(--vscode-panel-border);
}

/* 上下标 */
.markdown-content :deep(sup) {
  font-size: 0.75em;
  vertical-align: super;
}

.markdown-content :deep(sub) {
  font-size: 0.75em;
  vertical-align: sub;
}

/* 高亮 */
.markdown-content :deep(mark) {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 235, 59, 0.3));
  padding: 0 2px;
  border-radius: 2px;
}

/* 折叠详情 */
.markdown-content :deep(details) {
  margin: 0.8em 0;
  padding: 0.5em;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border);
}

.markdown-content :deep(summary) {
  cursor: pointer;
  font-weight: 600;
  padding: 0.25em 0;
}

.markdown-content :deep(details[open] > summary) {
  margin-bottom: 0.5em;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 0.5em;
}

/* LaTeX 公式 */
.markdown-content :deep(.katex-block) {
  margin: 1em 0;
  padding: 12px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  overflow-x: auto;
  text-align: center;
}

/* Mermaid 图表 */
.markdown-content :deep(.mermaid-wrapper) {
  position: relative;
  margin: 0;
  padding: 16px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  justify-content: center;
  cursor: zoom-in;
}

.markdown-content :deep(.mermaid) {
  background: transparent;
  line-height: normal;
  cursor: zoom-in;
}

/* Mermaid 工具栏 hover 已由 .mermaid-block-container 的 .code-block-toolbar 统一处理 */

.markdown-content :deep(.mermaid svg) {
  max-width: 100%;
  height: auto;
}

.markdown-content :deep(.katex) {
  font-family: 'Times New Roman', Times, serif;
  font-size: 1.1em;
}

.markdown-content :deep(.katex-error) {
  color: var(--vscode-errorForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-inputValidation-errorBackground);
  padding: 2px 4px;
  border-radius: 2px;
}

/* 沉浸式全屏查看样式 */
.mermaid-zoom-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: var(--vscode-editor-background);
  display: flex;
  flex-direction: column;
}

.zoom-floating-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--vscode-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10001;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
}

.zoom-floating-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
  transform: rotate(90deg);
}

.zoom-body {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden; /* 拖拽模式不需要原生滚动条 */
  position: relative;
  user-select: none;
}

.zoomed-mermaid-content {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
  transition: transform 0.05s linear; /* 缩放和平移需要平滑感 */
  pointer-events: none; /* 让事件透传给 zoom-body 处理 */
}

.zoomed-mermaid-content :deep(svg) {
  max-width: none !important;
  max-height: none !important;
  width: auto !important;
  height: auto !important;
}

.zoom-controls {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  pointer-events: none;
}

.zoom-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 6px 6px 16px;
  border-radius: 30px;
  background: var(--vscode-sideBar-background);
  border: 1px solid var(--vscode-panel-border);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  backdrop-filter: blur(12px);
}

.zoom-btn-group {
  display: flex;
  align-items: center;
  background: var(--vscode-editor-background);
  border-radius: 20px;
  border: 1px solid var(--vscode-panel-border);
  overflow: hidden;
}

.zoom-divider {
  width: 1px;
  height: 20px;
  background: var(--vscode-panel-border);
}

.zoom-status-tip {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding-right: 12px;
}

.zoom-action-btn {
  height: 32px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.zoom-action-btn.icon-only {
  width: 36px;
}

.zoom-action-btn.text-btn {
  padding: 0 10px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  min-width: 50px;
  border-left: 1px solid var(--vscode-panel-border);
  border-right: 1px solid var(--vscode-panel-border);
}

.zoom-action-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.zoom-action-btn.close-btn {
  padding: 0 16px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-radius: 16px;
  font-weight: 500;
  margin-left: 4px;

  /* 保证“关闭预览”始终单行显示 */
  white-space: nowrap;
  word-break: keep-all;
  flex-shrink: 0;
  gap: 6px;
}

.zoom-action-btn.close-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.zoom-action-btn.close-btn i {
  font-size: 14px;
}

/* 过渡动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

/* 增加 Mermaid 文字对比度：强制白字黑边 (Meme 字体风格)，确保任何背景色下都清晰 */
.markdown-content :deep(.mermaid text),
.markdown-content :deep(.mermaid span),
.zoomed-mermaid-content :deep(text),
.zoomed-mermaid-content :deep(span) {
  fill: #ffffff !important;
  color: #ffffff !important;
  font-weight: 600 !important;
  text-shadow: 
    -1px -1px 0 #000,  
     1px -1px 0 #000,
    -1px  1px 0 #000,
     1px  1px 0 #000,
     0px  0px 4px rgba(0,0,0,0.8) !important;
}

/* 节点样式微调 */
.markdown-content :deep(.mermaid .node),
.zoomed-mermaid-content :deep(.node) {
  stroke-width: 1.5px !important;
}

/* 连线文字处理 */
.markdown-content :deep(.mermaid .edgeLabel),
.zoomed-mermaid-content :deep(.edgeLabel) {
  background-color: transparent !important;
  padding: 0 4px;
}

.mermaid-zoom-overlay {
  background: var(--vscode-editor-background);
  background-image: radial-gradient(var(--vscode-panel-border) 1px, transparent 1px);
  background-size: 20px 20px;
}

/* 图片 */
.markdown-content :deep(img) {
  max-width: 400px;
  max-height: 300px;
  width: auto;
  height: auto;
  border-radius: 4px;
  object-fit: contain;
}

.markdown-content :deep(img.workspace-image) {
  min-width: 100px;
  min-height: 60px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px dashed var(--vscode-panel-border);
}

.markdown-content :deep(img.loaded-image) {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  border: 1px solid var(--vscode-panel-border);
}

.markdown-content :deep(img.loaded-image:hover) {
  transform: scale(1.02);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.markdown-content :deep(img.image-error) {
  min-width: 100px;
  min-height: 40px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px dashed var(--vscode-errorForeground);
  opacity: 0.7;
}
</style>