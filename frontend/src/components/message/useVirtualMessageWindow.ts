/**
 * useVirtualMessageWindow - 消息列表虚拟窗口 / 滚动 / UI 状态保存恢复
 *
 * 从 MessageList.vue 拆分（S4 批次），纯重构不改行为：
 * - visibleCount / hasMore / loadMore（先前端展开、再按需后端拉取，含连续空页上限与滚动位置保持）
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
import { pruneMediumTrimmedByMessageId } from './mediumTrimState'
import { pruneBackgroundTaskViewModes, pruneThoughtViewModes } from './messageViewModes'
import { messageListUiStateByTab, MESSAGE_LIST_UI_STATE_CAP, type RestoreNoticeState } from './messageListUiState'
import { resolveLoadedVisibleMessages } from './messageListUtils'
import { clearLineDiffCache } from '../../utils/lineDiff'
import type { Message, CheckpointRecord } from '../../types'

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
  const visibleCount = ref(VISIBLE_INCREMENT)

  // 是否还有更多“未加载到窗口”的历史消息
  const hasMoreHistory = computed(() => chatStore.windowStartIndex > 0)
  // 顶部加载指示器：后端有更多消息 或 前端还有已加载但未渲染的消息
  const hasMore = computed(() => hasMoreHistory.value || visibleCount.value < props.messages.length)

  // 上翻历史滑动窗口（loadOlderMessagesPage 底部裁剪）后，窗口末尾与真实最新消息之间存在缺口：
  // 展示底部「回到最新」入口，点击重载最后一页并滚动到底部（被裁剪的最新消息恢复可见）。
  const hasNewerMessages = computed(() =>
    chatStore.windowStartIndex + chatStore.allMessages.length < chatStore.totalMessages
  )

  // 回到最新：重载最后一页（窗口末尾重新对齐真实最新），再滚动到底部
  async function scrollToNewest() {
    await chatStore.loadHistory()
    needsScrollToBottom.value = true
    nextTick(() => tryScrollToBottom({ instant: true }))
  }

  // 增强的消息对象接口
  interface EnhancedMessage {
    message: Message
    backendIndex: number
    beforeCheckpoints: CheckpointRecord[]
    afterCheckpoints: CheckpointRecord[]
  }

  const enhancedVisibleMessages = computed<EnhancedMessage[]>(() => {
    const visibleMessages = resolveLoadedVisibleMessages(props.messages, visibleCount.value)

    // 预先按消息索引对检查点进行分组
    return visibleMessages.map(message => {
      const backendIndex = typeof message.backendIndex === 'number' ? message.backendIndex : -1
      const cpGroup = backendIndex !== -1 ? checkpointsByMsgIndex.value.get(backendIndex) : null

      return {
        message,
        backendIndex,
        beforeCheckpoints: cpGroup?.before || [],
        afterCheckpoints: cpGroup?.after || []
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

  // 是否正在加载更多（用于节流）
  const viewportHeight = ref(0)

  const isLoadingMore = ref(false)

  // 加载更多历史消息（先展示已加载的，再按需从后端拉更早一页）
  async function loadMore() {
    if (isLoadingMore.value || !hasMore.value) return
    if (!scrollbarRef.value) return
    const container = scrollbarRef.value.getContainer()
    if (!container) return

    // 固化发起时的标签页与会话身份
    const originTabId = props.tabId

    isLoadingMore.value = true
    const oldScrollHeight = container.scrollHeight
    const oldScrollTop = container.scrollTop

    try {
      const needBackendLoad = hasMoreHistory.value
      const needFrontendExpand = visibleCount.value < props.messages.length

      // 优先展开前端已加载但未渲染的消息
      if (needFrontendExpand) {
        visibleCount.value += VISIBLE_INCREMENT
      }

      // 如果后端还有更多消息，再拉取
      if (needBackendLoad) {
        const prevLen = props.messages.length
        await nextTick()

        await chatStore.loadOlderMessagesPage()
        await nextTick()

        // 校验归属：await 期间可能已切换标签页或对话
        if (props.tabId !== originTabId) return

        if (props.messages.length <= prevLen) {
          // 如果这一页没有新增可见消息，继续尝试下一页
          // 连续空页上限：后端返回 loaded=true 但无新增（空页）时停止，避免死循环
          let emptyPages = 0
          while (hasMoreHistory.value && props.tabId === originTabId && emptyPages < MAX_EMPTY_LOAD_PAGES) {
            const currentLen = props.messages.length
            const loaded = await chatStore.loadOlderMessagesPage()
            await nextTick()

            if (props.tabId !== originTabId) break

            if (!loaded || props.messages.length > currentLen) {
              break
            }
            emptyPages++
          }
        }
      }
    } catch (error) {
      // 拉取失败：记录日志，加载标记在 finally 中复位
      console.error('[MessageList] Failed to load older messages:', error)
    } finally {
      // 无条件复位加载标记，避免切走标签页后该标签页上拉加载永久禁用（H4）
      isLoadingMore.value = false
      // 仅当标签页未切换时才修正滚动位置
      if (props.tabId === originTabId) {
        const newScrollHeight = container.scrollHeight
        container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)
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
    const container = scrollbarRef.value?.getContainer()
    if (!container) return
    if (container.scrollHeight <= container.clientHeight + 1) {
      void loadMore()
    }
  }

  // 滚动事件处理：实现自动加载
  function handleScroll(e: Event) {
    const container = e.target as HTMLElement
    if (!container) return
    if (viewportHeight.value !== container.clientHeight) {
      viewportHeight.value = container.clientHeight
    }

    // 当滚动到距离顶部 100px 以内时自动加载
    if (hasMore.value && !isLoadingMore.value && container.scrollTop < 100) {
      loadMore()
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
    uiStateByTab.set(tabId, {
      scrollTop: container?.scrollTop || 0,
      visibleCount: visibleCount.value,
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
      visibleCount.value = saved.visibleCount
      isBuildExpanded.value = saved.buildExpanded
      isTodoExpanded.value = saved.todoExpanded
      restoreNotice.value = saved.restoreNotice ?? null
      needsScrollToBottom.value = false
      nextTick(() => {
        const container = scrollbarRef.value?.getContainer()
        if (container) {
          container.scrollTop = saved.scrollTop
        }
        suppressConversationReset.value = false
      })
      return
    }

    visibleCount.value = VISIBLE_INCREMENT
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
    // 标记需要滚动到底部
    needsScrollToBottom.value = true
    nextTick(() => tryScrollToBottom({ instant: true }))
  })

  // 监听消息变化，当消息加载完成时尝试滚动
  watch(() => props.messages, (newMessages) => {
    // 当消息加载完成时，尝试滚动
    // 如果容器还没有尺寸（display: none），ResizeObserver 会在可见时触发
    if (needsScrollToBottom.value && newMessages.length > 0) {
      tryScrollToBottom({ instant: true })
    }
  }, { deep: false })

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
    clearLineDiffCache()
  })

  return {
    scrollbarRef,
    hasMore,
    loadMore,
    messageRenderRows,
    hasNewerMessages,
    scrollToNewest
  }
}
