/**
 * LimCode - 对话处理器
 *
 * 负责处理对话请求，协调各个模块
 */

import { t } from '../../../i18n';
import type { ConfigManager } from '../../config/ConfigManager';
import type { ChannelManager } from '../../channel/ChannelManager';
import type { ConversationManager } from '../../conversation/ConversationManager';
import type { ToolRegistry } from '../../../tools/ToolRegistry';
import type { CheckpointManager } from '../../checkpoint';
import type { SettingsManager } from '../../settings/SettingsManager';
import type { SettingsChangeEvent, SettingsChangeListener } from '../../settings/types';
import type { McpManager } from '../../mcp/McpManager';
import { PromptManager } from '../../prompt';
import { TokenCountService } from '../../channel/TokenCountService';
import { ChannelError, ErrorType } from '../../channel/types';
import type {
    ChatRequestData,
    ChatSuccessData,
    ChatErrorData,
    ChatStreamChunkData,
    ChatStreamCompleteData,
    ChatStreamErrorData,
    ChatStreamToolIterationData,
    ChatStreamCheckpointsData,
    ChatStreamToolConfirmationData,
    ChatStreamToolsExecutingData,
    ChatStreamToolStatusData,
    ChatStreamAutoSummaryData,
    ChatStreamAutoSummaryStatusData,
    ToolConfirmationResponseData,
    RetryRequestData,
    EditAndRetryRequestData,
    DeleteToMessageRequestData,
    DeleteToMessageSuccessData,
    DeleteToMessageErrorData,
    SummarizeContextRequestData,
    SummarizeContextSuccessData,
    SummarizeContextErrorData
} from './types';
import { ToolCallParserService, MessageBuilderService, TokenEstimationService, ContextTrimService, ToolExecutionService, SummarizeService, ToolIterationLoopService, CheckpointService, DiffInterruptService, ChatFlowService } from './services';
import { ContextBudgetExceededError } from './services/ContextTrimService';
import type { RerollRequestData, EditBranchRequestData } from './services/ChatFlowService';

/**
 * 对话处理器
 *
 * 职责：
 * 1. 接收对话请求
 * 2. 保存用户消息到历史
 * 3. 调用 AI API
 * 4. 处理工具调用（自动执行并返回结果）
 * 5. 保存 AI 响应到历史
 * 6. 返回响应
 */
export class ChatHandler {
    private checkpointManager?: CheckpointManager;
    private settingsManager?: SettingsManager;
    private settingsChangeListener?: SettingsChangeListener;
    private mcpManager?: McpManager;
    private promptManager: PromptManager;
    private tokenCountService: TokenCountService;
    private toolCallParserService: ToolCallParserService;
    private messageBuilderService: MessageBuilderService;
    private tokenEstimationService: TokenEstimationService;
    private contextTrimService: ContextTrimService;
    private toolExecutionService: ToolExecutionService;
    private summarizeService: SummarizeService;
    private toolIterationLoopService: ToolIterationLoopService;
    private checkpointService: CheckpointService;
    private diffInterruptService: DiffInterruptService;
    private chatFlowService: ChatFlowService;
    
    constructor(
        private configManager: ConfigManager,
        private channelManager: ChannelManager,
        private conversationManager: ConversationManager,
        private toolRegistry?: ToolRegistry
    ) {
        this.promptManager = new PromptManager();
        this.tokenCountService = new TokenCountService();
        this.toolCallParserService = new ToolCallParserService();
        this.messageBuilderService = new MessageBuilderService();
        this.tokenEstimationService = new TokenEstimationService(
            this.conversationManager,
            this.tokenCountService
        );
        this.contextTrimService = new ContextTrimService(
            this.conversationManager,
            this.promptManager,
            this.tokenEstimationService,
            this.messageBuilderService
        );
        this.checkpointService = new CheckpointService(
            this.conversationManager
        );
        this.toolExecutionService = new ToolExecutionService(
            this.toolRegistry,
            this.mcpManager,
            this.settingsManager,
            this.checkpointService,
            // BCP-01：注入 ConversationManager，让工具批次 before/after 存档点共用一次
            // getMessageNodeIdAt 反查（每批次只全量重读一次 transcript，而非两次）
            this.conversationManager
        );
        // 注入 conversationStore，供 todo_write 等工具持久化使用
        this.toolExecutionService.setConversationStore(this.conversationManager);
        this.summarizeService = new SummarizeService(
            this.configManager,
            this.channelManager,
            this.conversationManager,
            this.contextTrimService
        );
        this.toolIterationLoopService = new ToolIterationLoopService(
            this.channelManager,
            this.conversationManager,
            this.toolCallParserService,
            this.messageBuilderService,
            this.tokenEstimationService,
            this.contextTrimService,
            this.toolExecutionService,
            this.checkpointService
        );
        this.diffInterruptService = new DiffInterruptService();
        this.chatFlowService = new ChatFlowService(
            this.configManager,
            this.conversationManager,
            this.settingsManager,
            this.messageBuilderService,
            this.tokenEstimationService,
            this.toolIterationLoopService,
            this.checkpointService,
            this.diffInterruptService,
            this.toolExecutionService,
            this.toolCallParserService
        );
        // 设置 PromptManager 到 ToolIterationLoopService
        this.toolIterationLoopService.setPromptManager(this.promptManager);
        // 设置 SummarizeService 到 ToolIterationLoopService（用于自动总结）
        this.toolIterationLoopService.setSummarizeService(this.summarizeService);
        // 设置 TokenEstimationService 到 SummarizeService（用于估算待总结消息的 token 数）
        this.summarizeService.setTokenEstimationService(this.tokenEstimationService);
    }
    
