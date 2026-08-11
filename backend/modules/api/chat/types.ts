/**
 * LimCode - 对话 API 类型定义
 * 
 * 定义对话相关的请求和响应类型
 */

import type { Content, SummaryTokenStats } from '../../conversation/types';
import type { StreamChunk } from '../../channel/types';
import type { CheckpointRecord } from '../../checkpoint';
import type { DynamicContextStrategy } from '../../settings/types';


// ==================== 请求数据 ====================

/**
 * 附件数据
 */
export interface AttachmentData {
    /** 附件 ID */
    id: string;
    
    /** 文件名 */
    name: string;
    
    /** 附件类型 */
    type: 'image' | 'video' | 'audio' | 'document' | 'code';
    
    /** 文件大小（字节） */
    size: number;
    
    /** MIME 类型 */
    mimeType: string;
    
    /** Base64 编码的数据 */
    data: string;
    
    /** 缩略图（可选，Base64 编码） */
    thumbnail?: string;
}

/**
 * 隐藏 functionResponse 负载（用于“无可见用户消息”的继续对话）
 */
export interface HiddenFunctionResponseData {
    /** 对应的工具调用 ID（可选） */
    id?: string;

    /** 工具名称 */
    name: string;

    /** 宿主侧审批门闸令牌（可选，仅计划类隐藏 continuation 使用） */
    approvalId?: string;

    /** 函数响应对象 */
    response: Record<string, unknown>;
}

/**
 * 对话请求数据
 */
export interface ChatRequestData {
    /** 对话 ID */
    conversationId: string;
    
    /** 配置 ID */
    configId: string;

    /**
     * 模型覆盖（可选）
     *
     * 如果提供，将覆盖该 config 的 model 字段，仅对本次请求生效。
     */
    modelOverride?: string;
    
    /** 用户消息（文本） */
    message: string;

    /**
     * 用户消息的稳定节点 ID（BR-01：Content.id 与 BranchGraph 节点 id 对齐）。
     * 前端发送时携带自身生成的 id，后端原样落库，保证窗口消息 id 与主历史/分支图一致；
     * 省略时由后端生成（兼容旧客户端与后端内部调用）。
     */
    messageId?: string;
    
    /** 附件列表（可选） */
    attachments?: AttachmentData[];
    
    /** 取消信号 */
    abortSignal?: AbortSignal;

    /**
     * 总结请求专用取消信号（仅取消总结 API，不中断主对话请求）
     *
     * 仅在自动总结流程中使用。
     */
    summarizeAbortSignal?: AbortSignal;

    /**
     * 隐藏 functionResponse：存在时，不创建可见 user 文本消息，改为写入 functionResponse 后继续循环
     */
    hiddenFunctionResponse?: HiddenFunctionResponseData;

    /**
     * Prompt 模式 ID（可选）
     *
     * 如果提供，将在本次请求期间临时切换到该模式，影响系统提示词模板和工具策略。
     */
    promptModeId?: string;

    /**
     * 消息来源。background_task 是系统生成的异步任务回执，不应被当作真实用户新回合。
     */
    source?: 'user' | 'background_task' | 'agent_message';

    /** agent_message 内部回合领取凭据；后端落库后原子确认，防重复/丢失。 */
    agentMessageClaimId?: string;

    /**
     * 本次发送的动态上下文策略覆盖。
     */
    dynamicContextStrategyOverride?: DynamicContextStrategy;
}

// ==================== 响应数据 ====================

/**
 * 对话成功响应数据
 */
export interface ChatSuccessData {
    success: true;
    /** AI 回复（完整 Content 格式） */
    content: Content;
}

/**
 * 对话错误响应数据
 */
export interface ChatErrorData {
    success: false;
    error: {
        /** 错误代码 */
        code: string;
        /** 错误消息 */
        message: string;
    };
}

/**
 * 流式响应块数据
 */
export interface ChatStreamChunkData {
    /** 对话 ID */
    conversationId: string;
    /** 流式块 */
    chunk: StreamChunk;
}

/**
 * 流式完成数据
 */
