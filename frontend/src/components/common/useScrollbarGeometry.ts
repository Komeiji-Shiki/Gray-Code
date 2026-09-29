import type { Ref } from 'vue'

/** 虚拟轨道只映射全局位置，贴底判断始终使用当前 DOM 的真实高度。 */
export function useScrollbarGeometry(props: { virtualTotal: number; virtualStart: number; virtualEnd: number; stickyThreshold: number },
  isVirtualScroll: Readonly<Ref<boolean>>, virtualRowHeight: Readonly<Ref<number>>, scrollContainer: Ref<HTMLElement | null>, seek: (index: number) => void) {
  function getVirtualProgress(container: HTMLElement): number {
    const total = Math.max(1, props.virtualTotal)
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const within = maxScrollTop > 0 ? Math.min(1, Math.max(0, container.scrollTop / maxScrollTop)) : 0
    const span = props.virtualEnd - props.virtualStart
    // 窗口行区间未知（virtualEnd ≤ virtualStart）时退化为「窗口即全量」，滑块仍随滚动移动。
    if (span <= 0) return within
    return Math.min(1, Math.max(0, (props.virtualStart + span * within) / total))
  }

  /** 虚拟模式下把当前真实窗口的局部 scrollTop 映射到全局估算坐标（仅用于滑块几何）。 */
  function getVerticalLayoutMetrics(container: HTMLElement): {
    scrollHeight: number
    clientHeight: number
    scrollTop: number
    maxScrollTop: number
  } {
    const clientHeight = container.clientHeight
    if (!isVirtualScroll.value) {
      const scrollHeight = container.scrollHeight
      return {
        scrollHeight,
        clientHeight,
        scrollTop: container.scrollTop,
        maxScrollTop: Math.max(0, scrollHeight - clientHeight)
      }
    }

    const scrollHeight = Math.max(clientHeight + 1, props.virtualTotal * virtualRowHeight.value)
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
    return {
      scrollHeight,
      clientHeight,
      scrollTop: getVirtualProgress(container) * maxScrollTop,
      maxScrollTop
    }
  }

  function getVirtualThumbRatio(container: HTMLElement): number {
    const metrics = getVerticalLayoutMetrics(container)
    if (metrics.maxScrollTop <= 0) return 0
    return metrics.scrollTop / metrics.maxScrollTop
  }

  function emitVirtualSeekRatio(ratio: number): void {
    if (!isVirtualScroll.value || props.virtualTotal <= 0) return
    const clamped = Math.max(0, Math.min(1, ratio))
    seek( Math.round(clamped * Math.max(0, props.virtualTotal - 1)))
  }

  // 检查是否在底部（用于粘性底部）
  function hasGlobalTail(): boolean {
    return !isVirtualScroll.value || props.virtualEnd >= props.virtualTotal
  }

  function isAtBottom(): boolean {
    if (!scrollContainer.value) return false
    const container = scrollContainer.value
    // 已加载窗口尚未覆盖全局尾部时，局部 DOM 到底不等于对话到底。
    if (!hasGlobalTail()) return false
    // 贴底只取决于真实 DOM 位置：虚拟模式的总高度是按行数估算的，与真实内容高度无关
    // （长消息下偏差可达数倍），用它计算距底距离会把窗口尾部一大段误判成「仍在底部」。
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    return maxScrollTop - container.scrollTop <= props.stickyThreshold
  }


  return { getVirtualProgress, getVerticalLayoutMetrics, getVirtualThumbRatio, emitVirtualSeekRatio, hasGlobalTail, isAtBottom }
}
