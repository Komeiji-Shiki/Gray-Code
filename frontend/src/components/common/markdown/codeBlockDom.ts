/**
 * 代码块 DOM 交互控制器（从 MarkdownRenderer.vue 抽取）
 *
 * 管理 v-html 渲染出的代码块的：
 * - 换行状态（is-nowrap，按 data-block-id 保持，同一条消息内尽量保持）
 * - 流式期间“超高”代码块的保留展开态（keep-expanded，避免流式结束塌缩丢阅读位置）
 * - 工具栏点击（复制 / 换行切换，含复制失败反馈计时器）
 *
 * 状态与 DOM 操作全部内聚于控制器实例（每组件实例一个）；父组件只接线：
 * 渲染管线调用 applyCodeBlockWrapStates，容器 click 委托 handleCodeToolbarClick，
 * 卸载时调用 cleanup。
 */
import type { Ref } from 'vue'
import { copyToClipboard } from '@/utils/format'

/** 流式期间“超高”代码块（自然高度超过折叠阈值，流式结束恢复 max-height 后会塌缩）：
 * 结束/中断时为这些块保留展开态（keep-expanded），避免布局跳动丢失阅读位置；
 * 用户点击换行按钮或滚动离开该块后恢复正常高度限制。 */
export const CODE_BLOCK_COLLAPSE_HEIGHT = 400

export interface CodeBlockDomController {
  /** 回填代码块的换行状态与按钮提示；同时维护流式保留展开态（见 applyCodeBlockWrapStates） */
  applyCodeBlockWrapStates(): void
  /** 清空上一轮的流式保留展开态记录（新流开始时调用；超高块会在每次渲染后重新测量记录） */
  clearStreamingOverHeightBlocks(): void
  /** 处理代码块工具栏点击（复制 / 换行切换） */
  handleCodeToolbarClick(event: Event): Promise<void>
  /** 卸载清理：清复制计时器、断开 IntersectionObserver */
  cleanup(): void
}

/**
 * 创建代码块 DOM 交互控制器
 *
 * @param containerRef           渲染容器（v-html 挂载点）
 * @param isStreamingClassActive 流式类的“滞后副本”ref（isStreaming 变 false 时先保留
 *                               is-streaming 类，等完成态渲染应用 keep-expanded 后再解除）
 * @param isStreaming            读取当前 props.isStreaming 的 getter
 */
export function createCodeBlockDomController(
  containerRef: Ref<HTMLElement | null>,
  isStreamingClassActive: Ref<boolean>,
  isStreaming: () => boolean
): CodeBlockDomController {
  // 代码块换行状态（同一条消息内尽量保持；key 为 data-block-id）
  const codeWrapOverrides = new Map<string, boolean>() // true => nowrap

  const streamingOverHeightBlockIds = new Set<string>()

  // 复制按钮状态计时器存储
  const copyTimers = new Map<HTMLButtonElement, number>()

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
    const recording = isStreaming() || isStreamingClassActive.value

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
      block.classList.toggle('keep-expanded', !isStreaming() && streamingOverHeightBlockIds.has(blockId))

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
    if (!isStreaming() && isStreamingClassActive.value) {
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

    for (const block of Array.from(blocks)) {
      if (!block.classList.contains('keep-expanded')) continue
      if (keepExpandedObservedBlocks.has(block)) continue
      keepExpandedObservedBlocks.add(block)
      keepExpandedObserver.observe(block)
    }
  }

  /**
   * 处理代码块工具栏点击（复制 / 换行切换）
   */
  async function handleCodeToolbarClick(event: Event) {
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

    let code: string
    try {
      code = decodeURIComponent(atob(encodedCode))
    } catch {
      return
    }

    // 加固复制：clipboard API 不可用（Webview 非 secure context）时回退 execCommand；
    // 失败给按钮短暂红色反馈，不再静默吞掉（原来失败只有 console.error，用户无感知）
    const ok = await copyToClipboard(code)
    if (!ok) {
      copyBtn.classList.add('copy-failed')
      const failedTimer = window.setTimeout(() => {
        copyBtn.classList.remove('copy-failed')
        copyTimers.delete(copyBtn)
      }, 1200)
      copyTimers.set(copyBtn, failedTimer)
      console.error('复制失败:', code.slice(0, 80))
      return
    }

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
  }

  /** 清空上一轮的流式保留展开态记录（新流开始时调用） */
  function clearStreamingOverHeightBlocks() {
    streamingOverHeightBlockIds.clear()
  }

  /** 卸载清理：清复制计时器、断开 IntersectionObserver */
  function cleanup() {
    copyTimers.forEach((timer) => {
      window.clearTimeout(timer)
    })
    copyTimers.clear()
    keepExpandedObserver?.disconnect()
    keepExpandedObserver = null
    keepExpandedObservedBlocks.clear()
  }

  return {
    applyCodeBlockWrapStates,
    clearStreamingOverHeightBlocks,
    handleCodeToolbarClick,
    cleanup
  }
}
