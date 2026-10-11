<script setup lang="ts">
import { useScrollbarStyles } from './useScrollbarStyles'
import { useScrollbarGeometry } from './useScrollbarGeometry'
import { useScrollbarMarkers } from './useScrollbarMarkers'
import { useScrollbarInput } from './useScrollbarInput'
import CustomScrollbarMarkers from './CustomScrollbarMarkers.vue'
import { ref, onMounted, onBeforeUnmount, nextTick, computed, watch } from 'vue'
import { t } from '../../i18n'

/**
 * 自定义滚动条组件 - 方角、始终可见、悬浮式
 * 支持在轨道上渲染 marker 节点（如用户消息标记），点击可快速跳转
 */

const props = defineProps({
  /** 滚动条宽度（px） */
  width: {
    type: Number,
    default: 6
  },
  /** 导轨颜色（留空使用透明） */
  trackColor: {
    type: String,
    default: ''
  },
  /** 可选：强制指定滑块颜色 */
  thumbColor: {
    type: String,
    default: ''
  },
  /** 可选：滑块 hover 颜色 */
  thumbHoverColor: {
    type: String,
    default: ''
  },
  /** 滚动条与边缘的距离（px） */
  offset: {
    type: Number,
    default: 2
  },
  /** 最小滑块高度/宽度（px） */
  minThumbHeight: {
    type: Number,
    default: 24
  },
  /** 粘性底部 - 当位于底部时自动跟随新内容 */
  stickyBottom: {
    type: Boolean,
    default: false
  },
  /** 粘性底部判定阈值（px） */
  stickyThreshold: {
    type: Number,
    default: 50
  },
  /** 是否显示置顶/置底跳转按钮 */
  showJumpButtons: {
    type: Boolean,
    default: false
  },
  /** 是否启用横向滚动 */
  horizontal: {
    type: Boolean,
    default: false
  },
  /**
   * 最大高度（px 或 CSS 值）
   * 设置后组件将以内容自适应高度模式工作
   * 不再需要父容器有固定高度
   */
  maxHeight: {
    type: [Number, String],
    default: ''
  },
  // ==================== Marker 相关 Props ====================
  /**
   * CSS 选择器，用于在滚动内容中查找需要标记的元素
   * 例如 '.user-message' 会匹配所有用户消息
   * 留空则不渲染任何 marker
   */
  markerSelector: {
    type: String,
    default: ''
  },
  /** marker 节点颜色 */
  markerColor: {
    type: String,
    default: 'rgba(100, 160, 255, 0.55)'
  },
  /** marker 节点高度（px） */
  markerHeight: {
    type: Number,
    default: 6
  },
  /** marker 节点默认透明度 (0-1) */
  markerOpacity: {
    type: Number,
    default: 0.55
  },
  /** marker hover 透明度 (0-1) */
  markerHoverOpacity: {
    type: Number,
    default: 1
  },
  /** marker tooltip 前缀文案（与序号拼接显示，如 "User #3"） */
  markerTooltipPrefix: {
    type: String,
    default: 'User'
  },
  /** 虚拟消息轨道的总消息数；为 0 时使用真实 DOM 高度。 */
  virtualTotal: {
    type: Number,
    default: 0
  },
  /** 当前已渲染窗口在对话中的绝对起点（0-based）。 */
  virtualStart: {
    type: Number,
    default: 0
  },
  /** 当前已渲染窗口在对话中的绝对终点（不含）。 */
  virtualEnd: {
    type: Number,
    default: 0
  },
  /** 虚拟消息高度估算，仅用于滚动条比例，不会生成布局空白。 */
  virtualEstimatedRowHeight: {
    type: Number,
    default: 96
  },
  /** 全局用户消息 marker 索引。 */
  virtualMarkers: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits<{
  /** 请求外部加载并定位到全局消息索引。 */
  seek: [index: number]
}>()

const scrollContainer = ref<HTMLElement | null>(null)
const scrollTrack = ref<HTMLElement | null>(null)
const hScrollTrack = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)

// 垂直滚动条状态
const thumbHeight = ref(0)
const thumbTop = ref(0)
const showScrollbar = ref(false)
/** 垂直滑块百分比位置（0-100，供 role="slider" 的 aria-valuenow 使用） */
const vScrollRatio = ref(0)

// 横向滚动条状态
const thumbWidth = ref(0)
const thumbLeft = ref(0)
const showHScrollbar = ref(false)
/** 横向滑块百分比位置（0-100，供 role="slider" 的 aria-valuenow 使用） */
const hScrollRatio = ref(0)

let layoutUpdateRafId: number | null = null
interface LayoutUpdateOptions {
  preserveBottom?: boolean
  updateMarkers?: boolean
  forceMarkers?: boolean
}
const pendingLayoutUpdateOptions = {
  preserveBottom: false,
  updateMarkers: false,
  forceMarkers: false
}

let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null

const isVirtualScroll = computed(() => props.virtualTotal > 0)
const virtualRowHeight = computed(() => Math.max(1, Number.isFinite(props.virtualEstimatedRowHeight) && props.virtualEstimatedRowHeight > 0
  ? props.virtualEstimatedRowHeight
  : 96))

/**
 * 虚拟模式下当前窗口在整段历史中的行进度（0-1）。
 *
 * 按「窗口内滚动比例 × 窗口覆盖的行区间」映射，与 marker 位置、轨道点击和拖动 seek
 * 使用的全局行索引是同一坐标系。不能改用「virtualStart × 估算行高 + 真实 scrollTop」
 * 的像素估算法：真实内容高度与「行数 × 估算行高」无关，长消息（长思考）会让该估算值
 * 超过估算总高度而被钳制，滑块会在窗口尾部一大段范围内钉在底部不动。
 */
const geometry = useScrollbarGeometry(
  props, isVirtualScroll, virtualRowHeight, scrollContainer, index => emit('seek', index)
)
const { getVerticalLayoutMetrics, hasGlobalTail, isAtBottom } = geometry
const {
  markerPositions, tooltipVisible, tooltipContent, tooltipIndex, tooltipMarkerPrefix, tooltipTop,
  initializeMarkers, updateMarkers, requestMarkerScan, handleMarkerClick, handleMarkerMouseEnter,
  handleMarkerMouseLeave, handleTooltipMouseEnter, handleTooltipWheel
} = useScrollbarMarkers(
  props, scrollContainer, scrollTrack, tooltipRef, isVirtualScroll, index => emit('seek', index)
)

// 记录是否在底部（内容变化前检查）
let wasAtBottom = true

/**
 * 程序化贴底写入的目标 scrollTop：写入后紧随的 scroll 事件是程序触发的，
 * 不能据此重算 wasAtBottom（写入后 scrollHeight 可能已因大段输出/md 解析继续增长，
 * 实时复验会误判为「用户滚离」→ 永久丢吸底）。scroll 事件到达时比对实际 scrollTop：
 * - 等于目标值 → 程序写入（或用户恰好滚回同一点，等价于贴底意图）→ 状态保持
 * - 不等于 → 用户滚动 → 同步复验更新 wasAtBottom（不等 rAF，避免同帧稍后
 *   执行的 updateLayout 用陈旧状态把用户拉回底部）
 */
let programmaticScrollTop: number | null = null

/**
 * 用户滚动输入后的冷静期（ms）：期间不执行贴底跟随。
 * 高 tps 下内容增长会抵消滚动距离（滚 100px 内容长 80px），无冷静期时
 * 用户连续滚动也会被每帧贴底写入拉回——「使劲滚才能滚上去」。
 * wheel 等输入事件在输入处理阶段同步派发（早于 scroll 事件与 rAF），
 * 且程序写入 scrollTop 不会触发它，是可靠的「用户滚动意图」信号。
 */
const USER_SCROLL_COOLDOWN_MS = 250
/** 最近一次用户滚动输入的时间（performance.now 时间轴） */
let lastUserScrollInputAt = Number.NEGATIVE_INFINITY
const {
  isDragging, isHDragging, virtualDragRatio, handleThumbMouseDown, handleTrackClick,
  handleHThumbMouseDown, handleHTrackClick, handleThumbKeydown
} = useScrollbarInput({
  props, scrollContainer, scrollTrack, hScrollTrack, thumbHeight, thumbWidth,
  isVirtualScroll, virtualRowHeight, geometry,
  onUserScrollInput: () => {
    lastUserScrollInputAt = performance.now()
  }
})

/** 贴底跟随写入阈值（px）：与目标位置差值小于该值时跳过写 scrollTop，避免每帧赋值 */
const STICKY_FOLLOW_THRESHOLD = 2

/** 上次 updateScrollbar 读取的布局值：三项均未变化时跳过响应式写入（流式期间绝大多数帧相同） */
let lastScrollMetrics: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
} | null = null

