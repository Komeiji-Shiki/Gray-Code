/**
 * GrayCode - 对话历史管理类型定义
 * 
 * 完整支持 Gemini API 格式,包括:
 * - 文本、文件、内联数据
 * - 函数调用和函数响应
 * - 思考签名(Thinking)
 * - 思考内容(Thought)
 * - 所有高级特性
 * 
 * 存储格式: 完整的 Gemini Content[] 数组
 * 文件命名: 以对话 ID 作为文件名
 */

// B1/T16：跨端共享类型迁入 shared/protocol.ts 单一来源；此处 re-export 保持既有导入方不破
// （Content 接口在下方直接引用 ContentPart / UsageMetadata / SummaryTokenStats，故需 import 到本地作用域）
import type { ContentPart, SummaryTokenStats, UsageMetadata } from '../../../shared/protocol';
export type { ContentPart, OpenAIResponsesReasoningMetadata, SummaryTokenStats, ThoughtSignatures, TokenDetailsEntry, UsageMetadata } from '../../../shared/protocol';

/**
 * 修改原因：上下文裁剪状态原本用裸字符串分散在 API 服务里，历史变更入口无法统一失效它。
 * 修改方式：把会话 metadata 中的裁剪状态 key 提升为 conversation 域常量，供 ConversationManager 与 ContextTrimService 共享。
 * 修改目的：让删除、插入、回档等 transcript 结构变化都能通过统一 key 清理旧裁剪状态，避免旧 trimState 继续截断上下文。
 */
export const CONVERSATION_CONTEXT_TRIM_STATE_KEY = 'trimState';

/**
 * 不同渠道的 Token 计数
 *
 * 由于不同渠道（Gemini、OpenAI、Anthropic）对同一消息的 token 计算方式不同，
 * 使用对象结构分开存储，便于按当前使用的渠道类型获取对应的 token 数。
 *
 * 计算方式：
 * - 通过调用各渠道的 token 计数 API 获取精确值
 * - 如果 API 调用失败，回退到估算方法
 */
export interface ChannelTokenCounts {
    /** Gemini 渠道的 token 数 */
    gemini?: number;
    
    /** OpenAI 渠道的 token 数 */
    openai?: number;
    
    /** Anthropic 渠道的 token 数 */
    anthropic?: number;
    
    /** 其他渠道的 token 数 */
    [key: string]: number | undefined;
}

/**
 * Gemini Content（消息内容）
 *
 * Gemini API 的标准消息格式
 */
export interface Content {
    /** 角色 */
    role: 'user' | 'model' | 'system';
    /** 内容片段列表 */
    parts: ContentPart[];
    
    /**
     * 消息在历史记录中的索引
     *
     * 由后端在返回消息时填充，用于前端在删除/重试时
     * 直接使用此索引，无需进行复杂的索引转换计算。
     */
    index?: number;
    
    /**
     * 稳定消息节点 ID（BR-01）
     *
     * - 新写入的消息由 ConversationManager 统一生成（ensureNodeId）；
     * - 旧历史缺失时由 BR-02 惰性迁移按确定性规则补齐（幂等：同一历史多次迁移产出同一 ID 集合）；
     * - 树状分支 API 使用此 ID 定位消息节点，数组下标仅作为当前活跃路径的显示位置；
     * - 后端内部字段：formatHistoryForAPI 白名单过滤，不会发送给模型。
     */
    id?: string;
    
    /**
     * 父消息节点 ID（BR-01）
     *
     * 主历史是线性活跃路径：parentId = 前一条消息的 id（首条为 null）。
     * 旧历史迁移时按数组顺序补齐线性 parentId。
     */
    parentId?: string | null;
    
    /**
     * 模型版本（仅 model 消息有值）
     *
     * 例如: "gemini-2.5-flash", "gpt-5o"
     * 用于标识是哪个模型生成的回复
     */
    modelVersion?: string;
    
    /**
     * Token 使用统计（仅 model 消息有值）
     *
     * 包含完整的 usageMetadata：
     * - promptTokenCount: 输入 prompt 的 token 数
     * - candidatesTokenCount: 输出候选的 token 数
     * - totalTokenCount: token 
     * - thoughtsTokenCount: 思考部分的 token 数
     * - promptTokensDetails: prompt token 详情
     */
    usageMetadata?: UsageMetadata;

