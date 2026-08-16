/**
 * 裁剪计划器（从 ContextTrimService 抽离）。
 *
 * - planContextTrimStartIndex：旧 trim 模式下按 token 阈值计算裁剪起点
 * - performContextTrim：跳过超预算回合，计算并持久化新的裁剪起点
 */

import type { Content } from '../../../../conversation/types';
import type { ConversationManager, GetHistoryOptions } from '../../../../conversation/ConversationManager';
import type { BaseChannelConfig } from '../../../../config/configs/base';
import type { DynamicContextStrategy } from '../../../../settings/types';
import type { Logger } from '../../../../../core/logger';
import type { ContextTrimInfo } from '../../utils';
import { resolveMaxContextTokensForConfig } from './contextWindowResolution';
import { resolveContextManagementPolicy } from './policy';
import { identifyConversationRounds, calculateContextThreshold } from './roundDetection';
import { getNormalizedHistoryForStartIndex } from './historySelection';
import { saveTrimState, clearTrimState } from './trimState';
import type { RoundTokenInfo } from './tokenAccumulator';

export interface ContextTrimPlannerDeps {
    conversationManager: ConversationManager;
    log: Logger;
}

/**
 * 计算上下文裁剪后应该从哪个索引开始获取历史
 *
 * 当最新助手消息的 totalTokenCount 超过阈值时，
 * 计算需要跳过的回合，返回应该开始的消息索引。
 *
 * 注意：这个方法不删除任何消息，只是计算过滤的起始位置。
 *
 * @returns 应该开始获取历史的索引（0 表示不需要裁剪）
 */
export function planContextTrimStartIndex(
    history: Content[],
    config: BaseChannelConfig,
    latestTokenCount: number,
    modelOverride: string | undefined,
    log: Logger
): number {
    const policy = resolveContextManagementPolicy(config);
    if (!policy.enabled || policy.mode !== 'trim') {
        return 0;
    }

    // 获取最大上下文和阈值
    const maxContextResolution = resolveMaxContextTokensForConfig(config, modelOverride);
    // 裁剪阈值针对可用输入预算，而不是包含输出预留的原始组合窗口。
    const maxContextTokens = maxContextResolution.maxInputTokens;
    const thresholdConfig = config.contextThreshold ?? '80%';
    const threshold = calculateContextThreshold(thresholdConfig, maxContextTokens);

    log.debug('calculateContextTrimStartIndex.threshold', {
        latestTokenCount,
        threshold,
        thresholdConfig,
        maxContextTokens,
        contextWindowTokens: maxContextResolution.maxContextTokens,
        maxOutputTokens: maxContextResolution.maxOutputTokens ?? null,
        maxInputTokens: maxContextResolution.maxInputTokens,
        maxContextSource: maxContextResolution.source,
        configMaxContextTokens: maxContextResolution.configMaxContextTokens,
        modelId: maxContextResolution.modelId,
        modelContextWindow: maxContextResolution.modelContextWindow
    });

    // 如果未超过阈值，无需裁剪
    if (latestTokenCount <= threshold) {
        return 0;
    }

    // 识别回合
    const rounds = identifyConversationRounds(history);

    // 至少需要保留当前回合（最后一个回合）
    if (rounds.length <= 1) {
        return 0;
    }

    // 估算每个回合的 token 数（基于最后一个有 token 记录的回合）
    // 简单策略：按回合数等比例估算
    const avgTokensPerRound = latestTokenCount / rounds.length;

    // 计算需要保留的回合数
    const targetTokens = threshold;
    const roundsToKeep = Math.max(1, Math.floor(targetTokens / avgTokensPerRound));

    // 需要跳过的回合数
    const roundsToSkip = Math.max(0, rounds.length - roundsToKeep);

    if (roundsToSkip === 0) {
        return 0;
    }

    // 返回应该开始的索引
    const startIndex = rounds[roundsToSkip].startIndex;

    return startIndex;
}

/**
 * 执行上下文裁剪
 *
 * @param promptTokens 系统提示词 + 动态上下文的总 token 数
 */
