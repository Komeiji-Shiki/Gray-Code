/**
 * Chat Store 类型定义
 */

import type { Ref, ComputedRef } from 'vue'
import type { Message, ErrorInfo, CheckpointSummary, Attachment, BranchStreamReplayContext } from '../../types'
import type { EditorNode } from '../../types/editorNode'
import type { SmoothMode } from '../../utils/smoothStream'

// 重新导出类型以供其他模块使用
// CPF-03: 新代码使用 CheckpointSummary；CheckpointRecord 保留导出（结构同构，兼容旧消费方）
export type { CheckpointSummary, CheckpointRecord, ErrorInfo, BranchStreamReplayContext } from '../../types'

/**
 * 对话摘要
 */
export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview?: string
  /** 是否已持久化到后端 */
  isPersisted: boolean
  /** 工作区 URI */
  workspaceUri?: string
  /** Storage integrity status from backend metadata */
  integrityStatus?: 'ok' | 'meta_missing' | 'meta_corrupt' | 'history_missing' | 'history_corrupt'
}

/**
 * 工作区筛选模式
 */
export type WorkspaceFilter = 'current' | 'all'

/**
 * 附件数据类型（用于发送到后端）
 */
export interface AttachmentData {
  id: string
  name: string
  type: 'image' | 'video' | 'audio' | 'document' | 'code'
  size: number
  mimeType: string
  data: string
  thumbnail?: string
}

/**
 * 重试状态
 */
export interface RetryStatus {
  isRetrying: boolean
  attempt: number
  maxAttempts: number
  error?: string
  errorDetails?: any
  nextRetryIn?: number
}

/**
 * 自动总结提示状态
 */
export interface AutoSummaryStatus {
  isSummarizing: boolean
  /** 来源：自动触发或手动触发 */
  mode?: 'auto' | 'manual'
  message?: string
}

/**
 * 配置详情
 */
export interface ConfigInfo {
  id: string
  name: string
  model: string
  type: string
  maxContextTokens?: number
}

// ============ 树状分支（TREE-10 候选切换器数据源） ============

/** 分支节点（后端 ConversationBranchNode 的前端投影，仅保留 UI 所需字段） */
export interface BranchNodeData {
  id: string
  parentId: string | null
  role: 'user' | 'model' | 'system'
  kind?: 'normal' | 'reroll' | 'edit' | 'continue' | 'imported' | 'exported'
  createdAt?: number
  timestamp?: number
  modelVersion?: string
  activeChildId?: string | null
  label?: string
  deleted?: boolean
  /** 轻量内容投影（仅用于候选摘要展示） */
  parts?: Array<{ text?: string; functionCall?: { name?: string } }>
  /** BCP-04：是否绑定工作区存档（后端 getBranchGraph/switchBranchCandidate 响应富化） */
  hasWorkspaceState?: boolean
  /** BCP-04：root→该节点路径上是否执行过写工具（后端富化，决策 1 判据之一） */
  wroteToWorkspace?: boolean
}

/** 候选摘要（后端 BranchCandidateSummary 投影） */
export interface BranchCandidateSummaryData {
  nodeId: string
  parentId: string | null
  kind?: string
  createdAt?: number
  timestamp?: number
  modelVersion?: string
  label?: string
  preview?: string
  deleted?: boolean
}

/** 分支图（后端 ConversationBranchGraph 投影，TREE-10 数据源） */
export interface BranchGraphData {
  version?: number
  rootNodeId: string | null
  activeTailNodeId: string | null
  activeChildId?: string | null
  nodes: Record<string, BranchNodeData>
  candidateSummaries?: BranchCandidateSummaryData[]
  exportedFrom?: { conversationId: string; nodeId: string }
}

// ============ Build（Plan 执行）相关 ============

export type BuildStatus = 'running' | 'done'

export interface BuildSession {
  id: string
  conversationId: string
  title: string
  planContent: string
  planPath?: string
  channelId?: string
  modelId?: string
  startedAt: number
  anchorBackendIndex?: number
  status: BuildStatus
}

/**
 * 排队消息（候选区）
 */
export interface QueuedMessage {
  id: string
  /**
   * 本条队列消息的发送选项。
   */
  sendOptions?: {
    dynamicContextStrategyOverride?: 'single' | 'preserve'
  }
  /** 序列化后的编辑器内容（包含 @上下文标记） */
  content: string
  /** 附件 */
  attachments: Attachment[]
  /** 入队时间戳 */
  timestamp: number
  /** 入队时的会话 ID（null 表示无会话归属，兜底兼容旧队列项） */
  conversationId: string | null
}