    /** 仅总结消息存在；描述主上下文压缩效果，不是总结模型请求用量。 */
    summaryTokenStats?: SummaryTokenStats;

    /**
     * usageMetadata 是否来自未终结的流（被用户取消/网络中断时截断的半截数据）。
     *
     * 流被中止时 usageMetadata 只覆盖已收到的 chunk，token 数可能严重偏低；
     * 上下文裁剪与用量统计在遇到此标记时应回退到估算而非信任 usageMetadata。
     */
    usageMetadataPartial?: boolean;
    
    /**
     * 思考持续时间（毫秒）
     *
     * 仅对包含思考内容的 model 消息有值
     * 记录从请求开始到收到第一个非思考内容块之间的时间，包含首字/首块等待时间。
     * 用于在前端显示 AI 思考耗时。
     */
    thinkingDuration?: number;
    
    /**
     * 思考开始时间戳（毫秒）
     *
     * 仅在流式响应过程中使用，用于计算思考持续时间
     * 对思考模型从请求开始时间计入；完成后会被移除，只保留 thinkingDuration
     */
    thinkingStartTime?: number;
    
    /**
     * 响应持续时间（毫秒）
     *
     * 从发出请求到响应正常结束的时间
     * 仅对 model 消息有值
     */
    responseDuration?: number;
    
    /**
     * 第一个流式块时间戳（毫秒）
     *
     * 用于计算 Token 速率
     */
    firstChunkTime?: number;
    
    /**
     * 首字延迟（毫秒）
     *
     * 从请求开始到第一个流式块到达的时间（TTFT）
     * 用于前端展示首字等待耗时，并让 Token 速率计算剥离首字等待窗口
     */
    ttft?: number;
    
    /**
     * 流式响应持续时间（毫秒）
     *
     * 从收到第一个流式块到响应结束的时间
     * 用于计算 Token 速率
     */
    streamDuration?: number;
    
    /**
     * 流式块数量
     *
     * 用于判断是否只有一个块（只有一个块时不计算速率）
     */
    chunkCount?: number;
    
    /**
     * 标识此 user 消息是否为函数调用响应
     *
     * 仅对 role='user' 的消息有意义
     * - true: 此消息包含 functionResponse（函数执行结果）
     * - false/undefined: 此消息是普通用户消息
     *
     * 用于区分普通用户消息和函数响应消息，
     * 在过滤思考签名时需要此标记来定位最后一个非函数响应的用户消息
     */
    isFunctionResponse?: boolean;
    
    /**
     * 标识此 user 消息是否为上下文总结消息
     *
     * 仅对 role='user' 的消息有意义
     * - true: 此消息是上下文总结，包含之前对话的压缩摘要
     * - false/undefined: 此消息是普通用户消息
     *
     * 使用场景:
     * - 当对话过长时，用户可以触发上下文总结
     * - 系统会将旧对话压缩为总结消息
     * - 后续调用 AI 时，从最后一个总结消息开始获取历史
     *
     * 前端显示：
     * - 以特殊样式显示，表明这是总结内容
     * - 可以展开查看完整总结
     */
    isSummary?: boolean;
    
    /**
     * 总结消息覆盖的消息数量
     *
     * 仅当 isSummary=true 时有意义
     * 记录此总结替代了多少条原始消息
     */
    summarizedMessageCount?: number;

    /**
     * 标识此总结消息是否由系统自动触发
     *
     * 仅当 isSummary=true 时有意义
     * - true: 自动总结（由上下文阈值触发）
     * - false/undefined: 手动总结
     */
    isAutoSummary?: boolean;

    /**
     * 标识此消息已被上下文总结覆盖（逻辑截断）。
     *
     * 仅对非总结消息有意义：
     * - true: 该消息已被总结消息覆盖，原文仍完整保留在历史中（可显示、可搜索），
     *   但默认不再参与发送给 AI 的请求与 token 统计（发送历史从最后一个总结消息开始）；
     * - false/undefined: 活跃消息。
     *
     * 首条真实用户消息（任务锚点）永不标记，始终发送。
     */
    isSummarized?: boolean;

    /**
     * 标识此消息是用户主动输入的消息
     *
     * 仅对 role='user' 的消息有意义
     * - true: 用户主动发送的消息（区别于工具响应、总结等系统生成的 user 消息）
     * - false/undefined: 非用户主动输入的消息
     *
     * 用途：
     * - 确定动态提示词的插入位置（插入到连续用户输入组之前）
     * - 区分用户主动消息和系统消息
     */
    isUserInput?: boolean;
    
