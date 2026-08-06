/**
 * GrayCode 前端类型定义
 */

// ============ 消息相关类型 ============

/**
 * ContentPart - Gemini API 内容片段
 */
export interface ContentPart {
  text?: string
  inlineData?: {
    mimeType: string
    data: string  // Base64
  }
  fileData?: {
    mimeType: string
    fileUri: string
    displayName?: string
  }
  functionCall?: {
    name: string
    args: Record<string, unknown>
    id?: string
    /**
     * 是否已被用户拒绝执行
     *
     * 当用户在工具等待确认时点击终止按钮，此字段会被设置为 true
     * 用于在重新加载对话时正确显示工具状态
     */
    rejected?: boolean
    /**
     * 流式响应中的索引 (OpenAI 格式)
     */
    index?: number
    /**
     * Responses API 的 output item 内部 ID。
     *
     * 前端只把 itemId 当作同一轮流式工具调用的内部合并键，不把它当作最终工具调用 ID。
     */
    itemId?: string
    /**
     * 标记 partialArgs 是完整 arguments，而不是 delta。
     *
     * arguments.done/output_item.done 给的是完整 JSON，合并时看到 finalArgs 就覆盖已有 partialArgs。
     */
    finalArgs?: boolean
    /**
     * 流式响应中的原始参数片段
     */
    partialArgs?: string
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
    id?: string  // 用于匹配工具调用请求
    parts?: ContentPart[]
  }
  thoughtSignature?: string
  thought?: boolean
}

/**
 * Token 详情条目
 */
export interface TokenDetailsEntry {
  /** 模态类型: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" */
  modality: string
  /** Token 数量 */
  tokenCount: number
}

/**
 * Token 使用统计（Gemini usageMetadata 格式）
 */
export interface UsageMetadata {
  /** 输入 prompt 的 token 数量 */
  promptTokenCount?: number
  
  /** 候选输出内容的 token 数量 */
  candidatesTokenCount?: number
  
  /** 总 token 数量 */
  totalTokenCount?: number
  
  /** 缓存内容的 token 数量（写入缓存 + 命中缓存） */
  cachedContentTokenCount?: number

  /** 缓存写入的 token 数量（Anthropic cache_creation_input_tokens） */
  cacheCreationTokenCount?: number

  /** 缓存命中的 token 数量（Anthropic cache_read_input_tokens / OpenAI cached_tokens / Gemini cachedContentTokenCount） */
  cacheReadTokenCount?: number
  
  /** 思考部分的 token 数量 */
  thoughtsTokenCount?: number
  
  /** Prompt token 详情（按模态分类） */
  promptTokensDetails?: TokenDetailsEntry[]
  
  /** 候选输出 token 详情（按模态分类，如 IMAGE、TEXT 等） */
  candidatesTokensDetails?: TokenDetailsEntry[]
}

export interface SummaryTokenStats {
  sourceTokenCount: number
  summaryTokenCount: number
  estimatedTokensSaved: number
  contextTokenCountBefore?: number
  estimatedContextTokenCountAfter?: number
}

/**
 * Content - Gemini API 消息格式
 */