export async function performContextTrim(
    deps: ContextTrimPlannerDeps,
    conversationId: string,
    fullHistory: Content[],
    config: BaseChannelConfig,
    historyOptions: GetHistoryOptions,
    effectiveStartIndex: number,
    estimatedTotalTokens: number,
    promptTokens: number,
    roundsAfterStart: RoundTokenInfo[],
    threshold: number,
    maxContextTokens: number,
    dynamicContextStrategy: DynamicContextStrategy = 'single'
): Promise<ContextTrimInfo> {
    // 至少需要保留当前回合（最后一个回合）
    if (roundsAfterStart.length <= 1) {
        const normalizedHistory = await getNormalizedHistoryForStartIndex(
            deps.conversationManager,
            conversationId,
            fullHistory,
            historyOptions,
            effectiveStartIndex,
            effectiveStartIndex,
            dynamicContextStrategy
        );
        deps.log.debug('trim.perform.no_additional_cut', {
            conversationId,
            effectiveStartIndex: normalizedHistory.trimStartIndex,
            estimatedTotalTokens,
            reason: 'only_one_round'
        });
        return { history: normalizedHistory.history, trimStartIndex: normalizedHistory.trimStartIndex };
    }

    // 计算额外裁剪的 token 数
    // 额外裁剪是基于最大上下文计算的
    // 例如：最大上下文 200k，阈值 80%（160k），额外裁剪 30%（60k）
    // 当超过 160k 时触发裁剪，裁剪目标 = 160k - 60k = 100k
    // 这样下次从 100k 增长到 160k 需要更多回合，避免频繁触发裁剪
    const extraCutConfig = config.contextTrimExtraCut ?? 0;
    const extraCut = calculateContextThreshold(extraCutConfig, maxContextTokens, 0);

    // 实际保留目标 = 阈值 - 额外裁剪
    const targetTokens = Math.max(0, threshold - extraCut);

    // 额外裁剪 >= 阈值 → targetTokens=0，一次裁剪会清空整段对话；记警告防止静默全裁
    if (targetTokens === 0 && extraCut > 0) {
        deps.log.debug('trim.extraCut.zeroTarget', {
            threshold,
            extraCut,
            extraCutConfig,
            maxContextTokens
        });
    }

    deps.log.debug('trim.perform.start', {
        conversationId,
        effectiveStartIndex,
        estimatedTotalTokens,
        promptTokens,
        threshold,
        extraCutConfig,
        extraCut,
        targetTokens,
        roundsAfterStart: roundsAfterStart.length
    });

    // 使用自计算的累计 token 数来计算需要跳过多少回合
    let roundsToSkip = 0;
    let remainingEstimatedTokensAfterTrim = estimatedTotalTokens;
    const roundEvaluation: Array<{ k: number; remainingTokens: number }> = [];

    // 从 k=1 开始尝试，k 表示要跳过的回合数（从第 k 个回合开始保留）
    for (let k = 1; k < roundsAfterStart.length; k++) {
        const skippedTokens = roundsAfterStart[k - 1].cumulativeTokens - promptTokens;
        const remainingTokens = estimatedTotalTokens - skippedTokens;
        roundEvaluation.push({ k, remainingTokens });

        if (remainingTokens <= targetTokens) {
            roundsToSkip = k;
            break;
        }
    }

    // 如果遍历完还没找到合适的裁剪点，且总 token 超过阈值，只保留最后一个回合
    if (roundsToSkip === 0 && estimatedTotalTokens > targetTokens) {
        roundsToSkip = roundsAfterStart.length - 1;
    }

    if (roundsToSkip > 0) {
        const skippedTokens = roundsAfterStart[roundsToSkip - 1].cumulativeTokens - promptTokens;
        remainingEstimatedTokensAfterTrim = estimatedTotalTokens - skippedTokens;
    }

    if (roundsToSkip === 0) {
        // 不需要额外裁剪，返回从起始索引开始的历史
        const normalizedHistory = await getNormalizedHistoryForStartIndex(
            deps.conversationManager,
            conversationId,
            fullHistory,
            historyOptions,
            effectiveStartIndex,
            effectiveStartIndex,
            dynamicContextStrategy
        );
        deps.log.debug('trim.perform.no_additional_cut', {
            conversationId,
            effectiveStartIndex: normalizedHistory.trimStartIndex,
            estimatedTotalTokens,
            threshold,
            targetTokens,
            remainingEstimatedTokensAfterTrim,
            roundEvaluation
        });
        return { history: normalizedHistory.history, trimStartIndex: normalizedHistory.trimStartIndex };
    }

    // 计算在原始历史中的起始索引
    const trimStartIndex = roundsAfterStart[roundsToSkip].startIndex;

    const normalizedTrimmedHistory = await getNormalizedHistoryForStartIndex(
        deps.conversationManager,
        conversationId,
        fullHistory,
        historyOptions,
        effectiveStartIndex,
        trimStartIndex,
        dynamicContextStrategy
    );
    const trimmedHistory = normalizedTrimmedHistory.history;
    const finalTrimStartIndex = normalizedTrimmedHistory.trimStartIndex;

    // 保存裁剪状态到持久化存储
    if (normalizedTrimmedHistory.normalization.valid) {
        await saveTrimState(deps.conversationManager, conversationId, {
            trimStartIndex: finalTrimStartIndex
        });
    } else {
        deps.log.warn('trim_state_cleared_invalid', {
            conversationId,
            savedTrimStartIndex: trimStartIndex,
            reason: normalizedTrimmedHistory.normalization.reason,
            issueKind: normalizedTrimmedHistory.normalization.issueKind,
            callId: normalizedTrimmedHistory.normalization.issueCallId
        });
        await clearTrimState(deps.conversationManager, conversationId);
    }

    deps.log.debug('trim.perform.applied', {
        conversationId,
        roundsToSkip,
        trimStartIndex,
        finalTrimStartIndex,
        trimmedHistoryLength: trimmedHistory.length,
        estimatedTotalTokens,
        threshold,
        targetTokens,
        remainingEstimatedTokensAfterTrim,
        roundEvaluation
    });

    return {
        history: trimmedHistory,
        trimStartIndex: finalTrimStartIndex,
        contextManagementDecision: {
            enabled: true,
            mode: 'trim',
            source: resolveContextManagementPolicy(config).source,
            action: 'trim_applied'
        }
    };
}
