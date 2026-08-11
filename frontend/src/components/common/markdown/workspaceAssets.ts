/**
 * 工作区资源 DOM 控制器（从 MarkdownRenderer.vue 抽取）
 *
 * 管理 v-html 渲染内容中的工作区资源交互：
 * - 渲染前文件路径存在性预校验（prevalidateFilePaths）
 * - 工作区图片异步加载（loadWorkspaceImages，带模块级缓存）
 * - 图片点击打开文件（handleImageClick）
 * - 工作区文件链接点击打开并定位（handleWorkspaceFileLinkClick，含普通相对链接 fallback）
 *
 * 跨端消息名：统一引用 @shared/protocol 的 MESSAGE_NAMES（S5 收尾：protocol 迁移
 * 已闭合，原字符串字面量已机械替换为 MESSAGE_NAMES 引用）。
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import type { Ref } from 'vue'
import { sendToExtension, showNotification } from '@/utils/vscode'
import { fileExistenceCache, setCached, imageCache, setCachedImage } from './markdownItCore'
import {
  decodeDataPath,
  normalizeWorkspaceFilePath,
  parsePositiveInt,
  parseWorkspaceFileRefExact,
  extractPotentialFilePaths,
  type WorkspaceFileRef
} from './workspaceFileRefs'

export interface WorkspaceAssetController {
  /** 渲染前预校验：批量检查未缓存的路径是否存在 */
  prevalidateFilePaths(content: string): Promise<void>
  /** 加载工作区图片（带模块级缓存与字节预算） */
  loadWorkspaceImages(): Promise<void>
  /** 处理图片点击（打开工作区文件） */
  handleImageClick(event: Event): Promise<void>
  /** 处理工作区文件链接点击（路径/行号 -> 打开文件并定位/高亮） */
  handleWorkspaceFileLinkClick(event: Event): Promise<void>
}

/**
 * 创建工作区资源 DOM 控制器
 *
 * @param containerRef 渲染容器（v-html 挂载点）
 */
export function createWorkspaceAssetController(
  containerRef: Ref<HTMLElement | null>
): WorkspaceAssetController {
  /**
   * 文件存在性缓存 & 预校验
   *
   * 在 markdown-it 渲染之前，从原始内容中提取所有可能的文件路径，
   * 批量请求后端校验，结果写入缓存。
   * 渲染时，markdown-it 插件 / fence 渲染器查缓存决定是否生成 <a> 标签。
   * 不存在（或未缓存）的路径直接输出为纯文本，无任何闪烁。
   */

  /**
   * 渲染前预校验：批量检查未缓存的路径是否存在
   */
  async function prevalidateFilePaths(content: string) {
    const allPaths = extractPotentialFilePaths(content)
    const unchecked = allPaths.filter(p => !fileExistenceCache.has(p))
    if (unchecked.length === 0) return

    try {
      const resp = await sendToExtension<{ results: Record<string, boolean> }>(
        MESSAGE_NAMES.checkWorkspaceFilesExist,
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
    // 缓存命中的图片同步设置 src；未命中的收集后按并发上限批量拉取
    const pending: Array<{ img: Element; imgPath: string }> = []

    for (const img of images) {
      const encodedPath = img.getAttribute('data-path')
      if (!encodedPath) continue

      let imgPath: string
      try {
        imgPath = decodeURIComponent(atob(encodedPath))
      } catch (error) {
        console.error('解码图片路径失败:', error)
        img.classList.add('image-error')
        continue
      }

      if (imageCache.has(imgPath)) {
        img.setAttribute('src', imageCache.get(imgPath)!)
        img.classList.remove('workspace-image')
        img.classList.add('loaded-image')
        img.setAttribute('data-image-path', imgPath)
        continue
      }

      pending.push({ img, imgPath })
    }

    // 有界并行拉取：每批最多 4 个并发跨端请求，避免大量图片时一次性打爆扩展进程
    const CONCURRENCY = 4
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async ({ img, imgPath }) => {
        try {
          const response = await sendToExtension<{
            success: boolean;
            data?: string;
            mimeType?: string;
            error?: string;
          }>(MESSAGE_NAMES.readWorkspaceImage, { path: imgPath })

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
      }))
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
        await sendToExtension(MESSAGE_NAMES.openWorkspaceFile, { path: imgPath })
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
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFileAt, {
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

  return {
    prevalidateFilePaths,
    loadWorkspaceImages,
    handleImageClick,
    handleWorkspaceFileLinkClick
  }
}
