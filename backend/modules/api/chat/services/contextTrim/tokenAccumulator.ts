/**
 * 上下文 token 累加器（从 ContextTrimService 抽离）。
 *
 * 从 effectiveStartIndex 起累加历史消息 token，输出：
 * - estimatedTotalTokens：系统提示词 + 动态上下文 + 历史切片 + 首条锚点 的总量
 * - roundTokenInfos：各回合的累计 token 边界（供裁剪计划器跳过整回合）
 * - usageStats：模型 / 用户消息的计数口径统计（仅日志观测用）
 */

import type { Content } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';
import type { TokenEstimationService } from '../TokenEstimationService';
import type { MessageBuilderService } from '../MessageBuilderService';

/** 回合 Token 信息（内部使用） */
export interface RoundTokenInfo {
    /** 回合起始索引 */
    startIndex: number;
    /** 回合结束索引 */
    endIndex: number;
    /** 系统提示词 + effectiveStartIndex 到这个回合结束的累计 token 数 */
    cumulativeTokens: number;
}

export interface AccumulateUsageStats {
    modelMessagesWithUsage: number;
    modelMessagesOutputBased: number;
    modelMessagesMismatch: number;
    modelMessagesWithoutUsage: number;
    userMessages: number;
    userFromChannelCount: number;
    userFromEstimatedFieldCount: number;
    userFromLocalEstimateCount: number;
    userTokensTotal: number;
    modelTokensTotal: number;
}

export interface AccumulateTokensResult {
    estimatedTotalTokens: number;
    roundTokenInfos: RoundTokenInfo[];
    usageStats: AccumulateUsageStats;
}

export interface AccumulateTokensDeps {
    tokenEstimationService: TokenEstimationService;
    messageBuilderService: MessageBuilderService;
}

export interface AccumulateTokensParams {
    fullHistory: Content[];
    effectiveStartIndex: number;
    lastNonFunctionResponseUserIndex: number;
    historyThoughtMinIndex: number;
    historyThoughtMaxIndex: number;
    sendHistoryThoughts: boolean;
    sendHistoryThoughtSignatures: boolean;
    sendCurrentThoughts: boolean;
    sendCurrentThoughtSignatures: boolean;
    channelType: string;
    /** 系统提示词 + 当前动态上下文的总 token 数 */
    promptTokens: number;
    preservedDynamicContextTokenByIndex?: Map<number, number>;
}