/**
 * 平滑流式显示条目：partKey 标识当前正在流出的段落（text/thought + part 索引），
 * text 为该段落的累计显示文本（含创建时的真实文本基线）。
 * MessageItem 只替换 partKey 匹配的块，找不到匹配就不替换（避免覆盖上一段已完成块）。
 */
export interface SmoothDisplayText {
  partKey: string
  text: string
}

/**
 * Chat Store 状态类型
 */
export interface ChatStoreState {
  /**
   * 已加载的对话摘要列表（仅元数据）
   *
   * 注意：为了提升大量历史对话时的启动速度，这里会分页加载。
   */
  conversations: Ref<Conversation[]>

  /** 所有已持久化对话 ID（用于分页加载） */
  persistedConversationIds: Ref<string[]>

  /** 已加载的持久化对话数量（游标/已加载条数） */
  persistedConversationsLoaded: Ref<number>

  /** 是否正在加载更多对话（滚动分页） */
  isLoadingMoreConversations: Ref<boolean>

  /** 当前对话ID */
  currentConversationId: Ref<string | null>
  /**
   * 当前对话的消息窗口（包括 functionResponse 消息）
   *
   * 注意：这是“窗口化”的消息列表，不保证从 0 开始，也不保证包含全量历史。
   * `Message.backendIndex`（绝对索引）用于与后端对齐。
   */
  allMessages: Ref<Message[]>
  /**
   * message.id -> allMessages 数组下标。
   *
   * 这是高频按消息 id 定位的派生索引，allMessages 仍是唯一消息真源。
   * 维护时保持 findIndex 的首命中语义，避免重复 id 的极端历史改变旧行为。
   */
  messageIndexById: Ref<Map<string, number>>
  /** 当前窗口的起始绝对索引（等于 allMessages[0].backendIndex） */
  windowStartIndex: Ref<number>
  /** 后端该对话的总消息数（绝对长度） */
  totalMessages: Ref<number>
  /** 是否正在上拉加载更早消息页 */
  isLoadingMoreMessages: Ref<boolean>
  /** 是否发生过“窗口折叠”（从顶部丢弃旧消息以释放资源） */
  historyFolded: Ref<boolean>
  /** 已折叠丢弃的消息条数（包含 functionResponse） */
  foldedMessageCount: Ref<number>
  /** 配置ID */
  configId: Ref<string>
  /** 当前会话选择的模型 ID（对话级隔离，不直接改全局渠道配置） */
  selectedModelId: Ref<string>
  /** 当前配置详情 */
  currentConfig: Ref<ConfigInfo | null>
  /** 加载状态 */
  isLoading: Ref<boolean>
  /** 流式响应状态 */
  isStreaming: Ref<boolean>
  /** 对话列表加载状态 */
  isLoadingConversations: Ref<boolean>
  /** 错误信息 */
  error: Ref<ErrorInfo | null>
  /** 当前流式消息ID */
  streamingMessageId: Ref<string | null>
  /** 当前流式请求 ID（用于过滤迟到/过期 chunk） */
  activeStreamId: Ref<string | null>
  /**
   * 平滑流式显示层：messageId -> 当前正在输出的段落（最后一个 text/thought part）的平滑文本。
   * 真实内容（parts/content）由流式累加，此 Map 只驱动显示节奏；
   * 流式结束/中止时由调用方 delete 对应键，UI 切回真实 content。
   */
  smoothTexts: Map<string, SmoothDisplayText>
  /**
   * 平滑档位（M1）：由 chatStore watch settingsStore.smoothStreaming 同步，
   * streamChunkHandlers 每 chunk 只读该 ref，不再内联 useSettingsStore()。
   * 测试 mock 状态可能不含此字段（读侧用可选链兜底为 'off'）。
   */
  smoothMode: Ref<SmoothMode>
  /** 等待AI响应状态 */
  isWaitingForResponse: Ref<boolean>
  /** 重试状态 */
  retryStatus: Ref<RetryStatus | null>
  /** 自动总结状态（用于显示“自动总结中”提示） */
  autoSummaryStatus: Ref<AutoSummaryStatus | null>
  /** 当前对话的检查点列表（CPF-03：轻量 CheckpointSummary，不含完整哈希映射） */
  checkpoints: Ref<CheckpointSummary[]>
  /** 存档点配置：是否合并无变更的存档点 */
  mergeUnchangedCheckpoints: Ref<boolean>
  /** 恢复预览进行中（恢复确认框打开前计算待删除文件清单） */
  isRestorePreviewing: Ref<boolean>
  /** 正在删除的对话 ID 集合 */
  deletingConversationIds: Ref<Set<string>>
  /** 当前工作区 URI */
  currentWorkspaceUri: Ref<string | null>
  /** 输入框内容 */
  inputValue: Ref<string>
  /** 工作区筛选模式 */
  workspaceFilter: Ref<WorkspaceFilter>
  /** 编辑器节点数组（包含文本和上下文徽章，用于对话级输入状态隔离） */
  editorNodes: Ref<EditorNode[]>
  /** 当前对话的附件列表 */
  attachments: Ref<Attachment[]>
  /** 当前对话的 Prompt 模式 ID（对话级隔离） */
  currentPromptModeId: Ref<string>