export interface Content {
  role: 'user' | 'model'
  parts: ContentPart[]
  /** 后端持久化的稳定消息节点 ID；分支操作必须使用该值，不能使用前端流式占位 ID。 */
  id?: string
  /** 主历史中的父消息节点 ID（首条为 null）。 */
  parentId?: string | null
  /**
   * 消息在后端历史记录中的索引
   *
   * 由后端在返回消息时填充，前端在删除/重试时直接使用此索引
   */
  index?: number
  /** 模型版本（仅 model 消息有值），如 "gemini-2.5-flash" */
  modelVersion?: string
  /** Token 使用统计（仅 model 消息有值） */
  usageMetadata?: UsageMetadata
  summaryTokenStats?: SummaryTokenStats
  /** 系统内部消息来源；background_task 用于恢复后台任务卡片并排除新回合语义。 */
  source?: 'user' | 'background_task'
  /** 是否为函数响应消息 */
  isFunctionResponse?: boolean
  /** 是否为上下文总结消息 */
  isSummary?: boolean
  /** 总结消息覆盖的消息数量 */
  summarizedMessageCount?: number
  /** 是否为自动触发的总结消息 */
  isAutoSummary?: boolean
  /** 该消息已被上下文总结覆盖（逻辑截断）：原文保留、仍可显示/搜索，但不参与发送给 AI */
  isSummarized?: boolean
  /**
   * 思考开始时间戳（毫秒）
   *
   * 仅在流式响应过程中使用，用于前端实时显示思考时间
   * 完成后会被移除，只保留 thinkingDuration
   */
  thinkingStartTime?: number
  /**
   * 思考持续时间（毫秒）
   *
   * 仅对包含思考内容的 model 消息有值
   * 由后端计算并保存，记录从收到第一个思考块到收到第一个非思考内容块之间的时间
   */
  thinkingDuration?: number
  /**
   * 响应持续时间（毫秒）
   *
   * 从发出请求到响应正常结束的时间
   */
  responseDuration?: number
  /**
   * 第一个流式块时间戳（毫秒）
   *
   * 用于计算 Token 速率
   */
  firstChunkTime?: number
  /**
   * 流式响应持续时间（毫秒）
   *
   * 从收到第一个流式块到响应结束的时间
   */
  streamDuration?: number
  /**
   * 流式块数量
   *
   * 用于判断是否只有一个块
   */
  chunkCount?: number
  /**
   * 消息创建时间戳（毫秒）
   *
   * 用于前端显示消息发送时间
   */
  timestamp?: number
  /** @deprecated 使用 usageMetadata.thoughtsTokenCount */
  thoughtsTokenCount?: number
  /** @deprecated 使用 usageMetadata.candidatesTokenCount */
  candidatesTokenCount?: number
}

/**
 * Message - 前端展示用的消息格式
 *
 * 存储架构：
 * - allMessages: 存储所有消息，包括 functionResponse 消息，索引与后端一一对应
 * - messages: 计算属性，过滤掉 functionResponse 消息，用于显示
 *
 * 工具调用和响应通过 id 字段匹配，无需额外的索引映射
 */
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
  /**
   * 主历史中的父消息节点 ID（BR-01：首条消息为 null）。
   * 前端据此识别根节点——编辑根节点时无父节点可挂编辑候选，自动降级为「原地保存」。
   */
  parentId?: string | null
  /**
   * 消息来源：'user' 为正常用户输入，'background_task' 为后台任务回流
   */
  source?: 'user' | 'background_task'
  /**
   * 该消息在后端历史中的绝对索引（Content.index）
   *
   * - 从后端加载的历史消息：应当有值
   * - 流式阶段的本地占位消息：可能暂时为空（localOnly=true），等后端落库并回传后再补齐
   */
  backendIndex?: number
  attachments?: Attachment[]
  metadata?: MessageMetadata
  streaming?: boolean
  /**
   * 是否为仅前端临时存在的消息（后端历史未必包含）
   *
   * 典型场景：发送请求时创建的 assistant 占位消息；若网络中断/代理断开导致后端未持久化，
   * 则该消息会一直处于 localOnly 状态。对这类消息进行 retry/delete 时必须避免把
   * allMessages 的数组下标当作后端索引，否则会触发 messageIndexOutOfBounds。
   */
  localOnly?: boolean
  parts?: ContentPart[]  // 保留原始 Gemini 格式
  toolCalls?: ToolCall[]  // 工具调用列表
  toolResults?: ToolResult[]  // 工具执行结果
  tools?: ToolUsage[]  // 工具使用信息（合并后的数据）
  /**
   * 是否为 functionResponse 消息
   *
   * 这类消息在消息列表中隐藏，但用于和工具调用配对。
   * 工具调用和响应通过 ToolUsage.id / functionResponse.id 匹配。
   */
  isFunctionResponse?: boolean
  /**
   * 是否为上下文总结消息
   *
   * 总结消息以特殊样式显示，包含之前对话的压缩摘要
   */
  isSummary?: boolean
  /**
   * 总结消息覆盖的消息数量
   */
  summarizedMessageCount?: number
  /** 主上下文压缩统计；与总结模型请求 usage 分离。 */
  summaryTokenStats?: SummaryTokenStats
  /** 是否为自动触发的总结消息 */
  isAutoSummary?: boolean
  /** 该消息已被上下文总结覆盖（逻辑截断）：原文保留、仍可显示/搜索，但不参与发送给 AI */
  isSummarized?: boolean
}

