/**
 * ConversationManager 文件级类型定义（拆分自 ConversationManager.ts，声明原样保留）。
 *
 * ConversationManager.ts 通过 `export type { ... } from './manager/types'` 再导出，
 * 保证 `import { GetHistoryOptions } from '../ConversationManager'` 等既有引用不断。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

/**
 * 多模态能力（用于过滤历史中的多模态数据）
 */
export interface MultimodalCapability {
    /** 是否支持图片 */
    supportsImages: boolean;
    /** 是否支持文档（PDF） */
    supportsDocuments: boolean;
    /** 是否支持回传多模态数据到历史记录 */
    supportsHistoryMultimodal: boolean;
}

/**
 * 获取历史的选项
 */
export interface GetHistoryOptions {
    /** 是否包含当前轮次的思考内容（默认 false） */
    includeThoughts?: boolean;
    
    /** 是否发送历史思考内容（默认 false） */
    sendHistoryThoughts?: boolean;
    
    /** 是否发送历史思考签名（默认 false） */
    sendHistoryThoughtSignatures?: boolean;

    /** 是否发送当前轮次的思考内容（默认根据渠道决定） */
    sendCurrentThoughts?: boolean;

    /** 是否发送当前轮次的思考签名（默认根据渠道决定） */
    sendCurrentThoughtSignatures?: boolean;
    
    /** 渠道类型，用于选择对应格式的签名 */
    channelType?: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    
    /**
     * 多模态能力（可选）
     *
     * 如果提供，将根据能力过滤历史中的多模态数据：
     * - 如果不支持 supportsHistoryMultimodal，则过滤所有历史中的 inlineData
     * - 如果不支持 supportsDocuments，则过滤文档类型的 inlineData
     * - 如果不支持 supportsImages，则过滤图片类型的 inlineData
     */
    multimodalCapability?: MultimodalCapability;
    
    /**
     * 历史思考回合数
     *
     * 控制发送多少轮非最新回合的历史对话思考：
     * - `-1`: 发送全部历史回合的思考（默认值）
     * - `0`: 不发送任何历史回合的思考
     * - 正数 `n`: 发送最近 n 轮非最新回合的思考（如 1 表示只发送倒数第二回合）
     *
     * 仅在 sendHistoryThoughts 或 sendHistoryThoughtSignatures 为 true 时生效
     */
    historyThinkingRounds?: number;
    
    /**
     * 起始索引（可选）
     *
     * 从指定索引开始获取历史，用于上下文裁剪。
     * 默认为 0（从头开始）。
     */
    startIndex?: number;

    /**
     * 是否保留内部动态上下文字段 turnDynamicContext。
     *
     * 默认 false：常规 API 历史会过滤内部字段。
     * preserve 策略构建请求时会开启，用于把旧动态上下文固定插回原位。
     */
    includeTurnDynamicContext?: boolean;
}

export interface CreateBranchConversationResult {
    conversationId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview?: string;
    workspaceUri?: string;
}

/** TREE-06：主历史重写结果（rewriteHistoryFromBranchGraph） */
export interface BranchHistoryRewriteResult {
    /** 是否实际落盘重写了主历史（false = 主历史已等于活跃路径，无变更未写盘） */
    rewritten: boolean;
    /** 重写后的主历史消息数（含 functionResponse 拆分消息） */
    historyLength: number;
    /** 图活跃路径节点数（不含 functionResponse，决策 8） */
    activePathLength: number;
    /**
     * 旧主历史与新主历史首次按 id 分歧的数组下标（含该下标；检查点从该索引起清理）。
     * null = 无分歧（未重写 / 内容完全一致）。
     */
    divergenceIndex: number | null;
    /** 重写后主历史消息 id 列表（含 functionResponse 消息 id，供校验/测试） */
    historyIds: string[];
}

/**
 * 对话列表摘要（HIS-10）：一次批量 IPC 返回一页对话列表所需的轻量元数据。
 * 完整 metadata 只在打开具体对话时读取。
 */
export interface ConversationSummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview?: string;
    workspaceUri?: string;
    integrityStatus?: string;
}