  /** 当前 Build 会话（用于 Plan 执行 UI 展示） */
  activeBuild: Ref<BuildSession | null>

  /**
   * 当前回合的模型覆盖（仅对本轮流式/工具确认生效）
   *
   * 用于：Plan 执行时选择“渠道 + 模型”，并在 toolConfirmation 时保持一致。
   */
  pendingModelOverride: Ref<string | null>

  /**
   * 当前回合的一次性渠道覆盖（仅对本轮流式/工具确认生效）
   *
   * Plan 等「仅本次使用所选渠道」场景：chatStream/toolConfirmation 的 configId
   * 改用该值，但绝不写后端全局 activeChannelId、也不写对话元数据。
   * 回合结束（complete/cancelled/error）时与 pendingModelOverride 一并清除。
   */
  pendingConfigIdOverride: Ref<string | null>

  /** 消息排队队列（候选区） */
  messageQueue: Ref<QueuedMessage[]>

  /** 上一次被 cancelStream 取消的 streamingMessageId（用于防止迟到的 cancelled/error chunk 误清新请求状态） */
  _lastCancelledStreamId: Ref<string | null>

  /** 最近一个因审批门闸停止的 streamId（用于迟到 chunk 诊断） */
  _lastApprovalGatedStreamId: Ref<string | null>

  /**
   * 最近一次流式失败时保留在窗口中的半截 assistant 消息 ID（localOnly，后端未持久化）。
   * retryAfterError 据此回滚失败残留，避免重试后窗口/历史出现半截回答。
   */
  _failedStreamMessageId: Ref<string | null>

  /**
   * reroll/编辑分支流结束标记（TREE-01/TREE-03 前端接入）：retryFromMessage / editAndRetry /
   * restoreAndRetry / restoreAndEdit 发起 chat.rerollStream / chat.editBranchStream 前置位
   * （值为发起流的会话 ID）；streamHandler 在终结事件（complete/终结性 toolIteration/error/cancelled）
   * 且该会话为当前会话时据此刷新分支图并复位——新候选落图后 BranchSwitcherBar 才能显示「‹ 2/2 ›」切换器。
   * 会话已切换时标记保持惰性（不被其他会话的终结 chunk 消费），避免误刷其他会话的分支图。
   */
  _pendingBranchRefreshAfterStream: Ref<string | null>

  /**
   * 当前 reroll / 编辑分支流的原请求快照。
   * 仅在流进行期间存在；成功/取消时丢弃，失败时转存到 ErrorInfo.branchReplayContext 后清空。
   */
  _pendingBranchReplayContext: Ref<BranchStreamReplayContext | null>

  // ============ 多对话标签页 ============

  /** 当前打开的标签页列表（有序） */
  openTabs: Ref<TabInfo[]>

  /** 当前激活的标签页 ID */
  activeTabId: Ref<string | null>

  /** 后台标签页的会话快照（tabId -> snapshot） */
  sessionSnapshots: Ref<Map<string, ConversationSessionSnapshot>>

  /** 后台对话的流式缓冲区（conversationId -> chunks） */
  backgroundStreamBuffers: Ref<Map<string, import('../../types').StreamChunk[]>>

  /** 工具响应缓存：toolCallId -> response，避免 getToolResponseById 的 O(M) 线性扫描 */
  toolResponseCache: Ref<Map<string, Record<string, unknown>>>

  /**
   * functionResponse.id -> allMessages 数组下标。
   * 随消息写入维护的权威索引，让 getToolResponseById 退化为纯 O(1) 查表。
   */
  toolResponseIndex: Ref<Map<string, number>>

  // ============ 树状分支（TREE-10） ============