export interface MessageMetadata {
  /** 模型版本，如 "gemini-2.5-flash" */
  modelVersion?: string
  /** @deprecated 使用 modelVersion */
  model?: string
  tokens?: number
  latency?: number
  /** 完整的 token 使用统计 */
  usageMetadata?: UsageMetadata
  /**
   * 思考开始时间戳（毫秒）
   *
   * 仅在流式响应过程中使用，用于前端实时显示思考时间
   * 完成后会被移除，只保留 thinkingDuration
   */
  thinkingStartTime?: number
  /**
   * 思考持续时间（毫秒）
   *
   * 仅对包含思考内容的消息有值
   * 由后端计算并保存，记录从收到第一个思考块到收到第一个非思考内容块之间的时间
   */
  thinkingDuration?: number
  /**
   * 响应持续时间（毫秒）
   *
   * 由后端计算，从发出请求到响应正常结束的时间
   */
  responseDuration?: number
  /**
   * 第一个流式块时间戳（毫秒）
   *
   * 用于计算 Token 速率
   */
  firstChunkTime?: number
  /**
   * 流式响应持续时间（毫秒）
   *
   * 由后端计算，从收到第一个流式块到响应结束的时间
   */
  streamDuration?: number
  /**
   * 流式块数量
   *
   * 由后端记录，用于判断是否只有一个块
   */
  chunkCount?: number
  /** @deprecated 使用 usageMetadata.thoughtsTokenCount */
  thoughtsTokenCount?: number
  /** @deprecated 使用 usageMetadata.candidatesTokenCount */
  candidatesTokenCount?: number
  [key: string]: any
}

// ============ 工具相关类型 ============

/**
 * 工具调用信息
 */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status?: 'streaming' | 'queued' | 'awaiting_approval' | 'executing' | 'awaiting_apply' | 'success' | 'error' | 'warning'
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  id: string
  name: string
  result: Record<string, unknown>
  error?: string
  duration?: number
}

/**
 * 工具使用信息 - 用于在消息中显示
 */
export interface ToolUsage {
  id: string
  name: string
  args: Record<string, unknown>
  /**
   * 流式工具调用的内部 output item ID。
   *
   * 用于在最终 call_id 出现前，把参数增量和占位工具合并到同一张卡片。
   */
  itemId?: string
  /**
   * Provider 给出的流式工具序号，允许 0。
   *
   * 部分 Responses 事件只有 output_index，没有 call_id，需要用 index 作为次级合并键。
   */
  index?: number
  result?: Record<string, unknown>
  error?: string
  duration?: number
  /**
   * 工具状态（统一状态机）
   * - streaming: AI 正在输出/拼接工具调用（参数可能仍是 partial）
   * - queued: 已拿到完整工具调用，等待轮到它执行（前置工具未完成）
   * - awaiting_approval: 等待用户批准后才可执行
   * - executing: 正在执行（工具 handler 运行中，可能持续较久）
   * - awaiting_apply: 已生成变更，等待用户审阅/应用（如 diff）
   * - success/error/warning: 最终结果
   */
  status?: 'streaming' | 'queued' | 'awaiting_approval' | 'executing' | 'awaiting_apply' | 'success' | 'error' | 'warning'
  
  /** 流式响应中的原始参数片段（streaming 状态时可用） */
  partialArgs?: string

  /** @deprecated 使用 status = awaiting_approval 代替 */
  awaitingConfirmation?: boolean
}

// ============ 附件相关类型 ============

