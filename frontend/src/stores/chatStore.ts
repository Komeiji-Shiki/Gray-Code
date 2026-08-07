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
 * - parsers.ts: 解析器
 * - utils.ts: 工具函数
 */

import { defineStore } from 'pinia'
import { computed as vueComputed, watch } from 'vue'
import type { Attachment, CheckpointRecord, CheckpointSummary, Message, StreamChunk } from '../types'
import { sendToExtension, onMessageFromExtension } from '../utils/vscode'
import { generateId } from '../utils/format'
import { replayTodoStateFromMessages, type TodoItem } from '../utils/todoList'
import type { EditorNode } from '../types/editorNode'

// 导入模块
import { createChatState } from './chat/state'
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
  setWorkspaceList,
  setActiveWorkspace as setActiveWorkspaceAction,
  setWorkspaceFilter as setWorkspaceFilterAction,
  loadSavedWorkspaces,
  removeSavedWorkspace,
  openWorkspaceFolderAction,
  openSavedWorkspace,
  saveCurrentWorkspace,
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
  cancelStreamAndRejectTools as cancelStreamAndRejectToolsFn,
  rejectPendingToolsWithAnnotation as rejectPendingToolsWithAnnotationFn
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
  restoreSummarizedMessages as restoreSummarizedMessagesFn,
  clearMessages as clearMessagesFn
} from './chat/messageActions'

import type { CancelStreamOptions } from './chat/toolActions'
import type { SendMessageOptions } from './chat/messageActions'
import type { BuildSession, QueuedMessage, WorkspaceFolderInfo } from './chat/types'

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

import type { StreamHandlerContext } from './chat/streamHandler'
import { useSettingsStore } from './settingsStore'

// 重新导出类型
export type { Conversation, WorkspaceFilter, TabInfo, QueuedMessage } from './chat/types'

// 模块级初始化保护（HIGH）：App.vue onMounted / HMR 重挂载会重复调用 initialize()。
// 若不幂等，会重复注册 onMessageFromExtension 订阅——每条 streamChunk 被重复处理 N 次
// （文本重复追加、checkpoint 重复写入、tps 计数翻倍）。取消函数保留在模块级，
// 重复调用时先注销旧监听再注册，保证任意时刻只有一份活跃订阅。
let disposeChatStreamListener: (() => void) | null = null

// ============ 检查点查询缓存（H-4） ============

/**
 * 检查点查询缓存结构（见 store 内 checkpointLookup computed 的注释）：
 * 数组引用 + 长度 + 首尾元素指纹，纯尾部追加时增量维护，其余回退全量重建。
 */
interface CheckpointLookup {
  ref: CheckpointSummary[]
  length: number
  first: CheckpointSummary | undefined
  last: CheckpointSummary | undefined
  /** messageIndex 升序去重数组（仅 sorted 时有效，供二分查找） */
  keys: number[]
  /** messageIndex → 原数组顺序的检查点列表 */
  groups: Map<number, CheckpointSummary[]>
  /** 单调分组时每个 key 的组在数组中的终止位置（下标 + 1）；非单调为 null */
  cumEndByKey: Map<number, number> | null
  /** 数组是否按 messageIndex 单调分组 */
  sorted: boolean
}

/** 全量重建（引用更换 / 收缩 / 尾元素被改写 / 非单调追加） */
function rebuildCheckpointLookup(checkpoints: CheckpointSummary[]): CheckpointLookup {
  const len = checkpoints.length
  const keys: number[] = []
  const groups = new Map<number, CheckpointSummary[]>()
  const cumEndByKey = new Map<number, number>()
  let sorted = true
  let lastKey: number | undefined
  for (let i = 0; i < len; i++) {
    const cp = checkpoints[i]
    const k = cp.messageIndex
    if (lastKey !== undefined && k < lastKey) sorted = false
    if (k !== lastKey) {
      keys.push(k)
      lastKey = k
    }
    cumEndByKey.set(k, i + 1)
    let group = groups.get(k)
    if (!group) {
      group = []
      groups.set(k, group)
    }
    group.push(cp)
  }
  const lookup: CheckpointLookup = {
    ref: checkpoints,
    length: len,
    first: checkpoints[0],
    last: checkpoints[len - 1],
    keys: sorted ? keys : [],
    groups,
    cumEndByKey: sorted ? cumEndByKey : null,
    sorted
  }
  checkpointLookupCache.set(checkpoints, lookup)
  return lookup
}

