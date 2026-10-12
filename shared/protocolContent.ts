// ============ 4. 跨端共享类型 ============

/**
 * ── 传输层契约说明（04#15，仅文档化、不引入类型/不改运行时逻辑） ──
 *
 * 以下不是「共享类型」，而是前端与扩展两侧共同依赖、但历史上只靠各自约定消化的传输语义。
 * 这里以注释形式固化，避免接口表面误导。
 *
 * 1) 流式请求的「多响应」契约
 *    同一 requestId 的流式请求（chatStream / retryStream / toolConfirmation /
 *    chat.rerollStream / chat.editBranchStream / cancelStream）会先后收到多帧信封响应，
 *    而非一次性回复：通常先收到成功响应（data 为 { started: true }），此后仍可能再收到
 *    成功响应（data 为 { cancelled: true }）或失败信封（success: false，error: { code,
 *    message }）。即 started 不是终态；前端必须继续按 requestId 匹配并消化 started 之后的
 *    cancelled / error，不能把 started 当作「该请求已一次性完成」。流式内容（chunk）另经
 *    streamChunkBatch 推送，其条目内的 chunk / complete / cancelled / error 等 payload
 *    判别字段不参与这里的 requestId 信封匹配（双通道）。
 *
 * 2) requestId 归一化约定（非法/缺失时的兜底）
 *    入口处（ChatViewProvider / SubAgentMonitorPanel）把非字符串或缺失的 message.requestId
 *    归一为 ''。响应/错误信封会原样回填该 requestId：'' 会被 JSON 保留（而 undefined 会被
 *    序列化丢弃），保证无 requestId 的错误响应仍能到达前端；前端此时无法靠 requestId 精确
 *    匹配，只能走自身超时/全局兜底（见 ChatViewProvider 入口归一化注释）。
 *
 * 3) resolveClientId 未注册时的回退语义
 *    WebviewClientRegistry.resolveClientId(requested, fallback) 的返回顺序为：已注册的
 *    requested → 已注册的 fallback → 非空 requested（即使未注册）→ 非空 fallback（即使
 *    未注册）→ undefined。注意：当 requested 是非空字符串但未注册时，接口返回的仍是该
 *    原始字符串而非 undefined——调用方不能把「返回值」当作「已注册」的判定依据；未注册
 *    clientId 后续的 sendResponse/sendError 会因 registry 查表失败而回退到主聊天。
 *    （权威实现见 webview/runtime/WebviewClientRegistry.ts，本文件只做契约固化。）
 */

/**
 * 用户新消息替换当前回合时，已经实际从前台转入后台的工作数量。
 * 两端只传计数；模型提示文本由后端固定生成，不能由 Webview 自由注入。
 */
export interface ForegroundWorkTransition {
  terminalCommands: number;
  subAgentTasks: number;
}

/** cancelStream 的终态响应；普通停止不会携带 foregroundWorkTransition。 */
export interface CancelStreamResponse {
  cancelled: boolean;
  foregroundWorkTransition?: ForegroundWorkTransition;
}

/**
 * Token 详情条目
 *
 * 按模态（modality）分类的 token 统计。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 完全一致
 * （B1 起以本文件为单一来源，两端 re-export）。
 */
export interface TokenDetailsEntry {
  /** 模态类型: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" */
  modality: string;
  /** Token 数量 */
  tokenCount: number;
}

/**
 * Token 使用统计（Gemini usageMetadata 格式；各渠道统一映射到该结构）
 *
 * 仅存储在 model 角色的消息上。结构在 backend/modules/conversation/types.ts 与
 * frontend/src/types/index.ts 完全一致（B1 起以本文件为单一来源，两端 re-export）。
 */
export interface UsageMetadata {
  /** 输入 prompt 的 token 数量 */
  promptTokenCount?: number;

  /** 提供商报告的总输出 token；reasoning/thinking token 已包含在内 */
  candidatesTokenCount?: number;

  /** 总 token 数量（prompt + candidates + thoughts） */
  totalTokenCount?: number;

  /** 缓存内容的 token 数量（写入缓存 + 命中缓存） */
  cachedContentTokenCount?: number;

  /** 缓存写入的 token 数量（Anthropic cache_creation_input_tokens） */
  cacheCreationTokenCount?: number;

  /** 缓存命中的 token 数量（Anthropic cache_read_input_tokens / OpenAI cached_tokens / Gemini cachedContentTokenCount） */
  cacheReadTokenCount?: number;

  /** 思考部分的 token 数量 */
  thoughtsTokenCount?: number;

  /** Prompt token 详情（按模态分类） */
  promptTokensDetails?: TokenDetailsEntry[];

  /** 候选输出 token 详情（按模态分类，如 IMAGE、TEXT 等） */
  candidatesTokensDetails?: TokenDetailsEntry[];
}

/**
 * 上下文总结的压缩统计
 *
 * 与总结模型自身的 usageMetadata 分开，避免把两种口径混为一谈。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 完全一致
 * （B1 起以本文件为单一来源，两端 re-export）。
 */