  /** 当前对话的分支图（null = 无图 / 线性模式 / 损坏降级） */
  branchGraph: Ref<BranchGraphData | null>
  /** 分支图拉取中 */
  branchGraphLoading: Ref<boolean>
  /** 分支切换 / 候选删除进行中（TREE-07：切换期间锁定切换器交互） */
  isSwitchingBranch: Ref<boolean>
}

/**
 * Chat Store 计算属性类型
 */
export interface ChatStoreComputed {
  /** 当前对话 */
  currentConversation: ComputedRef<Conversation | null>
  /** 排序后的对话列表 */
  sortedConversations: ComputedRef<Conversation[]>
  /** 按工作区筛选后的对话列表 */
  filteredConversations: ComputedRef<Conversation[]>
  /** 用于显示的消息列表（过滤掉纯 functionResponse 消息） */
  messages: ComputedRef<Message[]>
  /** 是否有消息 */
  hasMessages: ComputedRef<boolean>
  /** 是否显示空状态 */
  showEmptyState: ComputedRef<boolean>
  /** 当前模型名称 */
  currentModelName: ComputedRef<string>
  /** 最大上下文 Tokens */
  maxContextTokens: ComputedRef<number>
  /** 当前使用的 Tokens */
  usedTokens: ComputedRef<number>
  /** Token 使用百分比 */
  tokenUsagePercent: ComputedRef<number>
  /** 是否需要显示"继续对话"按钮 */
  needsContinueButton: ComputedRef<boolean>
  /** 是否有待确认的工具调用 */
  hasPendingToolConfirmation: ComputedRef<boolean>
  /** 待确认的工具列表 */
  pendingToolCalls: ComputedRef<import('../../types').ToolUsage[]>
}

// ============ 多对话标签页相关 ============

/**
 * 对话会话快照 - 切换标签页时保存/恢复的每对话状态
 */
export interface ConversationSessionSnapshot {
  /** 对话 ID */
  conversationId: string | null
  /** 消息列表 */
  allMessages: Message[]
  /** 窗口起始索引 */
  windowStartIndex: number
  /** 当前会话选择的配置 ID（渠道） */
  configId: string
  /** 当前会话选择的模型 ID */
  selectedModelId: string
  /** 总消息数 */
  totalMessages: number
  /** 是否正在加载更多消息 */
  isLoadingMoreMessages: boolean
  /** 是否流式中 */
  isStreaming: boolean
  /** 是否加载中 */
  isLoading: boolean
  /** 流式消息 ID */
  streamingMessageId: string | null
  /** 当前流式请求 ID */
  activeStreamId: string | null
  /** 是否等待响应 */
  isWaitingForResponse: boolean
  /** 检查点列表 */
  checkpoints: CheckpointSummary[]
  /** Build 会话 */
  activeBuild: BuildSession | null
  /** 错误信息 */
  error: ErrorInfo | null
  /** 重试状态 */
  retryStatus: RetryStatus | null
  /** 自动总结状态 */
  autoSummaryStatus: AutoSummaryStatus | null
  /** 是否已折叠 */
  historyFolded: boolean
  /** 折叠消息数 */
  foldedMessageCount: number
  /** 输入框内容 */
  inputValue: string
  /** 模型覆盖 */
  pendingModelOverride: string | null
  /** 一次性渠道覆盖（仅对本轮流式/工具确认生效） */
  pendingConfigIdOverride: string | null
  /** 编辑器节点（富文本状态，包含上下文徽章） */
  editorNodes: EditorNode[]
  /** 附件列表 */
  attachments: Attachment[]
  /** 消息排队队列 */
  messageQueue: QueuedMessage[]
  /** Prompt 模式 ID */
  currentPromptModeId: string
  /** 工具响应缓存快照（toolCallId -> response 条目数组，用于新 Map 重建） */
  toolResponseCache: Array<[string, Record<string, unknown>]>
  /** reroll / 编辑分支流完成后待刷新的会话 ID（标签页切换期间保持） */
  pendingBranchRefreshAfterStream?: string | null
  /** 当前分支流的原请求快照（标签页切换期间保持） */
  pendingBranchReplayContext?: BranchStreamReplayContext | null
  /** 分支图快照（TREE-12：切标签页回来恢复分支视图状态；null = 无图/线性模式） */
  branchGraph: BranchGraphData | null
}

/**
 * 标签页信息
 */
export interface TabInfo {
  /** 标签页唯一 ID */
  id: string
  /** 关联的对话 ID（null 表示新空白对话） */
  conversationId: string | null
  /** 显示标题 */
  title: string
  /** 是否正在流式响应中 */
  isStreaming: boolean
}
