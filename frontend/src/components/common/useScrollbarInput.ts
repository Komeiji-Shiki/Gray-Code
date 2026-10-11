import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { useScrollbarGeometry } from './useScrollbarGeometry'

interface ScrollbarInputOptions {
  props: { virtualTotal: number }
  scrollContainer: Ref<HTMLElement | null>
  scrollTrack: Ref<HTMLElement | null>
  hScrollTrack: Ref<HTMLElement | null>
  thumbHeight: Readonly<Ref<number>>
  thumbWidth: Readonly<Ref<number>>
  isVirtualScroll: Readonly<Ref<boolean>>
  virtualRowHeight: Readonly<Ref<number>>
  geometry: Pick<ReturnType<typeof useScrollbarGeometry>, 'getVerticalLayoutMetrics' | 'getVirtualThumbRatio' | 'emitVirtualSeekRatio'>
  onUserScrollInput: () => void
}

/** 滑块输入独立持有拖动状态和 document 监听，吸底意图仍通知布局调度方。 */
export function useScrollbarInput(options: ScrollbarInputOptions) {
  const {
    props, scrollContainer, scrollTrack, hScrollTrack, thumbHeight, thumbWidth,
    isVirtualScroll, virtualRowHeight, geometry, onUserScrollInput
  } = options
  const { getVerticalLayoutMetrics, getVirtualThumbRatio, emitVirtualSeekRatio } = geometry

  // 拖动状态用 ref：模板据此在拖动期间给 .scroll-thumb-v / .scroll-thumb-h 挂 'dragging' 类（仅拖动时启用 will-change）
  const isDragging = ref(false)
  const isHDragging = ref(false)
  /** 虚拟轨道拖动中的比例，释放鼠标后才发起一次 seek。 */
  const virtualDragRatio = ref<number | null>(null)
  let startY = 0
  let startX = 0
  let startScrollTop = 0
  let startScrollLeft = 0
  let startVirtualScrollTop = 0

  // 垂直滚动 - 鼠标按下滑块
  function handleThumbMouseDown(e: MouseEvent) {
    if (!scrollContainer.value) return
    
    // 滚动条拖动也是用户滚动意图：标记冷静期，避免拖动中被贴底拉回
    onUserScrollInput()
    isDragging.value = true
    startY = e.clientY
    startScrollTop = scrollContainer.value.scrollTop
    startVirtualScrollTop = getVerticalLayoutMetrics(scrollContainer.value).scrollTop
    virtualDragRatio.value = isVirtualScroll.value ? getVirtualThumbRatio(scrollContainer.value) : null
    
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    
    e.preventDefault()
  }

  // 垂直滚动 - 鼠标移动
  function handleMouseMove(e: MouseEvent) {
    if (!isDragging.value || !scrollContainer.value) return

    const container = scrollContainer.value
    const deltaY = e.clientY - startY
    const scrollHeight = container.scrollHeight
    const clientHeight = container.clientHeight
    const trackHeight = scrollTrack.value?.clientHeight || clientHeight
    const maxScrollTop = scrollHeight - clientHeight
    const maxThumbTop = trackHeight - thumbHeight.value

    if (isVirtualScroll.value) {
      const virtualMaxThumbTop = Math.max(1, maxThumbTop)
      const currentThumbTop = (startVirtualScrollTop / Math.max(1, getVerticalLayoutMetrics(container).maxScrollTop)) * virtualMaxThumbTop
      virtualDragRatio.value = Math.max(0, Math.min(1, (currentThumbTop + deltaY) / virtualMaxThumbTop))
      return
    }

    // 计算新的滚动位置
    const scrollDelta = (deltaY / Math.max(1, maxThumbTop)) * maxScrollTop
    container.scrollTop = startScrollTop + scrollDelta
  }

  // 垂直滚动 - 鼠标释放
  function handleMouseUp() {
    if (isDragging.value && isVirtualScroll.value && virtualDragRatio.value !== null) {
      emitVirtualSeekRatio(virtualDragRatio.value)
    }
    isDragging.value = false
    virtualDragRatio.value = null
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }

  // 垂直滚动 - 点击轨道跳转
  function handleTrackClick(e: MouseEvent) {
    if (!scrollTrack.value || !scrollContainer.value) return
    if (e.target !== scrollTrack.value) return
    
    const container = scrollContainer.value
    const trackRect = scrollTrack.value.getBoundingClientRect()
    const clickY = e.clientY - trackRect.top
    
    const scrollHeight = container.scrollHeight
    const clientHeight = container.clientHeight
    const trackHeight = scrollTrack.value.clientHeight
    const maxScrollTop = scrollHeight - clientHeight
    
    //计算目标滚动位置（点击位置居中）
    const targetThumbTop = clickY - thumbHeight.value / 2
    const maxThumbTop = trackHeight - thumbHeight.value
    const ratio = Math.max(0, Math.min(1, targetThumbTop / Math.max(1, maxThumbTop)))

    if (isVirtualScroll.value) {
      emitVirtualSeekRatio(ratio)
      return
    }
    
    container.scrollTop = ratio * maxScrollTop
  }

  // 横向滚动 - 鼠标按下滑块
  function handleHThumbMouseDown(e: MouseEvent) {
    if (!scrollContainer.value) return
    
    isHDragging.value = true
    startX = e.clientX
    startScrollLeft = scrollContainer.value.scrollLeft
    
    document.addEventListener('mousemove', handleHMouseMove)
    document.addEventListener('mouseup', handleHMouseUp)
    
    e.preventDefault()
  }

  // 横向滚动 - 鼠标移动
  function handleHMouseMove(e: MouseEvent) {
    if (!isHDragging.value || !scrollContainer.value) return
    
    const container = scrollContainer.value
    const deltaX = e.clientX - startX
    const scrollWidth = container.scrollWidth
    const clientWidth = container.clientWidth
    const maxScrollLeft = scrollWidth - clientWidth
    const maxThumbLeft = clientWidth - thumbWidth.value
    
    // 计算新的滚动位置
    const scrollDelta = (deltaX / maxThumbLeft) * maxScrollLeft
    container.scrollLeft = startScrollLeft + scrollDelta
  }

  // 横向滚动 - 鼠标释放
  function handleHMouseUp() {
    isHDragging.value = false
    document.removeEventListener('mousemove', handleHMouseMove)
    document.removeEventListener('mouseup', handleHMouseUp)
  }

  // 横向滚动 - 点击轨道跳转
  function handleHTrackClick(e: MouseEvent) {
    if (!hScrollTrack.value || !scrollContainer.value) return
    if (e.target !== hScrollTrack.value) return
    
    const container = scrollContainer.value
    const trackRect = hScrollTrack.value.getBoundingClientRect()
    const clickX = e.clientX - trackRect.left
    
    const scrollWidth = container.scrollWidth
    const clientWidth = container.clientWidth
    const maxScrollLeft = scrollWidth - clientWidth
    
    // 计算目标滚动位置（点击位置居中）
    const targetThumbLeft = clickX - thumbWidth.value / 2
    const maxThumbLeft = clientWidth - thumbWidth.value
    const ratio = Math.max(0, Math.min(1, targetThumbLeft / maxThumbLeft))
    
    container.scrollLeft = ratio * maxScrollLeft
  }

  /**
   * 键盘操作滑块（role="slider" 的可访问性支持）：
   * 方向键步进 / PageUp·PageDown 翻页 / Home·End 跳转首尾
   */
  function handleThumbKeydown(e: KeyboardEvent) {
    const container = scrollContainer.value
    if (!container) return
    const isHorizontal = (e.currentTarget as HTMLElement).classList.contains('scroll-thumb-h')

    if (!isHorizontal && isVirtualScroll.value) {
      e.preventDefault()
      const current = getVerticalLayoutMetrics(container).scrollTop
      const max = Math.max(0, props.virtualTotal * virtualRowHeight.value - container.clientHeight)
      const page = Math.max(1, container.clientHeight)
      let next = current
      switch (e.key) {
        case 'ArrowUp':
          next -= Math.max(virtualRowHeight.value, page * 0.1)
          break
        case 'ArrowDown':
          next += Math.max(virtualRowHeight.value, page * 0.1)
          break
        case 'PageUp':
          next -= page
          break
        case 'PageDown':
          next += page
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = max
          break
        default:
          return
      }
      emitVirtualSeekRatio(max > 0 ? Math.max(0, Math.min(1, next / max)) : 0)
      onUserScrollInput()
      return
    }

    const page = isHorizontal ? container.clientWidth : container.clientHeight
    const step = Math.max(40, page * 0.1)
    const current = isHorizontal ? container.scrollLeft : container.scrollTop
    const max = Math.max(0, (isHorizontal ? container.scrollWidth - container.clientWidth : container.scrollHeight - container.clientHeight))

    let next: number | null = null
    switch (e.key) {
      case 'ArrowUp':
        // 方向键按滑块轴向过滤：水平滑块不响应垂直方向键。
        // 过滤分支也要 preventDefault：滑块已获得焦点，按轴向外的方向键
        // 不应触发浏览器默认滚动（页面/外层滚动容器），应无副作用
        if (isHorizontal) {
          e.preventDefault()
          return
        }
        next = current - step
        break
      case 'ArrowDown':
        if (isHorizontal) {
          e.preventDefault()
          return
        }
        next = current + step
        break
      case 'ArrowLeft':
        // 垂直滑块不响应水平方向键（同样 preventDefault，见 ArrowUp 注释）
        if (!isHorizontal) {
          e.preventDefault()
          return
        }
        next = current - step
        break
      case 'ArrowRight':
        if (!isHorizontal) {
          e.preventDefault()
          return
        }
        next = current + step
        break
      case 'PageUp':
        next = current - page
        break
      case 'PageDown':
        next = current + page
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    e.preventDefault()
    const clamped = Math.max(0, Math.min(max, next))
    if (clamped === current) return
    if (isHorizontal) {
      container.scrollLeft = clamped
    } else {
      container.scrollTop = clamped
    }
    // 键盘滚动同样是用户滚动意图：标记冷静期，避免被贴底跟随拉回
    onUserScrollInput()
  }

  onBeforeUnmount(() => {
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.removeEventListener('mousemove', handleHMouseMove)
    document.removeEventListener('mouseup', handleHMouseUp)
  })

  return {
    isDragging,
    isHDragging,
    virtualDragRatio,
    handleThumbMouseDown,
    handleTrackClick,
    handleHThumbMouseDown,
    handleHTrackClick,
    handleThumbKeydown
  }
}