export function accumulateContextTokens(
    deps: AccumulateTokensDeps,
    params: AccumulateTokensParams
): AccumulateTokensResult {
    const {
        fullHistory,
        effectiveStartIndex,
        lastNonFunctionResponseUserIndex,
        historyThoughtMinIndex,
        historyThoughtMaxIndex,
        sendHistoryThoughts,
        sendCurrentThoughts,
        channelType,
        promptTokens,
        preservedDynamicContextTokenByIndex = new Map()
    } = params;

    let estimatedTotalTokens = promptTokens;
    const roundTokenInfos: RoundTokenInfo[] = [];
    let currentRoundStartIndex = -1;
    const usageStats: AccumulateUsageStats = {
        modelMessagesWithUsage: 0,
        modelMessagesOutputBased: 0,
        modelMessagesMismatch: 0,
        modelMessagesWithoutUsage: 0,
        userMessages: 0,
        userFromChannelCount: 0,
        userFromEstimatedFieldCount: 0,
        userFromLocalEstimateCount: 0,
        userTokensTotal: 0,
        modelTokensTotal: 0
    };

    // 首条真实用户消息锚点（prependFirstUserMessage：任务锚点永远前置）token 计入预算：
    // getNormalizedHistoryForStartIndex 在构建发送历史时把首条用户消息原样前置，其 token
    // 不在 effectiveStartIndex 之后的切片内，本函数默认漏计——预算校验会低估实际发送量，
    // 导致裁剪点偏浅、最终发送历史超出阈值。
    // 与 prependFirstUserMessage 的判定条件对齐（起点在首条用户消息之后时才会前置）；
    // 锚点 token 用注入估算器口径（与 fallback 路径 estimateCandidateTokens 一致）。
    const firstUserIndex = fullHistory.findIndex(message => isRealUserMessage(message));
    if (effectiveStartIndex > 0 && firstUserIndex >= 0 && firstUserIndex < effectiveStartIndex) {
        const firstUserTokens = deps.tokenEstimationService.estimateMessageTokens(fullHistory[firstUserIndex]);
        estimatedTotalTokens += firstUserTokens;
        usageStats.userTokensTotal += firstUserTokens;
    }

    // 只累加 effectiveStartIndex 之后的消息
    for (let i = effectiveStartIndex; i < fullHistory.length; i++) {
        const message = fullHistory[i];

        if (message.role === 'user') {
            // 只有真实用户输入才开始新回合；functionResponse、总结和后台任务回执都属于当前回合。
            if (isRealUserMessage(message)) {
                // 保存上一个回合的信息
                if (currentRoundStartIndex !== -1) {
                    roundTokenInfos.push({
                        startIndex: currentRoundStartIndex,
                        endIndex: i,
                        cumulativeTokens: estimatedTotalTokens
                    });
                }
                currentRoundStartIndex = i;
            }

            const preservedDynamicContextTokens = preservedDynamicContextTokenByIndex.get(i) ?? 0;
            if (preservedDynamicContextTokens > 0) {
                estimatedTotalTokens += preservedDynamicContextTokens;
                usageStats.userTokensTotal += preservedDynamicContextTokens;
            }

            // 用户消息：优先使用当前渠道的 tokenCountByChannel，其次 estimatedTokenCount，最后回退估算
            usageStats.userMessages++;

            let tokenCount = message.tokenCountByChannel?.[channelType];
            if (tokenCount !== undefined) {
                usageStats.userFromChannelCount++;
            } else if (message.estimatedTokenCount !== undefined) {
                tokenCount = message.estimatedTokenCount;
                usageStats.userFromEstimatedFieldCount++;
            } else {
                tokenCount = deps.tokenEstimationService.estimateMessageTokens(message);
                usageStats.userFromLocalEstimateCount++;
            }

            if (tokenCount === undefined) {
                tokenCount = 0;
            }

            estimatedTotalTokens += tokenCount;
            usageStats.userTokensTotal += tokenCount;
        } else if (message.role === 'model' && message.usageMetadata) {
            usageStats.modelMessagesWithUsage++;
            // model 消息：根据用户配置、消息内容和回合位置决定是否计算思考 token
            const isCurrentRound = i >= lastNonFunctionResponseUserIndex;
            const hasThought = deps.messageBuilderService.hasThoughtContent(message.parts);

            let includeThoughtsToken = false;

            if (isCurrentRound) {
                // 当前轮：仅在“发送思考内容”时计入 thoughtsTokenCount。
                // sendCurrentThoughtSignatures 只表示发送签名，不应等价于发送完整思考文本，
                // 否则会把 reasoning token 全量计入，导致显著高估。
                includeThoughtsToken = sendCurrentThoughts && hasThought;
            } else {
                // 历史轮：根据历史轮配置、消息内容和 historyThinkingRounds 决定
                const isInHistoryThoughtRange = i >= historyThoughtMinIndex && i < historyThoughtMaxIndex;
                if (isInHistoryThoughtRange) {
                    // 历史轮同理：仅在真正发送历史思考文本时计入 thoughtsTokenCount。
                    // sendHistoryThoughtSignatures=true 时通常只发送签名引用，不应按完整思考 token 计算。
                    includeThoughtsToken = sendHistoryThoughts && hasThought;
                }
            }

            const usage = message.usageMetadata;
            const rawCandidatesTokens = Math.max(0, usage.candidatesTokenCount ?? 0);
            const rawThoughtsTokens = Math.max(0, usage.thoughtsTokenCount ?? 0);

            let normalizedCandidatesTokens = rawCandidatesTokens;
            let normalizedThoughtsTokens = rawThoughtsTokens;

            const hasPromptAndTotal = typeof usage.promptTokenCount === 'number' && typeof usage.totalTokenCount === 'number';
            if (hasPromptAndTotal) {
                const outputTokensFromTotal = Math.max(0, usage.totalTokenCount! - usage.promptTokenCount!);
                normalizedThoughtsTokens = Math.min(rawThoughtsTokens, outputTokensFromTotal);
                normalizedCandidatesTokens = Math.max(0, outputTokensFromTotal - normalizedThoughtsTokens);
                usageStats.modelMessagesOutputBased++;

                const rawCombined = rawCandidatesTokens + rawThoughtsTokens;
                if (Math.abs(rawCombined - outputTokensFromTotal) > 1) {
                    usageStats.modelMessagesMismatch++;
                }
            }

            const modelTokens = normalizedCandidatesTokens +
                (includeThoughtsToken ? normalizedThoughtsTokens : 0);
            if (modelTokens > 0) {
                usageStats.modelTokensTotal += modelTokens;
                estimatedTotalTokens += modelTokens;
            }
        } else if (message.role === 'model') {
            usageStats.modelMessagesWithoutUsage++;
            // model 消息没有 usageMetadata，估算 token 数
            const modelTokens = deps.tokenEstimationService.estimateMessageTokens(message);
            usageStats.modelTokensTotal += modelTokens;
            estimatedTotalTokens += modelTokens;
        }
    }

    // 保存最后一个回合
    if (currentRoundStartIndex !== -1) {
        roundTokenInfos.push({
            startIndex: currentRoundStartIndex,
            endIndex: fullHistory.length,
            cumulativeTokens: estimatedTotalTokens
        });
    }

    return { estimatedTotalTokens, roundTokenInfos, usageStats };
}
