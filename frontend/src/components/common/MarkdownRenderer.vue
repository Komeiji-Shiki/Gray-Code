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

import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import MarkdownIt from 'markdown-it'
import type { Options } from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type Renderer from 'markdown-it/lib/renderer.mjs'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import hljs from 'highlight.js'
import katex from 'katex'
import mermaid from 'mermaid'
import { sendToExtension } from '@/utils/vscode'

// 初始化 Mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark', // 默认为暗色，后续可根据 VS Code 主题动态调整
  securityLevel: 'loose',
  fontFamily: 'var(--vscode-editor-font-family, "Segoe UI", sans-serif)'
})

// 插件导入
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import taskLists from 'markdown-it-task-lists'

const props = withDefaults(defineProps<{
  content: string
  latexOnly?: boolean  // 仅渲染 LaTeX，不渲染 Markdown（用于用户消息）
}>(), {
  latexOnly: false
})

// 容器引用
const containerRef = ref<HTMLElement | null>(null)

// 复制按钮状态计时器存储
const copyTimers = new Map<HTMLButtonElement, number>()

// Mermaid 渲染锁定
let isMermaidRendering = false

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
 */
async function renderMermaid() {
  if (!containerRef.value || isMermaidRendering) return
  
  const mermaidElements = containerRef.value.querySelectorAll('.mermaid')
  if (mermaidElements.length === 0) return

  isMermaidRendering = true
  // 检查当前主题
  const isDark = document.body.classList.contains('vscode-dark') || 
                 document.body.classList.contains('vscode-high-contrast')
  
  try {
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
      securityLevel: 'loose',
      fontFamily: 'var(--vscode-editor-font-family, "Segoe UI", sans-serif)'
    })

    await mermaid.run({
      nodes: Array.from(mermaidElements) as HTMLElement[]
    })
  } catch (error) {
    console.error('Mermaid 渲染失败:', error)
  } finally {
    isMermaidRendering = false
  }
}

// 图片加载状态
const imageCache = new Map<string, string>()

/**
 * 创建并配置 markdown-it 实例
 */
function createMarkdownIt() {
  const md = new MarkdownIt({
    html: true,           // 允许 HTML 标签
    xhtmlOut: false,
    breaks: true,         // 换行转 <br>
    linkify: true,        // 自动检测链接
    typographer: true,    // 启用智能引号等排版功能
    highlight: function (str: string, lang: string) {
      // Mermaid 图表支持
      if (lang === 'mermaid') {
        const encodedCode = btoa(encodeURIComponent(str))
        // 使用 pre 包装以防止 markdown-it 对其进行转义
        return `<pre class="mermaid-wrapper"><div class="mermaid">${str}</div><button class="code-copy-btn" data-code="${encodedCode}" title="复制 Mermaid 代码"><span class="copy-icon codicon codicon-copy"></span><span class="check-icon codicon codicon-check"></span></button></pre>`
      }

      // 代码高亮
      let highlighted: string
      let langClass = ''
      
      if (lang && hljs.getLanguage(lang)) {
        try {
          highlighted = hljs.highlight(str, { language: lang }).value
          langClass = `language-${lang}`
        } catch (e) {
          highlighted = hljs.highlightAuto(str).value
        }
      } else {
        highlighted = hljs.highlightAuto(str).value
      }
      
      // 对原始代码进行 base64 编码以便复制时解码
      const encodedCode = btoa(encodeURIComponent(str))
      
      // 返回以 <pre 开头的字符串，避免 markdown-it 额外包裹
      return `<pre class="hljs code-block-wrapper"><button class="code-copy-btn" data-code="${encodedCode}" title="复制代码"><span class="copy-icon codicon codicon-copy"></span><span class="check-icon codicon codicon-check"></span></button><code class="${langClass}">${highlighted}</code></pre>`
    }
  })
  
  // 加载插件
  md.use(footnote)       // 脚注支持
  md.use(deflist)        // 定义列表支持
  md.use(taskLists, {    // 任务列表支持
    enabled: true,
    label: true,
    labelAfter: true
  })
  
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
  
  return md
}

