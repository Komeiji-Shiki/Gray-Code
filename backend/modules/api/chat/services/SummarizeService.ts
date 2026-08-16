/**
 * GrayCode - 上下文总结服务
 *
 * 负责将对话历史压缩为总结消息
 */

import { t } from '../../../../i18n';
import { randomUUID } from 'node:crypto';
import { Logger } from '../../../../core/logger';
import { ErrorType } from '../../../channel/types';
import { isRealUserMessage } from '../../../conversation/helpers';
import {
    repairParentChainAfterDelete,
    repairParentChainAfterInsert,
    restoreSummarizedRange
} from '../../../conversation/TranscriptMutation';
import type { ConfigManager } from '../../../config/ConfigManager';
import type {ChannelManager } from '../../../channel/ChannelManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { Content, ContentPart } from '../../../conversation/types';
import type { SummaryTokenStats } from '../../../conversation/types';
import { getGlobalBranchService } from '../../../conversation/branch/BranchService';
import type { GenerateResponse, StreamChunk } from '../../../channel/types';
import type { BaseChannelConfig } from '../../../config/configs/base';
import { StreamAccumulator } from '../../../channel/StreamAccumulator';
import type { ContextTrimService } from './ContextTrimService';
import {
    resolveModelContextWindowForConfig,
    resolveMaxContextTokensForConfig
} from './ContextTrimService';
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
} from '../../../settings/types/summarizeTypes';
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
const SUMMARY_PROVIDER_RESERVE_RATIO = 0.02;
const MIN_SUMMARY_PROVIDER_RESERVE_TOKENS = 32;
// summarizeMaxInputRatio 是“自动总结缩小范围”的软预算设置；手动总结不应被默认 50% 提前拒绝。
// 手动请求只在接近总结模型真实窗口时预检失败，并给 provider 包装留出少量余量。
const MANUAL_SUMMARY_MAX_INPUT_RATIO = 0.95;

/**
 * 自动总结文本最低长度（字符数）。
 *
 * H1：物理替换语义下，低于该长度的总结会被直接拒绝（LOW_QUALITY_SUMMARY）而不替换历史——
 * 防止模型返回“已总结”“OK”等无信息量占位文本时，把真实对话历史物理删除。
 */
