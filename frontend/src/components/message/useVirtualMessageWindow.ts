/**
 * useVirtualMessageWindow - 消息列表虚拟窗口 / 滚动 / UI 状态保存恢复
 *
 * 从 MessageList.vue 拆分（S4 批次）：
 * - visibleCount / hasMore / loadMore（先前端展开、再按需后端拉取，含连续空页上限与滚动位置保持；
 *   F-08 起 visibleCount 封顶 MAX_RENDERED_ROWS，超出后改为滑动窗口裁剪顶部/底部行）
 * - maybeAutoLoadMore 自动补载 / handleScroll 滚动加载
 * - messageRenderRows 渲染行组装（build / todo sticky 条 + checkpoint 增强消息 + 总结分隔线）
 * - saveCurrentUiState / restoreUiState（模块级 messageListUiStateByTab，H5 / M2-1）
 * - tabId / currentConversationId / messages watcher、ResizeObserver、onMounted/onBeforeUnmount
 *
 * 与其它面板的共享状态（build/todo 锚点与可见性、展开 ref、restoreNotice、checkpoint 分组、
 * restoreTodoExpandedState）一律由 MessageList 以参数注入，不搞全局。
 */

import { ref, computed, watch, nextTick, onMounted, onUpdated, onBeforeUnmount } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useChatStore } from '../../stores'
import { CustomScrollbar } from '../common'
import { sendToExtension } from '../../utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { pruneMediumTrimmedByMessageId } from './mediumTrimState'
import { pruneBackgroundTaskViewModes, pruneThoughtViewModes } from './messageViewModes'
import { messageListUiStateByTab, MESSAGE_LIST_UI_STATE_CAP, type RestoreNoticeState } from './messageListUiState'
import {
  advanceMessageWindowStart,
  computePaginatedMessageFloorMap,
  computeCheckpointFloorMap,
  getMessageInputGroupPositions,
  type MessageInputGroupPosition
} from './messageListUtils'
import { clearLineDiffCache } from '../../utils/lineDiff'
import type { Message, CheckpointRecord } from '../../types'
import type { MessageListUiState } from './messageListUiState'
import { jumpToMessage as requestMessageJump, peekMessageJump, takeMessageJump, type MessageJumpTarget } from './messageJump'

/** 根据稳定消息锚点恢复滑动窗口；消息 prepend 后仍能回到原阅读段。 */
export function resolveRestoredWindowStart(
  messages: ReadonlyArray<Pick<Message, 'id'>>,
  visibleCount: number,
  saved: Pick<MessageListUiState, 'anchorMessageId' | 'anchorWindowOffset' | 'windowStart'>
): number {
  const anchorIndex = saved.anchorMessageId
    ? messages.findIndex(message => message.id === saved.anchorMessageId)
    : -1
  if (anchorIndex >= 0 && typeof saved.anchorWindowOffset === 'number') {
    return Math.max(0, anchorIndex - saved.anchorWindowOffset)
  }
  return Math.max(0, saved.windowStart ?? (messages.length - visibleCount))
}

export interface UseVirtualMessageWindowOptions {
  chatStore: ReturnType<typeof useChatStore>
  props: { messages: Message[]; tabId: string }
  /** checkpoint 恢复流提供：按消息索引分组的检查点（渲染增强用） */
  checkpointsByMsgIndex: ComputedRef<Map<number, { before: CheckpointRecord[]; after: CheckpointRecord[] }>>
  /** build 面板：Build 条可见性与插入锚点（sticky 行组装） */
  showBuildBar: ComputedRef<boolean>
  buildAnchorBackendIndex: ComputedRef<number | null>
  /** todo 面板：TODO 条可见性与插入锚点（sticky 行组装） */
  showTodoBar: ComputedRef<boolean>
  todoAnchorBackendIndex: ComputedRef<number | null>
  /** build / todo 面板：展开状态 ref（UI 状态保存/恢复读写） */
  isBuildExpanded: Ref<boolean>
  isTodoExpanded: Ref<boolean>
  /** checkpoint 恢复流：恢复结果提示（随 UI 状态保存/恢复） */
  restoreNotice: Ref<RestoreNoticeState | null>
  /** todo 面板：恢复 TODO 展开状态（restoreUiState 调用） */
  restoreTodoExpandedState: () => void
}