const checkpointLookupCache = new WeakMap<CheckpointSummary[], CheckpointLookup>()

function buildCheckpointLookup(checkpoints: CheckpointSummary[]): CheckpointLookup {
  const len = checkpoints.length
  const cached = checkpointLookupCache.get(checkpoints)
  const prefixOk = (
    cached !== undefined &&
    len >= cached.length &&
    (cached.length === 0 || checkpoints[cached.length - 1] === cached.last)
  )
  if (!prefixOk) {
    return rebuildCheckpointLookup(checkpoints)
  }
  if (cached.length === len) {
    // 同一指纹（Vue 重复求值 / 无变化）：直接复用，保持对象身份稳定
    return cached
  }
  // 纯尾部追加：增量维护（新 lookup 对象身份变化驱动下游 computed 重算）
  const keys = cached.keys.slice()
  const groups = new Map(cached.groups)
  const cumEndByKey = cached.cumEndByKey !== null ? new Map(cached.cumEndByKey) : null
  for (let i = cached.length; i < len; i++) {
    const cp = checkpoints[i]
    const k = cp.messageIndex
    const lastKey = keys[keys.length - 1]
    if (lastKey !== undefined && k < lastKey) {
      // 非单调追加：前缀优化失效，全量重建（重估 sorted/cumEndByKey）
      return rebuildCheckpointLookup(checkpoints)
    }
    if (k !== lastKey) {
      keys.push(k)
    }
    if (cumEndByKey !== null) {
      cumEndByKey.set(k, i + 1)
    }
    let group = groups.get(k)
    if (group !== undefined) {
      // 已有组：克隆后再追加，避免新 lookup 与旧 lookup 共享可变数组
      group = group.slice()
      groups.set(k, group)
    } else {
      group = []
      groups.set(k, group)
    }
    group.push(cp)
  }
  const lookup: CheckpointLookup = {
    ref: checkpoints,
    length: len,
    first: cached.first,
    last: checkpoints[len - 1],
    keys,
    groups,
    cumEndByKey,
    sorted: cached.sorted
  }
  checkpointLookupCache.set(checkpoints, lookup)
  return lookup
}