    /** 消息来源：真实用户输入或系统生成的后台/代理消息。仅用于内部历史语义与前端展示。 */
    source?: 'user' | 'background_task' | 'agent_message';

    /**
     * 消息创建时间戳（毫秒）
     *
     * 用于前端显示消息发送时间
     * 如果未设置，前端会使用加载时的时间
     */
    timestamp?: number;
    
    /**
     * 该消息按渠道分类的 token 数（仅用户消息和函数响应消息）
     *
     * 由于不同渠道（Gemini、OpenAI、Anthropic）对同一消息的 token 计算方式不同，
     * 按渠道类型分别存储，在裁剪上下文时根据当前使用的渠道获取对应值。
     *
     * 计算方式（优先级从高到低）：
     * 1. 调用渠道的 token 计数 API 获取精确值
     * 2. 如果 API 调用失败，使用相邻轮次 promptTokenCount 差值计算
     * 3. 如果没有 promptTokenCount，使用字符数估算
     *
     * 用于：
     * - 估算完整历史的 token 数
     * - 判断是否需要裁剪上下文
     * - 避免上下文振荡问题
     *
     * 示例：
     * {
     *   gemini: 1500,
     *   openai: 1520,
     *   anthropic: 1480
     * }
     */
    tokenCountByChannel?: ChannelTokenCounts;
    
    /**
     * @deprecated 使用 tokenCountByChannel 代替
     * 保留用于向后兼容，新代码应使用 tokenCountByChannel
     */
    estimatedTokenCount?: number;
    
    /**
     * @deprecated 使用 usageMetadata.thoughtsTokenCount 代替
     */
    thoughtsTokenCount?: number;
    
    /**
     * @deprecated 使用 usageMetadata.candidatesTokenCount 代替
     */
    candidatesTokenCount?: number;
    
    /**
     * 当前回合的动态上下文缓存（仅存在于回合起始的 user 消息上）
     *
     * 在回合开始时（用户发送消息）一次性生成动态上下文并存到此字段，
     * 回合内的所有迭代（包括工具确认后的继续、重试等）复用此缓存，
     * 确保同一回合内动态上下文保持一致。
     *
     * 仅存储纯文本内容，读取时重建为 Content[] 格式。
     *
     * 注意：此字段为后端内部字段，不会发送给 AI（getHistoryForAPI 自动过滤），
     * 也不会传给前端（getMessagesPaged 中过滤）。
     */
    turnDynamicContext?: string;

    /**
     * 当前回合使用的动态上下文策略（内部缓存字段）。
     */
    turnDynamicContextStrategy?: 'single' | 'preserve';
}

/**
 * 对话历史（Gemini 格式）
 * 
 * 这是存储的核心格式:
 * - 直接兼容 Gemini API
 * - 包含所有高级特性(函数调用、思考签名、思考内容等)
 * - 可以直接发送给 Gemini API
 * 
 * 存储方式:
 * - 文件名: {conversationId}.json
 * - 内容: JSON.stringify(ConversationHistory)
 * 
 * 思考内容存储:
 * - 思考摘要会被标记为 thought: true
 * - 思考签名会自动保存在 thoughtSignatures 字段
 * - 可选择是否在 UI 中显示思考内容
 */
export type ConversationHistory = Content[];

export type PendingApprovalGateKind = 'generate_plan' | 'execute_plan';
export type PendingApprovalGateContinuationIntent = 'generate_plan_now' | 'implement_now';
export type PendingApprovalGateSourceArtifactType = 'design' | 'review' | 'plan';

export interface PendingApprovalGate {
    /** 本次审批门闸唯一标识 */
    id: string;
    /** 门闸类别 */
    kind: PendingApprovalGateKind;
    /** 与现有 continuation 语义对齐的意图 */
    continuationIntent: PendingApprovalGateContinuationIntent;
    /** 触发当前门闸的工具调用 ID */
    sourceToolCallId: string;
    /** 触发当前门闸的工具名称 */
    sourceToolName: string;
    /** 触发当前门闸的源文档类型 */
    sourceArtifactType: PendingApprovalGateSourceArtifactType;
    /** 触发当前门闸的源文档路径（如有） */
    sourcePath?: string;
    /** 创建时间戳（毫秒） */
    createdAt: number;
}

