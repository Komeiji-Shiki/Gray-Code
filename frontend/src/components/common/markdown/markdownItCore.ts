/**
 * MarkdownRenderer 模块级单例（跨消息块共享）
 *
 * 文件存在性缓存 / 图片缓存 / 代码高亮缓存 / Mermaid 渲染队列
 * 必须是真正的模块级状态：消息列表会同时挂载多个 MarkdownRenderer 实例，若这些状态
 * 声明在组件 <script setup> 顶层，会随每个组件实例重新执行一遍（缓存失效、Mermaid 并发
 * 渲染、重复创建 markdown-it 实例）。
 *
 * 从 MarkdownRenderer.vue 的普通 <script> 块抽取（每模块只执行一次），组件内仅引用。
 */
import { nextTick } from 'vue'
import type { Ref } from 'vue'

/** 工作区文件存在性缓存：路径 → 是否存在 */
export const fileExistenceCache = new Map<string, boolean>()

/** 工作区图片 data URL 缓存：路径 → data: URL */
export const imageCache = new Map<string, string>()

/** highlightAuto 结果缓存：避免相同无标注代码块重复遍历 192 种语法 */
export const codeHighlightCache = new Map<string, string>()

/** 有界缓存写入：容量超限时淘汰最旧条目（FIFO），防止长会话无界增长 */
const CACHE_MAX_SIZE = 500
export function setCached<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value)
  if (map.size > CACHE_MAX_SIZE) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      map.delete(oldestKey)
    }
  }
}

/** 估算字符串驻留字节数（UTF-16，每字符 2 字节），与图片缓存口径一致 */
export function estimateStringBytes(value: string): number {
  return value.length * 2
}

/**
 * 代码高亮结果缓存字节预算：长代码块的高亮 HTML 可达数百 KB，仅按条数限界
 * （500 条）会让流式期间增长中的代码块反复写入大块结果，驻留内存膨胀到数十 MB；
 * 超限按 FIFO 淘汰最旧条目（与图片缓存同一策略）。
 */
const CODE_HIGHLIGHT_CACHE_MAX_BYTES = 4 * 1024 * 1024
let codeHighlightCacheBytes = 0

/** 代码高亮缓存写入：字节预算 + 条数上限双限界 */
export function setCachedCodeHighlight(map: Map<string, string>, key: string, value: string): void {
  const bytes = estimateStringBytes(value)
  const existing = map.get(key)
  if (existing !== undefined) {
    codeHighlightCacheBytes -= estimateStringBytes(existing)
  }
  map.set(key, value)
  codeHighlightCacheBytes += bytes

  // 字节预算超限：按 FIFO 淘汰最旧条目，直到回到预算内（至少保留 1 条，避免单条超大时清空缓存）
  while (codeHighlightCacheBytes > CODE_HIGHLIGHT_CACHE_MAX_BYTES && map.size > 1) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break
    const oldest = map.get(oldestKey)!
    map.delete(oldestKey)
    codeHighlightCacheBytes -= estimateStringBytes(oldest)
  }

  // 条数上限兜底（与其它缓存一致）
  if (map.size > CACHE_MAX_SIZE) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      const oldest = map.get(oldestKey)!
      map.delete(oldestKey)
      codeHighlightCacheBytes -= estimateStringBytes(oldest)
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
export function setCachedImage(path: string, dataUrl: string): void {
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

/**
 * 渲染 Mermaid 图表
 *
 * 使用 promise 串行队列（替代布尔锁），避免并发 renderMermaid
 * 导致 isMermaidRendering 提前返回后图片/mermaid 永久不渲染。
 * doRender 内部 await 后重新 querySelectorAll 并过滤 !node.isConnected，
 * 跳过已被 Vue 移除的 DOM 节点。
 */
export async function renderMermaid(containerRef: Ref<HTMLElement | null>): Promise<void> {
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