export function useVirtualMessageWindow(options: UseVirtualMessageWindowOptions) {
  const {
    chatStore,
    props,
    checkpointsByMsgIndex,
    showBuildBar,
    buildAnchorBackendIndex,
    showTodoBar,
    todoAnchorBackendIndex,
    isBuildExpanded,
    isTodoExpanded,
    restoreNotice,
    restoreTodoExpandedState
  } = options

  // 消息分页显示逻辑：解决消息过多导致的输入卡顿
  const VISIBLE_INCREMENT = 40
  // 连续空页上限：后端返回 loaded=true 但无新增消息时停止继续拉取，避免死循环
  const MAX_EMPTY_LOAD_PAGES = 3
  // 滚动到顶部/底部触发加载或贴尾的阈值（px）
  const SCROLL_LOAD_THRESHOLD = 100
  const ESTIMATED_MESSAGE_ROW_HEIGHT = 96

  // F-08：渲染窗口上限。此前 visibleCount 只增不减，用户持续上滚时渲染行数线性增长，
  // 从不裁掉已滚出视口顶部的行；数千条历史会渲染上千个 MessageItem，逐步吃掉流式渲染优化。
  // 这里把窗口长度封顶，超出后改为「滑动窗口」：loadMore 上翻历史时窗口上移，
  // 同时把底部最早渲染的行裁掉（见 loadMore 的重定位逻辑）。
  // 取值权衡：200 行既覆盖常见视口（约 5~10 屏），又不会让长会话退回 O(n) 渲染。
  const MAX_RENDERED_ROWS = 200

  // 窗口长度（渲染的消息条数），保持在 [1, MAX_RENDERED_ROWS]
  const visibleCount = ref(VISIBLE_INCREMENT)
  // 窗口起点：props.messages 中第一条参与渲染的消息下标（滑动窗口的 startIndex）
  const windowStart = ref(0)

  // 当前可见消息总数
  const messageCount = computed(() => props.messages.length)
  // 实际渲染条数（消息不足窗口大小时按实际条数）
  const windowSize = computed(() => Math.min(visibleCount.value, messageCount.value))
  // 窗口起点允许的最大值（保证窗口不越过数组末尾）
  const maxWindowStart = computed(() => Math.max(0, messageCount.value - windowSize.value))
  // 归一化后的窗口起点（windowStart 可能在消息数组被裁剪/替换后越界，这里兜底）
  const safeWindowStart = computed(() => {
    if (messageCount.value === 0) return 0
    return Math.min(Math.max(windowStart.value, 0), maxWindowStart.value)
  })
  // 窗口终点（不含），即滑动窗口的 endIndex
  const windowEnd = computed(() => safeWindowStart.value + windowSize.value)

  interface MessageMarker {
    index: number
    id?: string
    preview?: string
  }

  const messageMarkers = ref<MessageMarker[]>([])
  const markerTotal = ref(0)
  const globalFloorIndices = ref<number[] | null>(null)
  const messageMarkerCache = new Map<string, { total: number; markers: MessageMarker[]; floorIndices: number[] | null; loadedAt: number }>()
  let markerConversationId: string | null = null
  let markerRequestEpoch = 0

  // 分页边界来自完整 store 窗口，不能把隐藏 functionResponse 误当成尚未读取的历史。
  const loadedWindowEnd = computed(() => {
    const last = chatStore.allMessages.at(-1)
    const visibleLast = props.messages.at(-1)
    return Math.max(
      typeof last?.backendIndex === 'number' ? last.backendIndex + 1 : (Number(chatStore.windowStartIndex) || 0) + chatStore.allMessages.length,
      typeof visibleLast?.backendIndex === 'number' ? visibleLast.backendIndex + 1 : 0
    )
  })
  const virtualTotalMessages = computed(() => Math.max(Number(chatStore.totalMessages) || 0, loadedWindowEnd.value))
  const virtualWindowStart = computed(() => {
    if (safeWindowStart.value === 0) return Math.max(0, Number(chatStore.windowStartIndex) || 0)
    const first = props.messages[safeWindowStart.value]
    return typeof first?.backendIndex === 'number'
      ? first.backendIndex
      : Math.max(0, Number(chatStore.windowStartIndex) || 0) + safeWindowStart.value
  })
  const virtualWindowEnd = computed(() => {
    if (windowEnd.value >= props.messages.length) return loadedWindowEnd.value
    const last = props.messages[Math.max(safeWindowStart.value, windowEnd.value - 1)]
    const fallback = Math.max(virtualWindowStart.value, (Number(chatStore.windowStartIndex) || 0) + windowEnd.value)
    return typeof last?.backendIndex === 'number' ? Math.max(virtualWindowStart.value, last.backendIndex + 1) : fallback
  })
  const allMessageMarkers = computed<MessageMarker[]>(() => {
    const byIndex = new Map<number, MessageMarker>()
    for (const marker of messageMarkers.value) byIndex.set(marker.index, marker)
    for (const message of props.messages) {
      if (message.role !== 'user' || message.isFunctionResponse || typeof message.backendIndex !== 'number') continue
      if (byIndex.has(message.backendIndex)) continue
      const preview = message.content.replace(/\s+/g, ' ').trim().slice(0, 80)
      byIndex.set(message.backendIndex, {
        index: message.backendIndex,
        id: message.id,
        ...(preview ? { preview } : {})
      })
    }
    return Array.from(byIndex.values()).sort((a, b) => a.index - b.index)
  })

  async function refreshMessageMarkers(conversationId: string | null): Promise<void> {
    const epoch = ++markerRequestEpoch
    messageMarkers.value = []
    markerTotal.value = 0
    globalFloorIndices.value = null
    markerConversationId = conversationId
    if (!conversationId) return
    const cached = messageMarkerCache.get(conversationId)
    if (cached && cached.total === chatStore.totalMessages && Date.now() - cached.loadedAt < 60_000) {
      messageMarkers.value = cached.markers
      markerTotal.value = cached.total
      globalFloorIndices.value = cached.floorIndices
      return
    }
    try {
      const result = await sendToExtension<{ total?: number; markers?: MessageMarker[]; floorIndices?: number[] }>(MESSAGE_NAMES['conversation.getMessageMarkers'], {
        conversationId
      })
      if (epoch !== markerRequestEpoch || markerConversationId !== conversationId || chatStore.currentConversationId !== conversationId) return
      messageMarkers.value = Array.isArray(result?.markers)
        ? result.markers.filter(marker => Number.isFinite(marker.index) && marker.index >= 0)
        : []
      markerTotal.value = Number.isFinite(result?.total) ? Math.max(0, Number(result.total)) : 0
      globalFloorIndices.value = Array.isArray(result?.floorIndices)
        ? [...new Set(result.floorIndices.filter(index => Number.isSafeInteger(index) && index >= 0 && index < markerTotal.value))].sort((a, b) => a - b)
        : null
      messageMarkerCache.set(conversationId, {
        total: markerTotal.value,
        markers: messageMarkers.value,
        floorIndices: globalFloorIndices.value,
        loadedAt: Date.now()
      })
    } catch (error) {
      if (epoch !== markerRequestEpoch) return
      // 老宿主没有 marker 接口时保留现有滚动体验，真实消息页仍可正常分页。
      console.warn('[MessageList] Failed to load message markers:', error)
    }
  }

  // 与 CustomScrollbar 的协调点（F-08）：滑动窗口只保留真实消息节点，避免把
  // 未加载/未渲染范围伪装成可拖动的空白区域。窗口向下移动时由真实消息锚点恢复位置，
  // CustomScrollbar 的 marker 始终只对应当前 DOM 中真实存在的消息。

  // 是否还有更多“未加载到窗口”的历史消息
  const hasMoreHistory = computed(() => chatStore.windowStartIndex > 0)
  // 顶部加载指示器：后端有更多历史 或 窗口起点之前还有已加载但未渲染的消息
  const hasMore = computed(() => hasMoreHistory.value || safeWindowStart.value > 0)

  // 增强的消息对象接口
  interface EnhancedMessage {
    message: Message
    backendIndex: number
    beforeCheckpoints: CheckpointRecord[]
    afterCheckpoints: CheckpointRecord[]
    /** 楼层号（用户消息/模型回复各占一楼；tool 及内部消息不计） */
    floor?: number
  }

  // 楼层号映射：后端一次全局扫描提供绝对位置，分页窗口按 backendIndex 对齐。
  // 历史缩短后旧快照立即失效；新消息在快照末尾按连续索引顺延。
  const floorByMessageId = computed(() => computePaginatedMessageFloorMap(
    props.messages, chatStore.totalMessages < markerTotal.value ? null : globalFloorIndices.value, markerTotal.value
  ))

  // 存档序号：按创建时间升序编号（第 N 次存档）。
  const checkpointFloorByCheckpointId = computed(() => computeCheckpointFloorMap(chatStore.checkpoints))

  const enhancedVisibleMessages = computed<EnhancedMessage[]>(() => {
    const visibleMessages = props.messages.slice(safeWindowStart.value, windowEnd.value)

    // 预先按消息索引对检查点进行分组
    return visibleMessages.map(message => {
      const backendIndex = typeof message.backendIndex === 'number' ? message.backendIndex : -1
      const cpGroup = backendIndex !== -1 ? checkpointsByMsgIndex.value.get(backendIndex) : null

      return {
        message,
        backendIndex,
        beforeCheckpoints: cpGroup?.before || [],
        afterCheckpoints: cpGroup?.after || [],
        floor: floorByMessageId.value.get(message.id)
      }
    })
  })

  type RenderRow =
    | { kind: 'build'; key: 'build-bar' }
    | { kind: 'message'; key: string; item: EnhancedMessage; inputGroup?: MessageInputGroupPosition }
    | { kind: 'todo'; key: 'todo-bar' }
    | { kind: 'summarize-divider'; key: string }

  function shouldInsertSticky(anchor: number | null, idx: number): boolean {
    return anchor === null || (typeof idx === 'number' && idx >= 0 && idx >= anchor)
  }

  const messageRenderRows = computed<RenderRow[]>(() => {
    const visible = enhancedVisibleMessages.value
    const rows: RenderRow[] = []
    const buildAnchor = buildAnchorBackendIndex.value
    const todoAnchor = todoAnchorBackendIndex.value

    let buildInserted = !showBuildBar.value
    let todoInserted = !showTodoBar.value

    // 逻辑截断：最后一个总结消息之后渲染横线，分隔「已总结区域」与「未总结区域」。
    // 被总结消息（isSummarized）原文照常显示（不折叠），横线作为两者边界。
    let lastSummaryBackendIndex: number | null = null
    for (const item of visible) {
      if (item.message.isSummary && typeof item.backendIndex === 'number') {
        lastSummaryBackendIndex = item.backendIndex
      }
    }

    for (const item of visible) {
      const idx = item.backendIndex
      if (!buildInserted && shouldInsertSticky(buildAnchor, idx)) {
        rows.push({ kind: 'build', key: 'build-bar' })
        buildInserted = true
      }

      if (!todoInserted && shouldInsertSticky(todoAnchor, idx)) {
        rows.push({ kind: 'todo', key: 'todo-bar' })
        todoInserted = true
      }

      rows.push({ kind: 'message', key: item.message.id, item })

      // 在最后一个总结消息之后插入分隔线（已总结 / 未总结分界）
      if (lastSummaryBackendIndex !== null && idx === lastSummaryBackendIndex) {
        rows.push({ kind: 'summarize-divider', key: `summarize-divider:${idx}` })
      }
    }

    if (!buildInserted && showBuildBar.value) {
      rows.push({ kind: 'build', key: 'build-bar' })
    }

    if (!todoInserted && showTodoBar.value) {
      rows.push({ kind: 'todo', key: 'todo-bar' })
    }

    const inputGroups = getMessageInputGroupPositions(rows)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (row.kind === 'message') row.inputGroup = inputGroups[index]
    }
    return rows
  })

  // 将窗口长度约束在 [1, MAX_RENDERED_ROWS]
  function clampVisibleCount(value: number): number {
    if (!Number.isFinite(value)) return VISIBLE_INCREMENT
    return Math.max(1, Math.min(MAX_RENDERED_ROWS, Math.floor(value)))
  }

  // 贴尾：窗口渲染最新 size 条消息（吸底/流式新增的基础）
  function anchorToTail() {
    const len = props.messages.length
    const size = Math.min(visibleCount.value, len)
    windowStart.value = Math.max(0, len - size)
  }

  // 记录顶部锚点：滑窗会「顶部新增 + 底部裁剪」同时发生，scrollHeight 变化不再单调，
  // 不能用旧的 oldScrollTop + ΔscrollHeight 恢复位置；改为锚定第一条尚未完全滚出视口的消息。
  function captureTopAnchor(container: HTMLElement): { messageId: string | null; offset: number } {
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const containerRect = container.getBoundingClientRect()
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const rect = el.getBoundingClientRect()
      if (rect.bottom > containerRect.top + 1) {
        return { messageId: el.dataset.messageId ?? null, offset: rect.top - containerRect.top }
      }
    }
    return { messageId: null, offset: 0 }
  }

  let viewGeneration = 0
  let disposed = false
  let lastScrollTop: number | undefined
  let automaticFillUsed = false
  watch([() => props.tabId, () => chatStore.currentConversationId], () => {
    viewGeneration++
    lastScrollTop = undefined
    automaticFillUsed = false
    pendingUiRestore?.controller.abort()
    isLoadingMore.value = false
    isShiftingWindow.value = false
    pendingHistoryAnchor = undefined
  }, { flush: 'sync' })

  function isCurrentView(generation: number): boolean {
    return !disposed && generation === viewGeneration
  }

  function writeScrollTop(container: HTMLElement, top: number) {
    scrollbarRef.value?.scrollToPosition(top)
    lastScrollTop = container.scrollTop
  }

  // 用稳定 ID 恢复，不依赖新窗口内的数组位置；页面切换/卸载后的迟到恢复必须失效。
  async function restoreTopAnchor(container: HTMLElement, anchor: { messageId: string | null; offset: number }, generation = viewGeneration, isValid = () => true) {
    await nextTick()
    if (!isCurrentView(generation) || !isValid() || scrollbarRef.value?.getContainer() !== container || !anchor.messageId) return
    const element = Array.from(container.querySelectorAll<HTMLElement>('.message-item, .summary-message'))
      .find(item => item.dataset.messageId === anchor.messageId)
    if (!element) return
    const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
    writeScrollTop(container, container.scrollTop + delta)
  }

  /** 加载并定位到全局消息索引或稳定消息 ID。索引为后端历史 0-based 下标。 */
  async function jumpToMessage(target: MessageJumpTarget): Promise<boolean> {
    const generation = viewGeneration
    const conversationId = chatStore.currentConversationId
    if (disposed || !conversationId || target.conversationId && target.conversationId !== conversationId) return false
    cancelUiRestore()

    let targetIndex = typeof target.index === 'number' ? target.index : target.messageIndex
    const targetId = target.id || target.messageId
    if (targetId) {
      const loaded = props.messages.find(message => message.id === targetId)
      targetIndex = loaded?.backendIndex
      if (!Number.isFinite(targetIndex)) {
        const position = await sendToExtension<{ index?: number }>(MESSAGE_NAMES['conversation.getMessagePosition'], {
          conversationId, messageId: targetId
        })
        if (!isCurrentView(generation)) return false
        targetIndex = position?.index
      }
    }
    if (!Number.isFinite(targetIndex) || (targetIndex as number) < 0) return false
    targetIndex = Math.floor(targetIndex as number)

    const matchesTarget = (message: Message) => targetId ? message.id === targetId : message.backendIndex === targetIndex
    const targetAlreadyLoaded = props.messages.some(matchesTarget)
    if (!targetAlreadyLoaded) {
      const loaded = await chatStore.loadMessagesAroundIndex(targetIndex)
      if (!loaded || !isCurrentView(generation)) return false
    }

    const localIndex = props.messages.findIndex(matchesTarget)
    if (localIndex < 0) return false

    scrollbarRef.value?.pauseBottomFollow()
    visibleCount.value = clampVisibleCount(Math.max(visibleCount.value, Math.min(MAX_RENDERED_ROWS, props.messages.length)))
    windowStart.value = Math.max(0, Math.min(
      Math.max(0, props.messages.length - Math.min(visibleCount.value, props.messages.length)),
      localIndex - Math.floor(Math.max(1, viewportHeight.value / ESTIMATED_MESSAGE_ROW_HEIGHT) / 2)
    ))
    await nextTick()
    if (!isCurrentView(generation)) return false

    const container = scrollbarRef.value?.getContainer() as HTMLElement | null | undefined
    if (!container) return false
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const targetElement = Array.from(elements).find(element =>
      element.getAttribute('data-message-id') === (targetId || props.messages[localIndex]?.id)
    )
    if (!targetElement) return false
    const containerRect = container.getBoundingClientRect()
    const targetRect = targetElement.getBoundingClientRect()
    writeScrollTop(container, targetRect.top - containerRect.top + container.scrollTop - container.clientHeight * 0.35)
    return true
  }

  async function handleVirtualSeek(index: number): Promise<void> {
    requestMessageJump({ conversationId: chatStore.currentConversationId || undefined, index })
    await consumePendingMessageJump()
  }

  let consumingMessageJump = false
  async function consumePendingMessageJump(): Promise<void> {
    if (consumingMessageJump) return
    const conversationId = chatStore.currentConversationId
    const pending = peekMessageJump(conversationId)
    if (!pending || (props.messages.length === 0 && messageMarkers.value.length === 0)) return
    consumingMessageJump = true
    try {
      if (await jumpToMessage(pending) && peekMessageJump(conversationId) === pending) takeMessageJump(conversationId)
    } catch (error) {
      console.warn('[MessageList] Failed to locate message:', error)
    } finally {
      consumingMessageJump = false
      // 请求在途时只保留最后一个定位目标；旧请求结束后接着消费，避免被分页锁吞掉。
      const latest = peekMessageJump(chatStore.currentConversationId)
      if (latest && latest !== pending) void consumePendingMessageJump()
    }
  }

  function handleExternalMessageJump(event: MessageEvent): void {
    if (event.source !== window && event.source !== window.parent) return
    if (event.origin !== window.location.origin && event.origin !== 'null') return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.type !== 'graycode.jumpToMessage') return
    requestMessageJump({
      conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
      messageIndex: typeof data.messageIndex === 'number' ? data.messageIndex : undefined,
      messageId: typeof data.messageId === 'string' ? data.messageId : undefined
    })
    void consumePendingMessageJump()
  }

  /** 判断最后一条已渲染消息是否已经进入当前视口底部。 */
  function isNearRenderedWindowBottom(container: HTMLElement): boolean {
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const last = elements[elements.length - 1]
    if (!last) return false
    const containerRect = container.getBoundingClientRect()
    const lastRect = last.getBoundingClientRect()
    return lastRect.bottom > containerRect.top && lastRect.bottom <= containerRect.bottom + SCROLL_LOAD_THRESHOLD
  }

  /** 判断第一条已渲染消息是否已经接近当前视口顶部。 */
  function isNearRenderedWindowTop(container: HTMLElement): boolean {
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const first = elements[0]
    if (!first) return false
    const containerRect = container.getBoundingClientRect()
    const firstRect = first.getBoundingClientRect()
    // 首行接近视口顶部时触发分页；首行远在视口上方时不触发，避免在最新页底部
    // 反复请求。以首行顶部与底部共同判断，超高工具卡片进入顶部时也能触发。
    return firstRect.top <= containerRect.top + SCROLL_LOAD_THRESHOLD
      && firstRect.bottom > containerRect.top - SCROLL_LOAD_THRESHOLD
  }

  // 是否正在加载更多（用于节流）
  const viewportHeight = ref(0)

  const isLoadingMore = ref(false)
  const isShiftingWindow = ref(false)

  /**
   * 向后移动一个小窗口，继续展示已加载的历史消息。
   * 使用顶部可见消息作为锚点，避免替换 DOM 行时视口跳动；锚点至少保留一行，
   * 对于单条超高消息则等用户继续滚动后再移动窗口。
   */
  async function advanceWindow() {
    if (disposed || isLoadingMore.value || isShiftingWindow.value || windowEnd.value >= props.messages.length) return
    const container = scrollbarRef.value?.getContainer()
    if (!container) return

    const previousStart = safeWindowStart.value
    const requestedStart = advanceMessageWindowStart(
      previousStart,
      windowSize.value,
      props.messages.length,
      VISIBLE_INCREMENT
    )
    if (requestedStart <= previousStart) return

    const anchor = captureTopAnchor(container)
    const anchorIndex = anchor.messageId
      ? enhancedVisibleMessages.value.findIndex(item => item.message.id === anchor.messageId)
      : -1
    const step = Math.min(requestedStart - previousStart, Math.max(0, anchorIndex))
    if (step <= 0) return

    const generation = viewGeneration
    isShiftingWindow.value = true
    scrollbarRef.value?.pauseBottomFollow()
    try {
      windowStart.value = advanceMessageWindowStart(
        previousStart,
        windowSize.value,
        props.messages.length,
        step
      )
      await restoreTopAnchor(container, anchor, generation)
    } finally {
      if (isCurrentView(generation)) isShiftingWindow.value = false
    }
  }

  /** 定位到历史中段后继续下读：复用居中分页，重叠区保留完整旧渲染窗口。 */
  async function loadNewerWindow() {
    if (disposed || isShiftingWindow.value || isLoadingMore.value || chatStore.isLoadingMoreMessages) return
    const endIndex = loadedWindowEnd.value
    if (endIndex >= chatStore.totalMessages) return
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    const generation = viewGeneration
    const anchor = captureTopAnchor(container)
    isShiftingWindow.value = true
    scrollbarRef.value?.pauseBottomFollow()
    try {
      const loaded = await chatStore.loadMessagesAroundIndex(endIndex, { pageSize: MAX_RENDERED_ROWS * 2 })
      if (!loaded || !isCurrentView(generation) || peekMessageJump(chatStore.currentConversationId)) return
      const anchorIndex = props.messages.findIndex(message => message.id === anchor.messageId)
      if (anchorIndex < 0) return
      windowStart.value = anchorIndex
      await restoreTopAnchor(container, anchor, generation)
    } finally {
      if (isCurrentView(generation)) isShiftingWindow.value = false
    }
  }

  let pendingHistoryAnchor: { messageId: string | null; offset: number } | undefined

  // 一次上翻只展开一个渲染步长；空的可见页可有界跳过，但游标不前进时立即停止。
  async function loadMore() {
    if (disposed || isLoadingMore.value || isShiftingWindow.value || !hasMore.value || chatStore.isLoadingMoreMessages) return
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    const generation = viewGeneration
    const firstId = props.messages[safeWindowStart.value]?.id
    const needBackendLoad = hasMoreHistory.value && safeWindowStart.value === 0
    pendingHistoryAnchor = captureTopAnchor(container)
    isLoadingMore.value = true
    scrollbarRef.value?.pauseBottomFollow()
    try {
      if (needBackendLoad) {
        for (let page = 0; page < MAX_EMPTY_LOAD_PAGES; page++) {
          const cursor = chatStore.windowStartIndex
          const previousFirstId = props.messages[0]?.id
          const loaded = await chatStore.loadOlderMessagesPage()
          if (!isCurrentView(generation) || peekMessageJump(chatStore.currentConversationId)) return
          // 净长度不能代表进度：前端/后端可能同时裁掉另一端，或该页只有 functionResponse。
          if (!loaded || chatStore.windowStartIndex >= cursor) break
          if (props.messages[0]?.id !== previousFirstId || !hasMoreHistory.value) break
        }
      }
      if (!isCurrentView(generation) || peekMessageJump(chatStore.currentConversationId)) return
      const previousStart = props.messages.findIndex(message => message.id === firstId)
      if (previousStart < 0) return
      const anchorIndex = props.messages.findIndex(message => message.id === pendingHistoryAnchor?.messageId)
      const anchorOffset = Math.max(0, anchorIndex - previousStart)
      // 等待期间继续下读也不能把用户当前锚点从 200 行窗口末端裁掉。
      const step = Math.min(VISIBLE_INCREMENT, previousStart, Math.max(0, MAX_RENDERED_ROWS - 1 - anchorOffset))
      visibleCount.value = clampVisibleCount(visibleCount.value + step)
      windowStart.value = previousStart - step
      await restoreTopAnchor(container, pendingHistoryAnchor, generation)
    } catch (error) {
      console.error('[MessageList] Failed to load older messages:', error)
    } finally {
      if (isCurrentView(generation)) {
        pendingHistoryAnchor = undefined
        // 锚点写入完成前保持互斥，程序 scroll 不得立即启动相反方向的分页。
        isLoadingMore.value = false
      }
    }
  }

  // 视口未填满时每次进入会话最多自动补一个批次，不能用“加载结束→仍不满”递归扫描全部历史。
  function maybeAutoLoadMore() {
    if (disposed || pendingUiRestore || automaticFillUsed || isLoadingMore.value || isShiftingWindow.value || !hasMore.value) return
    if (windowEnd.value < props.messages.length) return
    const container = scrollbarRef.value?.getContainer()
    if (!container || container.clientHeight <= 0) return
    if (container.scrollHeight <= container.clientHeight + 1) {
      automaticFillUsed = true
      void loadMore()
    }
  }

  function handleScroll(e: Event) {
    const container = e.target as HTMLElement
    if (!container || disposed) return
    const previous = lastScrollTop ?? 0
    lastScrollTop = container.scrollTop
    if (viewportHeight.value !== container.clientHeight) viewportHeight.value = container.clientHeight
    if (isLoadingMore.value) {
      pendingHistoryAnchor = captureTopAnchor(container)
      return
    }
    if (pendingUiRestore || isShiftingWindow.value || peekMessageJump(chatStore.currentConversationId)
      || scrollbarRef.value?.isFollowingBottom()) return
    // 不把 anchor 恢复、贴底、同一位置重复 scroll 当成新的上翻请求。
    if (container.scrollTop < previous && hasMore.value && isNearRenderedWindowTop(container)) {
      void loadMore()
    } else if (container.scrollTop > previous && isNearRenderedWindowBottom(container)) {
      if (windowEnd.value < props.messages.length) void advanceWindow()
      else void loadNewerWindow()
    }
  }

  function handleWheel(e: WheelEvent) {
    if (e.ctrlKey || disposed || isLoadingMore.value || isShiftingWindow.value) return
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    // 真正到边缘/不足一屏时没有 scroll 事件；新滚轮意图仍可继续分页。
    if (e.deltaY < 0 && container.scrollTop <= 0 && hasMore.value) void loadMore()
    else if (e.deltaY > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 1) {
      if (windowEnd.value < props.messages.length) void advanceWindow()
      else void loadNewerWindow()
    }
  }

  // CustomScrollbar 引用
  const scrollbarRef = ref<InstanceType<typeof CustomScrollbar> | null>(null)

  // 标记是否需要滚动到底部（切换对话时设置）
  const needsScrollToBottom = ref(false)

  // 使用模块级 Map（H5）：组件卸载后滚动位置/展开状态不丢失
  const uiStateByTab = messageListUiStateByTab
  let pendingUiRestore: {
    tabId: string
    generation: number
    saved: MessageListUiState
    controller: AbortController
    running: boolean
  } | undefined

  // props 在组件更新前已经指向新会话；离开时必须使用仍在 DOM 中的旧窗口元数据。
  let renderedWindow = { tabId: props.tabId, conversationId: chatStore.currentConversationId,
    start: 0, rows: [] as Message[] }
  function rememberRenderedWindow() {
    renderedWindow = { tabId: props.tabId, conversationId: chatStore.currentConversationId,
      start: safeWindowStart.value, rows: enhancedVisibleMessages.value.map(item => item.message) }
  }
  onMounted(rememberRenderedWindow)
  onUpdated(rememberRenderedWindow)

  function cancelUiRestore() {
    pendingUiRestore?.controller.abort()
    pendingUiRestore = undefined
    needsScrollToBottom.value = false
  }

  function handleRestoreInput(event: Event) {
    if (event instanceof WheelEvent && (event.ctrlKey || event.deltaY === 0)) return
    if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
    if (event.type === 'pointerdown' && !(event.target as Element)?.closest('.scroll-track-container-v')) return
    if (!pendingUiRestore && !needsScrollToBottom.value) return
    cancelUiRestore()
    scrollbarRef.value?.pauseBottomFollow()
  }

  /**
   * M1-1：收集「仍可能被渲染」的消息 ID 并集（当前窗口 + 各标签页快照），
   * 供 pruneBackgroundTaskViewModes 清理已删除/已关闭会话遗留的视图模式记录。
   */
  function collectActiveBackgroundTaskMessageIds(): Set<string> {
    const ids = new Set<string>()
    for (const msg of chatStore.allMessages) {
      if (msg?.id) ids.add(msg.id)
    }
    for (const snapshot of chatStore.sessionSnapshots.values()) {
      for (const msg of snapshot.allMessages) {
        if (msg?.id) ids.add(msg.id)
      }
    }
    return ids
  }

  function saveCurrentUiState(tabId?: string) {
    if (!tabId) return
    // M2-1：已关闭的标签页不再保存（closeTab 已清理其 UI 状态，
    // 避免关闭活跃标签页后 watcher 又把旧记录写回造成泄漏）
    if (!chatStore.openTabs.some(t => t.id === tabId)) return
    // 还未恢复就再次切走，保留原状态，不能用过渡中的尾页覆盖它。
    if (pendingUiRestore?.tabId === tabId) return
    const container = scrollbarRef.value?.getContainer()
    const anchor = container ? captureTopAnchor(container) : { messageId: null, offset: 0 }
    const anchorWindowOffset = renderedWindow.rows.findIndex(message => message.id === anchor.messageId)
    uiStateByTab.set(tabId, {
      scrollTop: container?.scrollTop || 0,
      conversationId: renderedWindow.conversationId,
      followingBottom: scrollbarRef.value?.isFollowingBottom() ?? false,
      visibleCount: visibleCount.value,
      windowStart: renderedWindow.start,
      anchorMessageId: anchor.messageId,
      anchorBackendIndex: renderedWindow.rows[anchorWindowOffset]?.backendIndex,
      anchorOffset: anchor.offset,
      anchorWindowOffset: anchorWindowOffset >= 0 ? anchorWindowOffset : undefined,
      buildExpanded: isBuildExpanded.value,
      todoExpanded: isTodoExpanded.value,
      restoreNotice: restoreNotice.value ? { ...restoreNotice.value } : null
    })
    // M2-1：容量上限兜底（优先淘汰最旧的非当前记录）
    if (uiStateByTab.size > MESSAGE_LIST_UI_STATE_CAP) {
      let overflow = uiStateByTab.size - MESSAGE_LIST_UI_STATE_CAP
      for (const key of Array.from(uiStateByTab.keys())) {
        if (key === tabId) continue
        uiStateByTab.delete(key)
        overflow--
        if (overflow <= 0) break
      }
    }
  }

  async function tryRestoreUiState() {
    const attempt = pendingUiRestore
    if (!attempt || attempt.running || chatStore.isLoadingMoreMessages) return
    const { saved, generation, controller } = attempt
    // 已有快照先呈现原阅读位置；权威刷新结束后再对齐一次。用户输入可在两者之间取消。
    if (chatStore.isLoading && (saved.followingBottom || !props.messages.some(message => message.id === saved.anchorMessageId))) return
    const isValid = () => isCurrentView(generation) && pendingUiRestore === attempt && !controller.signal.aborted
    if (!isValid()) return
    attempt.running = true
    let waitingForLayout = false
    try {
      let anchor = props.messages.find(message => message.id === saved.anchorMessageId)
      if (saved.followingBottom) {
        if (loadedWindowEnd.value < chatStore.totalMessages) {
          const loaded = await chatStore.loadMessagesAroundIndex(chatStore.totalMessages - 1, { pageSize: MAX_RENDERED_ROWS * 2, signal: controller.signal })
          if (!loaded || !isValid()) return
        }
        anchorToTail()
      } else if (saved.anchorMessageId) {
        if (!anchor) {
          const conversationId = chatStore.currentConversationId
          // ID 权威查询覆盖后台删除/分支变化；绝不由 scrollTop 或可见长度估算历史位置。
          let position: { index?: number }
          try {
            position = await sendToExtension(MESSAGE_NAMES['conversation.getMessagePosition'], { conversationId, messageId: saved.anchorMessageId })
          } catch (error) {
            if (isValid()) console.warn('[MessageList] Failed to restore reading position:', error)
            return
          }
          if (!isValid()) return
          const index = typeof position?.index === 'number' && position.index >= 0
            ? position.index : saved.anchorBackendIndex
          if (typeof index !== 'number' || chatStore.totalMessages <= 0) return
          const targetIndex = Math.min(index, chatStore.totalMessages - 1)
          const loaded = await chatStore.loadMessagesAroundIndex(targetIndex, { pageSize: MAX_RENDERED_ROWS * 2, signal: controller.signal })
          if (!loaded || !isValid()) return
          anchor = props.messages.find(message => message.id === saved.anchorMessageId)
          // 锚点确实删除后使用该历史位置的下一条可见消息；隐藏工具响应不成为锚点。
          anchor ??= props.messages.find(message => typeof message.backendIndex === 'number' && message.backendIndex >= targetIndex)
            ?? props.messages.at(-1)
        }
        if (!anchor) return
        windowStart.value = resolveRestoredWindowStart(props.messages, visibleCount.value, {
          ...saved, anchorMessageId: anchor.id,
          anchorWindowOffset: Math.min(saved.anchorWindowOffset ?? 0, visibleCount.value - 1)
        })
      } else {
        // 仅兼容旧的本地 UI 快照；带稳定锚点的新快照不走裸 scrollTop 路径。
        windowStart.value = resolveRestoredWindowStart(props.messages, visibleCount.value, saved)
      }
      await nextTick()
      if (!isValid()) return
      const container = scrollbarRef.value?.getContainer()
      if (!container || container.clientHeight <= 0) {
        waitingForLayout = true
        return
      }
      if (saved.followingBottom) writeScrollTop(container, container.scrollHeight)
      else if (anchor) {
        await restoreTopAnchor(container, { messageId: anchor.id, offset: saved.anchorOffset ?? 0 }, generation, isValid)
        if (isValid() && saved.followingBottom === false) scrollbarRef.value?.pauseBottomFollow()
      } else writeScrollTop(container, saved.scrollTop)
    } finally {
      attempt.running = false
      if (isValid() && !waitingForLayout && !chatStore.isLoading) pendingUiRestore = undefined
    }
  }

  function restoreUiState(tabId?: string) {
    cancelUiRestore()
    if (!tabId) return
    const generation = viewGeneration
    const saved = uiStateByTab.get(tabId)
    if (saved && (saved.conversationId === undefined || saved.conversationId === chatStore.currentConversationId)) {
      visibleCount.value = clampVisibleCount(saved.visibleCount)
      isBuildExpanded.value = saved.buildExpanded
      isTodoExpanded.value = saved.todoExpanded
      restoreNotice.value = saved.restoreNotice ?? null
      scrollbarRef.value?.pauseBottomFollow()
      pendingUiRestore = { tabId, generation, saved, controller: new AbortController(), running: false }
      void tryRestoreUiState()
      return
    }

    visibleCount.value = VISIBLE_INCREMENT
    anchorToTail()
    needsScrollToBottom.value = true
    restoreTodoExpandedState()
    nextTick(() => {
      if (isCurrentView(generation)) tryScrollToBottom()
    })
  }

  // ResizeObserver 引用
  let resizeObserver: ResizeObserver | null = null

  watch([() => props.tabId, () => chatStore.currentConversationId], ([newTabId], [oldTabId]) => {
    if (oldTabId) {
      saveCurrentUiState(oldTabId)
      const activeIds = collectActiveBackgroundTaskMessageIds()
      pruneBackgroundTaskViewModes(activeIds)
      pruneThoughtViewModes(activeIds)
      pruneMediumTrimmedByMessageId(activeIds)
    }
    restoreUiState(newTabId)
  }, { immediate: true })

  // 切回后的权威刷新完成，再对齐锚点；窗口被裁剪/替换时才读取锚点所在页。
  watch([() => chatStore.isLoading, () => chatStore.isLoadingMoreMessages], () => { void tryRestoreUiState() })

  watch(() => chatStore.currentConversationId, newId => {
    void refreshMessageMarkers(newId)
  }, { immediate: true })

  // 新消息和删除会改变全局楼层；等当前回合结束后再刷新一次，避免流式期间反复全量扫描。
  let markerRefreshTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [() => chatStore.currentConversationId, () => chatStore.totalMessages,
      () => chatStore.isStreaming, () => chatStore.isWaitingForResponse],
    ([conversationId, total, streaming, waiting]) => {
      if (markerRefreshTimer) clearTimeout(markerRefreshTimer)
      markerRefreshTimer = null
      if (!conversationId || streaming || waiting || globalFloorIndices.value === null || total === markerTotal.value) return
      markerRefreshTimer = setTimeout(() => {
        markerRefreshTimer = null
        if (chatStore.currentConversationId === conversationId && !chatStore.isStreaming && !chatStore.isWaitingForResponse
          && chatStore.totalMessages !== markerTotal.value) void refreshMessageMarkers(conversationId)
      }, 150)
    }
  )

  watch(
    [() => chatStore.currentConversationId, () => props.messages.length, () => messageMarkers.value.length,
      () => chatStore.isLoadingMoreMessages, () => peekMessageJump(chatStore.currentConversationId)],
    () => { void consumePendingMessageJump() },
    { immediate: true }
  )

  // 监听消息变化，当消息加载完成时尝试滚动
  watch(() => props.messages, (newMessages) => {
    // 当消息加载完成时，尝试滚动
    // 如果容器还没有尺寸（display: none），ResizeObserver 会在可见时触发
    if (needsScrollToBottom.value && newMessages.length > 0) {
      // 先贴尾：保证滚动目标是「最新消息窗口」，而不是可能被上翻滑窗裁掉的旧窗口
      anchorToTail()
      tryScrollToBottom()
    }
  }, { deep: false })

  // 只监听结构身份，不随每个文本 chunk 重扫窗口。渲染窗口包含尾部不等于用户正在贴底。
  let previousMessages = props.messages
  watch([() => props.messages[0]?.id, () => props.messages.length, () => props.messages.at(-1)?.id], () => {
    const previous = previousMessages
    previousMessages = props.messages
    if (pendingUiRestore || isLoadingMore.value || isShiftingWindow.value) return
    const previousStart = Math.min(windowStart.value, Math.max(0, previous.length - visibleCount.value))
    const following = scrollbarRef.value?.isFollowingBottom()
    if (needsScrollToBottom.value || (following && previousStart + visibleCount.value >= previous.length)) {
      anchorToTail()
    } else {
      const firstId = previous[previousStart]?.id
      const nextStart = props.messages.findIndex(message => message.id === firstId)
      if (nextStart >= 0) windowStart.value = nextStart
    }
  })

  // 尝试滚动到底部（会检查容器是否准备好）
  function tryScrollToBottom() {
    if (!scrollbarRef.value) return

    const container = scrollbarRef.value.getContainer()
    if (!container) return

    // 检查容器是否有尺寸（可见状态）
    if (container.scrollHeight > 0 && container.clientHeight > 0) {
      if (needsScrollToBottom.value) {
        needsScrollToBottom.value = false
        writeScrollTop(container, container.scrollHeight)
      }
    }
    // 如果容器还没有尺寸，ResizeObserver 会在可见时触发
  }

  // 设置 ResizeObserver 监听容器尺寸变化
  onMounted(() => {
    window.addEventListener('message', handleExternalMessageJump)
    // 使用 nextTick 确保 scrollbarRef 已经绑定
    nextTick(() => {
      if (disposed || !scrollbarRef.value) return

      const container = scrollbarRef.value.getContainer()
      if (!container) return

      // 添加滚动事件监听以支持自动加载
      viewportHeight.value = container.clientHeight
      lastScrollTop = container.scrollTop
      container.addEventListener('scroll', handleScroll, { passive: true })
      container.addEventListener('wheel', handleWheel, { passive: true })
      const scrollWrapper = container.parentElement ?? container
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
        scrollWrapper.addEventListener(type, handleRestoreInput, { capture: true, passive: true })
      }

      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { height } = entry.contentRect
          if (height > 0) {
            viewportHeight.value = height
          }

          // 当容器从 0 高度变为有高度时，尝试滚动
          if (height > 0 && needsScrollToBottom.value) {
            // 使用 requestAnimationFrame 确保布局完成
            requestAnimationFrame(() => {
              tryScrollToBottom()
            })
          }

          // 容器尺寸就绪后检查：内容不满一屏时自动补载
          if (height > 0) {
            // 使用 requestAnimationFrame 确保布局完成
            requestAnimationFrame(() => {
              void tryRestoreUiState()
              maybeAutoLoadMore()
            })
          }
        }
      })

      resizeObserver.observe(container)
    })
  })

  // 清理监听器
  onBeforeUnmount(() => {
    saveCurrentUiState(renderedWindow.tabId)
    cancelUiRestore()
    disposed = true
    viewGeneration++
    markerRequestEpoch++
    if (markerRefreshTimer) clearTimeout(markerRefreshTimer)
    window.removeEventListener('message', handleExternalMessageJump)
    if (scrollbarRef.value) {
      const container = scrollbarRef.value.getContainer()
      if (container) {
        container.removeEventListener('scroll', handleScroll)
        container.removeEventListener('wheel', handleWheel)
        const scrollWrapper = container.parentElement ?? container
        for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
          scrollWrapper.removeEventListener(type, handleRestoreInput, true)
        }
      }
    }

    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }

    // A-M2：消息列表卸载后不再有 diff 面板消费方，主动释放模块级行级差分缓存
    clearLineDiffCache()
  })

  return {
    scrollbarRef,
    hasMore,
    isLoadingMore,
    loadMore,
    jumpToMessage,
    handleVirtualSeek,
    virtualTotalMessages,
    virtualWindowStart,
    virtualWindowEnd,
    messageMarkers: allMessageMarkers,
    messageRenderRows,
    checkpointFloorByCheckpointId
  }
}