// 计算并更新滚动条状态
function updateScrollbar() {
  if (!scrollContainer.value) return

  const container = scrollContainer.value
  const verticalMetrics = getVerticalLayoutMetrics(container)
  const scrollHeight = verticalMetrics.scrollHeight
  const clientHeight = verticalMetrics.clientHeight
  const scrollTop = verticalMetrics.scrollTop

  let unchanged = lastScrollMetrics !== null &&
    lastScrollMetrics.scrollHeight === scrollHeight &&
    lastScrollMetrics.clientHeight === clientHeight &&
    lastScrollMetrics.scrollTop === scrollTop

  let scrollWidth = 0
  let clientWidth = 0
  let scrollLeft = 0
  if (props.horizontal) {
    scrollWidth = container.scrollWidth
    clientWidth = container.clientWidth
    scrollLeft = container.scrollLeft
    unchanged = unchanged &&
      lastScrollMetrics !== null &&
      lastScrollMetrics.scrollWidth === scrollWidth &&
      lastScrollMetrics.clientWidth === clientWidth &&
      lastScrollMetrics.scrollLeft === scrollLeft
  }

  // 布局值未变化：不写任何响应式 ref（流式期间每帧调度，绝大多数帧在此提前返回）
  if (unchanged) return
  lastScrollMetrics = { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft }

  // 判断是否需要显示垂直滚动条
  const shouldShowScrollbar = scrollHeight > clientHeight
  if (showScrollbar.value !== shouldShowScrollbar) {
    showScrollbar.value = shouldShowScrollbar
  }
  
  if (showScrollbar.value) {
    // 垂直轨道实际高度（排除跳转按钮）
    const trackHeight = scrollTrack.value?.clientHeight || clientHeight
    
    // 计算滑块高度：滑块在轨道中的占比应等于可见内容在总内容中的占比
    // 公式：thumbHeight / trackHeight = clientHeight / scrollHeight
    const ratio = clientHeight / Math.max(1, scrollHeight)
    const nextThumbHeight = Math.max(props.minThumbHeight, trackHeight * ratio)
    if (thumbHeight.value !== nextThumbHeight) {
      thumbHeight.value = nextThumbHeight
    }

    // 计算滑块位置
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight)
    const maxThumbTop = Math.max(0, trackHeight - nextThumbHeight)
    const nextThumbTop = (scrollTop / maxScrollTop) * maxThumbTop
    if (thumbTop.value !== nextThumbTop) {
      thumbTop.value = nextThumbTop
    }
    // 滑块百分比（aria-valuenow）
    const nextVRatio = (scrollTop / maxScrollTop) * 100
    if (vScrollRatio.value !== nextVRatio) {
      vScrollRatio.value = nextVRatio
    }
  }
  
  // 更新横向滚动条
  if (props.horizontal) {
    // 判断是否需要显示横向滚动条
    const shouldShowHScrollbar = scrollWidth > clientWidth
    if (showHScrollbar.value !== shouldShowHScrollbar) {
      showHScrollbar.value = shouldShowHScrollbar
    }
    
    if (showHScrollbar.value) {
      // 计算滑块宽度（最小 minThumbHeight）
      const hRatio = clientWidth / Math.max(1, scrollWidth)
      const nextThumbWidth = Math.max(props.minThumbHeight, clientWidth * hRatio)
      if (thumbWidth.value !== nextThumbWidth) {
        thumbWidth.value = nextThumbWidth
      }
      
      // 计算滑块位置
      const maxScrollLeft = Math.max(1, scrollWidth - clientWidth)
      const maxThumbLeft = Math.max(1, clientWidth - nextThumbWidth)
      const nextThumbLeft = (scrollLeft / maxScrollLeft) * maxThumbLeft
      if (thumbLeft.value !== nextThumbLeft) {
        thumbLeft.value = nextThumbLeft
      }
      // 滑块百分比（aria-valuenow）
      const nextHRatio = (scrollLeft / maxScrollLeft) * 100
      if (hScrollRatio.value !== nextHRatio) {
        hScrollRatio.value = nextHRatio
      }
    }
  }
}