export const useChatStore = defineStore('chat', () => {
  // ============ 状态 ============
  const state = createChatState()

  // M1：平滑档位经 state 传递——streamChunkHandlers 每 chunk 只读 state.smoothMode，
  // 不内联 useSettingsStore()（高频调用 + try/catch 吞错）。
  const settingsStore = useSettingsStore()
  watch(() => settingsStore.smoothStreaming, (v) => {
    state.smoothMode.value = v
  }, { immediate: true })
  
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
   * 检查点查询缓存（H-4）：按 messageIndex 保序分组 + 升序 key 数组 + 前缀终点索引。
   *
   * 背景：MessageItem 每个组件实例都对自己的 messageIndex 全量 filter/sort 检查点
   * （O(n) × 实例数），且 checkpoints 数组在会话内只原地 push（checkpointActions.addCheckpoint）
   * 或整体替换（切换对话 / 裁剪 filter / 回档）。因此用"数组引用 + 长度 + 尾元素"指纹做
   * 增量维护：纯尾部追加只处理新增段，其余回退全量重建（WeakMap 以数组为键，旧会话数组随 GC 释放）。
   *
   * 输出（与原有消费语义逐项对齐）：
   * - keys：messageIndex 升序去重数组（供二分查最近前序；非单调时为 []）；
   * - groups：messageIndex → 原数组顺序的检查点列表（含 before/after 交错顺序）；
   * - cumEndByKey：单调分组时每个 key 的组在数组中的终止位置（组最后一条的下标 + 1），
   *   供 availableCheckpoints 用 slice(0, ...) O(1) 取全部前序；非单调时为 null；
   * - sorted：数组是否按 messageIndex 单调分组（非单调时调用方回退原始 filter，语义完全一致）。
   */
  const checkpointLookup = vueComputed(() => buildCheckpointLookup(state.checkpoints.value))

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

    // 前缀引用校验：缓存窗口是当前窗口的前缀且未被改写（含尾消息原地替换）时走增量
    const cache = todoReplayCache
    let prefixOk = false
    if (cache !== null && cache.messagesRef.length <= len) {
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
      anchorBackendIndex: result.anchorBackendIndex
    }
    return result
  })

  const getToolResponseById = (toolCallId: string) => getToolResponseByIdFn(state, toolCallId)
  const hasToolResponse = (toolCallId: string) => hasToolResponseFn(state, toolCallId)
  const getActualIndex = (displayIndex: number) => getActualIndexFn(state, computed, displayIndex)
  
  const cancelStreamAndRejectTools = () => cancelStreamAndRejectToolsFn(state, computed)
  const cancelStream = (options?: CancelStreamOptions) => cancelStreamFn(state, computed, options)
  const rejectPendingToolsWithAnnotation = (annotation: string) => 
    rejectPendingToolsWithAnnotationFn(state, computed, annotation)

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
  const clearMessages = () => clearMessagesFn(state)

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
      await createNewConvAction(state, cancelStreamAndRejectTools)
      void loadBranchGraphAction(state)
      return
    }

    // 创建新标签页
    const tabId = createTabAction(state, { title: 'New Chat' })
    if (tabId) {
      // 如果该标签页已存在（重复对话），直接切换
      const existingTab = state.openTabs.value.find(t => t.id === tabId)
      if (existingTab && existingTab.conversationId) {
        switchTabWrapped(tabId)
        return
      }
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

    // 在当前标签页中加载该对话
    await switchConvAction(state, id, cancelStreamAndRejectTools)
    void loadBranchGraphAction(state)

    // 更新当前标签页的信息
    if (state.activeTabId.value) {
      updateTabConversationId(state, state.activeTabId.value, id)
      const conv = state.conversations.value.find(c => c.id === id)
      if (conv) {
        updateTabTitle(state, state.activeTabId.value, conv.title)
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

  /**
   * 将消息加入排队队列
   */
  function enqueueMessage(content: string, attachments: Attachment[] = [], sendOptions?: QueuedMessage['sendOptions']): void {
    const item: QueuedMessage = {
      id: generateId(),
      content,
      attachments: [...attachments],
      timestamp: Date.now(),
      sendOptions,
      conversationId: state.currentConversationId.value
    }
    state.messageQueue.value = [...state.messageQueue.value, item]

    // 用户在响应期间发话：若当前会话正有前台命令在等待，将其转入后台，
    // 让本轮尽快结束、排队消息尽快送达（命令结果稍后以回执回流唤醒模型）。
    // fire-and-forget：后端没有可转移的命令时是 no-op。
    void sendToExtension('terminal.detachToBackground', {
      conversationId: state.currentConversationId.value
    }).catch(() => {})
  }

  /**
   * 取出队列第一条消息
   */
  function dequeueMessage(): QueuedMessage | null {
    const queue = state.messageQueue.value
    if (queue.length === 0) return null
    const first = queue[0]
    state.messageQueue.value = queue.slice(1)
    return first
  }

  /**
   * 取出队列中第一条属于指定会话的消息（无 conversationId 视为本会话消息）。
   *
   * 跨会话投递防护：跳过不属于当前会话的消息，取第一条属于当前会话的，
   * 避免跨会话消息卡死队头阻塞后续消息。processQueue 与 processQueueAfterAction
   * 共用此逻辑，返回剩余队列供调用方重新赋值。
   */
  function takeNextForConversation(
    queue: QueuedMessage[],
    conversationId: string | null
  ): { next: QueuedMessage; rest: QueuedMessage[] } | null {
    const matchIndex = queue.findIndex(m =>
      typeof m.conversationId !== 'string' || m.conversationId === conversationId
    )
    if (matchIndex === -1) return null
    const [next] = queue.splice(matchIndex, 1)
    return { next, rest: queue }
  }

  /**
   * 移除队列中指定消息
   */
  function removeQueuedMessage(id: string): void {
    state.messageQueue.value = state.messageQueue.value.filter(m => m.id !== id)
  }

  /**
   * 移动队列中的消息（拖拽排序）
   */
  function moveQueuedMessage(fromIndex: number, toIndex: number): void {
    const queue = [...state.messageQueue.value]
    if (fromIndex < 0 || fromIndex >= queue.length) return
    if (toIndex < 0 || toIndex >= queue.length) return
    if (fromIndex === toIndex) return

    const [item] = queue.splice(fromIndex, 1)
    queue.splice(toIndex, 0, item)
    state.messageQueue.value = queue
  }

  /**
   * 更新队列中指定消息的内容和附件（编辑）
   */
  function updateQueuedMessage(id: string, content: string, attachments: Attachment[]): void {
    state.messageQueue.value = state.messageQueue.value.map(m =>
      m.id === id
        ? { ...m, content, attachments: [...attachments] }
        : m
    )
  }

  /**
   * 立即发送队列中指定消息。
   * 正在响应时先把前台 SubAgent 转为后台，再取消旧回合并发送新消息。
   */
  async function sendQueuedMessageNow(id: string): Promise<void> {
    const item = state.messageQueue.value.find(m => m.id === id)
    if (!item) return

    // 从队列中移除
    removeQueuedMessage(id)

    // “立即发送”会替换当前回合；先要求后端同步解除前台 SubAgent 的父信号绑定，
    // 再取消旧流，避免子 Agent 在新流创建前已经被父级 abort 终止。
    if (state.isWaitingForResponse.value) {
      await cancelStream({ preserveSubAgents: true })
    }

    // 发送消息
    await sendMessage(item.content, item.attachments, item.sendOptions)
  }

  /**
   * 处理队列：AI 响应结束后自动取出下一条消息发送
   *
   * 在 handleComplete / handleCancelled / handleError 中被调用
   */
  async function processQueue(): Promise<void> {
    // 如果仍在响应中，不处理
    if (state.isWaitingForResponse.value) return

    // 跨会话投递防护：只投递属于当前会话的消息（无 conversationId 视为本会话），
    // 避免跨会话消息卡死队头阻塞后续消息
    const taken = takeNextForConversation(state.messageQueue.value, state.currentConversationId.value)
    if (!taken) return
    const { next, rest } = taken
    state.messageQueue.value = rest

    // 发送下一条排队消息；失败时放回队首（去重防死循环），
    // 避免「我排队的消息丢了」（M4）
    const sent = await sendMessage(next.content, next.attachments, next.sendOptions)
    if (!sent) {
      const currentQueue = state.messageQueue.value
      if (!currentQueue.some(m => m.id === next.id)) {
        state.messageQueue.value = [next, ...currentQueue]
      }
    }
  }

  /**
   * 自动投递进行中标记：防止 toolIteration 边界的连续触发重入
   * （cancelStream 的 IPC 往返是异步的，在 sendMessage 完成前禁止再次投递）。
   */
  let queueAfterActionDraining = false

  /**
   * 处理队列（动作边界，P1）：LLM 执行完当前动作（非终结 toolIteration，流继续）后
   * 立即自动取出下一条排队消息发送，不再等待整个回合完整结束。
   *
   * 与 sendQueuedMessageNow 完全同构（取消旧流替换当前回合 + 发送新回合），
   * 因此复用其全部安全保证：
   * 1. 动作彻底结束：toolIteration 由后端在工具结果 settleFunctionResponses/addContent
   *    全部落盘后才发出，当前动作已完整持久化，不存在半截动作；
   * 2. 历史不丢序：cancelStream({ preserveSubAgents: true }) 替换当前回合后，新流由
   *    webview 层 awaitOldStreamCompletion 与后端 waitForOldStreamExit 保证在旧流
   *    finally 完全退出（含工具结算落盘）后才写入新用户消息（H1 写序竞态防护），
   *    插入点之前的完整历史保持原样、不会丢失；
   * 3. 发送失败时把消息放回队首（保持原顺序），避免排队消息静默丢失；
   * 4. 跨会话防护与 processQueue 一致：只投递属于当前会话的消息；
   * 5. 投递窗口（cancelStream/sendMessage 的 IPC 往返）内会话切换或并发发送者
   *    抢先开启新流时，放弃本次投递并放回队列，杜绝「发错会话」与「排队消息
   *    降级为 inbox 中断（乱序且可能滞留不被送达）」。
   */
  async function processQueueAfterAction(): Promise<void> {
    // 投递进行中（cancelStream/sendMessage 未完成）不重入
    if (queueAfterActionDraining) return

    // 记录投递目标会话：cancelStream 往返期间用户可能切换会话，
    // 用取消息时的会话 ID 做归属校验（跨会话跳过逻辑与 processQueue 一致）
    const currentId = state.currentConversationId.value
    const taken = takeNextForConversation(state.messageQueue.value, currentId)
    if (!taken) return
    const { next, rest } = taken
    state.messageQueue.value = rest

    queueAfterActionDraining = true
    try {
      // 当前回合仍在响应中（动作边界必然如此，防御性判断以兼容迟到的调度）：
      // 替换当前回合前先把前台 SubAgent 转为后台，再取消旧流。
      if (state.isWaitingForResponse.value) {
        await cancelStream({ preserveSubAgents: true })
      }

      // 投递窗口内会话已切换（tab 切换）：放回队列——消息保留自身 conversationId，
      // 由跨会话跳过逻辑保护，绝不投递到错误会话。
      if (state.currentConversationId.value !== currentId) {
        state.messageQueue.value = [next, ...state.messageQueue.value]
        return
      }

      // 投递窗口内已有其他发送者（手动发送/后台任务回执/立即发送等）抢先开启新流：
      // 放回队列等下一个动作边界或回合终结时再试——此时 sendMessage 的忙时分支会把
      // 消息降级为 inbox 中断（乱序投递、4000 字符上限、回合无工具调用时可能滞留），
      // 不符合排队消息「成为真实新回合」的语义。
      if (state.isStreaming.value || state.isWaitingForResponse.value) {
        state.messageQueue.value = [next, ...state.messageQueue.value]
        return
      }

      const sent = await sendMessage(next.content, next.attachments, next.sendOptions)
      if (!sent) {
        // 发送未成功（IPC 失败 / 会话切换校验未过等）：放回队首保持原顺序，
        // 由下一个动作边界或回合终结时再次尝试，不静默丢弃排队消息。
        state.messageQueue.value = [next, ...state.messageQueue.value]
      }
    } finally {
      queueAfterActionDraining = false
    }
  }

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

    state.activeBuild.value = normalizedBuild

    if (options?.persist === false) return
    if (!conversationId) return

    // 防止把 A 对话的 Build 误写到 B 对话（切换竞态）
    if (normalizedBuild && normalizedBuild.conversationId !== conversationId) {
      return
    }

    try {
      await sendToExtension('conversation.setCustomMetadata', {
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
  const addCheckpoint = (checkpoint: any) => addCheckpointFn(state, checkpoint)
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
          await sendToExtension('cancelStream', { conversationId })
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
  
  async function initialize(): Promise<void> {
    // 幂等保护：重复调用（HMR/App 重挂载）时先注销旧订阅再重新注册，
    // 避免每条 streamChunk 被重复处理（文本重复追加、checkpoint 重复写入、tps 计数翻倍）。
    disposeChatStreamListener?.()

    disposeChatStreamListener = onMessageFromExtension((message) => {
      if (message.type === 'streamChunk') {
        handleStreamChunkWrapper(message.data)
      } else if (message.type === 'streamChunkBatch') {
        // 批量处理：对连续 toolStatus 做合并优化，其余逐条处理。
        // 整个批量在同一同步上下文完成，Vue 自动合并响应式更新。
        handleStreamChunkBatch(message.data as StreamChunk[], streamHandlerCtx)
      } else if (message.type === 'workspaceUri') {
        // 活动工作区变化广播：仅当当前对话未绑定工作区（或没有当前对话）时跟随。
        // 对话对象缺失（列表可能滞后）时保守处理——不覆盖，避免把已绑定对话的
        // 显示工作区改成别的项目。
        const conv = state.conversations.value.find(c => c.id === state.currentConversationId.value)
        const isBound = conv ? !!conv.workspaceUri : true
        if (!state.currentConversationId.value || !isBound) {
          setCurrentWorkspaceUri(state, message.data)
        }
      } else if (message.type === 'workspaceList') {
        setWorkspaceList(state, message.data)
      } else if (message.type === 'retryStatus') {
        handleRetryStatus(state, message.data)
      }
    })
    
    try {
      const wsData = await sendToExtension<any>('getWorkspaceList', {})
      setCurrentWorkspaceUri(state, wsData?.activeWorkspaceUri ?? null)
      setWorkspaceList(state, wsData?.workspaces ?? [])
    } catch {
      // 忽略错误
    }
    
    await loadSavedWorkspaces(state)
    
    await loadSavedConfigId(state)
    await loadCurrentConfig(state)
    await loadCheckpointConfig(state)
    await loadConversations()
    
    state.currentConversationId.value = null
    state.allMessages.value = []
    state.windowStartIndex.value = 0
    state.totalMessages.value = 0
    state.isLoadingMoreMessages.value = false
    state.historyFolded.value = false
    state.foldedMessageCount.value = 0
    state.toolResponseCache.value = new Map()

    // 初始化标签页：创建第一个空白标签页
    const initialTabId = createTabAction(state, { title: 'New Chat' })
    if (initialTabId) {
      state.activeTabId.value = initialTabId
    }
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
    checkpointLookup,
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
    rejectPendingToolsWithAnnotation,
    editAndRetry,
    deleteMessage,
    deleteSingleMessage,
    clearMessages,

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
    workspaceList: state.workspaceList,
    savedWorkspaces: state.savedWorkspaces,
    workspaceFilter: state.workspaceFilter,
    setCurrentWorkspaceUri: (uri: string | null) => setCurrentWorkspaceUri(state, uri),
    setWorkspaceList: (list: WorkspaceFolderInfo[]) => setWorkspaceList(state, list),
    setActiveWorkspace: (workspaceUri: string | null) => setActiveWorkspaceAction(state, workspaceUri),
    setWorkspaceFilter,
    loadSavedWorkspaces: () => loadSavedWorkspaces(state),
    removeSavedWorkspace: (fsPath: string) => removeSavedWorkspace(state, fsPath),
    openWorkspaceFolder: (fsPath?: string) => openWorkspaceFolderAction(state, fsPath),
    openSavedWorkspace: (entry: WorkspaceFolderInfo) => openSavedWorkspace(state, entry),
    saveCurrentWorkspace: () => saveCurrentWorkspace(state),
    
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