export type AttachmentType = 'image' | 'video' | 'audio' | 'document' | 'code'

export interface Attachment {
  id: string
  name: string
  type: AttachmentType
  size: number
  url?: string
  data?: string  // base64 或其他数据
  mimeType: string
  thumbnail?: string
  metadata?: AttachmentMetadata
}

export interface AttachmentMetadata {
  width?: number
  height?: number
  duration?: number
  language?: string
  [key: string]: any
}

// ============ 会话相关类型 ============

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview?: string
  metadata?: SessionMetadata
}

export interface SessionMetadata {
  model?: string
  tags?: string[]
  [key: string]: any
}

// ============ 配置相关类型 ============

export interface ChatConfig {
  model: string
  provider: 'gemini' | 'openai' | 'openai-responses' | 'anthropic' | 'custom'
  apiKey?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
}

export interface UIConfig {
  theme: 'auto' | 'light' | 'dark'
  fontSize: number
  codeTheme: string
  enableAnimations: boolean
  compactMode: boolean
}

// ============ VSCode 通信类型 ============

export interface VSCodeMessage<T = any> {
  type: string
  requestId?: string
  data: T
}

export interface VSCodeRequest {
  type: 'chat' | 'chatStream' | 'retry' | 'retryStream' | 'editAndRetry' | 'editAndRetryStream' |
        'chat.rerollStream' | 'chat.editBranchStream' | 'deleteMessage' | 'getHistory' | 'getConfig' | 'updateConfig'
  data: any
  requestId: string
}

export interface VSCodeResponse<T = any> {
  type: string
  requestId: string
  success: boolean
  data?: T
  error?: ErrorInfo
}

// ============ Chat API 请求类型 ============

export interface ChatRequest {
  conversationId: string
  configId: string
  message: string
  /** 可选：覆盖本次请求使用的模型（不修改 config） */
  modelOverride?: string
  /** 可选：覆盖本次请求的动态上下文策略 */
  dynamicContextStrategyOverride?: 'single' | 'preserve'
  /** 消息来源；background_task 是系统生成的后台结果回执 */
  source?: 'user' | 'background_task'
}

export interface RetryRequest {
  conversationId: string
  configId: string
  /** 可选：覆盖本次重试使用的模型（不修改 config） */
  modelOverride?: string
}

export interface EditAndRetryRequest {
  conversationId: string
  messageIndex: number
  newMessage: string
  configId: string
  /** 可选：覆盖本次编辑重试使用的模型（不修改 config） */
  modelOverride?: string
}

export interface DeleteMessageRequest {
  conversationId: string
  targetIndex: number
}

// ============ Chat API 响应类型 ============

export interface ChatSuccessResponse {
  success: true
  content: Content
}

export interface ChatErrorResponse {
  success: false
  error: ErrorInfo
}

/**
 * 后端 StreamChunk 格式（来自 ChannelManager）
 */
export interface BackendStreamChunk {
  delta: ContentPart[]
  done: boolean
  usage?: UsageMetadata
  finishReason?: string
  contentSnapshot?: Content
  /** 模型版本（仅最后一个块包含） */
  modelVersion?: string
}

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  id?: string
  name: string
  result: Record<string, unknown>
}

/**
 * 待确认的工具调用
 */
export interface PendingToolCall {
  /** 工具调用 ID */
  id: string
  /** 工具名称 */
  name: string
  /** 工具参数 */
  args: Record<string, unknown>
}

/**
 * 前端接收的流式消息格式
 */