// 创建 markdown-it 实例
const md = createMarkdownIt()

/**
 * 处理 LaTeX 公式
 */
function processLatex(text: string): string {
  // 先处理块级公式 $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, formula) => {
    try {
      return `<div class="katex-block">${katex.renderToString(formula.trim(), {
        displayMode: true,
        throwOnError: false,
        output: 'html'
      })}</div>`
    } catch (e) {
      console.warn('KaTeX block render error:', e)
      return `<div class="katex-error">$$${escapeHtml(formula)}$$</div>`
    }
  })
  
  // 再处理行内公式 $...$（排除已处理的块级公式）
  text = text.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g, (_match, formula) => {
    try {
      return katex.renderToString(formula.trim(), {
        displayMode: false,
        throwOnError: false,
        output: 'html'
      })
    } catch (e) {
      console.warn('KaTeX inline render error:', e)
      return `<span class="katex-error">$${escapeHtml(formula)}$</span>`
    }
  })
  
  return text
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
  processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
    const placeholder = `___LATEX_BLOCK_${formulas.length}___`
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
  processed = processed.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g, (match, formula) => {
    const placeholder = `___LATEX_INLINE_${formulas.length}___`
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
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 渲染 Markdown 和 LaTeX
 */
function renderContent(content: string, latexOnly: boolean): string {
  if (!content) return ''
  
  // 仅 LaTeX 模式（用户消息）
  if (latexOnly) {
    return renderLatexOnly(content)
  }
  
  // 完整 Markdown + LaTeX 模式
  // 1. 先提取代码块，避免代码块内的内容被 LaTeX 处理
  const codeBlocks: string[] = []
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `___CODE_BLOCK_${codeBlocks.length - 1}___`
  })
  
  // 2. 提取行内代码
  const inlineCodes: string[] = []
  processed = processed.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match)
    return `___INLINE_CODE_${inlineCodes.length - 1}___`
  })
  
  // 3. 处理 LaTeX
  processed = processLatex(processed)
  
  // 4. 还原行内代码
  processed = processed.replace(/___INLINE_CODE_(\d+)___/g, (_, index) => {
    return inlineCodes[parseInt(index)]
  })
  
  // 5. 还原代码块
  processed = processed.replace(/___CODE_BLOCK_(\d+)___/g, (_, index) => {
    return codeBlocks[parseInt(index)]
  })
  
  // 6. 使用 markdown-it 渲染
  let html = md.render(processed)
  
  // 7. 保留多个连续空格（在段落内容中）
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

// 渲染结果
const renderedContent = computed(() => {
  return renderContent(props.content, props.latexOnly)
})

/**
 * 处理复制按钮点击
 */
function handleCopyClick(event: Event) {
  const target = event.target as HTMLElement
  const button = target.closest('.code-copy-btn') as HTMLButtonElement
  
  if (!button) return
  
  // 阻止冒泡，避免触发放大查看
  event.stopPropagation()
  
  const encodedCode = button.getAttribute('data-code')
  if (!encodedCode) return
  
  const code = decodeURIComponent(atob(encodedCode))
  
  navigator.clipboard.writeText(code).then(() => {
    const existingTimer = copyTimers.get(button)
    if (existingTimer) {
      window.clearTimeout(existingTimer)
    }
    
    button.classList.add('copied')
    
    const timer = window.setTimeout(() => {
      button.classList.remove('copied')
      copyTimers.delete(button)
    }, 1000)
    
    copyTimers.set(button, timer)
  }).catch(err => {
    console.error('复制失败:', err)
  })
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
        imageCache.set(imgPath, dataUrl)
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
      zoomTitle.value = 'Mermaid 图表'
      resetZoom() // 每次打开重置缩放状态
      isZoomModalVisible.value = true
    }
  }
}