// 虚拟窗口滚动到新页或 marker 索引刷新时，滚动条本身没有 childList 变更，
// 与内容变化共用布局帧，避免在 Vue 更新的微任务中强制布局；索引切换不受重扫节流影响。
watch(
  () => [props.virtualTotal, props.virtualStart, props.virtualEnd, props.virtualMarkers, props.markerSelector] as const,
  () => scheduleLayoutUpdate({ forceMarkers: true })
)

function updateLayout(options: LayoutUpdateOptions = {}) {
  if (!scrollContainer.value) return

  const container = scrollContainer.value
  if (options.preserveBottom && props.stickyBottom && wasAtBottom && hasGlobalTail()) {
    // 用户滚动输入冷静期内不贴底：让滚动真正生效（内容增长可能抵消滚动距离）
    const inUserScrollCooldown = performance.now() - lastUserScrollInputAt < USER_SCROLL_COOLDOWN_MS
    if (!inUserScrollCooldown) {
      // 贴底跟随：与目标位置差值超过阈值才写 scrollTop（已贴底时每帧赋值是纯浪费）
      const targetTop = container.scrollHeight - container.clientHeight
      if (Math.abs(container.scrollTop - targetTop) > STICKY_FOLLOW_THRESHOLD) {
        programmaticScrollTop = targetTop
        container.scrollTop = targetTop
      }
      // 写入即贴底：不在此复验（scrollHeight 可能已因大段输出/md 解析继续增长，
      // 复验会误判「不在底部」→ 永久丢吸底）。wasAtBottom 只由用户滚动更新。
    }
  }

  updateScrollbar()

  if (options.forceMarkers) {
    updateMarkers()
  } else if (options.updateMarkers && (props.markerSelector || isVirtualScroll.value)) {
    requestMarkerScan()
  }
}

