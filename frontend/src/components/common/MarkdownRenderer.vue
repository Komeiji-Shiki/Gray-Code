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
 *
 * 纯重构拆分说明（行为零变化、公共导出不变）：
 * 模块级单例与纯渲染逻辑已按职责抽取至 ./markdown/ 子目录：
 * - markdownItCore：缓存 / Mermaid 队列 / renderMermaid
 * - workspaceFileRefs：工作区文件引用解析工具
 * - markdownItEngine：markdown-it 实例与渲染管线纯函数
 * - codeBlockDom：代码块换行/复制/流式保留展开态 DOM 控制器
 * - workspaceAssets：文件预校验/图片加载/链接点击 DOM 控制器
 * - MermaidZoomModal：沉浸式全屏查看组件
 * 本文件仅保留：props/emits 契约、渲染节流管线、DOM 后处理接线与 .markdown-content 样式。
 */

import { ref, shallowRef, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from '@/i18n'
import { renderMermaid, fileExistenceCache, estimateStringBytes } from './markdown/markdownItCore'
import { extractPotentialFilePaths } from './markdown/workspaceFileRefs'
import { renderContent, type RenderProfile } from './markdown/markdownItEngine'
import { createCodeBlockDomController } from './markdown/codeBlockDom'
import { createWorkspaceAssetController } from './markdown/workspaceAssets'
import MermaidZoomModal from './markdown/MermaidZoomModal.vue'

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

const emit = defineEmits<{
  /** 当前 source 对应的 v-html 已经完成 DOM patch。 */
  rendered: [source: string]
}>()

const { t, actualLanguage } = useI18n()

// 容器引用
const containerRef = ref<HTMLElement | null>(null)

// 放大查看状态（缩放/平移/焦点管理等展示逻辑内聚于 MermaidZoomModal）
const isZoomModalVisible = ref(false)
const zoomedContent = ref('')
const zoomTitle = ref('')

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
/** 完成态渲染缓存字节预算：长消息 HTML 可达数百 KB，仅按条数限界会让缓存驻留内存膨胀到数十 MB */
const COMPLETED_RENDER_CACHE_MAX_BYTES = 8 * 1024 * 1024
const completedRenderCache = new Map<string, string>()
let completedRenderCacheBytes = 0

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
  completedRenderCacheBytes += estimateStringBytes(html)

  // 字节预算超限：按 FIFO 淘汰最旧条目，直到回到预算内（至少保留 1 条，避免单条超大时清空缓存）
  while (completedRenderCacheBytes > COMPLETED_RENDER_CACHE_MAX_BYTES && completedRenderCache.size > 1) {
    const oldestKey = completedRenderCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    const oldest = completedRenderCache.get(oldestKey)!
    completedRenderCache.delete(oldestKey)
    completedRenderCacheBytes -= estimateStringBytes(oldest)
  }

  // 条数上限兜底（与其它缓存一致）
  if (completedRenderCache.size > COMPLETED_RENDER_CACHE_LIMIT) {
    const oldestKey = completedRenderCache.keys().next().value
    if (typeof oldestKey === 'string') {
      const oldest = completedRenderCache.get(oldestKey)!
      completedRenderCache.delete(oldestKey)
      completedRenderCacheBytes -= estimateStringBytes(oldest)
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
    // 捕获本次真正写入 renderedContent 的 source；await 期间 props 可能继续增长，
    // 旧 render 不能误报为新 source 已经落地。
    const renderedSource = rendered ? lastRenderedSource : null
    // Mermaid / workspace images 需要基于最新 DOM 执行；流式阶段只回填轻量代码块状态。
    await nextTick()
    codeBlockDom.applyCodeBlockWrapStates()

    if (
      renderedSource !== null &&
      containerRef.value
    ) {
      emit('rendered', renderedSource)
    }
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
      codeBlockDom.clearStreamingOverHeightBlocks()
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
      codeBlockDom.applyCodeBlockWrapStates()
      if (
        postProcessedSource !== source ||
        postProcessedProfile !== profile
      ) {
        await workspaceAssets.prevalidateFilePaths(source)

        // 为什么这里要在预校验后再尝试一次 render：
        // 首次同步渲染时，工作区文件存在性缓存可能还是未知状态，
        // 预校验完成后需要让”是否生成文件链接”这个边界重新收敛一次。
        const rerenderedAfterPrevalidate = renderCurrentContent()
        if (rerenderedAfterPrevalidate) {
          await nextTick()
          codeBlockDom.applyCodeBlockWrapStates()
        }

        await workspaceAssets.loadWorkspaceImages()
        await renderMermaid(containerRef)
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
    await workspaceAssets.prevalidateFilePaths(source)

    const rendered = renderCurrentContent()

    // 需要后处理（图片/Mermaid）且尚未完成
    const needsPostProcess = (
      postProcessedSource !== source ||
      postProcessedProfile !== profile
    )

    await applyPostRenderDomState(rendered, needsPostProcess)

    if (!rendered && !needsPostProcess) return

    await workspaceAssets.loadWorkspaceImages()
    await renderMermaid(containerRef)

    postProcessedSource = source
    postProcessedProfile = profile
  }, 0)
}

// ===================== 代码块 DOM 交互（换行/复制/流式保留展开态） =====================
const codeBlockDom = createCodeBlockDomController(containerRef, isStreamingClassActive, () => props.isStreaming)

// ===================== 工作区资源（文件预校验/图片加载/链接点击） =====================
const workspaceAssets = createWorkspaceAssetController(containerRef)

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
      // 缩放/平移状态在 MermaidZoomModal 内打开时重置（等价于原 resetZoom()）
      isZoomModalVisible.value = true
    }
  }
}

