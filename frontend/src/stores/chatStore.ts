/**
 * Chat Store - Pinia状态管理
 * 
 * 管理对话和消息状态：
 * - 当前对话ID
 * - 消息列表
 * - 对话列表
 * - 加载/流式状态
 * 
 * 逻辑说明：
 * 1. 打开时创建临时对话（不立即持久化）
 * 2. 用户发送第一条消息时才持久化对话
 * 3. 加载历史对话从后端获取
 * 
 * 模块化结构：
 * - state.ts: 状态定义
 * - computed.ts: 计算属性
 * - streamHandler.ts: 流式响应处理
 * - conversationActions.ts: 对话操作
 * - messageActions.ts: 消息操作
 * - toolActions.ts: 工具操作
 * - checkpointActions.ts: 检查点操作
 * - configActions.ts: 配置操作
 * - queueActions.ts: 消息队列编排
 * - parsers.ts: 解析器
 * - utils.ts: 工具函数
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { defineStore } from 'pinia'
import { computed as vueComputed, watch } from 'vue'
import type { Attachment, CheckpointRecord, Message, StreamChunk } from '../types'
import { sendToExtension, onMessageFromExtension } from '../utils/vscode'
import { replayTodoStateFromMessages, type TodoItem } from '../utils/todoList'
import type { EditorNode } from '../types/editorNode'

// 导入模块
import { createChatState, getMessagesStructuralVersion, rebuildMessageIndexById } from './chat/state'
import { createChatComputed } from './chat/computed'
import { handleStreamChunk, handleStreamChunkBatch } from './chat/streamHandler'
import { formatTime } from './chat/utils'

import {
  createNewConversation as createNewConvAction,
  loadConversations as loadConvsAction,
  loadMoreConversations as loadMoreConvsAction,
  loadHistory,
  loadOlderMessagesPage as loadOlderMessagesPageAction,
  loadCheckpoints,
  switchConversation as switchConvAction,
  deleteConversation as deleteConvAction,
  isDeletingConversation,
  updateConversationAfterMessage,
  createBranchConversation as createBranchConversationAction
} from './chat/conversationActions'

import {
  loadCurrentConfig,
  setConfigId as setConfigIdAction,
  loadSavedConfigId,
  loadCheckpointConfig,
  setSelectedModelId as setSelectedModelIdAction,
  setMergeUnchangedCheckpoints,
  setCurrentWorkspaceUri,
  setWorkspaceFilter as setWorkspaceFilterAction,
  setInputValue as setInputValueAction,
  clearInputValue as clearInputValueAction,
  handleRetryStatus,
  setCurrentPromptModeId as setCurrentPromptModeIdAction,
  persistConversationPromptMode
} from './chat/configActions'

import {
  getCheckpointsForMessage as getCheckpointsFn,
  hasCheckpoint as hasCheckpointFn,
  addCheckpoint as addCheckpointFn,
  createManualCheckpoint as createManualCheckpointFn,
  previewRestore as previewRestoreFn,
  restoreCheckpoint as restoreCheckpointFn,
  restoreAndRetry as restoreAndRetryFn,
  restoreAndDelete as restoreAndDeleteFn,
  restoreAndEdit as restoreAndEditFn,
  summarizeContext as summarizeContextFn,
  cancelSummarizeRequest as cancelSummarizeRequestFn
} from './chat/checkpointActions'

import {
  getToolResponseById as getToolResponseByIdFn,
  hasToolResponse as hasToolResponseFn,
  getActualIndex as getActualIndexFn,
  cancelStream as cancelStreamFn,
  cancelStreamAndRejectTools as cancelStreamAndRejectToolsFn
} from './chat/toolActions'

import {
  sendMessage as sendMessageFn,
  retryLastMessage as retryLastMessageFn,
  retryFromMessage as retryFromMessageFn,
  retryAfterError as retryAfterErrorFn,
  dismissError as dismissErrorFn,
  editAndRetry as editAndRetryFn,
  deleteMessage as deleteMessageFn,
  deleteSingleMessage as deleteSingleMessageFn,
  restoreSummarizedMessages as restoreSummarizedMessagesFn
} from './chat/messageActions'

import type { CancelStreamOptions } from './chat/toolActions'
import type { SendMessageOptions } from './chat/messageActions'
import type { BuildSession, QueuedMessage } from './chat/types'

import {
  loadBranchGraph as loadBranchGraphAction,
  refreshBranchGraph as refreshBranchGraphAction,
  switchBranchCandidate as switchBranchCandidateAction,
  deleteBranchCandidate as deleteBranchCandidateAction,
  restoreBranchCandidate as restoreBranchCandidateAction,
  renameBranchCandidate as renameBranchCandidateAction
} from './chat/branchActions'

import {
  createTab as createTabAction,
  closeTab as closeTabAction,
  switchTab as switchTabAction,
  findTabByConversationId,
  updateTabTitle,
  updateTabConversationId,
  reorderTab as reorderTabAction
} from './chat/tabActions'

import {
  enqueueMessage as enqueueMessageFn,
  dequeueMessage as dequeueMessageFn,
  removeQueuedMessage as removeQueuedMessageFn,
  moveQueuedMessage as moveQueuedMessageFn,
  updateQueuedMessage as updateQueuedMessageFn,
  sendQueuedMessageNow as sendQueuedMessageNowFn,
  processQueue as processQueueFn,
  processQueueAfterAction as processQueueAfterActionFn,
  type QueueActionDeps
} from './chat/queueActions'

import type { StreamHandlerContext } from './chat/streamHandler'
import { useSettingsStore } from './settingsStore'
import { registerChatBridge } from './backgroundTasks/bridge'

// 重新导出类型
export type { Conversation, WorkspaceFilter, TabInfo, QueuedMessage } from './chat/types'

// 模块级初始化保护（HIGH）：App.vue onMounted / HMR 重挂载会重复调用 initialize()。
// 若不幂等，会重复注册 onMessageFromExtension 订阅——每条 streamChunk 被重复处理 N 次
// （文本重复追加、checkpoint 重复写入、tps 计数翻倍）。取消函数保留在模块级，
// 重复调用时先注销旧监听再注册，保证任意时刻只有一份活跃订阅。
let disposeChatStreamListener: (() => void) | null = null

/**
 * 已完成首次状态初始化的 store state 实例集合（按实例记录，WeakSet 不泄漏）。
 * initialize() 的状态重置（清空会话/建空白标签页）只应在首次执行：
 * HMR/App 重挂载导致的重复 initialize 不应清空用户当前会话。
 */
