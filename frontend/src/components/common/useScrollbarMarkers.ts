import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { MarkerItem } from './CustomScrollbarMarkers.vue'
import { projectVirtualScrollbarMarkers } from './virtualScrollbarMarkers'

interface ScrollbarMarkerProps {
  markerSelector: string
  virtualTotal: number
  virtualMarkers: unknown[]
}

/** 标记扫描、预览定位与其定时器共同管理，布局合帧仍由滚动容器调度。 */
export function useScrollbarMarkers(
  props: ScrollbarMarkerProps,
  scrollContainer: Ref<HTMLElement | null>,
  scrollTrack: Ref<HTMLElement | null>,
  isVirtualScroll: Readonly<Ref<boolean>>,
  seek: (index: number) => void
) {
  const markerPositions = ref<MarkerItem[]>([])
  // marker 重扫节流：流式期间内容结构变更每帧都会触发调度，但 marker 位置只随
  // 结构/尺寸变化才有意义。用 ≥500ms 间隔 + 尾沿补偿限制全量重扫频率，
  // 避免流式期间每帧对 '.user-message' 等元素逐个 getBoundingClientRect()
  // （强制同步布局）并重建 markerPositions 响应式数组。
  const MARKER_SCAN_THROTTLE_MS = 500
  let lastMarkerScanAt = 0
  let pendingMarkerScanTimer: ReturnType<typeof setTimeout> | null = null

  // ==================== Tooltip 状态 ====================
  const tooltipVisible = ref(false)
  const tooltipContent = ref('')
  const tooltipIndex = ref(0)
  /** 当前 hover marker 的专属 tooltip 前缀，缺省时由组件使用默认前缀。 */
  const tooltipMarkerPrefix = ref('')
  const tooltipTop = ref(0)
  let tooltipHideTimer: ReturnType<typeof setTimeout> | null = null
  const tooltipRef = ref<HTMLElement | null>(null)
  let tooltipRafId: number | null = null

  const virtualMarkerTrackHeight = ref(0)
  const virtualMarkerPositions = computed(() => projectVirtualScrollbarMarkers(
    props.virtualMarkers as Array<{ index: number; preview?: string }>, props.virtualTotal, virtualMarkerTrackHeight.value
  ))
  watch(virtualMarkerPositions, positions => {
    if (isVirtualScroll.value && props.markerSelector) markerPositions.value = positions
  })

  // ==================== Marker 逻辑 ====================

  /**
   * 计算元素相对于滚动容器内容顶部的绝对偏移
   * 使用 getBoundingClientRect + scrollTop 换算，不依赖 offsetParent 链
   */
  function getContentOffset(element: HTMLElement, container: HTMLElement): number {
    const elRect = element.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    return elRect.top - containerRect.top + container.scrollTop
  }

  /**
   * 扫描 markerSelector 匹配的元素，计算它们在轨道上的映射位置
   * 仅在内容/尺寸变化时调用（不在每次 scroll 事件中调用——位置是内容相关的，不是视口相关的）
   */
  function updateMarkers() {
    if (!scrollContainer.value || !props.markerSelector || !scrollTrack.value) {
      markerPositions.value = []
      return
    }

    const container = scrollContainer.value
    const trackHeight = scrollTrack.value.clientHeight

    if (isVirtualScroll.value) {
      // 页码改变只影响滑块；全局标记位置取决于总量、标记内容与轨道高度。
      virtualMarkerTrackHeight.value = trackHeight
      markerPositions.value = virtualMarkerPositions.value
      return
    }

    // 内容不足以滚动时无需显示 marker
    const scrollHeight = container.scrollHeight
    const clientHeight = container.clientHeight
    if (scrollHeight <= clientHeight || trackHeight <= 0) {
      markerPositions.value = []
      return
    }

    const elements = container.querySelectorAll(props.markerSelector)
    const newPositions: MarkerItem[] = []

    elements.forEach((el, idx) => {
      const htmlEl = el as HTMLElement
      const contentOffset = getContentOffset(htmlEl, container)
      const preview = htmlEl.getAttribute('data-preview') || ''
      // 颜色与 tooltip 前缀支持按元素覆盖：如总结截断点用黄色 marker + 专属前缀，
      // 与普通用户消息的蓝色 marker 区分（元素缺省时回落 props 默认值）
      const color = htmlEl.getAttribute('data-marker-color') || ''
      const tooltipPrefix = htmlEl.getAttribute('data-marker-tooltip-prefix') || ''
      // 映射到轨道位置：(元素在内容中的偏移 / 总内容高度) * 轨道高度
      const trackPos = (contentOffset / scrollHeight) * trackHeight
      newPositions.push({ top: trackPos, element: htmlEl, index: idx + 1, contentPreview: preview, color, tooltipPrefix })
    })

    markerPositions.value = newPositions
  }

  /**
   * 点击 marker 跳转到对应元素
   */
  function handleMarkerClick(marker: MarkerItem, e: MouseEvent) {
    e.stopPropagation()
    if (!scrollContainer.value) return
    if (typeof marker.targetIndex === 'number') {
      seek(marker.targetIndex)
      return
    }
    marker.element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /**
   * 鼠标进入 marker 时显示 tooltip
   */
  function handleMarkerMouseEnter(marker: MarkerItem, _e: MouseEvent) {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer)
      tooltipHideTimer = null
    }
    tooltipContent.value = marker.contentPreview
    tooltipIndex.value = marker.index
    tooltipMarkerPrefix.value = marker.tooltipPrefix
    tooltipVisible.value = true

    // 需要在 DOM 渲染后再计算位置，保证 tooltipRef 已挂载并获取到真实高度
    if (tooltipRafId) cancelAnimationFrame(tooltipRafId)
    tooltipRafId = requestAnimationFrame(() => {
      tooltipRafId = null
      clampTooltipPosition(marker)
    })
  }

  /**
   * 根据 marker 位置和 tooltip 实际高度，将 tooltip 钳制在可视区域内
   */
  function clampTooltipPosition(marker: MarkerItem) {
    if (!scrollTrack.value || !scrollContainer.value) return

    const trackRect = scrollTrack.value.getBoundingClientRect()
    // marker 在屏幕上的绝对 Y 坐标
    const markerScreenY = trackRect.top + marker.top

    // tooltip 实际高度（如果还没渲染则取估算值）
    const tipEl = tooltipRef.value
    const tipHeight = tipEl ? tipEl.offsetHeight : 60

    // 理想位置：tooltip 垂直居中于 marker
    let idealTop = markerScreenY - tipHeight / 2

    // 上下边界：以滚动容器的可视区域为准（而非整个 viewport），
    // 避免被顶部标签栏等 UI 遮挡
    const containerRect = scrollContainer.value.getBoundingClientRect()
    const viewportTop = containerRect.top
    const viewportBottom = containerRect.bottom
    if (idealTop < viewportTop + 4) {
      idealTop = viewportTop + 4
    }
    if (idealTop + tipHeight > viewportBottom - 4) {
      idealTop = viewportBottom - 4 - tipHeight
    }

    // 转回轨道坐标系（tooltip 的 CSS top 是相对于 scroll-track 的）
    tooltipTop.value = idealTop - trackRect.top
  }

  /**
   * 鼠标离开 marker 时延迟隐藏 tooltip
   */
  function handleMarkerMouseLeave() {
    tooltipHideTimer = setTimeout(() => {
      tooltipVisible.value = false
      tooltipHideTimer = null
    }, 150)
  }

  /**
   * 鼠标进入 tooltip 气泡本身时，取消隐藏
   */
  function handleTooltipMouseEnter() {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer)
      tooltipHideTimer = null
    }
  }

  /**
   * tooltip 上的 wheel 事件转发给滚动容器，保持滚动体验
   */
  function handleTooltipWheel(e: WheelEvent) {
    if (!scrollContainer.value) return
    // 阻止默认行为（避免整个页面滚动），转发给内容容器
    e.preventDefault()
    scrollContainer.value.scrollBy({
      top: e.deltaY,
      behavior: 'auto'
    })
  }

  /**
   * 节流版 marker 重扫：距上次扫描 ≥MARKER_SCAN_THROTTLE_MS 时立即执行；
   * 否则安排一次尾沿补偿扫描，保证流式结束后 marker 位置最终与 DOM 一致
   * （期间只合并请求，不逐帧全量重扫）。
   */
  function requestMarkerScan() {
    if (!props.markerSelector || pendingMarkerScanTimer) return
    const now = Date.now()
    const elapsed = now - lastMarkerScanAt
    if (elapsed >= MARKER_SCAN_THROTTLE_MS) {
      lastMarkerScanAt = now
      updateMarkers()
    } else {
      pendingMarkerScanTimer = setTimeout(() => {
        pendingMarkerScanTimer = null
        lastMarkerScanAt = Date.now()
        updateMarkers()
      }, MARKER_SCAN_THROTTLE_MS - elapsed)
    }
  }

  function initializeMarkers() {
    if (!props.markerSelector) return
    updateMarkers()
    lastMarkerScanAt = Date.now()
  }

  onBeforeUnmount(() => {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer)
      tooltipHideTimer = null
    }
    if (tooltipRafId) {
      cancelAnimationFrame(tooltipRafId)
      tooltipRafId = null
    }
    if (pendingMarkerScanTimer) {
      clearTimeout(pendingMarkerScanTimer)
      pendingMarkerScanTimer = null
    }
  })

  return {
    markerPositions,
    tooltipVisible,
    tooltipContent,
    tooltipIndex,
    tooltipMarkerPrefix,
    tooltipTop,
    tooltipRef,
    initializeMarkers,
    updateMarkers,
    requestMarkerScan,
    handleMarkerClick,
    handleMarkerMouseEnter,
    handleMarkerMouseLeave,
    handleTooltipMouseEnter,
    handleTooltipWheel
  }
}