/**
 * 对话元数据
 *
 * 存储对话的额外信息(不是 Gemini 格式的一部分)
 */
export interface ConversationMetadata {
    /** 对话 ID */
    id: string;
    /** 对话标题 */
    title?: string;
    /** 创建时间 */
    createdAt: number;
    /** 最后更新时间 */
    updatedAt: number;
    
    /**
     * 工作区 URI
     *
     * 创建对话时的工作区路径，用于筛选显示
     * 例如: "file:///c%3A/Users/xxx/projects/my-project"
     */
    workspaceUri?: string;
    
    /** 自定义元数据 */
    custom?: Record<string, unknown>;

    /**
     * Storage integrity status (optional)
     *
     * - ok: history and metadata are readable
     * - meta_missing: history exists but metadata file is missing
     * - meta_corrupt: metadata exists but cannot be parsed
     * - history_missing: metadata exists but history file is missing
     * - history_corrupt: history exists but cannot be parsed
     */
    integrityStatus?: 'ok' | 'meta_missing' | 'meta_corrupt' | 'history_missing' | 'history_corrupt';
}

/**
 * 完整的对话数据(包含历史和元数据)
 */
export interface ConversationData {
    /** 对话元数据 */
    metadata: ConversationMetadata;
    /** 对话历史(Gemini 格式) */
    history: ConversationHistory;
}

/**
 * 消息位置定位
 */
export interface MessagePosition {
    /** 消息索引 */
    index: number;
    /** 角色 */
    role: 'user' | 'model' | 'system';
}

/**
 * 消息过滤器
 */
export interface MessageFilter {
    /** 按角色过滤 */
    role?: 'user' | 'model' | 'system';
    /** 按是否包含函数调用过滤 */
    hasFunctionCall?: boolean;
    /** 按是否包含文本过滤 */
    hasText?: boolean;
    /** 按是否为思考内容过滤 */
    isThought?: boolean;
    /** 按索引范围过滤 */
    indexRange?: {
        start: number;
        end: number;
    };
}

/**
 * 历史快照
 * 
 * 用于保存对话的某个时间点状态
 */
export interface HistorySnapshot {
    /** 快照 ID */
    id: string;
    /** 对话 ID */
    conversationId: string;
    /** 快照名称 */
    name?: string;
    /** 快照描述 */
    description?: string;
    /** 快照时间戳 */
    timestamp: number;
    /** 历史记录(Gemini 格式) */
    history: ConversationHistory;
}

/**
 * 对话统计信息
 */
export interface ConversationStats {
    /** 总消息数 */
    totalMessages: number;
    /** 用户消息数 */
    userMessages: number;
    /** 模型消息数 */
    modelMessages: number;
    /** 系统消息数（system 角色单独统计，不计入 modelMessages） */
    systemMessages: number;
    /** 函数调用次数 */
    functionCalls: number;
    /** 是否包含思考签名 */
    hasThoughtSignatures: boolean;
    /** 是否包含思考内容 */
    hasThoughts: boolean;
    /** 是否包含文件数据 */
    hasFileData: boolean;
    /** 是否包含内嵌多模态数据 */
    hasInlineData: boolean;
    /** 内嵌数据总大小（字节） */
    inlineDataSize: number;
    /** 多模态内容统计 */
    multimedia: {
        images: number;
        audio: number;
        video: number;
        documents: number;
    };
    /** Token 统计 */
    tokens: {
        /** 总思考 token 数 */
        totalThoughtsTokens: number;
        /** 总候选输出 token 数 */
        totalCandidatesTokens: number;
        /** 总 token 数（思考 + 输出） */
        totalTokens: number;
        /** 有思考 token 记录的消息数 */
        messagesWithThoughtsTokens: number;
        /** 有候选 token 记录的消息数 */
        messagesWithCandidatesTokens: number;
    };
}

/**
 * 消息编辑操作
 */
export interface MessageEdit {
    /** 消息索引 */
    index: number;
    /** 新的文本内容 */
    newText: string;
}

/**
 * 消息插入操作
 */
export interface MessageInsert {
    /** 插入位置（在此索引之前插入） */
    beforeIndex: number;
    /** 要插入的消息 */
    content: Content;
}