export interface StreamChunk {
  type:
    | 'chunk'
    | 'complete'
    | 'error'
    | 'toolIteration'
    | 'cancelled'
    | 'checkpoints'
    | 'awaitingConfirmation'
    | 'toolsExecuting'
    | 'toolStatus'
    | 'autoSummaryStatus'
    | 'autoSummary'
  conversationId: string
  /** 前端生成的流请求 ID，用于过滤迟到/过期 chunk */
  /** 事件创建时间戳（毫秒），用于声音提醒过期丢弃等场景 */
  createdAt?: number
  streamId?: string
  chunk?: BackendStreamChunk
  content?: Content
  error?: ErrorInfo
  /** 是否为工具迭代（工具调用后还有后续消息） */
  toolIteration?: boolean
  /** 工具执行结果列表 */
  toolResults?: ToolExecutionResult[]
  /** 创建的检查点列表 */
  checkpoints?: CheckpointRecord[]
  /** 等待确认的工具调用列表（当 type 为 'awaitingConfirmation' 时） */
  pendingToolCalls?: PendingToolCall[]
  /** 标记工具即将开始执行（用于在工具执行前先发送计时信息） */
  toolsExecuting?: boolean

  /** 工具状态更新（用于实时排队推进） */
  toolStatus?: boolean
  tool?: {
    id: string
    name: string
    status: 'queued' | 'executing' | 'awaiting_apply' | 'success' | 'error' | 'warning'
    /** 工具参数快照；用于 toolStatus 早于完整 functionCall 到达时更新工具卡参数预览 */
    args?: Record<string, unknown>
    result?: Record<string, unknown>
  }

  /** 自动总结状态（用于显示“自动总结中”提示） */
  autoSummaryStatus?: boolean
  /** 自动总结状态值 */
  status?: 'started' | 'completed' | 'failed'
  /** 自动总结状态提示信息（可选） */
  message?: string

  /** 自动总结完成（用于前端即时插入总结消息） */
  autoSummary?: boolean
  /** 自动总结消息内容 */
  summaryContent?: Content
  /** 总结消息插入位置（完整历史绝对索引） */
  insertIndex?: number
  /**
   * 逻辑截断语义：后端不删除消息，只给历史中 backendIndex ∈ [insertIndex - removedCount, insertIndex)
   * 的消息打 isSummarized 标记（原文保留），并把总结消息插入到 insertIndex。缺省/0 = 无消息被标记。
   */
  removedCount?: number
}

// ============ 错误类型 ============

/**
 * 分支流失败后的重放参数。
 *
 * 不包含 streamId：每次重放都必须生成新的流 ID；其余字段固定为原请求快照，
 * 避免失败后切换配置或 Prompt 模式导致重试语义漂移。
 */
export type BranchStreamReplayContext =
  | {
      kind: 'reroll'
      conversationId: string
      assistantNodeId: string
      configId: string
      modelOverride?: string
      promptModeId?: string
    }
  | {
      kind: 'editBranch'
      conversationId: string
      userNodeId: string
      newText: string
      configId: string
      modelOverride?: string
      promptModeId?: string
      /** 编辑模式：'branch' 新建分支（默认）；'keep' 原地改写原消息，保持当前分支 */
      mode?: 'branch' | 'keep'
    }

export interface ErrorInfo {
  code: string
  message: string
  /** 底层错误类型（后端 ChannelError.type，如 API_ERROR/NETWORK_ERROR/TIMEOUT_ERROR/PARSE_ERROR） */
  type?: string
  /** reroll / 编辑分支流失败时保存的原请求快照，供错误条执行同类分支流重放 */
  branchReplayContext?: BranchStreamReplayContext
  details?: any
}

// ============ UI 状态类型 ============

export type ModalType = 'settings' | 'history' | 'attachment' | null

export interface AppState {
  loading: boolean
  error: ErrorInfo | null
  modalType: ModalType
  currentSession: string | null
}

// ============ 事件类型 ============

export interface ChatEvent {
  type: 'send' | 'receive' | 'error' | 'stream'
  message?: Message
  error?: ErrorInfo
}

// ============ 工具函数类型 ============

export type MessageFormatter = (message: Message) => string
export type AttachmentValidator = (file: File) => boolean | string

// ============ 常量 ============

// 附件大小上限（实质无限制）。注意：实际仍可能受 VS Code webview 消息体积/内存、以及模型接口上限影响。
export const MAX_ATTACHMENT_SIZE = Number.MAX_SAFE_INTEGER
export const MAX_MESSAGE_LENGTH = 10000
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/webm']
export const SUPPORTED_AUDIO_TYPES = ['audio/mp3', 'audio/wav', 'audio/ogg']