onMounted(() => {
  if (containerRef.value) {
    containerRef.value.addEventListener('click', codeBlockDom.handleCodeToolbarClick)
    containerRef.value.addEventListener('click', workspaceAssets.handleWorkspaceFileLinkClick)
    containerRef.value.addEventListener('click', workspaceAssets.handleImageClick)
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
    containerRef.value.removeEventListener('click', codeBlockDom.handleCodeToolbarClick)
    containerRef.value.removeEventListener('click', workspaceAssets.handleWorkspaceFileLinkClick)
    containerRef.value.removeEventListener('click', workspaceAssets.handleImageClick)
    containerRef.value.removeEventListener('click', handleMermaidClick)
  }
  codeBlockDom.cleanup()
})
</script>

<template>
  <div ref="containerRef" class="markdown-content" :class="{ 'is-streaming': isStreamingClassActive }" v-html="renderedContent"></div>

  <!-- 沉浸式全屏查看（缩放/平移/键盘可达性内聚于 MermaidZoomModal） -->
  <MermaidZoomModal
    :visible="isZoomModalVisible"
    :content="zoomedContent"
    :title="zoomTitle"
    @close="isZoomModalVisible = false"
  />
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

/* 复制失败：按钮短暂变红提示（原实现失败只 console.error，用户无感知） */
.markdown-content :deep(.code-copy-btn.copy-failed) {
  opacity: 1 !important;
}

.markdown-content :deep(.code-copy-btn.copy-failed .copy-icon) {
  display: none;
}