    /**
     * 设置检查点管理器（可选）
     */
    setCheckpointManager(checkpointManager: CheckpointManager): void {
        this.checkpointManager = checkpointManager;
        this.checkpointService.setCheckpointManager(checkpointManager);
    }
    
    /**
     * 设置设置管理器（可选）
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        // 避免重复注册 listener（setSettingsManager 可能被多次调用）
        if (this.settingsChangeListener && this.settingsManager) {
            this.settingsManager.removeChangeListener(this.settingsChangeListener);
        }
        
        const listener: SettingsChangeListener = this.settingsChangeListener ?? ((event: SettingsChangeEvent) => {
            const path = event.path;
            const pathStartsWithSystemPrompt =
                typeof path === 'string' && path.startsWith('toolsConfig.system_prompt');
            
            const toolsChangeContainsSystemPrompt =
                event.type === 'tools'
                && (
                    (typeof path === 'string' && path.includes('system_prompt'))
                    || (event.newValue && typeof event.newValue === 'object' && 'system_prompt' in (event.newValue as Record<string, unknown>))
                    || (event.oldValue && typeof event.oldValue === 'object' && 'system_prompt' in (event.oldValue as Record<string, unknown>))
                );
            
            if (pathStartsWithSystemPrompt || toolsChangeContainsSystemPrompt) {
                this.promptManager.invalidateCache();
            }
        });
        
        this.settingsChangeListener = listener;
        this.settingsManager = settingsManager;
        this.settingsManager.addChangeListener(listener);
        // 更新 tokenCountService 的代理设置
        this.tokenCountService.setProxyUrl(settingsManager.getEffectiveProxyUrl());
        // 更新 tokenEstimationService 的设置管理器
        this.tokenEstimationService.setSettingsManager(settingsManager);
        // 更新 toolExecutionService 的设置管理器
        this.toolExecutionService.setSettingsManager(settingsManager);
        // 更新 summarizeService 的设置管理器
        this.summarizeService.setSettingsManager(settingsManager);
        // 更新 checkpointService 的设置管理器
        this.checkpointService.setSettingsManager(settingsManager);
        // 更新 chatFlowService 的设置引用
        this.chatFlowService = new ChatFlowService(
            this.configManager,
            this.conversationManager,
            this.settingsManager,
            this.messageBuilderService,
            this.tokenEstimationService,
            this.toolIterationLoopService,
            this.checkpointService,
            this.diffInterruptService,
            this.toolExecutionService,
            this.toolCallParserService
        );
    }
    
    /**
     * 设置 MCP 管理器（可选）
     */
    setMcpManager(mcpManager: McpManager): void {
        this.mcpManager = mcpManager;
        this.toolExecutionService.setMcpManager(mcpManager);
    }

    /**
     * 获取共享工具执行服务，供 SubAgent 复用主流程工具执行语义。
     */
    getToolExecutionService(): ToolExecutionService {
        return this.toolExecutionService;
    }
    
