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

import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
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
  computeMessageFloorMap,
  computeCheckpointFloorMap
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
  const messageMarkerCache = new Map<string, { total: number; markers: MessageMarker[]; loadedAt: number }>()
  let markerConversationId: string | null = null

  const virtualTotalMessages = computed(() => Math.max(
    markerTotal.value,
    Number(chatStore.totalMessages) || 0,
    Math.max(0, Number(chatStore.windowStartIndex) || 0) + messageCount.value
  ))
  const virtualWindowStart = computed(() => {
    const first = props.messages[safeWindowStart.value]
    return typeof first?.backendIndex === 'number'
      ? first.backendIndex
      : Math.max(0, Number(chatStore.windowStartIndex) || 0) + safeWindowStart.value
  })
  const virtualWindowEnd = computed(() => {
    const last = props.messages[Math.max(safeWindowStart.value, windowEnd.value - 1)]
    const fallback = Math.max(virtualWindowStart.value, (Number(chatStore.windowStartIndex) || 0) + windowEnd.value)
    return typeof last?.backendIndex === 'number' ? Math.max(virtualWindowStart.value, last.backendIndex + 1) : fallback
  })
  const allMessageMarkers = computed<MessageMarker[]>(() => {
    const byIndex = new Map<number, MessageMarker>()
    for (const marker of messageMarkers.value) byIndex.set(marker.index, marker)
    for (const message of props.messages) {
      if (message.role !== 'user' || typeof message.backendIndex !== 'number') continue
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
    messageMarkers.value = []
    markerTotal.value = 0
    markerConversationId = conversationId
    if (!conversationId) return
    const cached = messageMarkerCache.get(conversationId)
    if (cached && Date.now() - cached.loadedAt < 60_000) {
      messageMarkers.value = cached.markers
      markerTotal.value = cached.total
      return
    }
    try {
      const result = await sendToExtension<{ total?: number; markers?: MessageMarker[] }>(MESSAGE_NAMES['conversation.getMessageMarkers'], {
        conversationId
      })
      if (markerConversationId !== conversationId || chatStore.currentConversationId !== conversationId) return
      messageMarkers.value = Array.isArray(result?.markers)
        ? result.markers.filter(marker => Number.isFinite(marker.index) && marker.index >= 0)
        : []
      markerTotal.value = Number.isFinite(result?.total) ? Math.max(0, Number(result.total)) : 0
      messageMarkerCache.set(conversationId, {
        total: markerTotal.value,
        markers: messageMarkers.value,
        loadedAt: Date.now()
      })
    } catch (error) {
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

  // 楼层号映射：按对话消息顺序对 user/assistant 消息编号（总结消息也是 user role，计入）。
  // 基于全部已加载消息（props.messages）计算，窗口内渲染行直接按 message.id 取值。
  const floorByMessageId = computed(() => computeMessageFloorMap(props.messages))

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
    | { kind: 'message'; key: string; item: EnhancedMessage }
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
        const message = enhancedVisibleMessages.value[i]
        return { messageId: message?.message?.id ?? null, offset: rect.top - containerRect.top }
      }
    }
    return { messageId: null, offset: 0 }
  }

  // 用锚点恢复视口位置（兼容顶部新增与底部裁剪；锚点已不在窗口内时保持浏览器默认钳制）
  async function restoreTopAnchor(container: HTMLElement, anchor: { messageId: string | null; offset: number }) {
    await nextTick()
    if (!anchor.messageId) return
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const index = enhancedVisibleMessages.value.findIndex(m => m.message.id === anchor.messageId)
    if (index === -1 || index >= elements.length) return
    const el = elements[index]
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    // 锚点消息在内容中的绝对偏移（与 CustomScrollbar marker 计算同源：rect + scrollTop）
    const contentOffset = elRect.top - containerRect.top + container.scrollTop
    container.scrollTop = Math.max(0, contentOffset - anchor.offset)
  }

  /** 加载并定位到全局消息索引或稳定消息 ID。索引为后端历史 0-based 下标。 */
  async function jumpToMessage(target: MessageJumpTarget): Promise<boolean> {
    const conversationId = chatStore.currentConversationId
    if (!conversationId || target.conversationId && target.conversationId !== conversationId) return false

    let targetIndex = typeof target.index === 'number' ? target.index : target.messageIndex
    const targetId = target.id || target.messageId
    if (targetId) {
      const loaded = props.messages.find(message => message.id === targetId)
      targetIndex = loaded?.backendIndex
      if (!Number.isFinite(targetIndex)) {
        const position = await sendToExtension<{ index?: number }>(MESSAGE_NAMES['conversation.getMessagePosition'], {
          conversationId, messageId: targetId
        })
        if (chatStore.currentConversationId !== conversationId) return false
        targetIndex = position?.index
      }
    }
    if (!Number.isFinite(targetIndex) || (targetIndex as number) < 0) return false
    targetIndex = Math.floor(targetIndex as number)

    const matchesTarget = (message: Message) => targetId ? message.id === targetId : message.backendIndex === targetIndex
    const targetAlreadyLoaded = props.messages.some(matchesTarget)
    if (!targetAlreadyLoaded) {
      const loaded = await chatStore.loadMessagesAroundIndex(targetIndex)
      if (!loaded || chatStore.currentConversationId !== conversationId) return false
    }

    const localIndex = props.messages.findIndex(matchesTarget)
    if (localIndex < 0) return false

    visibleCount.value = clampVisibleCount(Math.max(visibleCount.value, Math.min(MAX_RENDERED_ROWS, props.messages.length)))
    windowStart.value = Math.max(0, Math.min(
      Math.max(0, props.messages.length - Math.min(visibleCount.value, props.messages.length)),
      localIndex - Math.floor(Math.max(1, viewportHeight.value / ESTIMATED_MESSAGE_ROW_HEIGHT) / 2)
    ))
    await nextTick()

    const container = scrollbarRef.value?.getContainer() as HTMLElement | null | undefined
    if (!container) return false
    const elements = container.querySelectorAll<HTMLElement>('.message-item, .summary-message')
    const targetElement = Array.from(elements).find(element =>
      element.getAttribute('data-message-id') === (targetId || props.messages[localIndex]?.id)
    )
    if (!targetElement) return false
    const containerRect = container.getBoundingClientRect()
    const targetRect = targetElement.getBoundingClientRect()
    container.scrollTop = Math.max(0, targetRect.top - containerRect.top + container.scrollTop - container.clientHeight * 0.35)
    return true
  }

  async function handleVirtualSeek(index: number): Promise<void> {
    await jumpToMessage({ index })
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
    } finally { consumingMessageJump = false }
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
    if (isShiftingWindow.value || windowEnd.value >= props.messages.length) return
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

    isShiftingWindow.value = true
    try {
      windowStart.value = advanceMessageWindowStart(
        previousStart,
        windowSize.value,
        props.messages.length,
        step
      )
      await restoreTopAnchor(container, anchor)
    } finally {
      isShiftingWindow.value = false
    }
  }

  // 加载更多历史消息（先展示已加载的，再按需从后端拉更早一页）
  async function loadMore() {
    if (isLoadingMore.value || !hasMore.value) return
    if (!scrollbarRef.value) return
    const container = scrollbarRef.value.getContainer()
    if (!container) return

    // 固化发起时的标签页与会话身份
    const originTabId = props.tabId
    const originConversationId = chatStore.currentConversationId

    isLoadingMore.value = true
    const anchor = captureTopAnchor(container)

    // 固化发起时的窗口状态，供加载完成后重定位窗口使用
    const prevLen = props.messages.length
    const prevStart = safeWindowStart.value
    const needBackendLoad = hasMoreHistory.value
    const needFrontendExpand = prevStart > 0

    try {
      // 如果后端还有更多消息，先拉取（prepend 会整体右移消息数组）
      if (needBackendLoad) {
        await nextTick()

        await chatStore.loadOlderMessagesPage()
        await nextTick()

        // 校验归属：await 期间可能已切换标签页或对话
        if (props.tabId !== originTabId || chatStore.currentConversationId !== originConversationId) return

        if (props.messages.length <= prevLen) {
          // 如果这一页没有新增可见消息，继续尝试下一页
          // 连续空页上限：后端返回 loaded=true 但无新增（空页）时停止，避免死循环
          let emptyPages = 0
          while (
            hasMoreHistory.value &&
            props.tabId === originTabId &&
            chatStore.currentConversationId === originConversationId &&
            emptyPages < MAX_EMPTY_LOAD_PAGES
          ) {
            const currentLen = props.messages.length
            const loaded = await chatStore.loadOlderMessagesPage()
            await nextTick()

            if (props.tabId !== originTabId || chatStore.currentConversationId !== originConversationId) break

            if (!loaded || props.messages.length > currentLen) {
              break
            }
            emptyPages++
          }
        }
      }

      // 加载完成后增长窗口或向上滑动窗口，并保持顶部阅读锚点。
      // 达到上限后 clampVisibleCount 会裁掉底部等量最新行。
      const added = props.messages.length - prevLen
      const frontendStep = needFrontendExpand ? VISIBLE_INCREMENT : 0

      visibleCount.value = clampVisibleCount(visibleCount.value + frontendStep + added)
      // 当前操作由顶部触发，直接贴尾会把阅读锚点移出窗口。
      windowStart.value = Math.max(0, prevStart - frontendStep)
    } catch (error) {
      // 拉取失败：记录日志，加载标记在 finally 中复位
      console.error('[MessageList] Failed to load older messages:', error)
    } finally {
      // 无条件复位加载标记，避免切走标签页后该标签页上拉加载永久禁用（H4）
      isLoadingMore.value = false
      // 仅当标签页与会话都未切换时才修正滚动位置（锚点法，兼容顶部新增 + 底部裁剪）
      if (props.tabId === originTabId && chatStore.currentConversationId === originConversationId) {
        await restoreTopAnchor(container, anchor)
      }
      // 内容仍不满一屏且还有更多时继续自动补载（覆盖初始挂载/首屏不满的场景）
      maybeAutoLoadMore()
    }
  }

  // 内容不满一屏时自动补载：覆盖初始挂载（容器尺寸就绪但内容不足一屏）的场景，
  // 避免顶部加载指示器可见却永远不触发加载。内部有 hasMore / isLoadingMore 防护，
  // 会在内容填满一屏或没有更多消息时自然收敛。
  function maybeAutoLoadMore() {
    if (isLoadingMore.value || !hasMore.value) return
    // 仅在窗口贴尾时自动补载：避免用户上翻历史（窗口未贴尾）时被自动向上滑窗
    if (windowEnd.value < props.messages.length) return
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    if (container.scrollHeight <= container.clientHeight + 1) {
      void loadMore()
    }
  }

  // 滚动事件处理：实现自动加载与滑窗贴尾
  function handleScroll(e: Event) {
    const container = e.target as HTMLElement
    if (!container) return
    if (viewportHeight.value !== container.clientHeight) {
      viewportHeight.value = container.clientHeight
    }

    // 顶部阈值：自动加载更早历史（沿用原 100px 判定）
    if (hasMore.value && !isLoadingMore.value && isNearRenderedWindowTop(container)) {
      void loadMore()
      return
    }

    // 窗口底部：只向后移动一个步长，继续展示已加载的中间历史。
    // 只有窗口已经覆盖 props.messages 尾部时，才由 CustomScrollbar 负责贴底跟随。
    if (!isShiftingWindow.value && windowEnd.value < props.messages.length && isNearRenderedWindowBottom(container)) {
      void advanceWindow()
    }
  }

  // CustomScrollbar 引用
  const scrollbarRef = ref<InstanceType<typeof CustomScrollbar> | null>(null)

  // 标记是否需要滚动到底部（切换对话时设置）
  const needsScrollToBottom = ref(false)
  const suppressConversationReset = ref(false)

  // 使用模块级 Map（H5）：组件卸载后滚动位置/展开状态不丢失
  const uiStateByTab = messageListUiStateByTab

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
    const container = scrollbarRef.value?.getContainer()
    const anchor = container ? captureTopAnchor(container) : { messageId: null, offset: 0 }
    const anchorWindowOffset = anchor.messageId
      ? enhancedVisibleMessages.value.findIndex(item => item.message.id === anchor.messageId)
      : -1
    uiStateByTab.set(tabId, {
      scrollTop: container?.scrollTop || 0,
      visibleCount: visibleCount.value,
      windowStart: safeWindowStart.value,
      anchorMessageId: anchor.messageId,
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

  function restoreUiState(tabId?: string) {
    if (!tabId) return
    const saved = uiStateByTab.get(tabId)
    if (saved) {
      visibleCount.value = clampVisibleCount(saved.visibleCount)
      windowStart.value = resolveRestoredWindowStart(props.messages, visibleCount.value, saved)
      isBuildExpanded.value = saved.buildExpanded
      isTodoExpanded.value = saved.todoExpanded
      restoreNotice.value = saved.restoreNotice ?? null
      needsScrollToBottom.value = false
      nextTick(async () => {
        const container = scrollbarRef.value?.getContainer()
        if (container) {
          if (saved.anchorMessageId) {
            await restoreTopAnchor(container, {
              messageId: saved.anchorMessageId,
              offset: saved.anchorOffset ?? 0
            })
          } else {
            container.scrollTop = saved.scrollTop
          }
        }
        suppressConversationReset.value = false
      })
      return
    }

    visibleCount.value = VISIBLE_INCREMENT
    anchorToTail()
    needsScrollToBottom.value = true
    restoreTodoExpandedState()
    nextTick(() => {
      tryScrollToBottom({ instant: true })
      suppressConversationReset.value = false
    })
  }

  // ResizeObserver 引用
  let resizeObserver: ResizeObserver | null = null

  watch(() => props.tabId, (newTabId, oldTabId) => {
    suppressConversationReset.value = true
    if (oldTabId && oldTabId !== newTabId) {
      saveCurrentUiState(oldTabId)
      // M1-1：对话/标签页切换时清理已不存在的消息视图模式（非渲染热路径，仅切换时执行）
      const activeIds = collectActiveBackgroundTaskMessageIds()
      pruneBackgroundTaskViewModes(activeIds)
      pruneThoughtViewModes(activeIds)
      pruneMediumTrimmedByMessageId(activeIds)
    }
    restoreUiState(newTabId)
  }, { immediate: true })

  // 监听对话切换：当前活跃标签页内加载新对话时，重置分页并滚动到底部
  watch(() => chatStore.currentConversationId, (newId, oldId) => {
    if (suppressConversationReset.value) return
    if (newId === oldId) return

    // 重置分页计数（新对话从最后一页开始显示）
    visibleCount.value = VISIBLE_INCREMENT
    // 重置窗口到贴尾（消息尚未到达时由 messages.length watcher 兜底）
    anchorToTail()
    // 标记需要滚动到底部
    needsScrollToBottom.value = true
    nextTick(() => tryScrollToBottom({ instant: true }))
  })

  watch(() => chatStore.currentConversationId, newId => {
    void refreshMessageMarkers(newId)
  }, { immediate: true })

  watch(
    [() => chatStore.currentConversationId, () => props.messages.length, () => messageMarkers.value.length,
      () => chatStore.isLoadingMoreMessages],
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
      tryScrollToBottom({ instant: true })
    }
  }, { deep: false })

  // 监听可见消息长度变化：窗口贴尾时跟随新增消息继续贴尾（流式新增不丢最新消息）；
  // 上翻历史（窗口未贴尾）时保持窗口不动，避免打断阅读位置。
  watch(() => props.messages.length, (_newLen, oldLen) => {
    if (needsScrollToBottom.value || windowEnd.value >= oldLen) {
      anchorToTail()
    }
  })

  // 尝试滚动到底部（会检查容器是否准备好）
  function tryScrollToBottom(options?: { instant?: boolean }) {
    if (!scrollbarRef.value) return

    const container = scrollbarRef.value.getContainer()
    if (!container) return

    // 检查容器是否有尺寸（可见状态）
    if (container.scrollHeight > 0 && container.clientHeight > 0) {
      if (needsScrollToBottom.value) {
        needsScrollToBottom.value = false
        scrollbarRef.value.scrollToBottom(options?.instant ? { instant: true } : undefined)
      }
    }
    // 如果容器还没有尺寸，ResizeObserver 会在可见时触发
  }

  // 设置 ResizeObserver 监听容器尺寸变化
  onMounted(() => {
    window.addEventListener('message', handleExternalMessageJump)
    // 使用 nextTick 确保 scrollbarRef 已经绑定
    nextTick(() => {
      if (!scrollbarRef.value) return

      const container = scrollbarRef.value.getContainer()
      if (!container) return

      // 添加滚动事件监听以支持自动加载
      viewportHeight.value = container.clientHeight
      container.addEventListener('scroll', handleScroll, { passive: true })

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
              tryScrollToBottom({ instant: true })
            })
          }

          // 容器尺寸就绪后检查：内容不满一屏时自动补载
          if (height > 0) {
            // 使用 requestAnimationFrame 确保布局完成
            requestAnimationFrame(() => {
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
    window.removeEventListener('message', handleExternalMessageJump)
    if (scrollbarRef.value) {
      const container = scrollbarRef.value.getContainer()
      if (container) {
        container.removeEventListener('scroll', handleScroll)
      }
    }

    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    saveCurrentUiState(props.tabId)

    // A-M2：消息列表卸载后不再有 diff 面板消费方，主动释放模块级行级差分缓存
    clearLineDiffCache()
  })

  return {
    scrollbarRef,
    hasMore,
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