.markdown-content :deep(.code-copy-btn.copy-failed .check-icon) {
  display: block;
  color: var(--vscode-errorForeground, #f14c4c);
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

/* ============================================================
   highlight.js 语法高亮主题（跟随 VS Code 主题变量）
   此前代码块只有 hljs 输出的 span 而无任何 .hljs-* 颜色规则，
   导致高亮退化为单色文本；这里按 VS Code 默认 Dark+/Light+ 语义配色。
   ============================================================ */
.markdown-content :deep(.hljs-keyword),
.markdown-content :deep(.hljs-selector-tag),
.markdown-content :deep(.hljs-literal),
.markdown-content :deep(.hljs-section),
.markdown-content :deep(.hljs-link),
.markdown-content :deep(.hljs-meta .hljs-keyword),
.markdown-content :deep(.hljs-function .hljs-keyword),
.markdown-content :deep(.hljs-type),
.markdown-content :deep(.hljs-built_in) {
  color: var(--vscode-keywordForeground, #569cd6);
}

.markdown-content :deep(.hljs-string),
.markdown-content :deep(.hljs-regexp),
.markdown-content :deep(.hljs-addition) {
  color: var(--vscode-string-foreground, #ce9178);
}

.markdown-content :deep(.hljs-title),
.markdown-content :deep(.hljs-title.function_),
.markdown-content :deep(.hljs-title.class_) {
  color: var(--vscode-entityName-function, #dcdcaa);
}

.markdown-content :deep(.hljs-number),
.markdown-content :deep(.hljs-symbol) {
  color: var(--vscode-number-foreground, #b5cea8);
}

.markdown-content :deep(.hljs-comment),
.markdown-content :deep(.hljs-quote) {
  color: var(--vscode-comment-foreground, #6a9955);
  font-style: italic;
}

.markdown-content :deep(.hljs-variable),
.markdown-content :deep(.hljs-template-variable),
.markdown-content :deep(.hljs-attribute),
.markdown-content :deep(.hljs-attr),
.markdown-content :deep(.hljs-params),
.markdown-content :deep(.hljs-property) {
  color: var(--vscode-variable-foreground, #9cdcfe);
}

.markdown-content :deep(.hljs-tag),
.markdown-content :deep(.hljs-name),
.markdown-content :deep(.hljs-selector-id),
.markdown-content :deep(.hljs-selector-class),
.markdown-content :deep(.hljs-selector-pseudo) {
  color: var(--vscode-entity-name-tag, #569cd6);
}

.markdown-content :deep(.hljs-deletion) {
  color: var(--vscode-entity-foreground, #f14c4c);
}

.markdown-content :deep(.hljs-emphasis) {
  font-style: italic;
}

.markdown-content :deep(.hljs-strong) {
  font-weight: bold;
}

.markdown-content :deep(.hljs-meta),
.markdown-content :deep(.hljs-doctag) {
  color: var(--vscode-meta-foreground, #d4d4d4);
}

.markdown-content :deep(.hljs-subst) {
  color: var(--vscode-foreground);
}

.markdown-content :deep(.hljs-operator),
.markdown-content :deep(.hljs-punctuation),
.markdown-content :deep(.hljs-bullet) {
  color: var(--vscode-foreground);
}

/* 浅色主题下调整暗色系默认值，保证对比度（覆盖仅在变量缺失时生效的 fallback） */
body.vscode-light .markdown-content :deep(.hljs-keyword),
body.vscode-light .markdown-content :deep(.hljs-selector-tag),
body.vscode-light .markdown-content :deep(.hljs-literal),
body.vscode-light .markdown-content :deep(.hljs-type),
body.vscode-light .markdown-content :deep(.hljs-built_in) {
  color: #0000ff;
}

body.vscode-light .markdown-content :deep(.hljs-string),
body.vscode-light .markdown-content :deep(.hljs-regexp),
body.vscode-light .markdown-content :deep(.hljs-addition) {
  color: #a31515;
}

body.vscode-light .markdown-content :deep(.hljs-title),
body.vscode-light .markdown-content :deep(.hljs-title.function_),
body.vscode-light .markdown-content :deep(.hljs-title.class_) {
  color: #795e26;
}

body.vscode-light .markdown-content :deep(.hljs-number),
body.vscode-light .markdown-content :deep(.hljs-symbol) {
  color: #098658;
}

body.vscode-light .markdown-content :deep(.hljs-comment),
body.vscode-light .markdown-content :deep(.hljs-quote) {
  color: #008000;
}

body.vscode-light .markdown-content :deep(.hljs-variable),
body.vscode-light .markdown-content :deep(.hljs-template-variable),
body.vscode-light .markdown-content :deep(.hljs-attribute),
body.vscode-light .markdown-content :deep(.hljs-attr),
body.vscode-light .markdown-content :deep(.hljs-params),
body.vscode-light .markdown-content :deep(.hljs-property) {
  color: #001080;
}

body.vscode-light .markdown-content :deep(.hljs-tag),
body.vscode-light .markdown-content :deep(.hljs-name),
body.vscode-light .markdown-content :deep(.hljs-selector-id),
body.vscode-light .markdown-content :deep(.hljs-selector-class),
body.vscode-light .markdown-content :deep(.hljs-selector-pseudo) {
  color: #800000;
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

/* 增加 Mermaid 文字对比度：强制白字黑边 (Meme 字体风格)，确保任何背景色下都清晰
 * （.zoomed-mermaid-content 部分随 MermaidZoomModal 组件迁移） */
.markdown-content :deep(.mermaid text),
.markdown-content :deep(.mermaid span) {
  fill: var(--vscode-foreground, #cccccc) !important;
  color: var(--vscode-foreground, #cccccc) !important;
  font-weight: 600 !important;
}

body.vscode-dark .markdown-content :deep(.mermaid text),
body.vscode-dark .markdown-content :deep(.mermaid span),
body.vscode-dark .zoomed-mermaid-content :deep(text),
body.vscode-dark .zoomed-mermaid-content :deep(span) {
  text-shadow:
    -1px -1px 0 #000,
     1px -1px 0 #000,
    -1px  1px 0 #000,
     1px  1px 0 #000,
     0px  0px 4px rgba(0,0,0,0.8) !important;
}

body.vscode-light .markdown-content :deep(.mermaid text),
body.vscode-light .markdown-content :deep(.mermaid span),
body.vscode-light .zoomed-mermaid-content :deep(text),
body.vscode-light .zoomed-mermaid-content :deep(span) {
  text-shadow:
    -1px -1px 0 #fff,
     1px -1px 0 #fff,
    -1px  1px 0 #fff,
     1px  1px 0 #fff,
     0px  0px 4px rgba(255,255,255,0.9) !important;
}

/* 节点样式微调 */
.markdown-content :deep(.mermaid .node) {
  stroke-width: 1.5px !important;
}

/* 连线文字处理 */
.markdown-content :deep(.mermaid .edgeLabel) {
  background-color: transparent !important;
  padding: 0 4px;
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