export interface ChatStreamCompleteData {
    /** 对话 ID */
    conversationId: string;
    /** 完整的 AI 回复（keep 等无生成场景可省略：前端对无 content 的终结 chunk 仅复位流状态） */
    content?: Content;
}

/**
 * 工具迭代完成数据（工具调用后需要创建新消息）
 */
export interface ChatStreamToolIterationData {
    /** 对话 ID */
    conversationId: string;
    /** 当前迭代的 AI 回复（包含工具调用） */
    content: Content;
    /** 标记这是工具迭代完成，还有后续消息 */
    toolIteration: true;
    /** 工具执行结果 */
    toolResults?: Array<{
        /** 工具调用 ID */
        id?: string;
        /** 工具名称 */
        name: string;
        /** 执行结果 */
        result: Record<string, unknown>;
    }>;
    /** 创建的检查点（如果有） */
    checkpoints?: CheckpointRecord[];
}

/**
 * 流式错误数据
 */
export interface ChatStreamErrorData {
    /** 对话 ID */
    conversationId: string;
    error: {
        /** 错误代码 */
        code: string;
        /** 错误消息 */
        message: string;
    };
}

/**
 * 流式检查点数据（用于立即发送检查点到前端）
 */
export interface ChatStreamCheckpointsData {
    /** 对话 ID */
    conversationId: string;
    /** 检查点列表 */
    checkpoints: CheckpointRecord[];
    /** 标记这是检查点数据 */
    checkpointOnly: true;
}

/**
 * 自动总结完成数据（用于前端插入总结消息）
 */
export interface ChatStreamAutoSummaryData {
    /** 对话 ID */
    conversationId: string;
    /** 标记这是自动总结消息 */
    autoSummary: true;
    /** 自动总结内容 */
    summaryContent: Content;
    /** 总结消息插入位置（完整历史中的绝对索引）。
     *
     * 逻辑截断语义下不删除任何消息：该值 = summarizeEndIndex（被总结区间终点），
     * 总结消息直接插入此位置；被总结区间的原始消息打 isSummarized 标记保留在历史中。 */
    insertIndex: number;
    /**
     * 本次总结标记（被总结覆盖）的原始消息数。
     *
     * 逻辑截断协议：前端应给本地 [insertIndex - removedCount, insertIndex) 区间的消息
     * 打 isSummarized 标记（不删除），并把总结消息插入到 insertIndex；缺省/0 表示本次
     * 没有消息被标记（如首条用户消息保护导致空区间）。
     */
    removedCount?: number;
}

/**
 * 自动总结状态数据（用于前端显示“自动总结中”提示）
 */
export interface ChatStreamAutoSummaryStatusData {
    /** 对话 ID */
    conversationId: string;
    /** 标记这是自动总结状态消息 */
    autoSummaryStatus: true;
    /** 状态 */
    status: 'started' | 'completed' | 'failed';
    /** 可选状态说明 */
    message?: string;
}

// ==================== 重试消息 ====================

/**
 * 重试请求数据
 */
export interface RetryRequestData {
    /** 对话 ID */
    conversationId: string;
    
    /** 配置 ID */
    configId: string;

    /**
     * 模型覆盖（可选）
     *
     * 如果提供，将覆盖该 config 的 model 字段，仅对本次重试生效。
     */
    modelOverride?: string;
    
    /** 取消信号 */
    abortSignal?: AbortSignal;

    /**
     * 总结请求专用取消信号（仅取消总结 API，不中断主对话请求）
     *
     * 仅在自动总结流程中使用。
     */
    summarizeAbortSignal?: AbortSignal;

    /** Prompt 模式 ID（可选） */
    promptModeId?: string;
}

// ==================== 编辑并重试 ====================

/**
 * 编辑并重试请求数据
 */
export interface EditAndRetryRequestData {
    /** 对话 ID */
    conversationId: string;
    
    /** 要编辑的消息索引（必须是用户消息） */
    messageIndex: number;
    
    /** 新的消息内容 */
    newMessage: string;
    
    /** 附件列表（可选） */
    attachments?: AttachmentData[];
    
    /** 配置 ID */
    configId: string;

