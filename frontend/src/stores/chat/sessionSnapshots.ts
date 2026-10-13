/** 会话快照、恢复与重置共用同一字段边界；标签页模块只编排切换流程。 */
import type { ChatStoreState, ConversationSessionSnapshot } from './types'
import { replaceAllMessages } from './state'
import { clearPendingDirtyConfirm } from './dirtyConfirmState'
import { clearAllSmoothForState } from './streamChunkHandlers'

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
    selectedReasoningEffort: state.selectedReasoningEffort.value,
    isLoadingMoreMessages: state.isLoadingMoreMessages.value,
    isStreaming: state.isStreaming.value,
    isLoading: state.isLoading.value,
    streamingMessageId: state.streamingMessageId.value,
    activeStreamId: state.activeStreamId.value,
    activeRunStatus: state.activeRunStatus.value,
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
    // Attachment imports capture this draft; preserve ownership across tab switches.
    attachments: state.attachments.value,
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
  replaceAllMessages(state, [...snapshot.allMessages])
  state.windowStartIndex.value = snapshot.windowStartIndex
  state.totalMessages.value = snapshot.totalMessages
  state.configId.value = snapshot.configId
  state.selectedModelId.value = snapshot.selectedModelId
  state.selectedReasoningEffort.value = snapshot.selectedReasoningEffort ?? ''
  state.isLoadingMoreMessages.value = snapshot.isLoadingMoreMessages
  state.isStreaming.value = snapshot.isStreaming
  state.isLoading.value = snapshot.isLoading
  state.streamingMessageId.value = snapshot.streamingMessageId
  state.activeStreamId.value = snapshot.activeStreamId ?? null
  state.activeRunStatus.value = snapshot.activeRunStatus ?? null
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
  state.attachments.value = snapshot.attachments
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

/** 新会话沿用当前渠道与原有模式默认值，通过恢复路径同步维护消息索引和缓存。 */
export function resetConversationState(state: ChatStoreState): void {
  clearAllSmoothForState(state)
  const empty: ConversationSessionSnapshot = {
    conversationId: null,
    allMessages: [],
    windowStartIndex: 0,
    totalMessages: 0,
    configId: state.configId.value,
    selectedModelId: state.currentConfig.value?.model || '',
    selectedReasoningEffort: '',
    isLoadingMoreMessages: false,
    isStreaming: false,
    isLoading: false,
    streamingMessageId: null,
    activeStreamId: null,
    activeRunStatus: null,
    isWaitingForResponse: false,
    checkpoints: [],
    activeBuild: null,
    error: null,
    retryStatus: null,
    autoSummaryStatus: null,
    historyFolded: false,
    foldedMessageCount: 0,
    inputValue: '',
    pendingModelOverride: null,
    pendingConfigIdOverride: null,
    editorNodes: [],
    attachments: [],
    messageQueue: [],
    currentPromptModeId: window.__GRAYCODE_HOST?.getDefaultPromptModeId?.() ?? 'code',
    toolResponseCache: [],
    pendingBranchRefreshAfterStream: null,
    pendingBranchReplayContext: null,
    branchGraph: null
  }
  restoreSessionFromSnapshot(state, empty)
  state._lastCancelledStreamId.value = null
  state.isSwitchingBranch.value = false
  state.branchGraphLoading.value = false
  clearPendingDirtyConfirm()
}