    /**
     * 处理非流式对话请求
     * 支持工具调用循环：当 AI 返回工具调用时，自动执行工具并将结果返回给 AI
     *
     * @param request 对话请求数据
     * @returns 对话响应数据
     */
    async handleChat(request: ChatRequestData): Promise<ChatSuccessData | ChatErrorData> {
        try {
            return await this.chatFlowService.handleChat(request);
        } catch (error) {
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 格式化错误信息
     * 如果有详细错误信息（如 API 返回的响应体），直接追加显示
     */
    private formatError(error: unknown): { code: string; message: string } {
        if (error instanceof ContextBudgetExceededError) {
            // 上下文窗口内无法构造合法请求：这是可解释的确定性错误，走 i18n 消息并透出 CONTEXT_OVERFLOW 码，
            // 而不是把异常英文原文（含估算数字）直接展示给用户。
            return {
                code: error.code,
                message: t('modules.api.chat.errors.contextOverflow', {
                    estimatedInputTokens: error.estimatedInputTokens,
                    inputTokenLimit: error.inputTokenLimit
                })
            };
        }
        if (error instanceof ChannelError) {
            let message = error.message;
            
            // 如果有详细错误信息，直接 JSON 序列化追加
            if (error.details) {
                try {
                    const detailsStr = typeof error.details === 'string'
                        ? error.details
                        : JSON.stringify(error.details, null, 2);
                    message = `${error.message}\n${detailsStr}`;
                } catch {
                    // 忽略序列化错误
                }
            }
            
            return {
                code: error.type || 'CHANNEL_ERROR',
                message
            };
        }
        
        const err = error as any;
        return {
            code: err.code || 'UNKNOWN_ERROR',
            message: err.message || t('modules.api.chat.errors.unknownError')
        };
    }
    
    /**
     * 处理流式对话请求（自动根据配置决定使用流式或非流式）
     * 支持工具调用循环：当 AI 返回工具调用时，自动执行工具并将结果返回给 AI
     *
     * @param request 对话请求数据
     * @returns 异步生成器，产生流式响应
     */
    async *handleChatStream(
        request: ChatRequestData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamCheckpointsData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        try {
            for await (const chunk of this.chatFlowService.handleChatStream(request)) {
                yield chunk;
            }
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // C-5：abort 后底层可能抛原生 AbortError（非 ChannelError），补信号检查避免误报"出错"
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }
            
            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 处理工具确认响应
     *
     * 当用户在前端确认或拒绝工具执行时调用此方法
     *
     * @param request 工具确认响应数据
     */
    async *handleToolConfirmation(
        request: ToolConfirmationResponseData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamCheckpointsData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        // 新实现：委托给 ChatFlowService 处理完整流程，保留统一的错误处理逻辑
        try {
            for await (const chunk of this.chatFlowService.handleToolConfirmation(request)) {
                yield chunk as any;
            }
            return;
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // 检查是否是取消导致的错误（信号已中止）
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
            return;
        }
    }
    
    /**
     * 处理上下文总结请求
     *
     * 将指定范围的对话历史压缩为一条总结消息
     *
     * @param request 总结请求数据
     * @returns 总结响应数据
     */
    async handleSummarizeContext(
        request: SummarizeContextRequestData
    ): Promise<SummarizeContextSuccessData | SummarizeContextErrorData> {
        return this.summarizeService.handleSummarizeContext(request);
    }

    /**
     * 恢复指定总结消息覆盖的原文（逻辑截断的反向操作）
     *
     * 取消覆盖区间的 isSummarized 标记并删除总结消息，原文重新参与发送与统计。
     *
     * @returns 恢复的消息数与被删除的总结消息 id
     */
    async handleRestoreSummarizedMessages(
        conversationId: string,
        summaryMessageId: string
    ): Promise<{ success: true; restoredCount: number; removedSummaryId?: string }> {
        return this.summarizeService.restoreSummarizedMessages(conversationId, summaryMessageId);
    }
    /**
     * 处理重试请求（非流式）
     * 支持工具调用循环
     *
     * @param request 重试请求数据
     * @returns 对话响应数据
     */
    async handleRetry(request: RetryRequestData): Promise<ChatSuccessData | ChatErrorData> {
        try {
            return await this.chatFlowService.handleRetry(request);
        } catch (error) {
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 处理重试请求（自动根据配置决定使用流式或非流式）
     * 支持工具调用循环
     *
     * @param request 重试请求数据
     * @returns 异步生成器，产生流式响应
     */
    async *handleRetryStream(
        request: RetryRequestData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        try {
            for await (const chunk of this.chatFlowService.handleRetryStream(request)) {
                // ChatFlowService 返回的是 ChatStreamOutput 联合类型，这里向下兼容原有联合类型
                yield chunk as any;
            }
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // C-5：abort 后底层可能抛原生 AbortError（非 ChannelError），补信号检查避免误报"出错"
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }
            
            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 处理 reroll 请求（TREE-01：重新生成并保留旧回答，流式）
     * 支持工具调用循环；旧回答作为候选保留在分支图中，失败可切回（决策 10）。
     *
     * @param request reroll 请求数据
     * @returns 异步生成器，产生流式响应
     */
    async *handleRerollStream(
        request: RerollRequestData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        try {
            for await (const chunk of this.chatFlowService.handleRerollStream(request)) {
                yield chunk as any;
            }
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // C-5：abort 后底层可能抛原生 AbortError（非 ChannelError），补信号检查避免误报"出错"
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
        }
    }

    /**
     * 处理编辑用户消息分支请求（TREE-03：编辑用户消息时创建新的用户消息分支，不覆盖原消息，流式）。
     * 支持工具调用循环；旧用户节点及其子树保留在分支图中，失败可切回（决策 10 精神）。
     *
     * @param request 编辑分支请求数据
     * @returns 异步生成器，产生流式响应
     */
    async *handleEditBranchStream(
        request: EditBranchRequestData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamCheckpointsData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        try {
            for await (const chunk of this.chatFlowService.handleEditBranchStream(request)) {
                yield chunk as any;
            }
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // C-5：abort 后底层可能抛原生 AbortError（非 ChannelError），补信号检查避免误报"出错"
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
        }
    }

    /**
     * 处理编辑并重试请求（非流式）
     * 支持工具调用循环
     *
     * @param request 编辑并重试请求数据
     * @returns 对话响应数据
     */
    async handleEditAndRetry(
        request: EditAndRetryRequestData
    ): Promise<ChatSuccessData | ChatErrorData> {
        try {
            return await this.chatFlowService.handleEditAndRetry(request);
        } catch (error) {
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 处理编辑并重试请求（自动根据配置决定使用流式或非流式）
     * 支持工具调用循环
     *
     * @param request 编辑并重试请求数据
     * @returns 异步生成器，产生流式响应
     */
    async *handleEditAndRetryStream(
        request: EditAndRetryRequestData
    ): AsyncGenerator<
        ChatStreamChunkData
        | ChatStreamCompleteData
        | ChatStreamErrorData
        | ChatStreamToolIterationData
        | ChatStreamCheckpointsData
        | ChatStreamToolConfirmationData
        | ChatStreamToolsExecutingData
        | ChatStreamToolStatusData
        | ChatStreamAutoSummaryData
        | ChatStreamAutoSummaryStatusData
    > {
        try {
            for await (const chunk of this.chatFlowService.handleEditAndRetryStream(request)) {
                yield chunk as any;
            }
        } catch (error) {
            // 检查是否是用户取消错误
            if (error instanceof ChannelError && error.type === ErrorType.CANCELLED_ERROR) {
                // 用户取消，yield cancelled 消息
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }

            // C-5：abort 后底层可能抛原生 AbortError（非 ChannelError），补信号检查避免误报"出错"
            if (request.abortSignal?.aborted) {
                yield {
                    conversationId: request.conversationId,
                    cancelled: true as const
                } as any;
                return;
            }
            
            yield {
                conversationId: request.conversationId,
                error: this.formatError(error)
            };
        }
    }
    
    /**
     * 处理删除到指定消息的请求
     *
     * @param request 删除请求数据
     * @returns 删除响应数据
     */
    async handleDeleteToMessage(
        request: DeleteToMessageRequestData
    ): Promise<DeleteToMessageSuccessData | DeleteToMessageErrorData> {
        try {
            return await this.chatFlowService.handleDeleteToMessage(request);
        } catch (error) {
            return {
                success: false,
                error: this.formatError(error)
            };
        }
    }

    /**
     * 在外部进行历史删除/回退后，刷新派生元数据（todoList / activeBuild 等）
     */
    async refreshDerivedMetadataAfterHistoryMutation(conversationId: string): Promise<void> {
        try {
            await this.chatFlowService.refreshDerivedMetadataAfterHistoryMutation(conversationId);
        } catch (error) {
            console.error('[ChatHandler] Failed to refresh derived metadata:', error);
        }
    }
    
}