// ============ 检查点相关类型 ============

/**
 * 检查点轻量摘要（CPF-02/CPF-03）
 *
 * 与后端 backend/modules/checkpoint/types.ts 的 CheckpointSummary 对齐：
 * 会话元数据只保留摘要，完整 fileHashes/fileStats/excluded 存于独立 manifest，
 * 前端列表/展示只接收此结构。
 *
 * 注意：前端历史代码（checkpointActions / tabActions / 设置页）仍以 CheckpointRecord
 * 消费同一批对象，因此这里定义为 CheckpointRecord 的结构别名——后端 getCheckpoints
 * 只下发摘要字段（不含 fileHashes/fileStats），类型上保持兼容。
 */
export type CheckpointSummary = CheckpointRecord

/**
 * 检查点记录
 *
 * 与对话消息索引关联的代码库快照记录。
 * 注意：后端新格式存档不再在元数据中保存 fileHashes/fileStats（已迁入 manifest），
 * 前端只应消费 CheckpointSummary 字段；以下旧字段仅用于兼容旧存档数据。
 */
export interface CheckpointRecord {
  /** 检查点唯一 ID */
  id: string
  
  /** 关联的对话 ID */
  conversationId: string
  
  /**
   * 关联的消息索引
   *
   * 表示此检查点是在处理该索引消息时创建的
   */
  messageIndex: number
  
  /** 触发备份的工具名称 */
  toolName: string
  
  /**
   * 备份阶段
   * - before: 工具执行前
   * - after: 工具执行后
   */
  phase: 'before' | 'after'
  
  /** 创建时间戳 */
  timestamp: number
  
  /** 备份目录名 */
  backupDir: string
  
  /** 备份的文件数量 */
  fileCount: number
  
  /** 内容签名（用于比较两个检查点是否内容一致） */
  contentHash: string
  
  /** 描述信息 */
  description?: string
  
  /** 备份类型：full=完整备份，incremental=增量备份 */
  type?: 'full' | 'incremental'
  
  /** 增量备份基于的检查点 ID（仅增量备份有效） */
  baseCheckpointId?: string
  
  /** 变更的文件列表（仅增量备份有效） */
  changes?: Array<{ path: string; type: 'added' | 'modified' | 'deleted'; hash?: string }>
  
  /** 所有文件的哈希映射（仅包含真正备份成功的文件；新格式存档不存，见 manifest） */
  fileHashes?: Record<string, string>
  
  /** 快照时的文件 stat 信息 */
  fileStats?: Record<string, { mtimeMs: number; size: number; mtimeNs?: string }>
  
  /** 快照时的自定义忽略模式 */
  ignorePatterns?: string[]
  
  /** 快照时可见但备份复制失败的文件 */
  unbackedPaths?: string[]
  
  /** 空目录列表（相对路径） */
  emptyDirs?: string[]

  /** 关联的消息节点 ID */
  messageNodeId?: string

  /** CPF-09: 备份目录磁盘占用（字节） */
  backupBytes?: number

  /** 该存档创建时按当时规则排除的文件数 */
  excludedCount?: number

  /** 存档 manifest 的 schema 版本 */
  manifestVersion?: number
}

// ============ 检查点 manifest 相关类型（EX-11 查看存档排除清单） ============

/**
 * 存档创建时的排除规则快照（EX-10，随 manifest 保存）。
 * 与后端 backend/modules/checkpoint/types.ts 的 CheckpointIgnoreSnapshot 对齐。
 */
export interface CheckpointManifestIgnoreSnapshot {
  version: number
  forcedRulesVersion: number
  defaultProfileVersion: number
  enabledProfiles: Record<string, boolean>
  /** 与排除配置 profilePatterns 同构（快照保留编辑后的每类别模式） */
  profilePatterns?: Record<string, string[]>
  maxFileSizeBytes: number
  customPatterns: string[]
}

