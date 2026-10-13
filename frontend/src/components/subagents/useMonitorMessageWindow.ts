import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, watch, type Ref } from 'vue'
import type { MonitorContentRow } from './monitorContentIndex'

export const MAX_MONITOR_RENDERED_MESSAGES = 200
const WINDOW_INCREMENT = 40
const FOLLOW_THRESHOLD = 80
const OLDER_THRESHOLD = 120

interface HistoryAnchor { messageId?: string; anchorId?: string; offset: number }
interface MonitorWindowOptions {
  rows: Readonly<Ref<MonitorContentRow[]>>
  runId: Readonly<Ref<string | undefined>>
  hasMoreBefore: Readonly<Ref<boolean>>
  loadOlder(): Promise<void>
  disposed(): boolean
}

/** 保留已加载数据，挂载窗口以重叠消息移动；阅读位置由真实消息矩形恢复，不估算长消息高度。 */
export function useMonitorMessageWindow(options: MonitorWindowOptions) {
  const scrollbarRef = ref<{ getContainer(): HTMLElement | undefined } | null>(null)
  const olderLoadEntryRef = ref<HTMLElement | null>(null)
  const shouldAutoFollow = ref(true)
  const viewGeneration = ref(0)
  const scrollPositionVersion = ref(0)
  const firstId = ref<string>()
  const fallbackStart = ref(0)
  let lastScrollTop: number | undefined
  let movingWindow = false
  let readingAnchor: HistoryAnchor | undefined
  let updateAnchor: { anchor: HistoryAnchor; runId: string; generation: number; position: number } | undefined
  let renderedRows: readonly MonitorContentRow[] = []
  let detach: (() => void) | undefined
  let resizeObserver: ResizeObserver | undefined
  let observedShell: HTMLElement | undefined
  const positions = computed(() => {
    const result = new Map<string, number>()
    options.rows.value.forEach((row, index) => {
      result.set(row.id, index)
      if (row.anchorId) result.set(row.anchorId, index)
    })
    return result
  })
  const bounds = computed(() => {
    const total = options.rows.value.length
    const maximumStart = Math.max(0, total - MAX_MONITOR_RENDERED_MESSAGES)
    const start = shouldAutoFollow.value ? maximumStart
      : Math.min(firstId.value ? positions.value.get(firstId.value) ?? fallbackStart.value : fallbackStart.value, maximumStart)
    return { start, end: Math.min(total, start + MAX_MONITOR_RENDERED_MESSAGES) }
  })
  const visibleRows = computed(() => options.rows.value.slice(bounds.value.start, bounds.value.end))
  const hasEarlier = computed(() => bounds.value.start > 0)
  const hasLater = computed(() => bounds.value.end < options.rows.value.length)
  const canLoadOlder = computed(() => hasEarlier.value || options.hasMoreBefore.value)

  function isViewCurrent(runId: string, generation: number): boolean {
    return !options.disposed() && options.runId.value === runId && viewGeneration.value === generation
  }
  function captureHistoryAnchor(container: HTMLElement): HistoryAnchor | undefined {
    const top = container.getBoundingClientRect().top
    for (const element of container.querySelectorAll<HTMLElement>('.message-item[data-message-id]')) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > top) {
        const row = renderedRows.find(item => item.id === element.dataset.messageId)
        return { messageId: element.dataset.messageId, anchorId: row?.anchorId, offset: rect.top - top }
      }
    }
  }
  function restoreHistoryAnchor(container: HTMLElement, anchor: HistoryAnchor) {
    const messageId = anchor.anchorId ? options.rows.value[positions.value.get(anchor.anchorId) ?? -1]?.id : anchor.messageId
    const element = Array.from(container.querySelectorAll<HTMLElement>('.message-item[data-message-id]'))
      .find(item => item.dataset.messageId === messageId)
    if (!element) return
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
    lastScrollTop = container.scrollTop
    readingAnchor = anchor
  }
  function stopFollowing() {
    if (!shouldAutoFollow.value) return
    firstId.value = visibleRows.value[0]?.anchorId ?? visibleRows.value[0]?.id
    fallbackStart.value = bounds.value.start
    shouldAutoFollow.value = false
  }
  function setStart(start: number) {
    stopFollowing()
    fallbackStart.value = Math.max(0, start)
    firstId.value = options.rows.value[fallbackStart.value]?.anchorId ?? options.rows.value[fallbackStart.value]?.id
  }
  async function shiftWindow(start: number) {
    if (movingWindow || options.disposed()) return
    const container = scrollbarRef.value?.getContainer()
    const anchor = container && captureHistoryAnchor(container)
    const runId = options.runId.value
    const generation = viewGeneration.value
    const position = scrollPositionVersion.value
    movingWindow = true
    setStart(start)
    await nextTick()
    if (runId && isViewCurrent(runId, generation) && container === scrollbarRef.value?.getContainer()
      && container && anchor && position === scrollPositionVersion.value) restoreHistoryAnchor(container, anchor)
    movingWindow = false
  }
  function showEarlier() { return shiftWindow(Math.max(0, bounds.value.start - WINDOW_INCREMENT)) }
  function showLater() { return shiftWindow(Math.min(bounds.value.start + WINDOW_INCREMENT,
    Math.max(0, options.rows.value.length - MAX_MONITOR_RENDERED_MESSAGES))) }
  function revealPrepended(previousFirstId: string | undefined) {
    const previousStart = previousFirstId ? positions.value.get(previousFirstId) ?? 0 : 0
    setStart(Math.max(0, previousStart - WINDOW_INCREMENT))
  }
  async function followToBottom() {
    const runId = options.runId.value
    const generation = viewGeneration.value
    await nextTick()
    if (!runId || !isViewCurrent(runId, generation) || !shouldAutoFollow.value) return
    const container = scrollbarRef.value?.getContainer()
    if (container) {
      container.scrollTop = container.scrollHeight
      lastScrollTop = container.scrollTop
    }
  }
  function returnToLatest() {
    shouldAutoFollow.value = true
    readingAnchor = undefined
    void followToBottom()
  }
  function nearOlderEntry(container: HTMLElement): boolean {
    const entry = olderLoadEntryRef.value
    if (!entry || !canLoadOlder.value) return false
    const viewport = container.getBoundingClientRect()
    const rect = entry.getBoundingClientRect()
    return rect.bottom >= viewport.top - OLDER_THRESHOLD && rect.top <= viewport.bottom
  }
  function handleScroll() {
    const container = scrollbarRef.value?.getContainer()
    if (!container || options.disposed() || movingWindow) return
    const movingUp = lastScrollTop !== undefined && container.scrollTop < lastScrollTop
    const movingDown = lastScrollTop !== undefined && container.scrollTop > lastScrollTop
    if (container.scrollTop !== lastScrollTop) scrollPositionVersion.value++
    lastScrollTop = container.scrollTop
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight
    if (!hasLater.value && distance <= FOLLOW_THRESHOLD) shouldAutoFollow.value = true
    else stopFollowing()
    if (!shouldAutoFollow.value) readingAnchor = captureHistoryAnchor(container)
    if (movingUp && nearOlderEntry(container)) void options.loadOlder()
    else if (movingDown && hasLater.value && distance <= FOLLOW_THRESHOLD) void showLater()
  }
  function handleWheel(event: WheelEvent) {
    const container = scrollbarRef.value?.getContainer()
    if (!container || options.disposed() || event.ctrlKey || movingWindow) return
    scrollPositionVersion.value++
    if (event.deltaY < 0 && container.scrollTop <= 0 && nearOlderEntry(container)) void options.loadOlder()
    else if (event.deltaY > 0 && hasLater.value
      && container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_THRESHOLD) void showLater()
  }

  watch(options.runId, () => {
    viewGeneration.value++
    lastScrollTop = undefined
    readingAnchor = undefined
    firstId.value = undefined
    fallbackStart.value = 0
    shouldAutoFollow.value = true
  }, { flush: 'sync' })
  onBeforeUpdate(() => {
    // 纯文本 delta 保持轻量行数组身份，只有挂载范围变化时才读取当前 DOM 锚点。
    if (shouldAutoFollow.value || renderedRows === visibleRows.value) return
    const container = scrollbarRef.value?.getContainer()
    const anchor = container && captureHistoryAnchor(container)
    const runId = options.runId.value
    if (anchor && runId) updateAnchor = { anchor, runId, generation: viewGeneration.value, position: scrollPositionVersion.value }
  })
  function observeShell() {
    const container = scrollbarRef.value?.getContainer()
    const shell = container?.querySelector<HTMLElement>('.message-shell')
    if (shell === observedShell) return
    resizeObserver?.disconnect()
    observedShell = shell
    if (shell) resizeObserver?.observe(shell)
  }
  onUpdated(() => {
    const saved = updateAnchor
    updateAnchor = undefined
    const container = scrollbarRef.value?.getContainer()
    if (saved && container && isViewCurrent(saved.runId, saved.generation) && saved.position === scrollPositionVersion.value) {
      restoreHistoryAnchor(container, saved.anchor)
    }
    renderedRows = visibleRows.value
    observeShell()
  })
  onMounted(() => {
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    lastScrollTop = container.scrollTop
    container.addEventListener('scroll', handleScroll, { passive: true })
    container.addEventListener('wheel', handleWheel, { passive: true })
    detach = () => {
      container.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', handleWheel)
    }
    // 与现有滚动组件一致，非浏览器宿主可以仅使用更新前后的消息锚点。
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (!options.disposed() && !shouldAutoFollow.value && !movingWindow && readingAnchor) restoreHistoryAnchor(container, readingAnchor)
      })
    }
    renderedRows = visibleRows.value
    observeShell()
  })
  onBeforeUnmount(() => { detach?.(); resizeObserver?.disconnect() })
  return {
    scrollbarRef, olderLoadEntryRef, shouldAutoFollow, viewGeneration, scrollPositionVersion,
    visibleRows, hasEarlier, hasLater, canLoadOlder, isViewCurrent, captureHistoryAnchor, restoreHistoryAnchor,
    stopFollowing, showEarlier, revealPrepended, followToBottom, returnToLatest,
  }
}