onMounted(() => {
  if (containerRef.value) {
    containerRef.value.addEventListener('click', handleCopyClick)
    containerRef.value.addEventListener('click', handleImageClick)
    containerRef.value.addEventListener('click', handleMermaidClick)
  }
  nextTick(async () => {
    await loadWorkspaceImages()
    await renderMermaid()
  })
})

watch(() => props.content, () => {
  nextTick(async () => {
    await loadWorkspaceImages()
    await renderMermaid()
  })
})

onUnmounted(()=> {
  if (containerRef.value) {
    containerRef.value.removeEventListener('click', handleCopyClick)
    containerRef.value.removeEventListener('click', handleImageClick)
    containerRef.value.removeEventListener('click', handleMermaidClick)
  }
  copyTimers.forEach((timer) => {
    window.clearTimeout(timer)
  })
  copyTimers.clear()
})
</script>

<template>
  <div ref="containerRef" class="markdown-content" v-html="renderedContent"></div>

  <!-- 沉浸式全屏查看 -->
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="isZoomModalVisible" class="mermaid-zoom-overlay">
        <!-- 悬浮关闭按钮 -->
        <button class="zoom-floating-close" @click="isZoomModalVisible = false" title="关闭预览">
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
              <button class="zoom-action-btn icon-only" @click="handleZoomOut" title="缩小">
                <i class="codicon codicon-zoom-out"></i>
              </button>
              <button class="zoom-action-btn text-btn" @click="resetZoom" title="重置缩放">
                {{ Math.round(zoomScale * 100) }}%
              </button>
              <button class="zoom-action-btn icon-only" @click="handleZoomIn" title="放大">
                <i class="codicon codicon-zoom-in"></i>
              </button>
            </div>
            <div class="zoom-divider"></div>
            <span class="zoom-status-tip">滚轮缩放，左键拖拽</span>
            <div class="zoom-divider"></div>
            <button class="zoom-action-btn close-btn" @click="isZoomModalVisible = false">
              <i class="codicon codicon-close"></i>
              关闭预览
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
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-foreground);
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
.markdown-content :deep(p + .code-block-wrapper),
.markdown-content :deep(.code-block-wrapper + p) {
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

/* 代码块容器 - 现在是 pre.code-block-wrapper */
.markdown-content :deep(pre.code-block-wrapper) {
  position: relative;
  margin: 0.5em 0;
  padding: 12px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 4px;
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(100, 100, 100, 0.4)) transparent;
}

/* 复制按钮 */
.markdown-content :deep(.code-copy-btn) {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 10;
  padding: 0;
}

.markdown-content :deep(.code-block-wrapper:hover .code-copy-btn) {
  opacity: 0.6;
}

.markdown-content :deep(.code-copy-btn:hover) {
  opacity: 1 !important;
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

/* 代码块内的 code */
.markdown-content :deep(pre.code-block-wrapper code) {
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
  font-size: 12px;
  line-height: 1.5;
  display: block;
}

/* 行内代码 */
.markdown-content :deep(code:not(.hljs)) {
  padding: 2px 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
  font-size: 0.9em;
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
  margin: 1em 0;
  padding: 16px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  justify-content: center;
}

.markdown-content :deep(.mermaid) {
  background: transparent;
  line-height: normal;
  cursor: zoom-in;
}

.markdown-content :deep(.mermaid-wrapper) {
  cursor: zoom-in;
}

.markdown-content :deep(.mermaid-wrapper .code-copy-btn) {
  opacity: 0;
  transition: opacity 0.15s;
}

.markdown-content :deep(.mermaid-wrapper:hover .code-copy-btn) {
  opacity: 0.6;
}

.markdown-content :deep(.mermaid-wrapper .code-copy-btn:hover) {
  opacity: 1 !important;
}

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