/** 一条被排除路径的记录（manifest.excluded 条目） */
export interface CheckpointManifestExcludedEntry {
  /** 工作区作用域路径（`rootId/relative/path`） */
  path: string
  /** 排除原因分类（forced/default/gitignore/custom/size/...） */
  reason: string
  /** 命中的具体规则模式（如 `*.log`、`logs/`）；gitignore/自定义规则才有 */
  rule?: string
  /** 规则来源说明（如 `logs` 类别名、`.gitignore` 路径、`custom`） */
  source?: string
  /** 文件字节数（reason === 'size' 时存在） */
  size?: number
}

/**
 * 存档完整 manifest（CPF-01/CPF-03，checkpoint.getManifest 返回）。
 * 与后端 backend/modules/checkpoint/types.ts 的 CheckpointManifest 对齐；
 * 前端只消费排除统计/排除规则快照摘要。旧版存档无 manifest 文件时返回 null。
 */
export interface CheckpointManifest {
  version: number
  checkpointId: string
  /** 被排除文件总数（后端摘要字段；缺省时可由 excluded 长度推导） */
  excludedCount?: number
  /** 被排除路径的完整清单（样本之外的全部） */
  excluded?: CheckpointManifestExcludedEntry[]
  /** 该存档创建时的排除规则快照 */
  ignoreSnapshot?: CheckpointManifestIgnoreSnapshot
}

// ============ 模型相关类型 ============

/**
 * 模型信息
 */
export interface ModelInfo {
  /** 模型 ID */
  id: string
  
  /** 模型名称 */
  name?: string
  
  /** 模型描述 */
  description?: string
  
  /** 上下文窗口大小 */
  contextWindow?: number
  
  /** 最大输出token */
  maxOutputTokens?: number
}
export const SUPPORTED_DOCUMENT_TYPES = ['application/pdf', 'text/plain', 'application/json']

// ============ MCP 相关类型 ============

/**
 * MCP 服务器传输类型
 */
export type McpTransportType = 'stdio' | 'sse' | 'streamable-http'

/**
 * MCP 服务器状态
 */
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * Stdio 传输配置
 */
export interface StdioTransportConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * SSE 传输配置
 */
export interface SseTransportConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

/**
 * Streamable HTTP 传输配置
 */
export interface StreamableHttpTransportConfig {
  type: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

/**
 * MCP 传输配置
 */
export type McpTransportConfig = StdioTransportConfig | SseTransportConfig | StreamableHttpTransportConfig

/**
 * MCP 服务器配置
 */
export interface McpServerConfig {
  id: string
  name: string
  description?: string
  transport: McpTransportConfig
  enabled: boolean
  autoConnect: boolean
  timeout?: number
  /**
   * 是否清理 JSON Schema
   *
   * 如果为 true，会移除 JSON Schema 中不兼容的字段（如 $schema, additionalProperties）
   * 某些 API（如 Gemini）不支持这些字段
   *
   * 默认为 true
   */
  cleanSchema?: boolean
  createdAt: number
  updatedAt: number
}

/**
 * MCP 工具定义
 */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

/**
 * MCP 资源定义
 */
export interface McpResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/**
 * MCP 提示模板定义
 */
export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

/**
 * MCP 服务器能力
 */
export interface McpServerCapabilities {
  tools?: McpToolDefinition[]
  resources?: McpResourceDefinition[]
  prompts?: McpPromptDefinition[]
  sampling?: boolean
  logging?: boolean
}

/**
 * MCP 服务器运行时信息
 */
export interface McpServerInfo {
  config: McpServerConfig
  status: McpServerStatus
  capabilities?: McpServerCapabilities
  protocolVersion?: string
  serverVersion?: string
  serverDescription?: string
  lastError?: string
  connectedAt?: number
}

/**
 * 创建 MCP 服务器输入
 */
export type CreateMcpServerInput = Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 更新 MCP 服务器输入
 */
export type UpdateMcpServerInput = Partial<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>>

// ============ 编辑器节点类型 ============

export * from './editorNode'

// ============ 用量统计类型 ============

export * from './usage'
