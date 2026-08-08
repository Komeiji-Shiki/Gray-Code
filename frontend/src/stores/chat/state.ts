/**
 * Chat Store 状态定义
 */

import { reactive, ref } from 'vue'
import type { Message, ErrorInfo } from '../../types'
import type { CheckpointSummary } from '../../types'
import type { Attachment } from '../../types'
import type { StreamChunk } from '../../types'
import type { EditorNode } from '../../types/editorNode'
import type {
  Conversation,
  WorkspaceFilter,
  RetryStatus,
  AutoSummaryStatus,
  ConfigInfo,
  BuildSession,
  ChatStoreState,
  TabInfo,
  ConversationSessionSnapshot,
  QueuedMessage,
  BranchGraphData,
  BranchStreamReplayContext
} from './types'
import { clearVisibleChatMessagesCache } from './windowUtils'
import type { SmoothMode } from '../../utils/smoothStream'

export type MessageIndexState = Pick<ChatStoreState, 'allMessages' | 'messageIndexById' | 'toolResponseIndex'>
export type MessageIndexLookupState = Pick<ChatStoreState, 'allMessages'> & Partial<Pick<ChatStoreState, 'messageIndexById' | 'toolResponseIndex'>>

function hasMessageIndexState(state: MessageIndexLookupState): state is MessageIndexState {
  return state.messageIndexById?.value instanceof Map
}

type NodeLikeGlobal = typeof globalThis & {
  process?: {
    env?: {
      NODE_ENV?: string
    }
  }
}

const SHOULD_ASSERT_MESSAGE_INDEX_INVARIANT = (() => {
  const nodeEnv = (globalThis as NodeLikeGlobal).process?.env?.NODE_ENV
  return nodeEnv === 'development' || nodeEnv === 'test'
})()

function getMessageIndexMap(state: MessageIndexLookupState): Map<string, number> | null {
  return hasMessageIndexState(state) ? state.messageIndexById.value : null
}

let messageIndexAssertionCounter = 0

function assertMessageIndexInvariant(state: MessageIndexLookupState): void {
  if (!SHOULD_ASSERT_MESSAGE_INDEX_INVARIANT || !hasMessageIndexState(state)) return
  // dev/test 下每次 append 都重建整表校验是 O(n)：抽样降频（每 50 次校验一次），
  // 保持防护能力的同时避免长会话流式期间的无谓开销
  messageIndexAssertionCounter++
  if (messageIndexAssertionCounter % 50 !== 0) return

  const expected = buildMessageIndexById(state.allMessages.value)
  const actual = state.messageIndexById.value
  const isConsistent =
    expected.size === actual.size &&
    Array.from(expected.entries()).every(([messageId, index]) => actual.get(messageId) === index)

  console.assert(isConsistent, '[chat/state] messageIndexById invariant violated', {
    expected: Array.from(expected.entries()),
    actual: Array.from(actual.entries()),
    messageIds: state.allMessages.value.map(message => message.id)
  })
}

/** 为当前 allMessages 重建 message.id -> 首次出现位置 的索引，保持 findIndex 的首命中语义。 */
export function buildMessageIndexById(messages: Message[]): Map<string, number> {
  const indexById = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const messageId = messages[i]?.id
    if (typeof messageId !== 'string' || messageId.length === 0) continue

    if (!indexById.has(messageId)) {
      indexById.set(messageId, i)
    }
  }

  return indexById
}

/**
 * 为当前 allMessages 重建 functionResponse.id -> 消息下标 的索引。
 * 只收录首命中记录，保持 O(1) 查表时的一致性语义。
 */
export function buildToolResponseIndex(messages: Message[]): Map<string, number> {
  const index = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message?.isFunctionResponse || !Array.isArray(message.parts)) continue

    for (const part of message.parts) {
      const frId = part.functionResponse?.id
      if (typeof frId === 'string' && frId.length > 0 && !index.has(frId)) {
        index.set(frId, i)
      }
    }
  }

  return index
}

/** 集中重建索引，供数组整体替换、tab restore、历史重载等路径校正 messageIndexById 与 toolResponseIndex。 */
export function rebuildMessageIndexById(state: MessageIndexLookupState): void {
  if (!hasMessageIndexState(state)) return

  state.messageIndexById.value = buildMessageIndexById(state.allMessages.value)
  if (state.toolResponseIndex) {
    state.toolResponseIndex.value = buildToolResponseIndex(state.allMessages.value)
  }
  assertMessageIndexInvariant(state)
}