    /**
     * 模型覆盖（可选）
     *
     * 如果提供，将覆盖该 config 的 model 字段，仅对本次编辑重试生效。
     */
    modelOverride?: string;
    
    /** 取消信号 */
    abortSignal?: AbortSignal;

    /**
     * 总结请求专用取消信号（仅取消总结 API，不中断主对话请求）
     *
     * 仅在自动总结流程中使用。
     */
    summarizeAbortSignal?: AbortSignal;

    /** Prompt 模式 ID（可选） */
    promptModeId?: string;

    /**
     * 可选，保留的检查点 ID（含其增量基链）
     *
     * 回档并编辑场景下传入刚用于恢复的存档点，
     * 使其不随检查点清理而消失，支持反复回档到同一位置。
     */
    preserveCheckpointId?: string;

    /**
     * 可选，被编辑消息的消息 ID（防索引漂移校验）。
     *
     * 请求带 messageId 时，后端会读取 messageIndex 处的消息并校验 id 一致；
     * 不一致说明索引已漂移（并发插入/删除/上下文压缩等），返回 MESSAGE_CHANGED。
     * 旧前端不带该字段时保持旧行为（仅按索引操作）。
     */
    messageId?: string;
}

// ==================== 删除消息 ====================

/**
 * 删除到指定消息请求数据
 */
export interface DeleteToMessageRequestData {
    /** 对话 ID */
    conversationId: string;
    
    /** 目标消息索引（删除到这个索引为止，包括该消息） */
    targetIndex: number;

    /**
     * 可选，保留的检查点 ID（含其增量基链）
     *
     * 回档场景下传入刚用于恢复的存档点，使其不随消息删除而消失，
     * 支持用户反复回档到同一位置。
     */
    preserveCheckpointId?: string;

    /**
     * 可选，被删除消息的消息 ID（防索引漂移校验）。
     *
     * 请求带 messageId 时，后端会校验 targetIndex 处消息 id 一致；
     * 不一致说明索引已漂移（并发插入/删除/上下文压缩等），返回 MESSAGE_CHANGED。
     * 旧前端不带该字段时保持旧行为（仅按索引操作）。
     */
    messageId?: string;
}

/**
 * 删除消息成功响应数据
 */
export interface DeleteToMessageSuccessData {
    success: true;
    /** 删除的消息数量 */
    deletedCount: number;
}

/**
 * 删除消息错误响应数据
 */
export interface DeleteToMessageErrorData {
    success: false;
    error: {
        /** 错误代码 */
        code: string;
        /** 错误消息 */
        message: string;
    };
}

// ==================== 工具确认 ====================

/**
 * 待确认的工具调用信息
 */
export interface PendingToolCall {
    /** 工具调用 ID */
    id: string;
    
    /** 工具名称 */
    name: string;
    
    /** 工具参数 */
    args: Record<string, unknown>;
}

/**
 * 工具确认请求数据（后端发送到前端）
 */
export interface ChatStreamToolConfirmationData {
    /** 对话 ID */
    conversationId: string;
    
    /** 等待确认的工具调用列表 */
    pendingToolCalls: PendingToolCall[];
    
    /** 当前迭代的 AI 回复（包含工具调用） */
    content: Content;
    
    /** 标记需要用户确认 */
    awaitingConfirmation: true;
    
    /** 已自动执行的工具结果（可选） */
    toolResults?: Array<{
        /** 工具调用 ID */
        id?: string;
        /** 工具名称 */
        name: string;
        /** 执行结果 */
        result: Record<string, unknown>;
    }>;
    
    /** 创建的检查点（如果有） */
    checkpoints?: CheckpointRecord[];
}

/**
 * 工具状态更新数据（用于前端实时展示工具队列推进）
 */
export interface ChatStreamToolStatusData {
    /** 对话 ID */
    conversationId: string;

    /** 标记为工具状态更新 */
    toolStatus: true;

    tool: {
        /** 工具调用 ID */
        id: string;
        /** 工具名称 */
        name: string;
        /** 工具状态 */
        status: 'queued' | 'executing' | 'awaiting_apply' | 'success' | 'error' | 'warning';
        /**
         * 可选：工具调用的完整参数快照。
         *
         * 流式提前执行状态可能早于前端完成 partialArgs 解析到达，携带 args 可让工具卡即时补齐描述。
         */
        args?: Record<string, unknown>;
        /** 可选：本次工具的执行结果（用于前端即时展示，不建议用于持久化） */
        result?: Record<string, unknown>;
    };
}