const MIN_SUMMARY_LENGTH = 50;


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

    private getLatestMainContextTokenCount(history: Content[]): number | undefined {
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i];
            if (message.role !== 'model' || !message.usageMetadata) continue;
            const prompt = message.usageMetadata.promptTokenCount;
            if (typeof prompt === 'number' && Number.isFinite(prompt)) return Math.max(0, prompt);
            const total = message.usageMetadata.totalTokenCount;
            if (typeof total === 'number' && Number.isFinite(total)) return Math.max(0, total);
        }
        return undefined;
    }

    private buildSummaryTokenStats(options: {
        fullHistory: Content[];
        messagesToSummarize: Content[];
        summaryText: string;
        channelType: string;
        providerSummaryTokens?: number;
    }): SummaryTokenStats {
        const sourceTokenCount = this.estimateMessagesTokens(options.messagesToSummarize, options.channelType);
        const summaryTokenCount = typeof options.providerSummaryTokens === 'number'
            ? Math.max(0, options.providerSummaryTokens)
            : this.estimateSingleMessageTokensLocally({ role: 'user', parts: [{ text: options.summaryText }] });
        const estimatedTokensSaved = Math.max(0, sourceTokenCount - summaryTokenCount);
        const contextTokenCountBefore = this.getLatestMainContextTokenCount(options.fullHistory);
        return {
            sourceTokenCount,
            summaryTokenCount,
            estimatedTokensSaved,
            ...(contextTokenCountBefore !== undefined
                ? {
                    contextTokenCountBefore,
                    estimatedContextTokenCountAfter: Math.max(
                        0,
                        contextTokenCountBefore - sourceTokenCount + summaryTokenCount
                    )
                }
                : {})
        };
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

    private resolveSummaryInputBudget(
        config: BaseChannelConfig,
        modelOverride: string | undefined,
        inputRatio: number,
        prompt: string
    ): {
        modelMaxContextTokens: number;
        modelMaxInputTokens: number;
        maxInputTokens: number;
        fixedRequestTokens: number;
        maxHistoryTokens: number;
    } {
        // 总结请求真正发给当前/独立总结模型，优先使用该模型自己的 contextWindow；
        // 渠道 maxContextTokens 只是上下文管理与显示基准，仅在模型元数据缺失时作为回退。
        const modelResolution = (
            resolveModelContextWindowForConfig(config, modelOverride)
            ?? resolveMaxContextTokensForConfig(config, modelOverride)
        );
        const modelMaxContextTokens = modelResolution.maxContextTokens;
        const modelMaxInputTokens = modelResolution.maxInputTokens;
        // inputRatio 是总结请求的历史输入比例；先从组合窗口扣除总结输出预留，
        // 再按比例规划待总结历史，避免“输入预算 + 总结输出”再次超过窗口。
        const maxInputTokens = Math.max(1, Math.floor(modelMaxInputTokens * inputRatio));
        const systemPromptTokens = this.estimateSingleMessageTokensLocally({
            role: 'user',
            parts: [{ text: BUILTIN_SUMMARIZE_SYSTEM_PROMPT }]
        });
        const userPromptTokens = this.estimateSingleMessageTokensLocally({
            role: 'user',
            parts: [{ text: prompt }]
        });
        const providerReserveTokens = Math.max(
            MIN_SUMMARY_PROVIDER_RESERVE_TOKENS,
            Math.floor(maxInputTokens * SUMMARY_PROVIDER_RESERVE_RATIO)
        );
        const fixedRequestTokens = systemPromptTokens + userPromptTokens + providerReserveTokens;
        return {
            modelMaxContextTokens,
            modelMaxInputTokens,
            maxInputTokens,
            fixedRequestTokens,
            maxHistoryTokens: Math.max(0, maxInputTokens - fixedRequestTokens)
        };
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
            const currentModelOverride = typeof request.modelOverride === 'string'
                ? request.modelOverride.trim() || undefined
                : undefined;
            this.log.info('manual.start', { conversationId, configId, modelOverride: currentModelOverride || null });

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

            // 1. 确保对话存在（getHistoryRef 同时完成历史加载供步骤 4 复用，
            //    避免同一请求两次全量读历史——旧实现 getHistory() 仅判存在、随后又读一次）
            const fullHistory = await this.conversationManager.getHistoryRef(conversationId);

            // 2. 确定使用的渠道配置
            let actualConfigId = configId;
            let actualModelId: string | undefined = currentModelOverride;

            if (useSeparateModel && summarizeChannelId) {
                const summarizeConfig = await this.configManager.getConfig(summarizeChannelId);
                if (summarizeConfig && summarizeConfig.enabled) {
                    actualConfigId = summarizeChannelId;
                    // 已切换到独立渠道后，不得继续沿用主对话的 modelOverride；
                    // 未显式选择总结模型时应回落到独立渠道自己的默认模型。
                    actualModelId = summarizeModelId.trim() || undefined;
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

            // 4. 获取对话历史（复用步骤 1 的加载结果，避免二次全量读取）
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
                mainModelOverride: currentModelOverride,
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

            const summaryBudget = this.resolveSummaryInputBudget(
                config,
                actualModelId,
                MANUAL_SUMMARY_MAX_INPUT_RATIO,
                prompt
            );
            const estimatedHistoryTokens = this.estimateMessagesTokens(cleanedMessages, config.type);
            if (estimatedHistoryTokens > summaryBudget.maxHistoryTokens) {
                this.log.warn('manual.context_overflow_unresolvable', {
                    conversationId,
                    estimatedHistoryTokens,
                    ...summaryBudget,
                    summarizeEndIndex
                });
                return {
                    success: false,
                    error: {
                        code: 'CONTEXT_OVERFLOW',
                        message: t('modules.api.chat.errors.summarizeContextOverflow')
                    }
                };
            }

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
                accumulator.setProviderType(config.type as 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom');

                try {
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
                } finally {
                    // 提前退出（abort）时回收流式响应生成器，避免底层流/连接资源悬挂；
                    // 正常耗尽后调用是幂等 no-op。
                    await response.return?.(undefined);
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

            // C：总结质量校验——与自动总结（auto.low_quality_summary）对齐：长度低于阈值视为
            // 低质量总结（可能丢失关键信息；模型返回“OK”等占位文本也不落盘），
            // 逻辑截断语义下标记不可逆，低质量总结不能覆盖真实对话。
            if (summaryText.length < MIN_SUMMARY_LENGTH) {
                this.log.warn('manual.low_quality_summary', {
                    conversationId,
                    summaryLength: summaryText.length,
                    promptTokens: beforeTokenCount,
                    completionTokens: afterTokenCount
                });
                return {
                    success: false,
                    error: {
                        code: 'LOW_QUALITY_SUMMARY',
                        message: t('modules.api.chat.errors.lowQualitySummary')
                    }
                };
            }

            // 11. 标记被总结区间 + 插入新的总结消息（逻辑截断语义，与自动总结一致）。
            // 旧实现「纯插入不标记」：被覆盖消息虽不发送（发送从最后一个总结消息开始），
            // 但前端无法区分“已被总结覆盖”的消息，history_search 也无法精确检索。
            // 现在给被覆盖消息打 isSummarized 标记（原文保留、可显示、可搜索），总结消息插入 summarizeEndIndex。
            // 注意：这里不删除旧的总结消息，这样用户可以保留每一次总结的历史记录；
            // 后续上下文裁剪/下一次总结都会自动使用“最后一个总结消息”。
            const insertIndex = summarizeEndIndex;

            const mainConfig = await this.configManager.getConfig(configId) || config;
            const summaryTokenStats = this.buildSummaryTokenStats({
                fullHistory,
                messagesToSummarize,
                summaryText,
                channelType: mainConfig.type,
                providerSummaryTokens: afterTokenCount
            });

            // 12. 创建总结消息并添加到历史
            const summaryContent: Content = {
                role: 'user',
                parts: [{ text: `${t('modules.api.chat.prompts.summaryPrefix')}\n\n${summaryText}` }],
                index: insertIndex,
                isSummary: true,
                summarizedMessageCount: totalSummarizedCount,
                summaryTokenStats,
                usageMetadata: {
                    promptTokenCount: beforeTokenCount,
                    candidatesTokenCount: afterTokenCount
                }
            };

            // 原子标记 + 插入：并发写入导致范围失效（起点越界 / 会吞掉当前回合用户消息）时不落盘。
            // 单轮对话（唯一真实用户消息被轮内截断范围覆盖）是手动总结的预期场景，放行不放弃。
            const markResult = await this.markAndInsertSummarizedAtomically(
                conversationId,
                historyStartIndex,
                insertIndex,
                summaryContent,
                previousSummarizedCount,
                true
            );

            if (!markResult.ok) {
                this.log.warn('manual.replace_rejected', {
                    conversationId,
                    code: markResult.code,
                    historyStartIndex,
                    insertIndex,
                    freshHistoryLength: markResult.freshHistoryLength
                });
                return {
                    success: false,
                    error: {
                        code: markResult.code,
                        message: t('modules.api.chat.errors.summarizeRangeStale')
                    }
                };
            }

            const removedCount = markResult.markedCount;
            // 首条用户消息保护（锚点不标记，永远发送）可能使实际标记数小于规划值：
            // 以实际标记数为准回填总结消息的累计覆盖数（插入的历史消息已在锁内修正，这里同步返回值）。
            summaryContent.summarizedMessageCount = previousSummarizedCount + removedCount;
            summaryContent.index = markResult.insertIndex;

            this.log.info('manual.completed', {
                conversationId,
                insertIndex: markResult.insertIndex,
                totalSummarizedCount,
                promptTokens: beforeTokenCount,
                completionTokens: afterTokenCount,
                summaryTokenStats
            });

            return {
                success: true,
                summaryContent,
                summarizedMessageCount: summaryContent.summarizedMessageCount,
                beforeTokenCount,
                afterTokenCount,
                summaryTokenStats,
                insertIndex: markResult.insertIndex,
                // 逻辑截断语义：不删除任何消息，removedCount = 本次标记（被总结覆盖）的消息数
                removedCount
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
        // 已收到响应的 call id：rejected 且无配对的调用（中断/取消残留真孤儿）整体丢弃，
        // 否则剥字段后变成孤儿 tool_calls 发给总结模型 → 400。有配对的 rejected 调用
        // 保留（剥字段），其响应在下方改写为拒绝态，成对发送。
        const respondedCallIds = new Set<string>();
        for (const msg of messages) {
            for (const part of msg.parts) {
                if (part.functionResponse?.id) {
                    respondedCallIds.add(part.functionResponse.id);
                }
            }
        }

        return messages.map(msg => {
            const cleanedParts = msg.parts
                // 过滤掉思考内容
                .filter(part => !part.thought && !(part.thoughtSignatures && Object.keys(part).length === 1))
                .map(part => {
                    // 丢弃无配对响应的 rejected functionCall（中断残留孤儿）
                    if (part.functionCall?.rejected && part.functionCall.id
                        && !respondedCallIds.has(part.functionCall.id)) {
                        return null as unknown as ContentPart;
                    }

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

                    // 图片等内联媒体替换为文本占位符：总结模型无需加载图片字节，
                    // 既省输入 token，也避免不支持多模态的总结渠道直接报错。
                    if (cleanedPart.inlineData) {
                        cleanedPart = {
                            text: `[Image: ${cleanedPart.inlineData.displayName || cleanedPart.inlineData.mimeType || 'attachment'}]`
                        };
                    } else if (cleanedPart.fileData) {
                        // 文件引用同样转占位符（用户贴入的图片文件等不被总结请求携带）。
                        cleanedPart = {
                            text: `[File: ${cleanedPart.fileData.displayName || cleanedPart.fileData.fileUri || 'attachment'}]`
                        };
                    }

                    // 清理 functionResponse.response 中仅供运行时/UI 使用的内部字段。
                    // agentInbox 是已发生的模型可见历史，保留以便总结不遗漏代理补充内容；
                    // 一次性消费由 mailbox drain/claim 保证，不通过删除历史字段实现。
                    if (cleanedPart.functionResponse) {
                        const rawResponse = cleanedPart.functionResponse.response as Record<string, unknown> | undefined;

                        if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
                            const { diffContentId, diffId, diffs, pendingDiffId, ...rest } = rawResponse;

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
                                    // steps / toolsUsed / agentInbox 保留给总结模型。
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
                    if (part === null) return false;
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
        abortSignal?: AbortSignal,
        modelOverride?: string
    ): Promise<SummarizeContextSuccessData | SummarizeContextErrorData> {
        try {
            const currentModelOverride = typeof modelOverride === 'string'
                ? modelOverride.trim() || undefined
                : undefined;
            this.log.info('auto.start', { conversationId, configId, modelOverride: currentModelOverride || null });

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
            let actualModelId: string | undefined = currentModelOverride;

            if (useSeparateModel && summarizeChannelId) {
                const summarizeConfig = await this.configManager.getConfig(summarizeChannelId);
                if (summarizeConfig && summarizeConfig.enabled) {
                    actualConfigId = summarizeChannelId;
                    actualModelId = summarizeModelId.trim() || undefined;
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
                mainModelOverride: currentModelOverride,
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

            // 6. 检查待总结内容是否超出总结模型的上下文。
            // 模型窗口必须按 actualModelId 解析，同时为内置 system prompt、用户总结提示词和
            // provider 消息包装预留输入预算，不能只统计被总结的历史消息。
            const defaultAutoPrompt = t('modules.api.chat.prompts.autoSummarizePrompt');
            const configuredAutoPrompt = configAutoSummarizePrompt.trim();
            const prompt = configuredAutoPrompt || defaultAutoPrompt;
            const summaryBudget = this.resolveSummaryInputBudget(
                config,
                actualModelId,
                configSummarizeMaxInputRatio,
                prompt
            );

            // 估算待总结消息的 token 量（口径与 resolveSummarizeRange 的预算估算一致：
            // 优先 usageMetadata / tokenCountByChannel，缺失才本地估算，避免两套口径不一致
            // 导致规划出的范围必然超出总结模型上下文）
            const channelType = config.type;
            // C-15：一次性逐条估算 token，之后增量维护总和（每轮收缩只扣减被排除段，
            // 替代每轮全量重扫+全量重估的 O(n²) 行为）
            const perMessageTokens = messagesToSummarize.map(msg => this.estimateMessageTokensForBudget(msg, channelType));
            let estimatedTokens = perMessageTokens.reduce((sum, t) => sum + t, 0);
            let insertIndex = summarizeEndIndex;

            // 规划锚点：当前回合起始真实用户消息（id + 绝对索引）。单轮长工具回合的轮内
            // 截断切点会越过该消息（只标记其后的已完成工具前缀），原子落盘时以此锚点
            // 校验总结生成期间没有新的真实用户输入（用户发新消息 = 锚点后移/替换 =
            // 本次总结作废）。
            let plannedCurrentUserMessage: { index: number; id?: string } | undefined;
            for (let i = fullHistory.length - 1; i >= 0; i--) {
                if (isRealUserMessage(fullHistory[i])) {
                    plannedCurrentUserMessage = { index: i, id: fullHistory[i].id };
                    break;
                }
            }

            // 超出了总结模型上下文：循环排除最后一对工具交互所在轮，重新估算直到装得下。
            // C-15：token 总和与逐条数组均增量维护，循环内直接按 insertIndex 游标在 fullHistory
            // 上扫描（不再每轮 fullHistory.slice() 重切，O(k·n) → O(n)），循环结束后只切片一次。
            // 若该轮起点（真实用户消息）在总结范围内则整轮一起排除（保持语义完整，
            // 避免把同一轮的工具交互拆散在总结消息两侧），轮首在范围之外时仅排除该工具交互。
            // C-16：维护"最后一个工具交互"扫描游标——每轮收缩后游标落在本次排除段之前
            // （整轮排除时为轮首之前、仅排除工具交互时在该交互之前），下一轮从该游标
            // 继续向前找即可，避免每轮从 insertIndex 全量回扫的 O(n²)。
            let toolScanCursor = insertIndex - 1;
            // 轮内收缩仅对单轮历史（整个历史只有一个真实用户回合）启用：单轮长工具回合的
            // 总结范围起点即当前轮轮首，整轮排除会清空范围，只能沿工具边界逐对收缩。
            // 多轮历史在整轮排除无法继续时保持旧行为（CONTEXT_OVERFLOW → granular fallback），
            // 避免把第一轮的用户输入也排除出总结范围（总结输入只剩用户消息 = 白烧一次总结调用）。
            let realUserCount = 0;
            for (let i = 0; i < fullHistory.length; i++) {
                if (isRealUserMessage(fullHistory[i])) realUserCount++;
            }
            while (estimatedTokens > summaryBudget.maxHistoryTokens) {
                // 找到当前范围内最后一对 functionCall + functionResponse
                let lastToolInteractionStart = -1;
                for (let i = toolScanCursor; i >= summarizeInputStartIndex; i--) {
                    const msg = fullHistory[i];
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
                for (let i = lastToolInteractionStart; i >= summarizeInputStartIndex; i--) {
                    if (isRealUserMessage(fullHistory[i])) {
                        roundStart = i;
                        break;
                    }
                }

                // 下一轮扫描游标必须落在本次排除段之前（整轮排除时在轮首之前、仅排除
                // 工具交互时在该交互之前）。此前游标在算出 roundStart 前就设成
                // lastToolInteractionStart - 1：整轮排除（roundStart < lastToolInteractionStart，
                // 同轮含多次工具交互）后游标落在已排除段内，二次扫描命中同轮残留
                // functionCall → cutIndex 不变 → 触发"范围没有缩小"防御 break 提前终止收缩。
                toolScanCursor = (roundStart >= 0 ? roundStart : lastToolInteractionStart) - 1;

                const cutIndex = (roundStart >= 0 ? roundStart : lastToolInteractionStart) - summarizeInputStartIndex;
                if (cutIndex <= 0) {
                    if (realUserCount !== 1) {
                        // 多轮历史：排除后总结范围为空（仅剩的轮自身仍超限），无法再收缩
                        break;
                    }
                    // 整轮排除会清空总结范围（范围起点即当前轮轮首 = 单轮长工具回合）。
                    // 改为轮内收缩：把「最后一对已完成工具交互」排除出总结范围，保留最新
                    // 工具轮、总结更老前缀，直到装进总结模型输入预算。切点落在 functionCall
                    // 消息上，FC+FR 同在保留区，配对完整不拆散。
                    const intraCut = lastToolInteractionStart - summarizeInputStartIndex;
                    if (intraCut <= 0) {
                        // 连最后一对工具交互都在范围起点：无法再收缩
                        break;
                    }
                    const prevIntraEnd = insertIndex;
                    const newIntraEnd = summarizeInputStartIndex + intraCut;
                    if (newIntraEnd >= prevIntraEnd) {
                        // 防御：范围没有缩小
                        break;
                    }
                    for (let i = intraCut; i < perMessageTokens.length; i++) {
                        estimatedTokens -= perMessageTokens[i];
                    }
                    perMessageTokens.length = intraCut;
                    insertIndex = newIntraEnd;
                    // 下一轮扫描游标落在本次排除段之前（该工具交互的 functionCall 之前）
                    toolScanCursor = intraCut - 1;
                    this.log.warn('auto.context_overflow_intra_round_trimmed', {
                        conversationId,
                        estimatedTokens,
                        maxHistoryTokens: summaryBudget.maxHistoryTokens,
                        maxInputTokens: summaryBudget.maxInputTokens,
                        fixedRequestTokens: summaryBudget.fixedRequestTokens,
                        originalRange: `${summarizeInputStartIndex}-${prevIntraEnd}`,
                        newRange: `${summarizeInputStartIndex}-${newIntraEnd}`
                    });
                    continue;
                }

                const prevEndIndex = insertIndex;
                const newEndIndex = summarizeInputStartIndex + cutIndex;
                if (newEndIndex >= prevEndIndex) {
                    // 防御：范围没有缩小
                    break;
                }

                // 把该轮（或该工具交互）排除在总结范围外，增量扣减被排除段的 token 并截短逐条数组
                for (let i = cutIndex; i < perMessageTokens.length; i++) {
                    estimatedTokens -= perMessageTokens[i];
                }
                perMessageTokens.length = cutIndex;
                insertIndex = newEndIndex;
                this.log.warn('auto.context_overflow_trimmed', {
                    conversationId,
                    estimatedTokens,
                    maxHistoryTokens: summaryBudget.maxHistoryTokens,
                    maxInputTokens: summaryBudget.maxInputTokens,
                    fixedRequestTokens: summaryBudget.fixedRequestTokens,
                    originalRange: `${summarizeInputStartIndex}-${prevEndIndex}`,
                    newRange: `${summarizeInputStartIndex}-${newEndIndex}`
                });
            }
            // 循环结束（或未收缩）后按最终游标统一切片一次
            messagesToSummarize = fullHistory.slice(summarizeInputStartIndex, insertIndex);

            // 收缩后总结范围不再覆盖任何新消息（只剩旧总结消息本身）时，本次总结
            // 没有可总结的新内容，直接放弃——继续调 AI 只会生成一份无新增信息的总结。
            if (insertIndex <= historyStartIndex) {
                this.log.warn('auto.no_new_messages_after_trim', { conversationId, historyStartIndex, insertIndex });
                return {
                    success: false,
                    error: {
                        code: 'NO_MESSAGES_TO_SUMMARIZE',
                        message: t('modules.api.chat.errors.noMessagesToSummarize')
                    }
                };
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
            if (estimatedTokens > summaryBudget.maxHistoryTokens) {
                this.log.warn('auto.context_overflow_unresolvable', {
                    conversationId,
                    estimatedTokens,
                    ...summaryBudget,
                    insertIndex
                });
                return {
                    success: false,
                    error: {
                        code: 'CONTEXT_OVERFLOW',
                        message: t('modules.api.chat.errors.summarizeContextOverflow')
                    }
                };
            }

            // 7. 计算累计覆盖的原始消息数
            const previousSummarizedCount = this.resolvePreviousSummarizedCount(fullHistory, lastSummaryIndex);
            const newlySummarizedCount = insertIndex - historyStartIndex;
            const totalSummarizedCount = previousSummarizedCount + newlySummarizedCount;

            // 8. 构建总结请求（用户提示词可在设置中配置）
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
                accumulator.setProviderType(config.type as 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom');

                try {
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
                } finally {
                    // 提前退出（abort）时回收流式响应生成器，避免底层流/连接资源悬挂；
                    // 正常耗尽后调用是幂等 no-op。
                    await response.return?.(undefined);
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

            // C：总结质量校验——长度低于阈值视为低质量总结（可能丢失关键信息），
            // 不替换历史（H1 物理替换语义下删除不可逆，低质量总结不能覆盖真实对话）。
            if (summaryText.length < MIN_SUMMARY_LENGTH) {
                this.log.warn('auto.low_quality_summary', {
                    conversationId,
                    summaryLength: summaryText.length,
                    promptTokens: beforeTokenCount,
                    completionTokens: afterTokenCount
                });
                return {
                    success: false,
                    error: {
                        code: 'LOW_QUALITY_SUMMARY',
                        message: t('modules.api.chat.errors.lowQualitySummary')
                    }
                };
            }

            const mainConfig = await this.configManager.getConfig(configId) || config;
            const summaryTokenStats = this.buildSummaryTokenStats({
                fullHistory,
                messagesToSummarize,
                summaryText,
                channelType: mainConfig.type,
                providerSummaryTokens: afterTokenCount
            });

            // 12. 创建总结消息并逻辑截断替换历史（H1 逻辑截断语义）。
            // 旧实现「只插入不删除」导致历史无限增长：模型视角被截断到最后一个总结、token 永远超阈值、每轮反复触发总结。
            // 旧实现「物理删除」虽然解决了 token 判定，但被总结的原始消息从磁盘消失，无法检索恢复。
            // 现在改为逻辑截断：被总结区间的消息打 isSummarized 标记（原文完整保留在历史中，可显示、可搜索），
            // 总结消息插入到 summarizeEndIndex；发送给 AI 与 token 统计均跳过 isSummarized 消息（ContextTrimService 过滤）。
            const summaryContent: Content = {
                role: 'user',
                parts: [{ text: `${t('modules.api.chat.prompts.summaryPrefix')}\n\n${summaryText}` }],
                index: insertIndex,
                isSummary: true,
                isAutoSummary: true,
                summarizedMessageCount: totalSummarizedCount,
                summaryTokenStats,
                usageMetadata: {
                    promptTokenCount: beforeTokenCount,
                    candidatesTokenCount: afterTokenCount
                }
            };

            const replaceResult = await this.markAndInsertSummarizedAtomically(
                conversationId,
                historyStartIndex,
                insertIndex,
                summaryContent,
                previousSummarizedCount,
                false,
                plannedCurrentUserMessage
            );

            if (!replaceResult.ok) {
                this.log.warn('auto.replace_rejected', {
                    conversationId,
                    code: replaceResult.code,
                    historyStartIndex,
                    insertIndex,
                    freshHistoryLength: replaceResult.freshHistoryLength
                });
                // H2：并发写入导致总结范围失效（起点越界 / 会吞掉当前回合用户消息）时不落盘，
                // 调用方（ToolIterationLoopService）走既有失败路径（granular fallback 兜底）。
                return {
                    success: false,
                    error: {
                        code: replaceResult.code,
                        message: t('modules.api.chat.errors.summarizeRangeStale')
                    }
                };
            }

            // 本次标记的消息数（逻辑截断语义下即“被总结覆盖”的消息数）
            const removedCount = replaceResult.markedCount;
            // 首条用户消息保护（锚点不标记，永远发送）可能使实际标记数小于规划值：
            // 以实际标记数为准回填总结消息的累计覆盖数（插入的历史消息已在锁内修正，这里同步返回值，
            // 保证前端收到的 summaryContent 与落盘一致）。
            summaryContent.summarizedMessageCount = previousSummarizedCount + removedCount;
            summaryContent.index = replaceResult.insertIndex;

            this.log.info('auto.completed', {
                conversationId,
                insertIndex: replaceResult.insertIndex,
                removedCount,
                // 以实际标记数为准（首条用户消息保护可能使标记数小于规划值）
                totalSummarizedCount: summaryContent.summarizedMessageCount,
                promptTokens: beforeTokenCount,
                completionTokens: afterTokenCount,
                summaryTokenStats
            });

            return {
                success: true,
                summaryContent,
                summarizedMessageCount: summaryContent.summarizedMessageCount,
                beforeTokenCount,
                afterTokenCount,
                summaryTokenStats,
                insertIndex: replaceResult.insertIndex,
                removedCount
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
     * H1（逻辑截断）+ H2 + 首条用户消息保护：在会话写锁内原子地「标记被总结区间 + 插入总结消息」。
     *
     * 为什么必须原子：ConversationManager.insertContent / deleteMessagesInRange 各自独立
     * 获取会话写锁（仓储互斥执行器不可重入），分两次调用之间其它并发写可能插入，导致总结
     * 位置越过当前用户消息或把并发新消息误标记。因此标记与插入必须在同一次
     * mutateContents（写锁内）完成；同时在该回调里基于最新历史重新校验区间，防止
     * 基于旧快照计算的 insertIndex 在并发写入后失效。
     *
     * 逻辑截断语义：被总结区间的消息不删除，打 isSummarized 标记（原文完整保留在历史中，
     * 可显示、可搜索）；发送给 AI 与 token 统计时跳过标记消息（ContextTrimService 过滤）。
     *
     * 首条用户消息保护：标记起点不早于「第一条真实用户消息之后」——用户的原始任务
     * 指令是长期上下文锚点，总结文本永远不如原话清楚，必须原样保留并始终发送。
     * 若第一条用户消息不在被总结区间内，标记起点保持规划值不变。
     *
     * 语义与既有单操作保持一致：
     * - 标记是纯字段追加，不动 parentId 链（消息仍在原位置，仅 isSummarized=true）；
     * - 插入复用 insertContent 的 ensureNodeId（缺 id 补随机 UUID）+ parentId 线性链接
     *   + repairParentChainAfterInsert（插入点之后 parentId===旧父 id 的消息重链到新消息）。
     *
     * @param historyStartIndex 被标记区间起点（= lastSummaryIndex+1 或 0）
     * @param insertIndex 被标记区间终点（开区间，基于旧快照计算；同时也是总结消息插入位置）
     * @param baseSummarizedCount 旧总结累计覆盖数（previousSummarizedCount），用于在锁内
     *                            以实际标记数为准回填插入消息的 summarizedMessageCount
     * @param allowCoverLastRealUserRound 手动总结放行开关：整个历史只有一个真实用户回合
     *        （单轮）时，轮内截断的切点必然位于轮首 user 消息之后，insertIndex 恒大于
     *        lastRealUserMessageIndex。此时没有「当前回合」需要保护——用户主动总结就是要
     *        覆盖这一轮的前半部分，允许落盘而不是放弃；手动总结无论轮数一律放行：多轮
     *        场景的 intra_round 扩展切进最后一轮同样是用户主动总结的预期行为。
     *        自动总结默认保持严格 STALE；唯一例外是单轮长工具回合的轮内截断（见
     *        plannedCurrentUserMessage）：切点越过锚点用户消息但该消息本身不标记（原文
     *        保留发送），只压缩它之后已完成的工具前缀，模型仍能看到原始任务。
     * @param plannedCurrentUserMessage 自动总结规划时最后一条真实用户消息的锚点
     *        （{ index, id }）。仅当 insertIndex 越过锁内最新真实用户消息时用于校验：
     *        锚点必须原样在位（id 一致、索引未后移，即总结期间没有新用户输入），否则
     *        STALE_RANGE 放弃本次总结。
     * @returns ok=true 时 markedCount = 实际标记的消息数，insertIndex = 总结消息的插入位置
     *          （= 入参 insertIndex，不因首条用户消息保护而改变）；
     *          ok=false 时 code='STALE_RANGE'（历史已变化，本次总结放弃，不落盘）
     */
    private async markAndInsertSummarizedAtomically(
        conversationId: string,
        historyStartIndex: number,
        insertIndex: number,
        summaryContent: Content,
        baseSummarizedCount: number,
        allowCoverLastRealUserRound = false,
        plannedCurrentUserMessage?: { index: number; id?: string }
    ): Promise<
        | { ok: true; markedCount: number; insertIndex: number }
        | { ok: false; code: 'STALE_RANGE'; freshHistoryLength: number }
    > {
        const repository = this.conversationManager.getTranscriptRepository(conversationId);
        let stale = false;
        let freshHistoryLength = 0;
        let replacedInsertIndex = historyStartIndex;
        let markedCount = 0;

        await repository.mutateContents(history => {
            freshHistoryLength = history.length;

            // H2：写锁内基于最新历史重新校验（并发删除/插入可能让旧快照区间失效）。
            if (
                historyStartIndex < 0
                || historyStartIndex > history.length
                || insertIndex < historyStartIndex
                || insertIndex > history.length
            ) {
                stale = true;
                return history; // 无变更：返回原引用，仓储跳过写回
            }

            // 校验总结范围不吞掉当前回合的真实用户消息（isRealUserMessage：排除
            // functionResponse / 总结消息 / isSummarized / 后台任务回执）。insertIndex 必须 <= 该消息下标，
            // 否则标记范围 [historyStartIndex, insertIndex) 会覆盖用户刚输入的消息。
            let lastRealUserMessageIndex = -1;
            for (let i = history.length - 1; i >= 0; i--) {
                if (isRealUserMessage(history[i])) {
                    lastRealUserMessageIndex = i;
                    break;
                }
            }
            if (lastRealUserMessageIndex < 0) {
                stale = true;
                return history;
            }
            if (insertIndex > lastRealUserMessageIndex && !allowCoverLastRealUserRound) {
                // 轮内截断（自动总结单轮长工具回合 / 手动总结覆盖当前轮）。
                // 手动总结（allowCoverLastRealUserRound=true）：覆盖最后一条真实用户消息
                // 及其后的内容正是用户主动总结的预期——单轮与多轮一致放行；首条用户消息
                // 保护仍生效（markStart 钳制）。
                // 自动总结：仅当「规划锚定的当前回合用户消息」原样在位时放行——id 一致且
                // 索引未后移（其后没有出现新的真实用户输入）。锚点用户消息本身不标记
                // （markStart 钳制在它之后），模型始终能看到原始任务；总结生成期间用户
                // 若发送新消息（锚点替换/后移），本次总结作废。
                const planned = plannedCurrentUserMessage;
                if (
                    !planned
                    || typeof planned.id !== 'string'
                    || planned.id.length === 0
                    || lastRealUserMessageIndex !== planned.index
                ) {
                    stale = true;
                    return history;
                }
                const anchor = history[lastRealUserMessageIndex];
                if (!anchor || anchor.id !== planned.id) {
                    stale = true;
                    return history;
                }
            }

            // 首条用户消息保护：标记起点不早于它之后（i + 1），且不越过 insertIndex。
            // 只有首条用户消息位于被总结区间内才需要收窄起点；它已在保留区时保持规划值。
            let markStart = historyStartIndex;
            for (let i = 0; i < history.length; i++) {
                if (isRealUserMessage(history[i])) {
                    if (i < insertIndex) {
                        markStart = Math.max(historyStartIndex, i + 1);
                    }
                    break;
                }
            }
            // 轮内截断（自动总结越过锚点用户消息）：锚点消息本身不标记，原文保留发送。
            // 手动总结（allowCoverLastRealUserRound=true）不钳制——用户主动总结覆盖当前轮
            // 是预期行为（多轮场景的 intra_round 扩展同样切进用户想要总结的轮）。
            if (insertIndex > lastRealUserMessageIndex && !allowCoverLastRealUserRound) {
                markStart = Math.max(markStart, lastRealUserMessageIndex + 1);
            }

            // 逻辑截断：给被总结区间内的消息打标记（原文保留，不参与发送与统计）。
            // 纯字段追加，不改动消息位置与 parentId 链。
            for (let i = markStart; i < insertIndex; i++) {
                history[i] = { ...history[i], isSummarized: true };
            }

            // 插入总结消息：补齐稳定节点 id + 线性 parentId 链（与 insertContent 语义一致）
            const inserted: Content = { ...summaryContent };
            if (typeof inserted.id !== 'string' || inserted.id.length === 0) {
                inserted.id = randomUUID();
            }
            if (inserted.parentId === undefined) {
                const oldParent = insertIndex > 0 ? history[insertIndex - 1] : null;
                inserted.parentId = oldParent?.id ?? null;
            }
            // 以实际标记数为准修正累计覆盖数（首条用户消息受保护时小于规划值）
            inserted.summarizedMessageCount = baseSummarizedCount + (insertIndex - markStart);
            inserted.index = insertIndex;
            history.splice(insertIndex, 0, inserted);
            repairParentChainAfterInsert(history, insertIndex, inserted.parentId ?? null, inserted.id);

            replacedInsertIndex = insertIndex;
            markedCount = insertIndex - markStart;
            return history.slice(); // 有变更：返回新引用触发写回
        });

        if (stale) {
            return { ok: false, code: 'STALE_RANGE', freshHistoryLength };
        }
        await this.syncBranchGraphAfterSummaryMutation(conversationId, 'summary_inserted');
        return { ok: true, markedCount, insertIndex: replacedInsertIndex };
    }

    /**
     * 恢复指定总结消息覆盖的原文（逻辑截断的反向操作）。
     *
     * 语义：取消该总结覆盖区间的 isSummarized 标记 + 删除总结消息本身。恢复后发送起点
     * 回退到上一个总结（或 0），原文重新参与发送与统计。
     *
     * 删除总结消息（ConversationManager.deleteMessage / deleteMessagesInRange 命中
     * isSummary 消息时）也会自动走本逻辑，避免「既无总结文本也无原文」的上下文真空。
     *
     * @param conversationId 对话 ID
     * @param summaryMessageId 要恢复的总结消息 id（Content.id）
     * @returns 恢复的消息数与被删除的总结消息 id；总结消息不存在时 success=true 且 restoredCount=0
     */
    async restoreSummarizedMessages(
        conversationId: string,
        summaryMessageId: string
    ): Promise<{ success: true; restoredCount: number; removedSummaryId?: string }> {
        const repository = this.conversationManager.getTranscriptRepository(conversationId);
        let restoredCount = 0;
        let removedSummaryId: string | undefined;

        await repository.mutateContents(history => {
            const summaryIndex = history.findIndex(message => (
                message.isSummary === true && message.id === summaryMessageId
            ));
            if (summaryIndex < 0) {
                return history; // 无变更：返回原引用，仓储跳过写回
            }
            // 取消覆盖区间的 isSummarized 标记（不改变长度与 parentId 链）
            const restored = restoreSummarizedRange(history, summaryIndex);
            // 删除总结消息本身（与 deleteMessagesInRange 的 repairParentChainAfterDelete 语义一致）
            const removed = restored.contents.splice(summaryIndex, 1);
            if (removed.length > 0) {
                repairParentChainAfterDelete(restored.contents, removed);
            }
            restoredCount = restored.restoredCount;
            removedSummaryId = removed[0]?.id ?? summaryMessageId;
            return restored.contents.slice();
        });

        if (removedSummaryId) {
            await this.syncBranchGraphAfterSummaryMutation(conversationId, 'summary_restored');
        }

        this.log.info('restore.completed', { conversationId, summaryMessageId, restoredCount, removedSummaryId });
        return { success: true, restoredCount, removedSummaryId };
    }

    /**
     * 总结是主历史的预期结构变更；已有分支图时同步活跃路径与 Content 元数据。
     * 主历史已经成功落盘，因此图同步失败只记录告警，异常修复入口会在下次分支操作前再次对账。
     */
    private async syncBranchGraphAfterSummaryMutation(
        conversationId: string,
        reason: 'summary_inserted' | 'summary_restored'
    ): Promise<void> {
        const branchService = getGlobalBranchService();
        if (!branchService) {
            return;
        }
        try {
            const result = await branchService.syncMainHistoryAfterStructuralMutation(conversationId, reason);
            if (result.deferred) {
                this.log.info('branch_sync_deferred_for_active_candidate', { conversationId, reason });
            }
        } catch (error) {
            this.log.warn('branch_summary_sync_failed', {
                conversationId,
                reason,
                error: (error as Error)?.message ?? String(error),
            });
        }
    }

    /**
     * 基于 token 预算解析总结范围
     *
     * 从最后一轮往前累计 token，能装进保留预算的轮保留，更早的轮纳入总结范围。
     * 保留预算百分比以「本次规划范围内的活跃历史 token 总量」为基数（'50%' = 截断一半、
     * 保留另一半）；keepRecentRounds 作为最少保留轮数下限；只有一个超大轮时回退到轮内截断。
     *
     * @returns summarizeEndIndex 为总结范围结束索引（fullHistory 绝对索引，同时也是总结消息插入位置）
     */
    private async resolveSummarizeRange(options: {
        conversationId: string;
        fullHistory: Content[];
        lastSummaryIndex: number;
        /** 主对话渠道 ID（token 估算口径以主对话模型为准；保留预算百分比基数已是活跃历史总量，不再依赖主模型窗口） */
        mainConfigId: string;
        keepRecentRounds: number;
        keepRecentTokens?: number | string;
        mainModelOverride?: string;
        mode: 'manual' | 'auto';
    }): Promise<
        | { ok: true; summarizeEndIndex: number; intraRoundSplit: boolean; currentRounds: number }
        | { ok: false; code: 'NOT_ENOUGH_ROUNDS' | 'NOT_ENOUGH_CONTENT'; currentRounds: number }
    > {
        const { conversationId, fullHistory, lastSummaryIndex, mode } = options;
        const historyStartIndex = lastSummaryIndex >= 0 ? lastSummaryIndex + 1 : 0;
        const historyAfterSummary = fullHistory.slice(historyStartIndex);
        const rounds = this.contextTrimService.identifyRounds(historyAfterSummary);

        const mainConfig = await this.configManager.getConfig(options.mainConfigId);
        const channelType = mainConfig?.type || 'custom';

        // 逐消息估算 token，再由规划器先建立轮级保护边界、随后在肥轮内部寻找安全 model 切点。
        const messageTokens = historyAfterSummary.map(message => (
            this.estimateMessageTokensForBudget(message, channelType)
        ));
        // 保留预算百分比基数 = 本次总结规划范围内的活跃历史 token 总量（上一次总结之后、
        // 未被 isSummarized 覆盖的消息）。'50%' 即「截断一半、保留另一半」，与主模型窗口无关；
        // 绝对 token 数配置（如 30000）仍表示固定保留预算。
        const totalActiveTokens = messageTokens.reduce((sum, tokens) => sum + tokens, 0);
        const keepBudgetTokens = resolveKeepRecentTokenBudget(options.keepRecentTokens, totalActiveTokens);
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
            let cutIndex = plan.cutIndex;
            // 自动总结严格保护当前回合：切点不得越过最后一条真实用户消息。
            // 越过后 markAndInsertSummarizedAtomically 的锁内 STALE 检查会拒绝本次总结，
            // 而拒绝发生在 AI 生成完成之后——白白消耗一次总结模型调用。钳制到当前回合
            // 起点后：多轮时切点最多落在当前回合边界（保留整个当前回合，总结更早内容）；
            // 单轮（唯一轮即当前回合）时无安全切点，直接放弃（不调 AI）。
            // 手动总结不受此限制：用户主动总结覆盖当前轮正是预期行为（锁内放行）。
            if (mode === 'auto') {
                let lastRealUserMessageIndex = -1;
                for (let i = historyAfterSummary.length - 1; i >= 0; i--) {
                    if (isRealUserMessage(historyAfterSummary[i])) {
                        lastRealUserMessageIndex = i;
                        break;
                    }
                }
                if (lastRealUserMessageIndex < 0) {
                    // 无真实用户消息（异常历史）：无法安全总结
                    return {
                        ok: false,
                        code: rounds.length === 0 ? 'NOT_ENOUGH_CONTENT' : 'NOT_ENOUGH_ROUNDS',
                        currentRounds: rounds.length
                    };
                }
                if (lastRealUserMessageIndex === 0) {
                    // 单轮长工具回合（唯一真实用户消息就是第一条，即首条锚点）：允许轮内截断，
                    // 总结该轮「已完成的工具前缀」。轮首用户消息受「首条用户消息保护」永不标记
                    // （锁内 markStart 钳制在它之后），模型始终能看到原始任务；planner 的切点
                    // 落在安全的 model 消息上，不拆散 functionCall/functionResponse 配对。
                    // 无工具交互的纯文本单轮同样允许（切点后保留区非空即可），总结输入超预算
                    // 时由 handleAutoSummarize 的溢出收缩 / CONTEXT_OVERFLOW 兜底。
                    if (cutIndex <= 0) {
                        return {
                            ok: false,
                            code: 'NOT_ENOUGH_ROUNDS',
                            currentRounds: rounds.length
                        };
                    }
                } else {
                    // 多轮：切点钳制到当前回合起点（保留整个当前轮，总结更早内容）。
                    // 不能深入当前轮——非首条用户消息没有「锚点保护」，被标记后模型会丢失
                    // 当前任务上下文。
                    cutIndex = Math.min(cutIndex, lastRealUserMessageIndex);
                    if (cutIndex <= 0) {
                        return {
                            ok: false,
                            code: 'NOT_ENOUGH_ROUNDS',
                            currentRounds: rounds.length
                        };
                    }
                }
            }
            const summarizeEndIndex = historyStartIndex + cutIndex;
            if (plan.boundary === 'intra_round') {
                this.log.info(`${mode}.intra_round_split`, {
                    conversationId,
                    cutIndex,
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
        // 中断/取消流的 usageMetadata 只覆盖已收到的 chunk，token 数可能严重偏低：
        // 若据此规划保留预算会低估实际占用、总结范围规划过大。
        // 与 conversation/usageStats.ts extractMessageTokens 及 manager/stats.ts
        // 的 usageMetadataPartial 回退口径一致——回退到本地估算而非信任半截 usage。
        if (message.usageMetadataPartial) {
            return this.estimateSingleMessageTokensLocally(message);
        }

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
    private isAbortError(err: unknown): boolean {
        if (!err || typeof err !== 'object') {
            return false;
        }
        const e = err as { type?: unknown; name?: unknown; code?: unknown };
        return (
            e.type === ErrorType.CANCELLED_ERROR
            || e.name === 'AbortError'
            || e.code === 'CANCELLED'
            || e.code === 'ABORTED'
        );
    }

    /**
     * 检查是否是 AsyncGenerator
     */
    private isAsyncGenerator(obj: unknown): obj is AsyncGenerator<StreamChunk> {
        return !!obj && typeof (obj as AsyncGenerator<StreamChunk>)[Symbol.asyncIterator] === 'function';
    }
}

