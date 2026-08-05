/**
 * LimCode - 上下文总结服务
 *
 * 负责将对话历史压缩为总结消息
 */

import { t } from '../../../../i18n';
import { Logger } from '../../../../core/logger';
import { ErrorType } from '../../../channel/types';
import { isRealUserMessage } from '../../../conversation/helpers';
import type { ConfigManager } from '../../../config/ConfigManager';
import type {ChannelManager } from '../../../channel/ChannelManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { Content } from '../../../conversation/types';
import type { GenerateResponse, StreamChunk } from '../../../channel/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { StreamAccumulator } from '../../../channel/StreamAccumulator';
import type { ContextTrimService } from './ContextTrimService';
import { DEFAULT_MAX_CONTEXT_TOKENS } from './ContextTrimService';
import type { TokenEstimationService } from './TokenEstimationService';
import {
    planSummarizeMessages,
    resolveKeepRecentTokenBudget
} from './summarizeRangePlanner';
import {
    DEFAULT_MAX_AUTO_SUMMARIZE_ATTEMPTS_PER_TURN,
    DEFAULT_SUMMARIZE_MAX_INPUT_RATIO,
    clampMaxAutoSummarizeAttempts,
    clampSummarizeMaxInputRatio
} from '../../../settings/summarizeTypes';
import type {
    SummarizeContextRequestData,
    SummarizeContextSuccessData,
    SummarizeContextErrorData
} from '../types';

/**
 * Built-in summarize system prompt (English only, channel-agnostic).
 *
 * Some providers/channels require non-empty instructions/system prompt,
 * so we always send this prompt during summarize requests.
 */
const BUILTIN_SUMMARIZE_SYSTEM_PROMPT = `You are an expert conversation summarization assistant.
Always respond in English.
Produce a structured summary with clear, step-by-step sections.
Follow this exact structure:
1. User Goal
2. Completed Steps
3. Current Progress
4. Next Steps
5. Important Constraints
6. Open Questions / Risks
Use concise bullet points under each section.
Preserve exact technical details (file paths, function names, config keys, IDs, and numbers).`;


/**
 * 上下文总结服务
 *
 * 职责：
 * 1. 处理上下文总结请求
 * 2. 识别需要总结的回合范围
 * 3. 清理历史消息中的内部字段
 * 4. 调用 AI 生成总结
 * 5. 管理总结消息的插入和删除
 */
export class SummarizeService {
    private readonly log = Logger.get('SummarizeService');

    constructor(
        private configManager: ConfigManager,
        private channelManager: ChannelManager,
        private conversationManager: ConversationManager,
        private contextTrimService: ContextTrimService,
        private settingsManager?: SettingsManager,
        private tokenEstimationService?: TokenEstimationService
    ) {}

    /**
     * 设置 Token 估算服务
     */
    setTokenEstimationService(service: TokenEstimationService): void {
        this.tokenEstimationService = service;
    }