function scheduleLayoutUpdate(options: LayoutUpdateOptions = {}) {
  pendingLayoutUpdateOptions.preserveBottom ||= !!options.preserveBottom
  pendingLayoutUpdateOptions.updateMarkers ||= !!options.updateMarkers
  pendingLayoutUpdateOptions.forceMarkers ||= !!options.forceMarkers

  if (layoutUpdateRafId !== null) return

  layoutUpdateRafId = requestAnimationFrame(() => {
    layoutUpdateRafId = null
    const nextOptions = { ...pendingLayoutUpdateOptions }
    pendingLayoutUpdateOptions.preserveBottom = false
    pendingLayoutUpdateOptions.updateMarkers = false
    pendingLayoutUpdateOptions.forceMarkers = false
    updateLayout(nextOptions)
  })
}

/**
 * 计算 marker 的 CSS 样式
 */
const markerBaseColor = computed(() => {
  return props.markerColor || 'rgba(100, 160, 255, 0.55)'
})

// 滚动事件处理：吸底状态同步更新（不等 rAF）——用户滚动意图立即生效，
// 避免同帧稍后执行的 updateLayout 读到陈旧 wasAtBottom 把用户拉回底部；
// 滚动条 UI 更新仍 rAF 合帧。
let lastScrollObservation: { top: number; height: number; viewport: number; start: number; end: number } | undefined
function handleScroll() {
  const container = scrollContainer.value
  if (!container) return
  const observation = {
    top: container.scrollTop, height: container.scrollHeight, viewport: container.clientHeight,
    start: props.virtualStart, end: props.virtualEnd
  }
  const previous = lastScrollObservation
  const layoutChanged = !previous || previous.height !== observation.height || previous.viewport !== observation.viewport
    || previous.start !== observation.start || previous.end !== observation.end
  const userInput = isDragging.value || performance.now() - lastUserScrollInputAt < USER_SCROLL_COOLDOWN_MS
  if (userInput) {
    wasAtBottom = isAtBottom()
    programmaticScrollTop = null
  } else if (programmaticScrollTop !== null && Math.abs(container.scrollTop - programmaticScrollTop) < 1) {
    programmaticScrollTop = null
  } else if (!previous || !layoutChanged && previous.top !== observation.top) {
    wasAtBottom = isAtBottom()
  }
  // 裁掉渲染窗口首行时 Chromium 会自行调 scrollTop；同位置事件也可能晚于高度增长。
  // 这些不是用户滚离，不能清掉 follow。必要时由同一个布局帧完成贴尾，不递归分页。
  lastScrollObservation = observation
  scheduleLayoutUpdate({ preserveBottom: layoutChanged && wasAtBottom })
}

/** 用户滚动输入（wheel/触摸板）：标记冷静期。输入事件同步派发、早于 scroll 事件与 rAF */
function handleUserScrollInput(event: Event): void {
  if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
  lastUserScrollInputAt = performance.now()
}

const { trackStyle, thumbStyle, hTrackStyle, hThumbStyle, wrapperStyle } = useScrollbarStyles(
  props, scrollTrack, virtualDragRatio, thumbHeight, thumbTop, thumbWidth, thumbLeft
)