/**
 * 工具开始执行数据（用于在工具执行前先发送计时信息）
 *
 * 这样前端可以在工具执行期间就显示 AI 响应的计时信息（思考时间、响应时间等）
 */
export interface ChatStreamToolsExecutingData {
    /** 对话 ID */
    conversationId: string;
    
    /** 即将执行的工具调用列表 */
    pendingToolCalls: PendingToolCall[];
    
    /** 当前迭代的 AI 回复（包含工具调用和计时信息） */
    content: Content;
    
    /** 标记工具即将开始执行 */
    toolsExecuting: true;
}

/**
 * 工具确认响应请求数据（前端发送到后端）
 */
export interface ToolConfirmationResponseData {
    /** 对话 ID */
    conversationId: string;
    
    /** 配置 ID */
    configId: string;

    /**
     * 模型覆盖（可选）
     *
     * 如果提供，将覆盖该 config 的 model 字段，仅对本次继续对话/工具确认生效。
     */
    modelOverride?: string;
    
    /** 确认或拒绝的工具调用 */
    toolResponses: Array<{
        /** 工具调用 ID */
        id: string;

        /** 工具名称 */
        name: string;

        /** 是否确认执行 */
        confirmed: boolean;
    }>;

    /** 取消信号 */
    abortSignal?: AbortSignal;

    /**
     * 总结请求专用取消信号（仅取消总结 API，不中断主对话请求）
     *
     * 仅在自动总结流程中使用。
     */
    summarizeAbortSignal?: AbortSignal;

    /** Prompt 模式 ID（可选） */
    promptModeId?: string;
}

// ==================== 上下文总结 ====================

/**
 * 总结上下文请求数据
 */
export interface SummarizeContextRequestData {
    /** 对话 ID */
    conversationId: string;
    
    /** 配置 ID */
    configId: string;

    /** 当前对话实际选中的模型（频道默认模型为空或被临时切换时使用） */
    modelOverride?: string;
    
    /** 保留最近 N 轮不参与总结（默认 2） */
    keepRecentRounds?: number;
    
    /** 自定义总结提示词（可选） */
    summarizePrompt?: string;
    
    /** 取消信号 */
    abortSignal?: AbortSignal;
}

/**
 * 总结上下文成功响应数据
 */
export interface SummarizeContextSuccessData {
    success: true;
    /** 总结后的消息内容 */
    summaryContent: Content;
    /** 被总结的消息数量 */
    summarizedMessageCount: number;
    /** @deprecated 总结模型请求的 promptTokenCount；不是主上下文大小。 */
    beforeTokenCount?: number;
    /** @deprecated 总结模型请求的 candidatesTokenCount；不是主上下文大小。 */
    afterTokenCount?: number;
    /** 主上下文压缩统计。 */
    summaryTokenStats?: SummaryTokenStats;
    /** 总结消息插入位置（完整历史中的绝对索引）。
     *
     * 逻辑截断语义下不删除任何消息：该值 = summarizeEndIndex（被总结区间终点），
     * 总结消息直接插入此位置；被总结区间的原始消息打 isSummarized 标记保留在历史中。 */
    insertIndex?: number;
    /**
     * 本次总结标记（被总结覆盖）的原始消息数。
     *
     * 逻辑截断语义下恒不删除消息：自动总结（handleAutoSummarize）与手动总结（handleSummarizeContext）
     * 都把 [markStart, insertIndex) 区间的消息标记为 isSummarized（首条用户消息受保护不标记），
     * 值 = insertIndex - markStart。前端据此标记本地消息并插入总结消息，无需删除任何消息。
     */
    removedCount: number;
}

/**
 * 总结上下文错误响应数据
 */
export interface SummarizeContextErrorData {
    success: false;
    error: {
        /** 错误代码 */
        code: string;
        /** 错误消息 */
        message: string;
    };
}