    /**
     * 设置设置管理器
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        this.settingsManager = settingsManager;
    }

    /**
     * 单个真实用户回合内自动总结的最大尝试次数。
     *
     * 供 ToolIterationLoopService 在回合开始时读取；配置缺失/非法时回落内置默认值 2。
     */
    getMaxAutoSummarizeAttemptsPerTurn(): number {
        const config = this.settingsManager?.getSummarizeConfig?.();
        return clampMaxAutoSummarizeAttempts(config?.maxAutoSummarizeAttemptsPerTurn);
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
        try {
            const { conversationId, configId } = request;
            this.log.info('manual.start', { conversationId, configId });

            // 从设置中读取总结配置
            let configKeepRecentRounds = 2;  // 默认值
            let configKeepRecentTokens: number | string | undefined;  // 保留预算（缺失/非法时由 planner 回落到内置默认值）
            let configSummarizePrompt = '';  // 默认值（空则使用内置 i18n 提示词）
            let useSeparateModel = false;
            let summarizeChannelId = '';
            let summarizeModelId = '';

            if (this.settingsManager) {
                const summarizeConfig = this.settingsManager.getSummarizeConfig();
                if (summarizeConfig) {
                    if (typeof summarizeConfig.keepRecentRounds === 'number') {
                        configKeepRecentRounds = summarizeConfig.keepRecentRounds;
                    }
                    if (typeof summarizeConfig.keepRecentTokens === 'number' || typeof summarizeConfig.keepRecentTokens === 'string') {
                        configKeepRecentTokens = summarizeConfig.keepRecentTokens;
                    }
                    if (typeof summarizeConfig.summarizePrompt === 'string') {
                        configSummarizePrompt = summarizeConfig.summarizePrompt;
                    }
                    useSeparateModel = !!summarizeConfig.useSeparateModel;
                    summarizeChannelId = summarizeConfig.summarizeChannelId || '';
                    summarizeModelId = summarizeConfig.summarizeModelId || '';
                }
            }
            const keepRecentRounds = configKeepRecentRounds;

            // 1. 确保对话存在
            await this.conversationManager.getHistory(conversationId);

            // 2. 确定使用的渠道配置
            let actualConfigId = configId;
            let actualModelId: string | undefined;

            if (useSeparateModel && summarizeChannelId) {
                const summarizeConfig = await this.configManager.getConfig(summarizeChannelId);
                if (summarizeConfig && summarizeConfig.enabled) {
                    actualConfigId = summarizeChannelId;
                    if (summarizeModelId) {
                        actualModelId = summarizeModelId;
                    }
                    this.log.info('manual.dedicated_model', { channelId: summarizeChannelId, modelId: summarizeModelId || 'default' });
                } else {
                    this.log.warn('manual.dedicated_channel_unavailable', { channelId: summarizeChannelId });
                }
            }

            // 3. 验证配置
            const config = await this.configManager.getConfig(actualConfigId);
            if (!config) {
                return {
                    success: false,
                    error: {
                        code: 'CONFIG_NOT_FOUND',
                        message: t('modules.api.chat.errors.configNotFound', { configId: actualConfigId })
                    }
                };
            }

            if (!config.enabled) {
                return {
                    success: false,
                    error: {
                        code: 'CONFIG_DISABLED',
                        message: t('modules.api.chat.errors.configDisabled', { configId: actualConfigId })
                    }
                };
            }

            // 4. 获取对话历史
            const fullHistory = await this.conversationManager.getHistoryRef(conversationId);

            this.log.info('manual.history_loaded', { conversationId, fullHistoryLength: fullHistory.length });

            // 5. 找到最后一个总结消息的位置
            // - 回合识别从最后一个总结消息之后开始（避免反复把旧对话算进“新回合”）
            // - 但真正发给 AI 做“合并总结”的内容，需要包含最后一个总结消息本身（用于承接之前的总结）
            const lastSummaryIndex = this.contextTrimService.findLastSummaryIndex(fullHistory);
            const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : 0;

            // 6. 基于 token 预算解析总结范围（保留最近约 keepRecentTokens 的内容，按轮边界对齐）
            const rangeResult = await this.resolveSummarizeRange({
                conversationId,
                fullHistory,
                lastSummaryIndex,
                mainConfigId: configId,
                keepRecentRounds,
                keepRecentTokens: configKeepRecentTokens,
                mode: 'manual'
            });

            if (!rangeResult.ok) {
                this.log.info('manual.range_unavailable', { conversationId, code: rangeResult.code, rounds: rangeResult.currentRounds, keepRecentRounds });
                return {
                    success: false,
                    error: {
                        code: rangeResult.code,
                        message: rangeResult.code === 'NOT_ENOUGH_ROUNDS'
                            ? t('modules.api.chat.errors.notEnoughRounds', { currentRounds: rangeResult.currentRounds, keepRounds: keepRecentRounds })
                            : t('modules.api.chat.errors.notEnoughContent', { currentRounds: rangeResult.currentRounds, keepRounds: keepRecentRounds })
                    }
                };
            }

            const summarizeEndIndex = rangeResult.summarizeEndIndex;

            // 提取需要总结的消息：
            // - 如果存在旧总结，则用“旧总结 + 总结之后的新消息”作为输入，避免每次都把最早的原始对话重新发给 AI。
            // - 如果不存在旧总结，则从 0 开始。
            const summarizeInputStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;
            const messagesToSummarize = fullHistory.slice(summarizeInputStartIndex, summarizeEndIndex);

            // 计算“本次总结后，累计覆盖了多少条原始消息”
            const previousSummarizedCount = this.resolvePreviousSummarizedCount(fullHistory, lastSummaryIndex);
            // 这次新纳入总结的消息数量（不包含旧 summary 本身）
            const newlySummarizedCount = summarizeEndIndex - historyStartIndex;
            const totalSummarizedCount = previousSummarizedCount + newlySummarizedCount;

            if (messagesToSummarize.length === 0) {
                this.log.warn('manual.no_messages', { conversationId, summarizeInputStartIndex, summarizeEndIndex });
                return {
                    success: false,
                    error: {
                        code: 'NO_MESSAGES_TO_SUMMARIZE',
                        message: t('modules.api.chat.errors.noMessagesToSummarize')
                    }
                };
            }

            // 7. 构建总结请求（用户提示词可在设置中配置）
            const defaultPrompt = t('modules.api.chat.prompts.defaultSummarizePrompt');
            const configuredManualPrompt = configSummarizePrompt.trim();
            const prompt = configuredManualPrompt || defaultPrompt;

            // 清理历史中不应发送给 API 的内部字段
            const cleanedMessages = this.cleanMessagesForSummarize(messagesToSummarize, config);

            this.log.info('manual.cleaned', {
                conversationId,
                channelType: config.type,
                rawMessageCount: messagesToSummarize.length,
                cleanedMessageCount: cleanedMessages.length,
                rawTotalParts: messagesToSummarize.reduce((s, m) => s + m.parts.length, 0),
                cleanedTotalParts: cleanedMessages.reduce((s, m) => s + m.parts.length, 0),
                summarizeInputStartIndex,
                summarizeEndIndex,
                keepRecentRounds
            });

            // 构建历史
            const summaryRequestHistory: Content[] = [
                ...cleanedMessages,
                {
                    role: 'user',
                    parts: [{ text: prompt }]
                }
            ];

            // 8. 调用 AI 生成总结
            const generateOptions: {
                configId: string;
                history: Content[];
                abortSignal?: AbortSignal;
                skipTools: boolean;
                skipRetry: boolean;
                modelOverride?: string;
                dynamicSystemPrompt: string;
            } = {
                configId: actualConfigId,
                history: summaryRequestHistory,
                abortSignal: request.abortSignal,
                skipTools: true,
                dynamicSystemPrompt: BUILTIN_SUMMARIZE_SYSTEM_PROMPT,
                skipRetry: true
            };

            if (actualModelId) {
                generateOptions.modelOverride = actualModelId;
            }

            const response = await this.channelManager.generate(generateOptions);

            // 处理响应
            let finalContent: Content;

            if (this.isAsyncGenerator(response)) {
                const accumulator = new StreamAccumulator();
                accumulator.setProviderType(config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom');

                for await (const chunk of response) {
                    if (request.abortSignal?.aborted) {
                        return {
                            success: false,
                            error: {
                                code: 'ABORTED',
                                message: t('modules.api.chat.errors.summarizeAborted')
                            }
                        };
                    }
                    accumulator.add(chunk);
                }

                finalContent = accumulator.getContent();
            } else {
                finalContent = (response as GenerateResponse).content;
            }

            // 9. 提取 token 信息
            const beforeTokenCount = finalContent.usageMetadata?.promptTokenCount;
            const afterTokenCount = finalContent.usageMetadata?.candidatesTokenCount;

            // 10. 提取总结文本
            const summaryText = finalContent.parts
                .filter(p => p.text && !p.thought)
                .map(p => p.text)
                .join('\n')
                .trim();

            if (!summaryText) {
                this.log.warn('manual.empty_summary', {
                    conversationId,
                    partsCount: finalContent.parts.length,
                    promptTokens: beforeTokenCount,
                    completionTokens: afterTokenCount
                });
                return {
                    success: false,
                    error: {
                        code: 'EMPTY_SUMMARY',
                        message: t('modules.api.chat.errors.emptySummary')
                    }
                };
            }

            // 11. 插入新的总结消息
            // 注意：这里不删除旧的总结消息。
            // 这样用户可以保留每一次总结的历史记录；同时后续上下文裁剪/下一次总结都会自动使用“最后一个总结消息”。
            const insertIndex = summarizeEndIndex;

            // 12. 创建总结消息并添加到历史
            const summaryContent: Content = {
                role: 'user',
                parts: [{ text: `${t('modules.api.chat.prompts.summaryPrefix')}\n\n${summaryText}` }],
                index: insertIndex,
                isSummary: true,
                summarizedMessageCount: totalSummarizedCount,
                usageMetadata: {
                    promptTokenCount: beforeTokenCount,
                    candidatesTokenCount: afterTokenCount
                }
            };

            await this.conversationManager.insertContent(conversationId, insertIndex, summaryContent);

            this.log.info('manual.completed', {
                conversationId,
                insertIndex,
                totalSummarizedCount,
                promptTokens: beforeTokenCount,
                completionTokens: afterTokenCount
            });

            return {
                success: true,
                summaryContent,
                summarizedMessageCount: totalSummarizedCount,
                beforeTokenCount,
                afterTokenCount,
                insertIndex
            };

        } catch (error) {
            const err = error as any;
            this.log.error('manual.exception', { conversationId: request.conversationId, code: err.code, message: err.message });
            // 用户取消（abort）不是普通失败：返回 ABORTED，避免调用方把它当作失败重试
            if (this.isAbortError(err)) {
                return {
                    success: false,
                    error: {
                        code: 'ABORTED',
                        message: t('modules.api.chat.errors.summarizeAborted')
                    }
                };
            }
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.chat.errors.unknownError')
                }
            };
        }
    }

    /**
     * 清理消息中不应发送给 API 的内部字段
     */
    private cleanMessagesForSummarize(messages: Content[], config: BaseChannelConfig): Content[] {
        return messages.map(msg => {
            const cleanedParts = msg.parts
                // 过滤掉思考内容
                .filter(part => !part.thought && !(part.thoughtSignatures && Object.keys(part).length === 1))
                .map(part => {
                    let cleanedPart = { ...part };

                    // 移除思考签名
                    if (cleanedPart.thoughtSignatures) {
                        const { thoughtSignatures, ...rest } = cleanedPart;
                        cleanedPart = rest;
                    }

                    // 清理 functionCall 中的 rejected 字段
                    if (cleanedPart.functionCall) {
                        const { rejected, ...cleanedFunctionCall } = cleanedPart.functionCall;
                        cleanedPart = {
                            ...cleanedPart,
                            functionCall: cleanedFunctionCall
                        };
                    }

                    // 清理 inlineData 中的元数据字段
                    if (cleanedPart.inlineData) {
                        if (config.type === 'gemini') {
                            const { id, name, ...cleanedInlineData } = cleanedPart.inlineData;
                            cleanedPart = {
                                ...cleanedPart,
                                inlineData: cleanedInlineData
                            };
                        } else {
                            const { id, name, displayName, ...cleanedInlineData } = cleanedPart.inlineData;
                            cleanedPart = {
                                ...cleanedPart,
                                inlineData: cleanedInlineData
                            };
                        }
                    }

                    // 清理 functionResponse.response 中的内部字段
                    // 与 conversation/helpers.cleanFunctionResponseForAPI 行为对齐：
                    // 顶层剥离 diffContentId/diffId/diffs/pendingDiffId/agentInbox（A-COMM 信箱消息，
                    // drain 一次性语义，禁止历史重放），data 层额外剥离 toolId/terminalId/multiRoot/
                    // command/cwd/shell/channelName/modelId/steps 等运行时元数据（仅供前端 UI 展示）；
                    // response / data 为数组时没有内部字段语义，原样返回（防止把数组误当对象解构）
                    if (cleanedPart.functionResponse) {
                        const rawResponse = cleanedPart.functionResponse.response as Record<string, unknown> | undefined;

                        if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
                            const { diffContentId, diffId, diffs, pendingDiffId, agentInbox, ...rest } = rawResponse;

                            if (rest.data && typeof rest.data === 'object' && !Array.isArray(rest.data)) {
                                const {
                                    diffContentId: dataDiffContentId,
                                    diffId: dataDiffId,
                                    diffs: dataDiffs,
                                    pendingDiffId: dataPendingDiffId,
                                    toolId: dataToolId,
                                    terminalId: dataTerminalId,
                                    multiRoot: dataMultiRoot,
                                    command: dataCommand,
                                    cwd: dataCwd,
                                    shell: dataShell,
                                    channelName: dataChannelName,
                                    modelId: dataModelId,
                                    steps: dataSteps,
                                    agentInbox: dataAgentInbox,
                                    ...dataRest
                                } = rest.data as Record<string, unknown>;

                                // data.results 数组中的每个元素同样剥离 diffContentId / pendingDiffId
                                if (Array.isArray(dataRest.results)) {
                                    dataRest.results = (dataRest.results as Array<Record<string, unknown>>).map(item => {
                                        if (item && typeof item === 'object' && !Array.isArray(item)) {
                                            const { diffContentId: itemDiffContentId, pendingDiffId: itemPendingDiffId, ...itemRest } = item;
                                            return itemRest;
                                        }
                                        return item;
                                    });
                                }

                                rest.data = dataRest;
                            }

                            cleanedPart = {
                                ...cleanedPart,
                                functionResponse: {
                                    ...cleanedPart.functionResponse,
                                    response: rest
                                }
                            };
                        }
                    }

                    return cleanedPart;
                })
                // 过滤掉清理后变成空的 parts
                .filter(part => {
                    const keys = Object.keys(part);
                    if (keys.length === 0) return false;
                    // 仅剩 thought: true/false 的空壳 part
                    if (keys.length === 1 && keys[0] === 'thought') return false;
                    return true;
                });

            // 跳过清理后 parts 为空的消息
            if (cleanedParts.length === 0) {
                return null;
            }

            // 保留消息的核心字段，移除不应发送给 API 的内部元数据
            const result: Content = {
                role: msg.role,
                parts: cleanedParts
            };

            // 保留总结消息标记（用于增量总结时 AI 理解上下文）
            if (msg.isSummary) {
                result.isSummary = msg.isSummary;
            }

            return result;
        }).filter((msg): msg is Content => msg !== null);
    }

    /**
     * 处理自动总结请求
     *
     * 与手动总结的区别：
     * 1. 用户可配置自动总结用户提示词（与手动总结一样）
     * 2. 当待总结内容超出总结模型上下文时，保留最后一轮工具交互不总结
     * 3. 总结完成后循环自然继续，AI 看到总结内容即可无缝衔接
     *
     * @param conversationId 对话 ID
     * @param configId 当前使用的配置 ID
     * @param abortSignal 取消信号
     * @returns 总结结果
     */
    async handleAutoSummarize(
        conversationId: string,
        configId: string,
        abortSignal?: AbortSignal
    ): Promise<SummarizeContextSuccessData | SummarizeContextErrorData> {
        try {
            this.log.info('auto.start', { conversationId, configId });

            // 从设置中读取总结配置
            let keepRecentRounds = 2;
            let configKeepRecentTokens: number | string | undefined;  // 保留预算（缺失/非法时由 planner 回落到内置默认值）
            let useSeparateModel = false;
            let summarizeChannelId = '';
            let configAutoSummarizePrompt = '';
            let summarizeModelId = '';
            // 自动总结单次请求输入占总结模型上下文窗口的比例（0~1，默认 0.5）
            let configSummarizeMaxInputRatio = DEFAULT_SUMMARIZE_MAX_INPUT_RATIO;

            if (this.settingsManager) {
                const summarizeConfig = this.settingsManager.getSummarizeConfig();
                if (summarizeConfig) {
                    if (typeof summarizeConfig.keepRecentRounds === 'number') {
                        keepRecentRounds = summarizeConfig.keepRecentRounds;
                    }
                    if (typeof summarizeConfig.keepRecentTokens === 'number' || typeof summarizeConfig.keepRecentTokens === 'string') {
                        configKeepRecentTokens = summarizeConfig.keepRecentTokens;
                    }
                    useSeparateModel = !!summarizeConfig.useSeparateModel;
                    summarizeChannelId = summarizeConfig.summarizeChannelId || '';
                    summarizeModelId = summarizeConfig.summarizeModelId || '';
                    configSummarizeMaxInputRatio = clampSummarizeMaxInputRatio(summarizeConfig.summarizeMaxInputRatio);
                    if (typeof summarizeConfig.autoSummarizePrompt === 'string') {
                        configAutoSummarizePrompt = summarizeConfig.autoSummarizePrompt;
                    }
                }
            }

            // 1. 确定使用的渠道配置
            let actualConfigId = configId;
            let actualModelId: string | undefined;

            if (useSeparateModel && summarizeChannelId) {
                const summarizeConfig = await this.configManager.getConfig(summarizeChannelId);
                if (summarizeConfig && summarizeConfig.enabled) {
                    actualConfigId = summarizeChannelId;
                    if (summarizeModelId) {
                        actualModelId = summarizeModelId;
                    }
                    this.log.info('auto.dedicated_model', { channelId: summarizeChannelId, modelId: summarizeModelId || 'default' });
                } else {
                    this.log.warn('auto.dedicated_channel_unavailable', { channelId: summarizeChannelId });
                }
            }

            // 2. 验证配置
            const config = await this.configManager.getConfig(actualConfigId);
            if (!config) {
                return {
                    success: false,
                    error: {
                        code: 'CONFIG_NOT_FOUND',
                        message: t('modules.api.chat.errors.configNotFound', { configId: actualConfigId })
                    }
                };
            }

            if (!config.enabled) {
                return {
                    success: false,
                    error: {
                        code: 'CONFIG_DISABLED',
                        message: t('modules.api.chat.errors.configDisabled', { configId: actualConfigId })
                    }
                };
            }

            // 3. 获取对话历史
            const fullHistory = await this.conversationManager.getHistoryRef(conversationId);

            this.log.info('auto.history_loaded', { conversationId, fullHistoryLength: fullHistory.length });
            // 4. 找到最后一个总结消息
            const lastSummaryIndex = this.contextTrimService.findLastSummaryIndex(fullHistory);
            const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : 0;

            // 5. 基于 token 预算解析总结范围（保留最近约 keepRecentTokens 的内容，按轮边界对齐；
            //    极端场景下对单个超大轮做轮内截断，防止总结反复失败死锁）
            const rangeResult = await this.resolveSummarizeRange({
                conversationId,
                fullHistory,
                lastSummaryIndex,
                mainConfigId: configId,
                keepRecentRounds,
                keepRecentTokens: configKeepRecentTokens,
                mode: 'auto'
            });

            if (!rangeResult.ok) {
                this.log.info('auto.range_unavailable', { conversationId, code: rangeResult.code, rounds: rangeResult.currentRounds, keepRecentRounds });
                return {
                    success: false,
                    error: {
                        code: rangeResult.code,
                        message: rangeResult.code === 'NOT_ENOUGH_ROUNDS'
                            ? t('modules.api.chat.errors.notEnoughRounds', { currentRounds: rangeResult.currentRounds, keepRounds: keepRecentRounds })
                            : t('modules.api.chat.errors.notEnoughContent', { currentRounds: rangeResult.currentRounds, keepRounds: keepRecentRounds })
                    }
                };
            }

            const summarizeEndIndex = rangeResult.summarizeEndIndex;

            // 提取需要总结的消息（包含旧总结以实现增量总结）
            const summarizeInputStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex : 0;
            let messagesToSummarize = fullHistory.slice(summarizeInputStartIndex, summarizeEndIndex);

            if (messagesToSummarize.length === 0) {
                this.log.warn('auto.no_messages', { conversationId, summarizeInputStartIndex, summarizeEndIndex });
                return {
                    success: false,
                    error: {
                        code: 'NO_MESSAGES_TO_SUMMARIZE',
                        message: t('modules.api.chat.errors.noMessagesToSummarize')
                    }
                };
            }

            // 6. 检查待总结内容是否超出总结模型的上下文
            // 获取总结模型的最大上下文（输入占比由设置控制，默认预留 50% 给输出）
            const summarizeModelMaxContext = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
            const maxInputTokens = Math.floor(summarizeModelMaxContext * configSummarizeMaxInputRatio);

            // 估算待总结消息的 token 量（口径与 resolveSummarizeRange 的预算估算一致：
            // 优先 usageMetadata / tokenCountByChannel，缺失才本地估算，避免两套口径不一致
            // 导致规划出的范围必然超出总结模型上下文）
            const channelType = config.type;
            let estimatedTokens = this.estimateMessagesTokens(messagesToSummarize, channelType);
            let insertIndex = summarizeEndIndex;

            // 超出了总结模型上下文：循环排除最后一对工具交互所在轮，重新估算直到装得下
            // 每次重新扫描当前 messagesToSummarize 中最后一对 functionCall + functionResponse；
            // 若该轮起点（真实用户消息）在总结范围内则整轮一起排除（保持语义完整，
            // 避免把同一轮的工具交互拆散在总结消息两侧），轮首在范围之外时仅排除该工具交互
            while (estimatedTokens > maxInputTokens) {
                // 找到当前范围内最后一对 functionCall + functionResponse
                let lastToolInteractionStart = -1;
                for (let i = messagesToSummarize.length - 1; i >= 0; i--) {
                    const msg = messagesToSummarize[i];
                    if (msg.role === 'model' && msg.parts.some(p => p.functionCall)) {
                        lastToolInteractionStart = i;
                        break;
                    }
                }

                if (lastToolInteractionStart < 0) {
                    // 没有可排除的工具交互了
                    break;
                }

                // 定位该工具交互所属轮次的起点（其之前最近的真实用户消息），整轮一起排除
                let roundStart = -1;
                for (let i = lastToolInteractionStart; i >= 0; i--) {
                    if (isRealUserMessage(messagesToSummarize[i])) {
                        roundStart = i;
                        break;
                    }
                }

                const cutIndex = roundStart >= 0 ? roundStart : lastToolInteractionStart;
                if (cutIndex <= 0) {
                    // 排除后总结范围为空（仅剩的轮自身仍超限），无法再收缩
                    break;
                }

                const prevEndIndex = insertIndex;
                const newEndIndex = summarizeInputStartIndex + cutIndex;
                if (newEndIndex >= prevEndIndex) {
                    // 防御：范围没有缩小
                    break;
                }

                // 把该轮（或该工具交互）排除在总结范围外，重新估算剩余内容
                messagesToSummarize = fullHistory.slice(summarizeInputStartIndex, newEndIndex);
                insertIndex = newEndIndex;
                this.log.warn('auto.context_overflow_trimmed', {
                    conversationId, estimatedTokens, maxInputTokens,
                    originalRange: `${summarizeInputStartIndex}-${prevEndIndex}`,
                    newRange: `${summarizeInputStartIndex}-${newEndIndex}`
                });
                estimatedTokens = this.estimateMessagesTokens(messagesToSummarize, channelType);
            }

            if (messagesToSummarize.length === 0) {
                this.log.warn('auto.no_messages_after_trim', { conversationId });
                return {
                    success: false,
                    error: {
                        code: 'NO_MESSAGES_TO_SUMMARIZE',
                        message: t('modules.api.chat.errors.noMessagesToSummarize')
                    }
                };
            }

            // 全部可排除的工具交互轮都排除后仍超限：返回显式错误，不把必败的超限请求发给 API
            if (estimatedTokens > maxInputTokens) {
                this.log.warn('auto.context_overflow_unresolvable', {
                    conversationId, estimatedTokens, maxInputTokens, insertIndex
                });
                return {
                    success: false,
                    error: {
                        code: 'CONTEXT_OVERFLOW',
                        message: '待总结内容超出总结模型上下文上限，请增大总结模型的上下文窗口或调整保留预算'
                    }
                };
            }

            // 7. 计算累计覆盖的原始消息数
            const previousSummarizedCount = this.resolvePreviousSummarizedCount(fullHistory, lastSummaryIndex);
            const newlySummarizedCount = insertIndex - historyStartIndex;
            const totalSummarizedCount = previousSummarizedCount + newlySummarizedCount;

            // 8. 构建总结请求（用户提示词可在设置中配置）
            const defaultAutoPrompt = t('modules.api.chat.prompts.autoSummarizePrompt');
            const configuredAutoPrompt = configAutoSummarizePrompt.trim();
            const prompt = configuredAutoPrompt || defaultAutoPrompt;

            // 清理历史中不应发送给 API 的内部字段
            const cleanedMessages = this.cleanMessagesForSummarize(messagesToSummarize, config);

            this.log.info('auto.cleaned', {
                conversationId,
                channelType: config.type,
                rawMessageCount: messagesToSummarize.length,
                cleanedMessageCount: cleanedMessages.length,
                rawTotalParts: messagesToSummarize.reduce((s, m) => s + m.parts.length, 0),
                cleanedTotalParts: cleanedMessages.reduce((s, m) => s + m.parts.length, 0),
                summarizeInputStartIndex,
                insertIndex,
                keepRecentRounds
            });

            const summaryRequestHistory: Content[] = [
                ...cleanedMessages,
                {
                    role: 'user',
                    parts: [{ text: prompt }]
                }
            ];

            // 9. 调用 AI 生成总结
            const generateOptions: {
                configId: string;
                history: Content[];
                abortSignal?: AbortSignal;
                skipTools: boolean;
                skipRetry: boolean;
                modelOverride?: string;
                dynamicSystemPrompt: string;
            } = {
                configId: actualConfigId,
                history: summaryRequestHistory,
                abortSignal,
                skipTools: true,
                dynamicSystemPrompt: BUILTIN_SUMMARIZE_SYSTEM_PROMPT,
                skipRetry: true
            };

            if (actualModelId) {
                generateOptions.modelOverride = actualModelId;
            }

            this.log.info('auto.generate_request', {
                conversationId,
                range: `${summarizeInputStartIndex}-${insertIndex}`,
                requestHistoryLength: summaryRequestHistory.length,
                configId: actualConfigId,
                modelOverride: actualModelId || null
            });

            const response = await this.channelManager.generate(generateOptions);

            // 处理响应
            let finalContent: Content;

            if (this.isAsyncGenerator(response)) {
                const accumulator = new StreamAccumulator();
                accumulator.setProviderType(config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom');

                for await (const chunk of response) {
                    if (abortSignal?.aborted) {
                        return {
                            success: false,
                            error: {
                                code: 'ABORTED',
                                message: t('modules.api.chat.errors.summarizeAborted')
                            }
                        };
                    }
                    accumulator.add(chunk);
                }

                finalContent = accumulator.getContent();
            } else {
                finalContent = (response as GenerateResponse).content;
            }

            // 10. 提取 token 信息
            const beforeTokenCount = finalContent.usageMetadata?.promptTokenCount;
            const afterTokenCount = finalContent.usageMetadata?.candidatesTokenCount;

            // 11. 提取总结文本
            const summaryText = finalContent.parts
                .filter(p => p.text && !p.thought)
                .map(p => p.text)
                .join('\n')
                .trim();

            if (!summaryText) {
                this.log.warn('auto.empty_summary', {
                    conversationId,
                    partsCount: finalContent.parts.length,
                    promptTokens: beforeTokenCount,
                    completionTokens: afterTokenCount
                });
                return {
                    success: false,
                    error: {
                        code: 'EMPTY_SUMMARY',
                        message: t('modules.api.chat.errors.emptySummary')
                    }
                };
            }

            // 12. 创建总结消息并插入到历史
            const summaryContent: Content = {
                role: 'user',
                parts: [{ text: `${t('modules.api.chat.prompts.summaryPrefix')}\n\n${summaryText}` }],
                index: insertIndex,
                isSummary: true,
                isAutoSummary: true,
                summarizedMessageCount: totalSummarizedCount,
                usageMetadata: {
                    promptTokenCount: beforeTokenCount,
                    candidatesTokenCount: afterTokenCount
                }
            };

            await this.conversationManager.insertContent(conversationId, insertIndex, summaryContent);

            this.log.info('auto.completed', {
                conversationId,
                insertIndex,
                totalSummarizedCount,
                promptTokens: beforeTokenCount,
                completionTokens: afterTokenCount
            });

            return {
                success: true,
                summaryContent,
                summarizedMessageCount: totalSummarizedCount,
                beforeTokenCount,
                afterTokenCount,
                insertIndex
            };

        } catch (error) {
            const err = error as any;
            this.log.error('auto.exception', { conversationId, code: err.code, message: err.message });
            // 用户取消（abort）不是普通失败：返回 ABORTED，避免调用方把它当作失败重试
            if (this.isAbortError(err)) {
                return {
                    success: false,
                    error: {
                        code: 'ABORTED',
                        message: t('modules.api.chat.errors.summarizeAborted')
                    }
                };
            }
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.chat.errors.unknownError')
                }
            };
        }
    }

    /**
     * 基于 token 预算解析总结范围
     *
     * 从最后一轮往前累计 token，能装进保留预算的轮保留，更早的轮纳入总结范围。
     * keepRecentRounds 作为最少保留轮数下限；只有一个超大轮时回退到轮内截断。
     *
     * @returns summarizeEndIndex 为总结范围结束索引（fullHistory 绝对索引，同时也是总结消息插入位置）
     */
    private async resolveSummarizeRange(options: {
        conversationId: string;
        fullHistory: Content[];
        lastSummaryIndex: number;
        /** 主对话渠道 ID（保留预算的百分比基数与 token 口径都以主对话模型为准） */
        mainConfigId: string;
        keepRecentRounds: number;
        keepRecentTokens?: number | string;
        mode: 'manual' | 'auto';
    }): Promise<
        | { ok: true; summarizeEndIndex: number; intraRoundSplit: boolean; currentRounds: number }
        | { ok: false; code: 'NOT_ENOUGH_ROUNDS' | 'NOT_ENOUGH_CONTENT'; currentRounds: number }
    > {
        const { conversationId, fullHistory, lastSummaryIndex, mode } = options;
        const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : 0;
        const historyAfterSummary = fullHistory.slice(historyStartIndex);
        const rounds = this.contextTrimService.identifyRounds(historyAfterSummary);

        // 保留预算以主对话模型的最大上下文为基数解析
        const mainConfig = await this.configManager.getConfig(options.mainConfigId);
        const maxContextTokens = typeof mainConfig?.maxContextTokens === 'number' && mainConfig.maxContextTokens > 0
            ? mainConfig.maxContextTokens
            : DEFAULT_MAX_CONTEXT_TOKENS;
        const channelType = mainConfig?.type || 'custom';
        const keepBudgetTokens = resolveKeepRecentTokenBudget(options.keepRecentTokens, maxContextTokens);

        // 逐消息估算 token，再由规划器先建立轮级保护边界、随后在肥轮内部寻找安全 model 切点。
        const messageTokens = historyAfterSummary.map(message => (
            this.estimateMessageTokensForBudget(message, channelType)
        ));
        const plan = planSummarizeMessages({
            messages: historyAfterSummary,
            messageTokens,
            keepBudgetTokens,
            minKeepRounds: options.keepRecentRounds,
            mode
        });

        this.log.info(`${mode}.range_plan`, {
            conversationId,
            rounds: rounds.length,
            keepBudgetTokens,
            minKeepRounds: options.keepRecentRounds,
            planType: plan?.boundary ?? 'none',
            cutIndex: plan?.cutIndex ?? null
        });

        if (plan) {
            const summarizeEndIndex = historyStartIndex + plan.cutIndex;
            if (plan.boundary === 'intra_round') {
                this.log.info(`${mode}.intra_round_split`, {
                    conversationId,
                    cutIndex: plan.cutIndex,
                    summarizeEndIndex,
                    keepBudgetTokens
                });
            }
            return {
                ok: true,
                summarizeEndIndex,
                intraRoundSplit: plan.boundary === 'intra_round',
                currentRounds: rounds.length
            };
        }

        return {
            ok: false,
            code: rounds.length === 0 ? 'NOT_ENOUGH_CONTENT' : 'NOT_ENOUGH_ROUNDS',
            currentRounds: rounds.length
        };
    }

    /**
     * 估算单条消息的 token 数（用于保留预算计算）
     *
     * 口径与 ContextTrimService.accumulateTokens 对齐：
     * - user 消息优先当前渠道的 tokenCountByChannel，其次 estimatedTokenCount，最后本地估算
     * - model 消息优先 usageMetadata（输出 token 扣除思考部分），否则本地估算
     */
    private estimateMessageTokensForBudget(message: Content, channelType: string): number {
        if (message.role === 'user') {
            const byChannel = message.tokenCountByChannel?.[channelType];
            if (typeof byChannel === 'number') {
                return byChannel;
            }
            if (typeof message.estimatedTokenCount === 'number') {
                return message.estimatedTokenCount;
            }
            return this.estimateSingleMessageTokensLocally(message);
        }

        const usage = message.usageMetadata;
        if (usage) {
            if (typeof usage.totalTokenCount === 'number' && typeof usage.promptTokenCount === 'number') {
                const outputTokens = Math.max(0, usage.totalTokenCount - usage.promptTokenCount);
                const thoughtsTokens = Math.min(Math.max(0, usage.thoughtsTokenCount ?? 0), outputTokens);
                return Math.max(0, outputTokens - thoughtsTokens);
            }
            if (typeof usage.candidatesTokenCount === 'number') {
                return Math.max(0, usage.candidatesTokenCount);
            }
        }
        return this.estimateSingleMessageTokensLocally(message);
    }

    /**
     * 本地估算单条消息的 token 数
     */
    private estimateSingleMessageTokensLocally(message: Content): number {
        if (this.tokenEstimationService) {
            return this.tokenEstimationService.estimateMessageTokens(message);
        }
        // 兜底：无 tokenEstimationService 时按统一安全系数 1.5 偏大估算
        const text = message.parts.map(p => p.text || '').join('');
        return Math.ceil(Math.ceil(text.length / 4) * 1.5) || 1;
    }

    /**
     * 估算一组消息的 token 数
     *
     * 用于判断待总结内容是否超出总结模型上下文。
     * 口径与 resolveSummarizeRange 的预算估算（estimateMessageTokensForBudget）一致：
     * 优先 usageMetadata / tokenCountByChannel，缺失才本地估算，保证溢出判断与范围规划一致。
     *
     * @param channelType 当前渠道类型（tokenCountByChannel 的取值口径）
     */
    private estimateMessagesTokens(messages: Content[], channelType: string): number {
        let total = 0;
        for (const msg of messages) {
            total += this.estimateMessageTokensForBudget(msg, channelType);
        }
        return total;
    }

    /**
     * 解析此前总结累计覆盖的原始消息数
     *
     * 从最后一个总结消息读取其 summarizedMessageCount（该值是截至该次总结的累计覆盖数）；
     * 若该字段缺失（历史数据不完整），则往前找更早的总结消息，取最近一个有该字段的累计值；
     * 仍找不到则回退 0。不再回退到数组下标——多条总结时下标与累计覆盖数不一致，会错算计数。
     */
    private resolvePreviousSummarizedCount(fullHistory: Content[], lastSummaryIndex: number): number {
        if (lastSummaryIndex < 0) {
            return 0;
        }
        for (let i = lastSummaryIndex; i >= 0; i--) {
            const msg = fullHistory[i];
            if (!msg?.isSummary) {
                continue;
            }
            if (typeof msg.summarizedMessageCount === 'number') {
                return msg.summarizedMessageCount;
            }
        }
        return 0;
    }

    /**
     * 判断错误是否为用户取消（abort）
     *
     * ChannelError 的取消类型为 ErrorType.CANCELLED_ERROR（channel/types.ts）；
     * 原生 fetch 中断会抛出 name === 'AbortError' 的 DOMException；
     * 部分调用方还会用 code='CANCELLED' / 'ABORTED' 标记取消。
     */
    private isAbortError(err: any): boolean {
        return !!err && (
            err.type === ErrorType.CANCELLED_ERROR
            || err.name === 'AbortError'
            || err.code === 'CANCELLED'
            || err.code === 'ABORTED'
        );
    }

    /**
     * 检查是否是 AsyncGenerator
     */
    private isAsyncGenerator(obj: any): obj is AsyncGenerator<StreamChunk> {
        return obj && typeof obj[Symbol.asyncIterator] === 'function';
    }
}