// 组件挂载
let initRafId: number | null = null
let initFallbackTimer: ReturnType<typeof setTimeout> | null = null
// 卸载标记：nextTick 回调可能晚于卸载执行（如 mounted 后立即销毁），
// 此时不能再新建 rAF / 100ms 兜底定时器与事件监听，否则没有清理时机
let isUnmounted = false

onMounted(() => {
  nextTick(() => {
    // 组件可能在本回调执行前已卸载：直接跳过初始化，避免新建定时器/监听后无清理时机
    if (isUnmounted) return
    // 首次更新：rAF 优先（下一帧布局完成后立即执行）；ResizeObserver 在尺寸变化时
    // 持续驱动；setTimeout 保留为最后兜底（部分环境 rAF 可能被节流/暂停）。
    // 多次执行幂等（updateScrollbar/updateMarkers 均为重算型函数）。
    const runInitialUpdate = () => {
      updateScrollbar()
      // 初始化 marker（同步更新节流基准，避免紧随其后的首次变更触发重复扫描）
      initializeMarkers()
    }
    initRafId = requestAnimationFrame(runInitialUpdate)
    initFallbackTimer = setTimeout(runInitialUpdate, 100)
    
    if (scrollContainer.value) {
      scrollContainer.value.addEventListener('scroll', handleScroll, { passive: true })
      scrollContainer.value.addEventListener('wheel', handleUserScrollInput, { passive: true })
      scrollContainer.value.addEventListener('touchmove', handleUserScrollInput, { passive: true })
      scrollContainer.value.addEventListener('keydown', handleUserScrollInput)
    }
    
    window.addEventListener('resize', updateScrollbar)

    // 使用 ResizeObserver 监听容器尺寸变化
    if (window.ResizeObserver && scrollContainer.value) {
      resizeObserver = new ResizeObserver(() => {
        scheduleLayoutUpdate({ preserveBottom: true, updateMarkers: true })
      })
      resizeObserver.observe(scrollContainer.value)
      // 图片加载/折叠和外部任务条会改变内容或视口高度，但未必产生 DOM mutation。
      const content = scrollContainer.value.firstElementChild
      if (content) resizeObserver.observe(content)
    }
    
    // 使用 MutationObserver 监听内容变化
    if (scrollContainer.value) {
      mutationObserver = new MutationObserver((mutations) => {
        // 字符级变更（CharFlow 直写 text node、v-html 内容替换）只改变文字/内容尺寸，
        // 不改变 marker 元素集合（marker 位置只依赖内容结构）；仍调度布局更新
        // （滚动条尺寸 + 贴底跟随），但不触发 marker 重扫，避免流式期间每帧
        // 对 marker 元素逐个 getBoundingClientRect() 强制同步布局。
        const hasStructuralChange = mutations.some(mutation => mutation.type === 'childList')
        scheduleLayoutUpdate({ preserveBottom: true, updateMarkers: hasStructuralChange })
      })
      mutationObserver.observe(scrollContainer.value, {
        childList: true,
        subtree: true,
        characterData: true
      })
    }
    
    // 初始化底部状态
    wasAtBottom = isAtBottom()
  })
})

// 组件卸载
onBeforeUnmount(() => {
  isUnmounted = true
  if (scrollContainer.value) {
    scrollContainer.value.removeEventListener('scroll', handleScroll)
    scrollContainer.value.removeEventListener('wheel', handleUserScrollInput)
    scrollContainer.value.removeEventListener('touchmove', handleUserScrollInput)
    scrollContainer.value.removeEventListener('keydown', handleUserScrollInput)
  }
  window.removeEventListener('resize', updateScrollbar)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }
  if (layoutUpdateRafId !== null) {
    cancelAnimationFrame(layoutUpdateRafId)
    layoutUpdateRafId = null
  }
  if (initRafId !== null) {
    cancelAnimationFrame(initRafId)
    initRafId = null
  }
  if (initFallbackTimer !== null) {
    clearTimeout(initFallbackTimer)
    initFallbackTimer = null
  }
})

// 内部滚动方法
function scrollToTop() {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTo({
      top: 0,
      behavior: 'smooth'
    })
  }
}

function scrollToBottom(options?: { instant?: boolean }) {
  if (scrollContainer.value) {
    const behavior = options?.instant ? 'auto' as ScrollBehavior : 'smooth'
    // 强制更新一次，确保获取最新的 scrollHeight
    nextTick(() => {
      if (scrollContainer.value) {
        scrollContainer.value.scrollTo({
          top: scrollContainer.value.scrollHeight,
          behavior
        })
      }
    })
  }
}