export function replaceAllMessages(state: MessageIndexLookupState, messages: Message[]): void {
  state.allMessages.value = messages
  rebuildMessageIndexById(state)
}

export function appendMessage(state: MessageIndexLookupState, message: Message): void {
  const nextIndex = state.allMessages.value.length
  state.allMessages.value.push(message)

  if (!hasMessageIndexState(state)) return

  const messageId = message?.id
  if (typeof messageId === 'string' && messageId.length > 0 && !state.messageIndexById.value.has(messageId)) {
    state.messageIndexById.value.set(messageId, nextIndex)
  }

  // 增量维护 toolResponseIndex：新写入的 functionResponse 消息直接注册
  if (
    state.toolResponseIndex &&
    message?.isFunctionResponse &&
    Array.isArray(message.parts)
  ) {
    for (const part of message.parts) {
      const frId = part.functionResponse?.id
      if (typeof frId === 'string' && frId.length > 0 && !state.toolResponseIndex.value.has(frId)) {
        state.toolResponseIndex.value.set(frId, nextIndex)
      }
    }
  }

  assertMessageIndexInvariant(state)
}

export function insertMessageAt(state: MessageIndexLookupState, index: number, message: Message): void {
  const boundedIndex = Math.max(0, Math.min(index, state.allMessages.value.length))
  const isPureAppend = boundedIndex >= state.allMessages.value.length
  state.allMessages.value.splice(boundedIndex, 0, message)
  rebuildMessageIndexById(state)

  // L1：中间位置插入（splice 原地改数组、首尾元素不变）会命中 windowUtils 的
  // 可见消息增量缓存——指纹只校验首尾元素，会把被插入的消息漏掉并把旧尾元素
  // 重复 concat 一次。与 replaceMessageAt 的中间替换处理对齐：非纯尾部追加一律
  // 清除缓存。典型场景：handleAutoSummary 在流式过程中把总结消息插到窗口中间。
  if (!isPureAppend) {
    clearVisibleChatMessagesCache(state as unknown as ChatStoreState)
  }
}

export function replaceMessageAt(state: MessageIndexLookupState, index: number, nextMessage: Message): void {
  if (index < 0 || index >= state.allMessages.value.length) return

  const currentMessage = state.allMessages.value[index]
  state.allMessages.value[index] = nextMessage

  if (currentMessage?.id !== nextMessage.id) {
    rebuildMessageIndexById(state)
    return
  }

  // L1：中间位置的同长度替换（首尾元素不变）会命中 windowUtils 的可见消息增量缓存
  // （指纹只校验首尾元素）。典型场景：迟到的旧请求 cancelled chunk 清理旧消息元数据。
  // 只有尾元素替换才是流式原地更新的安全模式，其余一律清除缓存。
  if (index !== state.allMessages.value.length - 1) {
    clearVisibleChatMessagesCache(state as unknown as ChatStoreState)
  }

  assertMessageIndexInvariant(state)
}

export function removeMessageAt(state: MessageIndexLookupState, index: number): void {
  if (index < 0 || index >= state.allMessages.value.length) return

  state.allMessages.value.splice(index, 1)
  rebuildMessageIndexById(state)
}

/**
 * messageIndexById 的统一查询入口。
 * 主路径走 Map；索引缺失或失配时回退到 findIndex，并在真实 store 中重建整表索引。
 */
export function getMessageIndexById(state: MessageIndexLookupState, messageId: string | null | undefined): number {
  if (!messageId) return -1

  const messages = state.allMessages.value
  const indexMap = getMessageIndexMap(state)
  const indexed = indexMap?.get(messageId)
  if (
    typeof indexed === 'number' &&
    indexed >= 0 &&
    indexed < messages.length &&
    messages[indexed]?.id === messageId
  ) {
    return indexed
  }

  const fallbackIndex = messages.findIndex(message => message.id === messageId)
  if (fallbackIndex === -1) {
    return -1
  }

  if (!indexMap || !state.messageIndexById) {
    return fallbackIndex
  }

  rebuildMessageIndexById(state)
  return state.messageIndexById.value.get(messageId) ?? fallbackIndex
}

/**
 * 创建 Chat Store 状态
 */
