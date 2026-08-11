/**
 * Chat Store 标签页操作
 *
 * 管理多对话标签页的创建、切换、关闭和状态快照/恢复
 */

import type { ChatStoreState, ConversationSessionSnapshot, TabInfo } from './types'
import type { StreamChunk } from '../../types'
import type { StreamHandlerContext } from './streamHandler'
import { handleStreamChunk } from './streamHandler'
import { rebuildMessageIndexById } from './state'
import { clearPendingDirtyConfirm } from './dirtyConfirmState'
import { clearAllSmoothForState } from './streamChunkHandlers'
import { pruneMessageListUiStateByTab } from '../../components/message/messageListUiState'

/** 最大标签页数量 */
const MAX_TABS = 100

/** 每个后台会话缓冲区的最大 chunk 数量（防止长工具循环/长文本流无限累积） */
const MAX_BACKGROUND_BUFFER_CHUNKS = 2000

/** 生成标签页 ID */
function generateTabId(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 将当前活跃会话状态快照为一个 ConversationSessionSnapshot
 */
export function snapshotCurrentSession(state: ChatStoreState): ConversationSessionSnapshot {
  return {
    conversationId: state.currentConversationId.value,
    allMessages: [...state.allMessages.value],
    windowStartIndex: state.windowStartIndex.value,
    totalMessages: state.totalMessages.value,
    configId: state.configId.value,
    selectedModelId: state.selectedModelId.value,
    isLoadingMoreMessages: state.isLoadingMoreMessages.value,
    isStreaming: state.isStreaming.value,
    isLoading: state.isLoading.value,
    streamingMessageId: state.streamingMessageId.value,
    activeStreamId: state.activeStreamId.value,
    isWaitingForResponse: state.isWaitingForResponse.value,
    checkpoints: [...state.checkpoints.value],
    activeBuild: state.activeBuild.value ? { ...state.activeBuild.value } : null,
    error: state.error.value ? { ...state.error.value } : null,
    retryStatus: state.retryStatus.value ? { ...state.retryStatus.value } : null,
    autoSummaryStatus: state.autoSummaryStatus.value ? { ...state.autoSummaryStatus.value } : null,
    historyFolded: state.historyFolded.value,
    foldedMessageCount: state.foldedMessageCount.value,
    inputValue: state.inputValue.value,
    pendingModelOverride: state.pendingModelOverride.value,
    pendingConfigIdOverride: state.pendingConfigIdOverride.value,
    editorNodes: [...state.editorNodes.value],
    attachments: [...state.attachments.value],
    messageQueue: [...state.messageQueue.value],
    currentPromptModeId: state.currentPromptModeId.value,
    toolResponseCache: Array.from(state.toolResponseCache.value.entries()),
    pendingBranchRefreshAfterStream: state._pendingBranchRefreshAfterStream.value,
    pendingBranchReplayContext: state._pendingBranchReplayContext.value
      ? { ...state._pendingBranchReplayContext.value }
      : null,
    // TREE-12：分支图快照（null = 无图 / 线性模式）；图按整体替换维护（无原地修改），共享引用安全
    branchGraph: state.branchGraph.value
  }
}

/**
 * 从快照恢复会话状态到当前活跃 state
 */
export function restoreSessionFromSnapshot(
  state: ChatStoreState,
  snapshot: ConversationSessionSnapshot
): void {
  state.currentConversationId.value = snapshot.conversationId
  state.allMessages.value = [...snapshot.allMessages]
  rebuildMessageIndexById(state)
  state.windowStartIndex.value = snapshot.windowStartIndex
  state.totalMessages.value = snapshot.totalMessages
  state.configId.value = snapshot.configId
  state.selectedModelId.value = snapshot.selectedModelId
  state.isLoadingMoreMessages.value = snapshot.isLoadingMoreMessages
  state.isStreaming.value = snapshot.isStreaming
  state.isLoading.value = snapshot.isLoading
  state.streamingMessageId.value = snapshot.streamingMessageId
  state.activeStreamId.value = snapshot.activeStreamId ?? null
  state.isWaitingForResponse.value = snapshot.isWaitingForResponse
  state.checkpoints.value = [...snapshot.checkpoints]
  state.activeBuild.value = snapshot.activeBuild ? { ...snapshot.activeBuild } : null
  state.error.value = snapshot.error ? { ...snapshot.error } : null
  state.retryStatus.value = snapshot.retryStatus ? { ...snapshot.retryStatus } : null
  state.autoSummaryStatus.value = snapshot.autoSummaryStatus ? { ...snapshot.autoSummaryStatus } : null
  state.historyFolded.value = snapshot.historyFolded
  state.foldedMessageCount.value = snapshot.foldedMessageCount
  state.inputValue.value = snapshot.inputValue
  state.pendingModelOverride.value = snapshot.pendingModelOverride
  state.pendingConfigIdOverride.value = snapshot.pendingConfigIdOverride ?? null
  state.editorNodes.value = [...snapshot.editorNodes]
  state.attachments.value = [...snapshot.attachments]
  state.messageQueue.value = [...snapshot.messageQueue]
  state.currentPromptModeId.value = snapshot.currentPromptModeId
  // 恢复工具响应缓存快照；旧快照无此字段时回退空 Map
  state.toolResponseCache.value = Array.isArray(snapshot.toolResponseCache)
    ? new Map(snapshot.toolResponseCache)
    : new Map()
  state._pendingBranchRefreshAfterStream.value = snapshot.pendingBranchRefreshAfterStream ?? null
  state._pendingBranchReplayContext.value = snapshot.pendingBranchReplayContext
    ? { ...snapshot.pendingBranchReplayContext }
    : null
  // TREE-12：恢复分支图快照（切标签页回来恢复分支视图状态）；旧快照无此字段时回退 null
  state.branchGraph.value = snapshot.branchGraph ?? null
}

/**
 * 重置当前会话状态为空白
 */
export function resetConversationState(state: ChatStoreState): void {
  // H1：会话重置前清理所有平滑条目（销毁实例 + 删除显示文本），UI 切回真实 content
  clearAllSmoothForState(state)
  state.currentConversationId.value = null
  state.allMessages.value = []
  rebuildMessageIndexById(state)
  state.windowStartIndex.value = 0
  state.totalMessages.value = 0
  state.isLoadingMoreMessages.value = false
  state.toolResponseCache.value = new Map()
  state.isStreaming.value = false
  state.isLoading.value = false
  state.streamingMessageId.value = null
  state.activeStreamId.value = null
  state._lastCancelledStreamId.value = null
  state._pendingBranchRefreshAfterStream.value = null
  state._pendingBranchReplayContext.value = null
  state.isWaitingForResponse.value = false
  state.checkpoints.value = []
  state.activeBuild.value = null
  state.error.value = null
  state.retryStatus.value = null
  state.autoSummaryStatus.value = null
  state.historyFolded.value = false
  state.foldedMessageCount.value = 0
  state.inputValue.value = ''
  state.pendingModelOverride.value = null
  state.pendingConfigIdOverride.value = null
  state.selectedModelId.value = state.currentConfig.value?.model || ''
  state.editorNodes.value = []
  state.attachments.value = []
  state.messageQueue.value = []
  state.currentPromptModeId.value = 'code'
  // TREE-12：新空白会话无分支图（等待 loadBranchGraph 拉取）
  state.branchGraph.value = null
  // TREE-07：会话重置同时复位分支切换 / 分支图加载锁，避免残留 true 永久锁死切换器
  state.isSwitchingBranch.value = false
  state.branchGraphLoading.value = false
  // BCP-05：整会话重置（新建空白对话）时清空 dirty 确认，
  // 避免确认框残留到新对话并把续作动作发到错误会话（resetConversationState 为全量重置，无条件清空）
  clearPendingDirtyConfirm()
}

/**
 * 创建新标签页
 *
 * @returns 新标签页的 ID，如果超过上限则返回 null
 */
export function createTab(
  state: ChatStoreState,
  options?: {
    conversationId?: string | null
    title?: string
    switchTo?: boolean
  }
): string | null {
  // 检查上限
  if (state.openTabs.value.length >= MAX_TABS) {
    console.warn('[tabActions] 标签页数量已达上限', MAX_TABS)
    return null
  }

  const tabId = generateTabId()
  const convId = options?.conversationId ?? null

  // 如果目标对话已在某个标签页中打开，直接切换到那个标签页
  if (convId) {
    const existingTab = state.openTabs.value.find(t => t.conversationId === convId)
    if (existingTab) {
      return existingTab.id
    }
  }

  const tab: TabInfo = {
    id: tabId,
    conversationId: convId,
    title: options?.title || 'New Chat',
    isStreaming: false
  }

  state.openTabs.value = [...state.openTabs.value, tab]

  return tabId
}

/**
 * 关闭标签页
 *
 * 如果关闭的是当前激活的标签页，自动切换到相邻标签页
 */
export function closeTab(
  state: ChatStoreState,
  tabId: string,
  cancelStreamAndRejectTools: () => Promise<void>,
  streamHandlerCtx?: StreamHandlerContext,
  cancelStreamByConversationId?: (conversationId: string) => Promise<void>
): void {
  const tabs = state.openTabs.value
  const tabIndex = tabs.findIndex(t => t.id === tabId)
  if (tabIndex === -1) return

  const tab = tabs[tabIndex]

  // 清理该标签页的快照
  state.sessionSnapshots.value.delete(tabId)

  // 清理该标签页对话的流式缓冲区
  if (tab.conversationId) {
    state.backgroundStreamBuffers.value.delete(tab.conversationId)
    // 取消该会话仍在进行的流，避免后续 chunk 为已关闭会话重建缓冲区（M20）
    if (cancelStreamByConversationId) {
      cancelStreamByConversationId(tab.conversationId).catch(error => {
        console.error('[tabActions] Failed to cancel stream for closed tab:', error)
      })
    }
  }

  // 移除标签页
  const newTabs = tabs.filter(t => t.id !== tabId)
  state.openTabs.value = newTabs

  // M2-1：清理 MessageList 模块级 UI 状态（tabId 全局唯一不复用，每关一个标签页泄漏一条）。
  // 注意：必须在移除标签页后调用；MessageList 的 saveCurrentUiState 已带
  // 「已关闭标签页不保存」保护，避免关闭活跃标签页时 watcher 把旧记录写回。
  pruneMessageListUiStateByTab(new Set(newTabs.map(t => t.id)))

  // 如果关闭的是当前活跃标签页
  if (state.activeTabId.value === tabId) {
    // H1：关闭活跃标签页时，后端 cancelled 会被 bufferBackgroundChunk 丢弃、前端收不到终结
    // 事件——这里在切换前本地清理该会话的平滑显示层（真实内容已由后端持久化/取消保留）
    clearAllSmoothForState(state)
    if (newTabs.length > 0) {
      // 切换到相邻标签页（优先右边，否则左边）
      const nextIndex = Math.min(tabIndex, newTabs.length - 1)
      const nextTab = newTabs[nextIndex]
      switchTab(state, nextTab.id, cancelStreamAndRejectTools, streamHandlerCtx)
    } else {
      // 没有剩余标签页，创建一个新的
      const newTabId = createTab(state, { title: 'New Chat', switchTo: false })
      if (newTabId) {
        resetConversationState(state)
        state.activeTabId.value = newTabId
      }
    }
  }
}

/**
 * 切换到指定标签页
 *
 * 快照当前活跃标签页的状态 -> 恢复目标标签页状态 -> 应用缓冲的流式数据
 */
export function switchTab(
  state: ChatStoreState,
  targetTabId: string,
  _cancelStreamAndRejectTools: () => Promise<void>,
  streamHandlerCtx?: StreamHandlerContext
): void {
  const currentTabId = state.activeTabId.value
  if (currentTabId === targetTabId) return

  // H1：切换标签页前清理当前会话的平滑条目——切走后该会话的 chunk 进入后台缓冲，
  // 显示层实例不再被驱动；返回时由缓冲回放按真实文本基线重建（H3），不会跳变/残留。
  clearAllSmoothForState(state)

  // 确认目标标签页存在
  const targetTab = state.openTabs.value.find(t => t.id === targetTabId)
  if (!targetTab) return

  // BCP-05：切换标签页（离开当前会话）时按归属清空 dirty 确认，
  // 避免确认框在新会话弹出并把续作动作发到错误会话（先确认目标标签页存在）
  clearPendingDirtyConfirm(state.currentConversationId.value)

  // 1. 快照当前活跃标签页的状态
  if (currentTabId) {
    // 更新当前标签页的 conversationId（可能已通过发送消息创建了新对话）
    const currentTab = state.openTabs.value.find(t => t.id === currentTabId)
    if (currentTab) {
      currentTab.conversationId = state.currentConversationId.value
      currentTab.isStreaming = state.isStreaming.value
      // 更新标题
      const conv = state.conversations.value.find(c => c.id === state.currentConversationId.value)
      if (conv) {
        currentTab.title = conv.title
      }

      // 仅当标签页仍存在时才快照：closeTab 关闭活跃标签页后（快照已删、tab 已移除）
      // 会调用 switchTab 切到相邻标签页，此时 currentTab 已不在 openTabs——无条件快照
      // 会把整个会话状态（allMessages/messageQueue 等）重新塞进 sessionSnapshots 成为
      // 永不被清理的孤儿快照（内存泄漏）。
      const snapshot = snapshotCurrentSession(state)
      state.sessionSnapshots.value.set(currentTabId, snapshot)
    }
  }

  // 2. 恢复目标标签页状态
  const targetSnapshot = state.sessionSnapshots.value.get(targetTabId)
  if (targetSnapshot) {
    restoreSessionFromSnapshot(state, targetSnapshot)
    state.sessionSnapshots.value.delete(targetTabId)
    // P1-兜底复位 isLoading / isLoadingMoreMessages：快照可能保存于会话加载中途
    // （空消息 + isLoading=true / 上拉加载中 isLoadingMoreMessages=true），
    // 且原加载的 finally 在会话已切换时跳过复位（见 switchConversation 的
    // validateSessionIdentity 守卫），切回后会出现空白会话 + loading 卡死，
    // 或 isLoadingMoreMessages 永久为 true 导致上拉加载被拦截 + spinner 卡死。
    // 恢复时强制复位：若加载仍在进行，其 finally 完成后会再次复位（幂等），无副作用。
    state.isLoading.value = false
    state.isLoadingMoreMessages.value = false
  } else {
    // 新标签页 - 重置为空白状态
    resetConversationState(state)
    // 如果标签页关联了 conversationId 但没有快照，这意味着尚未加载：
    // 这里只绑定会话 id，历史加载由调用方统一完成（openConversationInTab /
    // branchFromMessage 在 switchTab 后 await switchConvAction 做权威加载），
    // 避免同一会话被并发加载两次（loadHistory 与 switchConvAction 竞态）
    if (targetTab.conversationId) {
      state.currentConversationId.value = targetTab.conversationId
    }
  }

  // 3. 应用缓冲的后台流式数据
  const convId = state.currentConversationId.value
  if (convId && streamHandlerCtx && state.backgroundStreamBuffers.value.has(convId)) {
    const buffered = state.backgroundStreamBuffers.value.get(convId)!
    state.backgroundStreamBuffers.value.delete(convId)
    for (const chunk of buffered) {
      handleStreamChunk(chunk, streamHandlerCtx)
    }
  }

  // 4. 更新激活标签页 ID
  state.activeTabId.value = targetTabId
}

/**
 * 将流式 chunk 缓冲到后台对话的缓冲区
 */
export function bufferBackgroundChunk(
  state: ChatStoreState,
  chunk: StreamChunk
): void {
  const convId = chunk.conversationId
  if (!convId) return

  const buffers = state.backgroundStreamBuffers.value
  if (!buffers.has(convId)) {
    buffers.set(convId, [])
  }

  // 同时更新对应快照中的流式状态
  // 找到该 conversationId 对应的标签页
  const tab = state.openTabs.value.find(t => t.conversationId === convId)
  if (!tab) {
    // 会话已不在任何打开的标签页（如标签页已关闭）：丢弃缓冲，不重建
    buffers.delete(convId)
    return
  }

  const snapshot = state.sessionSnapshots.value.get(tab.id)

  // 总结类 chunk 例外（与 handleStreamChunk 门禁一致）：总结请求使用独立 abort 信号，
  // 主流结束后在途总结的完成事件仍会到达——此时按 streamId 过滤会漏掉总结消息与标记，
  // 而用户停留在其它标签页正是总结完成后才启动的常见场景（缓冲路径的本职）。
  const isSummaryType = chunk.type === 'autoSummary' || chunk.type === 'autoSummaryStatus'

  // 若快照已绑定 activeStreamId，则过滤掉旧流的迟到 chunk
  if (
    !isSummaryType &&
    snapshot?.activeStreamId &&
    chunk.streamId &&
    chunk.streamId !== snapshot.activeStreamId
  ) {
    return
  }

  // 快照当前并不处于等待/流式阶段时，收到带 streamId 的 chunk 视为迟到包，直接忽略。
  if (
    !isSummaryType &&
    snapshot &&
    !snapshot.activeStreamId &&
    chunk.streamId &&
    !snapshot.isWaitingForResponse &&
    !snapshot.isStreaming
  ) {
    return
  }

  // 快照尚未绑定时，首次收到带 streamId 的 chunk 即建立绑定。
  // 总结 chunk 不参与绑定：其 streamId 属于总结请求（与主流不同），绑定会把后续
  // 主流 chunk 全部误滤（tabActions 下游与回放路径都按 activeStreamId 校验）。
  if (snapshot && !snapshot.activeStreamId && chunk.streamId && !isSummaryType) {
    snapshot.activeStreamId = chunk.streamId
  }

  const buffer = buffers.get(convId)!
  buffer.push(chunk)

  // 缓冲上限保护：用户停留在其他标签页期间，长工具循环/长文本流会逐 chunk 累积。
  // 超过上限时丢弃最旧 chunk，避免切回标签页时全量同步回放导致 UI 卡死。
  // 丢弃最旧 chunk 是安全的：终结事件（complete/toolIteration 等）携带完整内容快照，
  // 回放时仍能重建最终消息状态。
  if (buffer.length > MAX_BACKGROUND_BUFFER_CHUNKS) {
    buffer.splice(0, buffer.length - MAX_BACKGROUND_BUFFER_CHUNKS)
  }

  if (snapshot) {
    switch (chunk.type) {
      case 'complete':
      case 'error':
      case 'cancelled':
        snapshot.isStreaming = false
        snapshot.isWaitingForResponse = false
        // 注意：不清除 activeStreamId！
        // 1) updateTabStreamingStatus 需要它来验证 chunk 属于当前流
        // 2) 切换标签页后回放缓冲 chunk 时需要它通过 streamId 校验
        // 3) 回放时 handleComplete/handleCancelled/handleError 会自然清除
        break
      case 'awaitingConfirmation':
        snapshot.isStreaming = false
        snapshot.isWaitingForResponse = true
        // 同上：不清除 activeStreamId，回放时 handleAwaitingConfirmation 会自然清除
        break
      case 'chunk':
      case 'toolsExecuting':
      case 'toolStatus':
      case 'toolIteration':
        snapshot.isStreaming = true
        snapshot.isWaitingForResponse = true
        break
      default:
        break
    }
  }
}

/**
 * 更新标签页的流式状态指示器
 */
export function updateTabStreamingStatus(
  state: ChatStoreState,
  chunk: StreamChunk
): void {
  const convId = chunk.conversationId
  if (!convId) return

  const tab = state.openTabs.value.find(t => t.conversationId === convId)
  if (!tab) return

  // 根据“当前会话状态 / 后台快照状态”过滤旧流的迟到 chunk，避免标签页状态闪回。
  const expectedStreamId = convId === state.currentConversationId.value
    ? state.activeStreamId.value
    : state.sessionSnapshots.value.get(tab.id)?.activeStreamId || null

  // 总结类 chunk 例外（与 handleStreamChunk 门禁一致）：按独立总结流 id 放行，
  // 只影响标签页指示器状态，不影响消息内容。
  const isSummaryType = chunk.type === 'autoSummary' || chunk.type === 'autoSummaryStatus'

  // 没有预期 streamId 时，不接收带 streamId 的 chunk（通常是迟到包）
  if (!isSummaryType && chunk.streamId && !expectedStreamId) {
    return
  }

  if (
    !isSummaryType &&
    expectedStreamId &&
    chunk.streamId &&
    chunk.streamId !== expectedStreamId
  ) {
    return
  }

  switch (chunk.type) {
    // 明确结束流式状态
    case 'complete':
    case 'error':
    case 'cancelled':
    case 'awaitingConfirmation':
      tab.isStreaming = false
      break

    // 明确处于流式/工具执行推进中
    case 'chunk':
    case 'toolsExecuting':
    case 'toolStatus':
    case 'toolIteration':
      tab.isStreaming = true
      break

    // 与主响应流无关的信号（如 checkpoints / autoSummaryStatus / autoSummary）
    // 不应覆盖标签页当前流式状态，避免“已完成后又被重置为加载中”的竞态。
    default:
      break
  }
}

/**
 * 通过 conversationId 查找已打开的标签页
 */
export function findTabByConversationId(
  state: ChatStoreState,
  conversationId: string
): TabInfo | undefined {
  return state.openTabs.value.find(t => t.conversationId === conversationId)
}

/**
 * 更新标签页标题
 */
export function updateTabTitle(
  state: ChatStoreState,
  tabId: string,
  title: string
): void {
  const tab = state.openTabs.value.find(t => t.id === tabId)
  if (tab) {
    tab.title = title
  }
}

/**
 * 更新标签页关联的 conversationId（创建新对话后更新）
 */
export function updateTabConversationId(
  state: ChatStoreState,
  tabId: string,
  conversationId: string
): void {
  const tab = state.openTabs.value.find(t => t.id === tabId)
  if (tab) {
    tab.conversationId = conversationId
  }
}

/**
 * 重新排列标签页顺序（拖拽排序）
 *
 * 将 fromIndex 处的标签页移动到 toIndex 位置
 */
export function reorderTab(
  state: ChatStoreState,
  fromIndex: number,
  toIndex: number
): void {
  const tabs = [...state.openTabs.value]
  if (
    fromIndex < 0 || fromIndex >= tabs.length ||
    toIndex < 0 || toIndex >= tabs.length ||
    fromIndex === toIndex
  ) {
    return
  }

  const [moved] = tabs.splice(fromIndex, 1)
  tabs.splice(toIndex, 0, moved)
  state.openTabs.value = tabs
}