export interface SummaryTokenStats {
  /** 被新摘要替换的历史消息估算 token。 */
  sourceTokenCount: number;
  /** 新摘要正文 token（优先使用 provider 输出计数，否则本地估算）。 */
  summaryTokenCount: number;
  /** max(0, sourceTokenCount - summaryTokenCount)。 */
  estimatedTokensSaved: number;
  /** 总结发生前最近一次主模型请求的 prompt token；可能缺失。 */
  contextTokenCountBefore?: number;
  /** 基于历史替换量计算的主上下文估算值；下一次主回复后应以真实 usage 为准。 */
  estimatedContextTokenCountAfter?: number;
}

/**
 * 思考签名（多格式支持，T16 迁入）
 *
 * 不同 API 提供商返回的思考签名格式不同，使用对象结构分开存储。
 * 示例: { gemini: "Eo4KCosKAXrI2nyWeryDa/51Rbxj4E/V/8w==" }
 *
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface ThoughtSignatures {
  /** Gemini 格式思考签名 */
  gemini?: string;

  /** Anthropic 格式思考签名（预留） */
  anthropic?: string;

  /** OpenAI 格式思考签名（预留） */
  openai?: string;

  /** OpenAI Responses 格式思考签名 */
  'openai-responses'?: string;

  /** 其他格式思考签名 */
  [key: string]: string | undefined;
}

/**
 * OpenAI Responses reasoning item 的标准元数据（T16 迁入）
 *
 * 用于无状态多轮原样回传。
 */
export interface OpenAIResponsesReasoningMetadata {
  /** Responses API reasoning output item 的稳定 ID，后续轮次需要原样回传 */
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  /** 可分享的 reasoning summary，保持官方数组格式 */
  summary?: Array<{ type: 'summary_text'; text: string }>;
  /** GPT-OSS 等模型可能返回的 reasoning text，保持官方数组格式 */
  content?: Array<{ type: 'reasoning_text'; text: string }>;
}

/**
 * Content Part（内容片段，T16 迁入）
 *
 * 两端结构超集：后端持久化的全部字段 + 前端遗留字段。
 * 结构在 backend/modules/conversation/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface OpenAIResponsesMessageMetadata {
  /** 每个 assistant output item 的边界，不等同于宿主对话消息 ID。 */
  id?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  /** 只保存供应方实际返回的 phase；旧历史不能猜测为 final_answer。 */
  phase?: 'commentary' | 'final_answer' | null;
  /** 同一 message 的 content 分段定位；不直接发送给 API。 */
  contentIndex?: number;
  /** 无 item_id 的兼容流使用 output_index 定位；不直接发送给 API。 */
  outputIndex?: number;
  contentType?: 'output_text' | 'refusal';
  annotations?: unknown[];
  logprobs?: unknown[];
}

export interface ContentPart {
  /** 文本内容 */
  text?: string;

  /**
   * 内联数据（Base64 编码）
   *
   * 标准 Gemini API 只需要 mimeType 和 data。
   * - displayName: Gemini API 支持的显示名称字段
   * - id 和 name 是附件元数据，仅用于存储和前端显示，发送给 AI 时会被过滤掉。
   */
  inlineData?: {
    mimeType: string;
    data: string; // Base64 编码的数据
    /** 显示名称（Gemini API 支持，可发送给 API） */
    displayName?: string;
    /** 附件 ID（仅用于存储和显示，发送 API 时过滤） */
    id?: string;
    /** 附件名称（仅用于存储和显示，发送 API 时过滤） */
    name?: string;
  };

  /**
   * 文件数据（File API 引用）
   *
   * displayName 在以下场景中必需：
   * - 在 functionResponse.parts 中，需要通过 {"$ref": "displayName"} 引用时
   */
  fileData?: {
    mimeType: string;
    fileUri: string;
    displayName?: string; // 用于 JSON 引用的唯一名称
  };

  /** 函数调用（模型请求） */
  functionCall?: {
    /** Responses 原生异步调用标记；只有运行器允许的调用才提前执行。 */
    async?: boolean;
    /** Responses 命名空间属于上游调用身份，回放时必须原样保留；本地派发仍使用 name。 */
    namespace?: string;
    name: string;
    args: Record<string, unknown>;
    /** 增量解析时的原始 JSON 字符串（用于流式输出） */
    partialArgs?: string;
    /**
     * Anthropic forced tool use 的预填参数标记。仅用于流式累加器把初始 input
     * 与后续 input_json_delta 合并；最终 Content 投影会删除该内部字段。
     */
    prefilledArgs?: boolean;
    id?: string; // 可选的函数调用 ID
    /** 是否已被用户拒绝执行（重新加载对话时正确显示工具状态） */
    rejected?: boolean;
    /**
     * 流式合并用的并行工具序号（Anthropic content_block index、
     * OpenAI Responses output_index）。缺 index 时参数增量会被错误地全部拼进
     * 最后一个工具壳，导致并行调用参数丢失。
     */
    index?: number;
    /** 流式合并用的完整参数标记：true 时 partialArgs 携带完整 arguments，累加器应覆盖 */
    finalArgs?: boolean;
    /** 流式合并用的上游 item 定位符（OpenAI Responses 等），仅用于事件归并 */
    itemId?: string;
  };