export function createChatState(): ChatStoreState {
  /**
   * 已加载的对话摘要列表（仅元数据）
   *
   * 注意：为了提升大量历史对话时的启动速度，这里会分页加载。
   */
  const conversations = ref<Conversation[]>([])

  /** 所有已持久化对话 ID（用于分页加载） */
  const persistedConversationIds = ref<string[]>([])

  /** 已加载的持久化对话数量（游标/已加载条数） */
  const persistedConversationsLoaded = ref(0)

  /** 是否正在加载更多对话（滚动分页） */
  const isLoadingMoreConversations = ref(false)
  
  /** 当前对话ID */
  const currentConversationId = ref<string | null>(null)
  
  /**
   * 当前对话的消息窗口（包括 functionResponse 消息）
   *
   * 注意：为降低超长历史带来的卡顿，前端只保留一个“窗口”。
   * 每条消息的绝对索引通过 Message.backendIndex 对齐后端历史。
   */
  const allMessages = ref<Message[]>([])

  /**
   * message.id -> allMessages 数组下标。
   * allMessages 仍是唯一消息真源；该 Map 只服务高频按 id 定位，并维持首命中语义。
   */
  const messageIndexById = ref<Map<string, number>>(new Map())

  /** 当前窗口的起始绝对索引（对应 allMessages[0].backendIndex） */
  const windowStartIndex = ref(0)

  /** 后端该对话的总消息数（用于判断是否还能加载更早消息） */
  const totalMessages = ref(0)

  /** 是否正在上拉加载更早消息页 */
  const isLoadingMoreMessages = ref(false)

  /** 是否发生过“窗口折叠”（用于 UI 提示） */
  const historyFolded = ref(false)

  /** 已折叠丢弃的消息条数（包含 functionResponse） */
  const foldedMessageCount = ref(0)
  
  /** 配置ID */
  const configId = ref('gemini-pro')

  /** 当前会话选择的模型 ID（对话级隔离） */
  const selectedModelId = ref('')
  
  /** 当前配置详情（包含模型名称） */
  const currentConfig = ref<ConfigInfo | null>(null)
  
  /** 加载状态 */
  const isLoading = ref(false)
  
  /** 流式响应状态 */
  const isStreaming = ref(false)
  
  /** 对话列表加载状态 */
  const isLoadingConversations = ref(false)
  
  /** 错误信息 */
  const error = ref<ErrorInfo | null>(null)
  
  /** 当前流式消息ID */
  const streamingMessageId = ref<string | null>(null)

  /**
   * 平滑流式显示层：messageId -> 当前正在输出的段落（最后一个 text/thought part）的平滑文本。
   * reactive Map：高频 commit（约 32ms 一次）直接 .set/.delete，无需整体替换。
   */
  const smoothTexts = reactive(new Map<string, import('./types').SmoothDisplayText>())

  /**
   * 平滑档位（M1）：默认 'balanced'，由 chatStore watch settingsStore.smoothStreaming 同步。
   * streamChunkHandlers 每 chunk 只读本 ref，不再内联 useSettingsStore()（高频调用 + try/catch 吞错）。
   */
  const smoothMode = ref<SmoothMode>('balanced')

  /** 当前流式请求 ID（用于过滤迟到/过期 chunk） */
  const activeStreamId = ref<string | null>(null)
  
  /** 等待AI响应状态 - 用于显示等待动画 */
  const isWaitingForResponse = ref(false)
  
  /** 重试状态 */
  const retryStatus = ref<RetryStatus | null>(null)

  /** 自动总结状态（用于显示“自动总结中”提示） */
  const autoSummaryStatus = ref<AutoSummaryStatus | null>(null)
  
  /** 当前对话的检查点列表（CPF-03：轻量 CheckpointSummary） */
  const checkpoints = ref<CheckpointSummary[]>([])
  
  /** 存档点配置：是否合并无变更的存档点 */
  const mergeUnchangedCheckpoints = ref(true)

  /** 恢复预览进行中（计算待删除文件清单，供确认框展示） */
  const isRestorePreviewing = ref(false)
  
  /** 正在删除的对话 ID 集合（用于防止重复删除） */
  const deletingConversationIds = ref<Set<string>>(new Set())
  
  /** 当前工作区 URI */
  const currentWorkspaceUri = ref<string | null>(null)
  
  /** 输入框内容（跨视图保持） */
  const inputValue = ref('')
  
  /** 工作区筛选模式（默认当前工作区） */
  const workspaceFilter = ref<WorkspaceFilter>('current')

  /** 当前 Build 会话（Plan 执行） */
  const activeBuild = ref<BuildSession | null>(null)

  /** 当前回合模型覆盖（用于 Plan 执行的“渠道 + 模型”选择） */
  const pendingModelOverride = ref<string | null>(null)

  /** 当前回合一次性渠道覆盖（Plan 等「仅本次使用所选渠道」场景，不写全局设置） */
  const pendingConfigIdOverride = ref<string | null>(null)

  /** 消息排队队列（候选区） */
  const messageQueue = ref<QueuedMessage[]>([])

  /** 上一次被 cancelStream 取消的 streamingMessageId */
  const _lastCancelledStreamId = ref<string | null>(null)

  /** 最近一个因审批门闸停止的 streamId */
  const _lastApprovalGatedStreamId = ref<string | null>(null)

  /** 最近一次流式失败时保留的半截 assistant 消息 ID（retryAfterError 回滚用） */
  const _failedStreamMessageId = ref<string | null>(null)

  /**
   * reroll/编辑分支流结束后需要刷新分支图（TREE-01/TREE-03 前端接入）。
   * 值为发起该流的会话 ID：仅当该会话成为当前会话且收到终结 chunk 时才消费（避免跨会话误刷）；
   * 流启动失败 / 会话切换兜底路径显式复位为 null。
   */
  const _pendingBranchRefreshAfterStream = ref<string | null>(null)

  /** 当前分支流的重放请求快照；终结时由 streamHandler 清理或转存到错误对象 */
  const _pendingBranchReplayContext = ref<BranchStreamReplayContext | null>(null)

  /** 编辑器节点数组（包含文本和上下文徽章，用于对话级输入状态隔离） */
  const editorNodes = ref<EditorNode[]>([])

  /** 当前对话的附件列表 */
  const attachments = ref<Attachment[]>([])

  /** 当前对话的 Prompt 模式 ID（对话级隔离，默认 'code'） */
  const currentPromptModeId = ref('code')

  // ============ 多对话标签页 ============

  /** 当前打开的标签页列表 */
  const openTabs = ref<TabInfo[]>([])

  /** 当前激活的标签页 ID */
  const activeTabId = ref<string | null>(null)

  /** 后台标签页的会话快照 */
  const sessionSnapshots = ref<Map<string, ConversationSessionSnapshot>>(new Map())

  /** 后台对话的流式缓冲区 */
  const backgroundStreamBuffers = ref<Map<string, StreamChunk[]>>(new Map())

  /** 工具响应缓存：toolCallId -> response，避免 O(M) 线性扫描 */
  const toolResponseCache = ref<Map<string, Record<string, unknown>>>(new Map())

  /** functionResponse.id -> 消息下标，随消息写入维护的权威索引 */
  const toolResponseIndex = ref<Map<string, number>>(new Map())

  // ============ 树状分支（TREE-10） ============

  /** 当前对话的分支图（null = 无图 / 线性模式 / 损坏降级） */
  const branchGraph = ref<BranchGraphData | null>(null)

  /** 分支图拉取中 */
  const branchGraphLoading = ref(false)

  /** 分支切换 / 候选删除进行中（TREE-07：切换期间锁定切换器交互） */
  const isSwitchingBranch = ref(false)

  return {
    conversations,
    persistedConversationIds,
    persistedConversationsLoaded,
    isLoadingMoreConversations,
    currentConversationId,
    allMessages,
    messageIndexById,
    toolResponseIndex,
    windowStartIndex,
    totalMessages,
    isLoadingMoreMessages,
    historyFolded,
    foldedMessageCount,
    configId,
    selectedModelId,
    currentConfig,
    isLoading,
    isStreaming,
    isLoadingConversations,
    error,
    streamingMessageId,
    activeStreamId,
    smoothTexts,
    smoothMode,
    isWaitingForResponse,
    retryStatus,
    autoSummaryStatus,
    checkpoints,
    mergeUnchangedCheckpoints,
    isRestorePreviewing,
    deletingConversationIds,
    currentWorkspaceUri,
    inputValue,
    workspaceFilter,
    activeBuild,
    editorNodes,
    attachments,
    currentPromptModeId,
    pendingModelOverride,
    pendingConfigIdOverride,
    messageQueue,
    _lastCancelledStreamId,
    _lastApprovalGatedStreamId,
    _failedStreamMessageId,
    _pendingBranchRefreshAfterStream,
    _pendingBranchReplayContext,
    openTabs,
    activeTabId,
    sessionSnapshots,
    backgroundStreamBuffers,
    toolResponseCache,
    branchGraph,
    branchGraphLoading,
    isSwitchingBranch
  }
}