const initializedChatStates = new WeakSet<object>()

export const useChatStore = defineStore('chat', () => {
  // ============ 状态 ============
  const state = createChatState()

  // M1：平滑档位经 state 传递——streamChunkHandlers 每 chunk 只读 state.smoothMode，
  // 不内联 useSettingsStore()（高频调用 + try/catch 吞错）。
  // watcher 在 initialize() 内创建并保存停止句柄（重复 initialize 先停旧句柄再重建）。
  const settingsStore = useSettingsStore()
  
  // ============ 计算属性 ============
  const computed = createChatComputed(state)

  /** 是否还有更多历史对话可加载（分页） */
  const hasMoreConversations = vueComputed(
    () => state.persistedConversationsLoaded.value < state.persistedConversationIds.value.length
  )
  
  // ============ 工具操作 ============
  
  const checkpointsByMessageIndex = vueComputed(() => {
    const grouped = new Map<number, { before: CheckpointRecord[]; after: CheckpointRecord[] }>()
    for (const checkpoint of state.checkpoints.value) {
      let bucket = grouped.get(checkpoint.messageIndex)
      if (!bucket) {
        bucket = { before: [], after: [] }
        grouped.set(checkpoint.messageIndex, bucket)
      }
      if (checkpoint.phase === 'before') {
        bucket.before.push(checkpoint)
      } else {
        bucket.after.push(checkpoint)
      }
    }
    return grouped
  })

  /**
   * todoSnapshot 增量重放缓存：缓存 [0, scannedCount) 的重放中间态 + 前缀消息引用快照。
   * 前缀引用逐元素相等、窗口只增不减且响应解析表与缓存时逐项一致时，
   * 仅从上次位置增量重放尾部（含旧尾消息——流式期间其 tools 会被原地追加/改写）；
   * 其余结构变更自动回退全量重放。尾消息始终不纳入缓存，保证流式工具状态更新可见。
   */
  let todoReplayCache: {
    scannedCount: number
    messagesRef: Message[]
    responseMap: Map<string, unknown>
    list: TodoItem[] | null
    anchorBackendIndex: number | null
    /** 缓存时的消息数组结构版本（state.ts 维护）：非纯尾部 splice/删除/整体替换会递增 */
    version: number
  } | null = null

  const todoSnapshot = vueComputed(() => {
    const allMessages = state.allMessages.value
    const len = allMessages.length

    const responseMap = new Map<string, unknown>()

    for (const [toolId, response] of state.toolResponseCache.value.entries()) {
      responseMap.set(toolId, response)
    }

    for (const message of allMessages) {
      if (!message.isFunctionResponse || !Array.isArray(message.parts)) continue
      for (const part of message.parts) {
        const toolId = part.functionResponse?.id
        const response = part.functionResponse?.response
        if (typeof toolId !== 'string' || response === undefined || responseMap.has(toolId)) continue
        responseMap.set(toolId, response)
      }
    }

    // 前缀引用校验：缓存窗口是当前窗口的前缀且未被改写（含尾消息原地替换）时走增量。
    // 注意：messagesRef 与 allMessages 是同一个响应式数组代理，原地 splice（中间插入/删除）
    // 无法被逐元素引用比较感知；结构版本号（state.ts 在非纯尾部变更时递增）作为补充指纹，
    // 版本不一致一律回退全量重放。
    const cache = todoReplayCache
    let prefixOk = false
    if (
      cache !== null &&
      cache.messagesRef.length <= len &&
      cache.version === getMessagesStructuralVersion(state)
    ) {
      prefixOk = true
      for (let i = 0; i < cache.scannedCount; i++) {
        if (allMessages[i] !== cache.messagesRef[i]) {
          prefixOk = false
          break
        }
      }
    }
    if (prefixOk && cache !== null) {
      // 响应解析表与缓存时逐项一致（引用比较）才可增量：toolResponseCache 可能被外部
      // getToolResponseById 回填/改写而消息引用不变，任何差异一律回退全量重放
      const cachedMap = cache.responseMap
      if (responseMap.size !== cachedMap.size) {
        prefixOk = false
      } else {
        for (const [toolId, response] of responseMap.entries()) {
          if (cachedMap.get(toolId) !== response) {
            prefixOk = false
            break
          }
        }
      }
    }

    const result = prefixOk && cache !== null
      ? replayTodoStateFromMessages(allMessages, {
          resolveToolResponseById: (toolCallId) => responseMap.get(toolCallId),
          fromIndex: cache.scannedCount,
          initialTodos: cache.list,
          initialAnchorBackendIndex: cache.anchorBackendIndex,
          initialTouched: cache.list !== null
        })
      : replayTodoStateFromMessages(allMessages, {
          resolveToolResponseById: (toolCallId) => responseMap.get(toolCallId)
        })

    // 尾消息可能在流式期间原地变更（tools 追加/状态改写），始终不纳入缓存
    todoReplayCache = {
      scannedCount: Math.max(0, len - 1),
      messagesRef: allMessages,
      responseMap,
      list: result.todos,
      anchorBackendIndex: result.anchorBackendIndex,
      version: getMessagesStructuralVersion(state)
    }
    return result
  })

  const getToolResponseById = (toolCallId: string) => getToolResponseByIdFn(state, toolCallId)
  const hasToolResponse = (toolCallId: string) => hasToolResponseFn(state, toolCallId)
  const getActualIndex = (displayIndex: number) => getActualIndexFn(state, computed, displayIndex)
  
  const cancelStreamAndRejectTools = () => cancelStreamAndRejectToolsFn(state, computed)
  const cancelStream = (options?: CancelStreamOptions) => cancelStreamFn(state, computed, options)

  // ============ 消息操作 ============
  
  const sendMessage = (messageText: string, attachments?: Attachment[], options?: SendMessageOptions): Promise<boolean> =>
    sendMessageFn(state, computed, messageText, attachments, options)
  
  const retryLastMessage = () => retryLastMessageFn(state, computed, cancelStream)
  const retryFromMessage = (messageIndex: number) => 
    retryFromMessageFn(state, computed, messageIndex, cancelStream)
  const retryAfterError = () => retryAfterErrorFn(state, computed)
  const dismissError = () => dismissErrorFn(state)
  
  const editAndRetry = (messageIndex: number, newMessage: string, attachments?: Attachment[], mode?: 'branch' | 'keep') =>
    editAndRetryFn(state, computed, messageIndex, newMessage, attachments, cancelStream, mode)
  
  const deleteMessage = (targetIndex: number) => deleteMessageFn(state, targetIndex, cancelStream)
  const deleteSingleMessage = (targetIndex: number) => deleteSingleMessageFn(state, targetIndex, cancelStream)

  // ============ 后台任务桥接（单向：chat → backgroundTaskStore） ============
  // 背景：chatStore ↔ backgroundTaskStore 曾是双向耦合（backgroundTaskStore 直接 useChatStore），
  // 模块级 import 环是初始化幂等/HMR 补丁（disposeChatStreamListener / initializedChatStates）
  // 存在的结构性原因之一。
  // 解耦：本 store 实例创建时把会话状态/操作面注册到 backgroundTasks/bridge 注册表
  // （单向依赖 chat → bridge），backgroundTaskStore 只消费注册表，不再反向依赖 chatStore。
  // 注册时机取实例创建（setup 体）而非 initialize：保证任何先于 initialize 的消费方
  // （backgroundTaskStore 的 flush/watch）都能拿到当前实例的实时状态（测试与生产同构）。
  registerChatBridge({
    getState: () => ({
      isStreaming: state.isStreaming.value,
      isWaitingForResponse: state.isWaitingForResponse.value,
      currentConversationId: state.currentConversationId.value
    }),
    cancelStream,
    sendMessage
  })

  // ============ 分支操作（TREE-07 切换 / TREE-10 切换器数据源） ============

  const loadBranchGraph = () => loadBranchGraphAction(state)
  const refreshBranchGraph = () => refreshBranchGraphAction(state)
  const switchBranchCandidate = (nodeId: string, options?: { mode?: 'chat-only' | 'chat-and-workspace'; confirmedDiscardDirty?: boolean }) =>
    switchBranchCandidateAction(state, nodeId, options)
  const deleteBranchCandidate = (nodeId: string) => deleteBranchCandidateAction(state, nodeId)
  const restoreBranchCandidate = (nodeId: string) => restoreBranchCandidateAction(state, nodeId)
  const renameBranchCandidate = (nodeId: string, label: string) => renameBranchCandidateAction(state, nodeId, label)

  // ============ 对话操作 ============
  
  /**
   * 创建新对话 - 标签页感知
   *
   * 如果当前标签页是空白的（无对话），直接复用；否则创建新标签页
   */
  const createNewConversation = async () => {
    // 如果当前标签页已经是空白的，直接在当前标签页创建
    if (!state.currentConversationId.value && state.allMessages.value.length === 0) {
      // 空白标签页可能已入队消息/附件/编辑器节点：resetConversationState 会清空它们，
      // 先暂存再恢复，避免「新建对话」静默丢弃排队内容（P2）；
      // 输入框内容 / Prompt 模式 / 模型选择同样被重置，一并保留（空白标签页新建对话不应清空输入态）
      const preserved = {
        messageQueue: state.messageQueue.value,
        attachments: state.attachments.value,
        editorNodes: state.editorNodes.value,
        inputValue: state.inputValue.value,
        currentPromptModeId: state.currentPromptModeId.value,
        selectedModelId: state.selectedModelId.value
      }
      await createNewConvAction(state, cancelStreamAndRejectTools)
      state.messageQueue.value = preserved.messageQueue
      state.attachments.value = preserved.attachments
      state.editorNodes.value = preserved.editorNodes
      state.inputValue.value = preserved.inputValue
      state.currentPromptModeId.value = preserved.currentPromptModeId
      state.selectedModelId.value = preserved.selectedModelId
      void loadBranchGraphAction(state)
      return
    }

    // 创建新标签页
    const tabId = createTabAction(state, { title: 'New Chat' })
    if (tabId) {
      // createTabAction 未传 conversationId：新标签页的 conversationId 恒为 null，
      // existingTab.conversationId 分支是死代码（旧实现每次都会走到），直接切换
      switchTabWrapped(tabId)
    }
  }

  const loadConversations = () => loadConvsAction(state)
  const loadMoreConversations = () => loadMoreConvsAction(state)
  const loadOlderMessagesPage = (options?: { pageSize?: number }) => loadOlderMessagesPageAction(state, options)

  /**
   * 切换对话 - 标签页感知
   *
   * 如果对话已在某个标签页中打开，切换到该标签页；
   * 否则在当前标签页中加载该对话
   */
  const switchConversation = async (id: string) => {
    // 检查对话是否已在某个标签页中打开
    const existingTab = findTabByConversationId(state, id)
    if (existingTab) {
      // 直接切换到已打开的标签页
      switchTabWrapped(existingTab.id)
      return
    }

    // await 前固化目标标签页：切换期间用户可能点了别的标签页，绑定必须基于快照
    const targetTabId = state.activeTabId.value

    // 在当前标签页中加载该对话
    await switchConvAction(state, id, cancelStreamAndRejectTools)
    void loadBranchGraphAction(state)

    // 更新当前标签页的信息（仅当用户没有切换走）
    if (targetTabId && state.activeTabId.value === targetTabId) {
      updateTabConversationId(state, targetTabId, id)
      const conv = state.conversations.value.find(c => c.id === id)
      if (conv) {
        updateTabTitle(state, targetTabId, conv.title)
      }
    }
  }

  /**
   * 从指定后端消息索引创建分支对话，并在新标签页中打开。
   */
  const branchFromMessage = async (messageBackendIndex: number): Promise<void> => {
    const sourceConversationId = state.currentConversationId.value
    if (!sourceConversationId) return
    if (!Number.isFinite(messageBackendIndex) || messageBackendIndex < 0) return

    if (state.isWaitingForResponse.value || state.isStreaming.value) {
      await cancelStreamAndRejectTools()
    }

    const conv = await createBranchConversationAction(state, sourceConversationId, messageBackendIndex)
    if (!conv) return

    const tabId = createTabAction(state, {
      conversationId: conv.id,
      title: conv.title
    })

    if (tabId) {
      switchTabWrapped(tabId)
      await switchConvAction(state, conv.id, cancelStreamAndRejectTools)
      void loadBranchGraphAction(state)
      updateTabTitle(state, tabId, conv.title)
    } else {
      await switchConversation(conv.id)
    }
  }

  const deleteConversation = (id: string) => deleteConvAction(
    state,
    id,
    switchConversation,
    createNewConversation
  )
  
  // ============ 配置操作 ============
  
  const setConfigId = (newConfigId: string) => setConfigIdAction(state, newConfigId)
  const setSelectedModelId = (modelId: string) => setSelectedModelIdAction(state, modelId)
  const setWorkspaceFilter = (filter: 'current' | 'all') => setWorkspaceFilterAction(state, filter)
  const setInputValue = (value: string) => setInputValueAction(state, value)

  const setCurrentPromptModeId = (modeId: string) => setCurrentPromptModeIdAction(state, modeId)
  const clearInputValue = () => clearInputValueAction(state)

  // ============ 编辑器节点（对话级输入状态隔离） ============

  function setEditorNodes(nodes: EditorNode[]) {
    state.editorNodes.value = nodes
  }

  // ============ 附件管理（对话级隔离） ============

  function addStoreAttachment(att: Attachment) {
    state.attachments.value = [...state.attachments.value, att]
  }

  function removeStoreAttachment(id: string) {
    state.attachments.value = state.attachments.value.filter(a => a.id !== id)
  }

  function clearStoreAttachments() {
    state.attachments.value = []
  }

  // ============ 消息队列（候选区） ============

  /** 队列编排依赖（sendMessage/cancelStream 为绑定 state/computed 的 store 层包装） */
  const queueActionDeps: QueueActionDeps = {
    sendMessage,
    cancelStream
  }

  const enqueueMessage = (content: string, attachments?: Attachment[], sendOptions?: QueuedMessage['sendOptions']) =>
    enqueueMessageFn(state, content, attachments, sendOptions)

  const dequeueMessage = () => dequeueMessageFn(state)

  const removeQueuedMessage = (id: string) => removeQueuedMessageFn(state, id)

  const moveQueuedMessage = (fromIndex: number, toIndex: number) => moveQueuedMessageFn(state, fromIndex, toIndex)

  const updateQueuedMessage = (id: string, content: string, attachments: Attachment[]) =>
    updateQueuedMessageFn(state, id, content, attachments)

  const sendQueuedMessageNow = (id: string) => sendQueuedMessageNowFn(state, queueActionDeps, id)

  const processQueue = () => processQueueFn(state, queueActionDeps)

  const processQueueAfterAction = () => processQueueAfterActionFn(state, queueActionDeps)

  // ============ Build（Plan 执行）============

  async function setActiveBuild(
    build: BuildSession | null,
    options?: { persist?: boolean }
  ): Promise<void> {
    const conversationId = state.currentConversationId.value || ''
    const defaultAnchorBackendIndex = state.windowStartIndex.value + state.allMessages.value.length

    const normalizedBuild = build && conversationId
      ? {
          ...build,
          conversationId: build.conversationId || conversationId,
          anchorBackendIndex:
            typeof build.anchorBackendIndex === 'number'
              ? build.anchorBackendIndex
              : defaultAnchorBackendIndex
        }
      : build

    // 防止把 A 对话的 Build 误写到 B 对话（切换竞态）：
    // 校验必须在写内存之前，否则校验失败时内存态已被污染
    if (normalizedBuild && normalizedBuild.conversationId !== conversationId) {
      return
    }

    state.activeBuild.value = normalizedBuild

    if (options?.persist === false) return
    if (!conversationId) return

    try {
      await sendToExtension(MESSAGE_NAMES['conversation.setCustomMetadata'], {
        conversationId,
        key: 'activeBuild',
        value: normalizedBuild
      })
    } catch (error) {
      console.error('[chatStore] Failed to persist activeBuild:', error)
    }
  }
  
  // ============ 检查点操作 ============
  
  const getCheckpointsForMessage = (messageIndex: number) => getCheckpointsFn(state, messageIndex)
  const hasCheckpoint = (messageIndex: number) => hasCheckpointFn(state, messageIndex)
  const addCheckpoint = (checkpoint: CheckpointRecord) => addCheckpointFn(state, checkpoint)
  const createManualCheckpoint = () => createManualCheckpointFn(state)
  const previewRestore = (checkpointId: string) => previewRestoreFn(state, checkpointId)
  const restoreCheckpoint = (checkpointId: string, deleteUntrackedFiles?: boolean, confirmedDiscardDirty?: boolean) =>
    restoreCheckpointFn(state, checkpointId, deleteUntrackedFiles, confirmedDiscardDirty)
  const restoreAndRetry = (messageIndex: number, checkpointId: string, confirmedDeleteUntracked?: boolean, confirmedDiscardDirty?: boolean) =>
    restoreAndRetryFn(state, messageIndex, checkpointId, computed.currentModelName.value, cancelStream, confirmedDeleteUntracked, confirmedDiscardDirty)
  const restoreAndDelete = (messageIndex: number, checkpointId: string, confirmedDeleteUntracked?: boolean, confirmedDiscardDirty?: boolean) =>
    restoreAndDeleteFn(state, messageIndex, checkpointId, cancelStream, confirmedDeleteUntracked, confirmedDiscardDirty)
  const restoreAndEdit = (messageIndex: number, newContent: string, attachments: Attachment[] | undefined, checkpointId: string, confirmedDeleteUntracked?: boolean, confirmedDiscardDirty?: boolean) =>
    restoreAndEditFn(state, messageIndex, newContent, attachments, checkpointId, computed.currentModelName.value, cancelStream, confirmedDeleteUntracked, confirmedDiscardDirty)
  const summarizeContext = () => summarizeContextFn(state, () => loadHistory(state))
  const cancelSummarizeRequest = () => cancelSummarizeRequestFn(state)
  const restoreSummarizedMessages = (summaryMessageId: string) => restoreSummarizedMessagesFn(state, summaryMessageId)

  // ============ 流式处理 ============

  /** 流式处理器上下文（供标签页切换时回放缓冲区使用） */
  const streamHandlerCtx: StreamHandlerContext = {
    state,
    currentModelName: () => computed.currentModelName.value,
    addCheckpoint,
    updateConversationAfterMessage: () => updateConversationAfterMessage(state),
    processQueue,
    processQueueAfterAction
  }
  
  function handleStreamChunkWrapper(chunk: StreamChunk): void {
    handleStreamChunk(chunk, streamHandlerCtx)
  }

  // ============ 标签页操作 ============

  /**
   * 创建新标签页
   */
  function createNewTab(): string | null {
    const tabId = createTabAction(state, { title: 'New Chat' })
    if (tabId) {
      switchTabWrapped(tabId)
    }
    return tabId
  }

  /**
   * 关闭标签页
   */
  function closeTabWrapped(tabId: string): void {
    closeTabAction(
      state,
      tabId,
      cancelStreamAndRejectTools,
      streamHandlerCtx,
      async (conversationId) => {
        try {
          await sendToExtension(MESSAGE_NAMES.cancelStream, { conversationId })
        } catch (error) {
          console.error('[chatStore] Failed to cancel stream on tab close:', error)
        }
      }
    )
  }

  /**
   * 切换标签页
   */
  function switchTabWrapped(tabId: string): void {
    switchTabAction(state, tabId, cancelStreamAndRejectTools, streamHandlerCtx)
    void loadCurrentConfig(state)
  }

  /**
   * 从历史打开对话（在新标签页或当前空白标签页中）
   */
  async function openConversationInTab(conversationId: string): Promise<void> {
    // 如果已在某个标签页中打开，直接切换
    const existingTab = findTabByConversationId(state, conversationId)
    if (existingTab) {
      switchTabWrapped(existingTab.id)
      return
    }

    // 如果当前标签页是空白的，在当前标签页中加载
    if (!state.currentConversationId.value && state.allMessages.value.length === 0) {
      await switchConversation(conversationId)
      return
    }

    // 创建新标签页并在其中加载对话
    const conv = state.conversations.value.find(c => c.id === conversationId)
    const tabId = createTabAction(state, {
      conversationId,
      title: conv?.title || 'Chat'
    })
    if (tabId) {
      switchTabWrapped(tabId)
      // 切换后需要从后端加载历史
      await switchConvAction(state, conversationId, cancelStreamAndRejectTools)
      void loadBranchGraphAction(state)
      if (conv) {
        updateTabTitle(state, tabId, conv.title)
      }
    }
  }

  // ============ 初始化 ============

  /** 平滑档位同步 watcher 的停止句柄（重复 initialize 前先停止旧句柄，避免重复监听） */
  let stopSmoothStreamingWatcher: (() => void) | null = null
  
  async function initialize(): Promise<void> {
    // 首次状态建立必须发生在任何 await 之前：启动加载期间界面或内部消息可能触发首条发送，
    // 发送流程需要一个稳定的 activeTabId 来绑定懒创建的会话。旧实现把清空/建标签页放在
    // 全部 IPC 完成之后，会把在途首条消息和会话 ID 整体覆盖，表现为消息闪现后消失。
    // 先标记再初始化：即使后续加载失败，重试 initialize 也不得清空用户已经开始的会话。
    if (!initializedChatStates.has(state)) {
      initializedChatStates.add(state)
      state.currentConversationId.value = null
      state.allMessages.value = []
      rebuildMessageIndexById(state)
      state.windowStartIndex.value = 0
      state.totalMessages.value = 0
      state.isLoadingMoreMessages.value = false
      state.historyFolded.value = false
      state.foldedMessageCount.value = 0
      state.toolResponseCache.value = new Map()

      const initialTabId = createTabAction(state, { title: 'New Chat' })
      if (initialTabId) {
        state.activeTabId.value = initialTabId
      }
    }

    // 幂等保护：重复调用（HMR/App 重挂载）时先注销旧订阅再重新注册，
    // 避免每条 streamChunk 被重复处理（文本重复追加、checkpoint 重复写入、tps 计数翻倍）。
    disposeChatStreamListener?.()
    stopSmoothStreamingWatcher?.()

    // M1：平滑档位 watcher（句柄保存，重复 initialize 时先停旧句柄再重建）
    stopSmoothStreamingWatcher = watch(() => settingsStore.smoothStreaming, (v) => {
      state.smoothMode.value = v
    }, { immediate: true })

    disposeChatStreamListener = onMessageFromExtension((message) => {
      if (message.type === 'streamChunk') {
        handleStreamChunkWrapper(message.data)
      } else if (message.type === 'streamChunkBatch') {
        // 批量处理：对连续 toolStatus 做合并优化，其余逐条处理。
        // 整个批量在同一同步上下文完成，Vue 自动合并响应式更新。
        handleStreamChunkBatch(message.data as StreamChunk[], streamHandlerCtx)
      } else if (message.type === 'workspaceUri') {
        setCurrentWorkspaceUri(state, message.data)
      } else if (message.type === 'retryStatus') {
        handleRetryStatus(state, message.data)
      }
    })
    
    try {
      const uri = await sendToExtension<string | null>(MESSAGE_NAMES.getWorkspaceUri, {})
      setCurrentWorkspaceUri(state, uri)
    } catch (error) {
      // 获取工作区 URI 失败不影响主流程，但记录日志便于排查
      console.warn('[chatStore] Failed to get workspace URI:', error)
    }
    
    await loadSavedConfigId(state)
    await loadCurrentConfig(state)
    await loadCheckpointConfig(state)
    await loadConversations()
  }

  // ============ 返回 ============
  
  return {
    // 状态
    conversations: state.conversations,
    currentConversationId: state.currentConversationId,
    allMessages: state.allMessages,
    windowStartIndex: state.windowStartIndex,
    totalMessages: state.totalMessages,
    isLoadingMoreMessages: state.isLoadingMoreMessages,
    historyFolded: state.historyFolded,
    foldedMessageCount: state.foldedMessageCount,
    messages: computed.messages,
    configId: state.configId,
    currentConfig: state.currentConfig,
    selectedModelId: state.selectedModelId,
    isLoading: state.isLoading,
    isStreaming: state.isStreaming,
    isLoadingConversations: state.isLoadingConversations,
    isLoadingMoreConversations: state.isLoadingMoreConversations,
    hasMoreConversations,
    activeStreamId: state.activeStreamId,
    isWaitingForResponse: state.isWaitingForResponse,
    retryStatus: state.retryStatus,
    autoSummaryStatus: state.autoSummaryStatus,
    smoothTexts: state.smoothTexts,
    error: state.error,
    
    // 计算属性
    currentConversation: computed.currentConversation,
    sortedConversations: computed.sortedConversations,
    filteredConversations: computed.filteredConversations,
    hasMessages: computed.hasMessages,
    showEmptyState: computed.showEmptyState,
    currentModelName: computed.currentModelName,
    maxContextTokens: computed.maxContextTokens,
    usedTokens: computed.usedTokens,
    tokenUsagePercent: computed.tokenUsagePercent,
    needsContinueButton: computed.needsContinueButton,
    hasPendingToolConfirmation: computed.hasPendingToolConfirmation,
    pendingToolCalls: computed.pendingToolCalls,
    todoSnapshot,
    checkpointsByMessageIndex,
    previewRestore,
    isRestorePreviewing: state.isRestorePreviewing,

    // 对话管理
    createNewConversation,
    loadConversations,
    loadMoreConversations,
    switchConversation,
    deleteConversation,
    branchFromMessage,
    isDeletingConversation: (id: string) => isDeletingConversation(state, id),
    
    // 消息管理
    loadHistory: () => loadHistory(state),
    loadOlderMessagesPage,
    sendMessage,
    retryLastMessage,
    retryFromMessage,
    retryAfterError,
    dismissError,
    cancelStream,
    cancelStreamAndRejectTools,
    editAndRetry,
    deleteMessage,
    deleteSingleMessage,

    // 分支（TREE-07 / TREE-10 / TREE-11）
    branchGraph: state.branchGraph,
    branchGraphLoading: state.branchGraphLoading,
    isSwitchingBranch: state.isSwitchingBranch,
    loadBranchGraph,
    refreshBranchGraph,
    switchBranchCandidate,
    deleteBranchCandidate,
    restoreBranchCandidate,
    renameBranchCandidate,
    
    // 配置管理
    setConfigId,
    loadCurrentConfig: () => loadCurrentConfig(state),
    setSelectedModelId,
    setCurrentPromptModeId,
    
    // 工具
    formatTime,
    getToolResponseById,
    hasToolResponse,
    getActualIndex,
    
    // 检查点
    checkpoints: state.checkpoints,
    mergeUnchangedCheckpoints: state.mergeUnchangedCheckpoints,
    getCheckpointsForMessage,
    hasCheckpoint,
    loadCheckpoints: () => loadCheckpoints(state),
    loadCheckpointConfig: () => loadCheckpointConfig(state),
    setMergeUnchangedCheckpoints: (value: boolean) => setMergeUnchangedCheckpoints(state, value),
    addCheckpoint,
    createManualCheckpoint,
    restoreCheckpoint,
    restoreAndRetry,
    restoreAndEdit,
    restoreAndDelete,
    
    // 工作区
    currentWorkspaceUri: state.currentWorkspaceUri,
    workspaceFilter: state.workspaceFilter,
    setCurrentWorkspaceUri: (uri: string | null) => setCurrentWorkspaceUri(state, uri),
    setWorkspaceFilter,
    
    // 输入框
    inputValue: state.inputValue,
    setInputValue,
    clearInputValue,

    // 编辑器节点 & 附件（对话级隔离）
    editorNodes: state.editorNodes,
    setEditorNodes,
    currentPromptModeId: state.currentPromptModeId,
    persistConversationPromptMode: () => persistConversationPromptMode(state),

    storeAttachments: state.attachments,
    addStoreAttachment,
    removeStoreAttachment,
    clearStoreAttachments,

    // 消息队列（候选区）
    messageQueue: state.messageQueue,
    enqueueMessage,
    dequeueMessage,
    removeQueuedMessage,
    sendQueuedMessageNow,
    moveQueuedMessage,
    updateQueuedMessage,
    processQueue,
    processQueueAfterAction,

    // Build（Plan 执行）
    activeBuild: state.activeBuild,
    setActiveBuild,
    pendingModelOverride: state.pendingModelOverride,
    pendingConfigIdOverride: state.pendingConfigIdOverride,
    
    // 上下文总结
    summarizeContext,
    cancelSummarizeRequest,
    restoreSummarizedMessages,

    // 标签页
    openTabs: state.openTabs,
    activeTabId: state.activeTabId,
    sessionSnapshots: state.sessionSnapshots,
    createNewTab,
    closeTab: closeTabWrapped,
    switchTab: switchTabWrapped,
    openConversationInTab,
    reorderTab: (fromIndex: number, toIndex: number) => reorderTabAction(state, fromIndex, toIndex),
    
    // 初始化
    initialize
  }
})