  /**
   * 函数响应（执行结果）
   *
   * Gemini 3 Pro+ 支持多模态函数响应：parts 可包含 inlineData/fileData 嵌套 parts。
   */
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string; // 函数调用 ID（Anthropic 必需）
    parts?: ContentPart[]; // 嵌套的多模态 parts (Gemini 3 Pro+)
  };

  /**
   * 思考签名（多格式支持）
   *
   * 按提供商格式分类存储。发送请求时根据目标 API 类型选择对应格式的签名发送；
   * 必须原样返回给模型、不能与其他 part 合并。
   */
  thoughtSignatures?: ThoughtSignatures;

  /** OpenAI Responses reasoning item 的标准元数据，用于无状态多轮原样回传 */
  openaiResponsesReasoning?: OpenAIResponsesReasoningMetadata;

  /** Responses assistant 输出项元数据；text 仍是唯一正文，避免编辑历史后回放旧正文。 */
  openaiResponsesMessage?: OpenAIResponsesMessageMetadata;

  /**
   * 是否为思考内容标志
   *
   * true 表示此 part 包含模型的思考过程而非最终回答。
   */
  thought?: boolean;

  /**
   * 加密的思考内容（Anthropic redacted_thinking，Base64）
   *
   * 仅后端产生（Anthropic 持久化进历史）；前端透传不渲染。
   * 发送时需要转换为 { type: 'redacted_thinking', data }。
   */
  redactedThinking?: string;

  /**
   * @deprecated 前端遗留死字段（无消费方）；统一使用 thoughtSignatures。
   */
  thoughtSignature?: string;
}

/**
 * 轻量存档摘要（CPF-02/CPF-03，T16 迁入）
 *
 * 会话元数据只保留此摘要，前端列表也只接收此结构，不再下发完整哈希映射。
 * 结构在 backend/modules/checkpoint/types.ts 与 frontend/src/types/index.ts 统一
 * （T16 起以本文件为单一来源，两端 re-export）。
 */
export interface CheckpointSummary {
  id: string;
  conversationId: string;
  messageNodeId?: string;
  messageIndex: number;
  toolName: string;
  phase: 'before' | 'after';
  timestamp: number;
  type: 'full' | 'incremental';
  baseCheckpointId?: string;
  contentHash: string;
  fileCount: number;
  backupBytes: number;
  excludedCount: number;
  manifestVersion: number;
}

/**
 * 带磁盘占用的存档摘要（getCheckpoints withSize=true 时下发）
 *
 * size 为 withSize 附加字段：优先用创建时记录的 backupBytes，旧存档缺失时懒扫描补齐。
 */
export type CheckpointSummaryWithSize = CheckpointSummary & { size: number };

// ============ 5. TODO：渐进接入（第一阶段未覆盖项） ============
//
// 1. 消息名：
//    - MESSAGE_NAMES 已收录 webview/handlers 注册表（registry.set / register）、
//      StreamRequestHandler / MessageRouter 直连的流式类型、ChatViewProvider 直连的
//      webviewReady、SubAgentMonitorPanel 直连的 Monitor 消息，共 203 个
//      （webview → 扩展请求方向）；
//    - PUSH_MESSAGE_NAMES 已补入扩展 → webview 推送消息名（postMessage 的 type：
//      'command'/'response'/'error'/'streamChunkBatch'/'subagentMonitor.event' 等 +
//      type:'command' 的 command 名，如 'startupFailed'/'windowFocusChanged'），共 20 个；
//      推送调用点（ChatViewProvider / SubAgentMonitorPanel / StreamChunkProcessor /
//      WebviewClientRegistry / commands/diffUi / StoragePathHandlers / backend bootstrap）
//      已全部改为引用常量；
//    - 消费方迁移：已完成——webview/handlers 注册表（registry.set，179 处验证）与
//      前端 sendToExtension 调用处均已引用 MESSAGE_NAMES 常量；遗留消息名
//      （chat / retry / editAndRetry / editAndRetryStream / getHistory / getConfig /
//      updateConfig）及其唯一消费方 VSCodeRequest 类型已一并清理，无裸字符串漂移。
//
// 2. 共享类型：
//    - 已迁移 TokenDetailsEntry / UsageMetadata / SummaryTokenStats（B1）、
//      ContentPart（含 ThoughtSignatures / OpenAIResponsesReasoningMetadata）与
//      CheckpointSummary / CheckpointSummaryWithSize（T16，两端统一为契约超集）；
//    - CheckpointManifest / CheckpointIgnoreSnapshot / CheckpointExcludedEntry 等检查点
//      类型仍分属 backend/modules/checkpoint/types.ts，未纳入本阶段范围。