// 虚拟窗口换页与粘性贴底共用同一滚动写入口，避免两者在下一帧各自纠正对方。
function pauseBottomFollow() {
  wasAtBottom = false
  programmaticScrollTop = null
}

function scrollToPosition(top: number) {
  const container = scrollContainer.value
  if (!container || isUnmounted) return
  const target = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight))
  if (Math.abs(container.scrollTop - target) > 0.5) container.scrollTop = target
  programmaticScrollTop = container.scrollTop
  wasAtBottom = isAtBottom()
  scheduleLayoutUpdate()
}

// 暴露方法供外部调用
defineExpose({
  update: updateScrollbar,
  updateMarkers,
  scrollToTop,
  scrollToBottom,
  scrollToPosition,
  pauseBottomFollow,
  isFollowingBottom: () => wasAtBottom && hasGlobalTail(),
  getContainer: () => scrollContainer.value
})
</script>

<template>
  <div
    class="custom-scrollbar-wrapper"
    :class="{ 'has-h-scroll': horizontal, 'auto-height': !!maxHeight }"
    :style="wrapperStyle"
  >
    <div
      ref="scrollContainer"
      class="scroll-container"
      :class="{ 'enable-h-scroll': horizontal, 'auto-height': !!maxHeight }"
    >
      <slot />
    </div>
    
    <!-- 垂直滚动条 -->
    <div
      v-show="showScrollbar"
      class="scroll-track-container-v"
      :style="{ right: `${offset}px`, width: `${width}px` }"
    >
      <button 
        v-if="showJumpButtons" 
        class="jump-btn jump-btn-top" 
        :title="t('components.common.scrollToTop')"
        @click.stop="scrollToTop"
      >
        <i class="codicon codicon-chevron-up"></i>
      </button>

      <div
        ref="scrollTrack"
        class="scroll-track scroll-track-v"
        :style="trackStyle"
        @click="handleTrackClick"
      >
        <!-- Marker 节点：渲染在轨道内，位于 thumb 之上 -->
        <CustomScrollbarMarkers
          :markers="markerPositions"
          :height="markerHeight"
          :base-color="markerBaseColor"
          :opacity="markerOpacity"
          @click="handleMarkerClick"
          @enter="handleMarkerMouseEnter"
          @leave="handleMarkerMouseLeave"
        />

        <div
          class="scroll-thumb scroll-thumb-v"
          :class="{ 'dragging': isDragging }"
          :style="thumbStyle"
          role="slider"
          tabindex="0"
          aria-orientation="vertical"
          :aria-label="t('components.common.scrollbar')"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="Math.round(vScrollRatio)"
          @mousedown="handleThumbMouseDown"
          @keydown="handleThumbKeydown"
        />

        <!-- Marker 悬浮预览气泡 -->
        <Transition name="marker-tooltip">
          <div
            v-if="tooltipVisible && tooltipContent"
            ref="tooltipRef"
            class="marker-tooltip"
            :style="{ top: `${tooltipTop}px` }"
            @mouseenter="handleTooltipMouseEnter"
            @mouseleave="handleMarkerMouseLeave"
            @wheel="handleTooltipWheel"
          >
            <div class="marker-tooltip-header">
              {{ tooltipMarkerPrefix || markerTooltipPrefix }} #{{ tooltipIndex }}
            </div>
            <div class="marker-tooltip-body">
              {{ tooltipContent }}
            </div>
          </div>
        </Transition>
      </div>

      <button 
        v-if="showJumpButtons" 
        class="jump-btn jump-btn-bottom" 
        :title="t('components.common.scrollToBottom')"
        @click.stop="() => scrollToBottom()"
      >
        <i class="codicon codicon-chevron-down"></i>
      </button>
    </div>
    
    <!-- 横向滚动条 -->
    <div
      v-show="showHScrollbar"
      ref="hScrollTrack"
      class="scroll-track scroll-track-h"
      :style="hTrackStyle"
      @click="handleHTrackClick"
    >
      <div
        class="scroll-thumb scroll-thumb-h"
        :class="{ 'dragging': isHDragging }"
        :style="hThumbStyle"
        role="slider"
        tabindex="0"
        aria-orientation="horizontal"
        :aria-label="t('components.common.horizontalScrollbar')"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="Math.round(hScrollRatio)"
        @mousedown="handleHThumbMouseDown"
        @keydown="handleThumbKeydown"
      />
    </div>
  </div>
</template>

<style scoped src="./CustomScrollbar.css"></style>
