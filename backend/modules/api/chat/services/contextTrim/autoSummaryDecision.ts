/**
 * 主会话与 SubAgent 共用的自动总结触发判定。
 *
 * 固定提示词本身已越过软阈值、但可压缩历史很少时，总结无法带来有效收益；此时允许
 * 请求继续。只有模型元数据明确声明的输入硬上限被越过时，才要求请求级 fallback。
 */

const AUTO_SUMMARY_USEFUL_HISTORY_RATIO = 0.01;
const MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 256;
const MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS = 8_192;

export interface AutoSummaryDecisionInput {
    estimatedTotalTokens: number;
    thresholdTokens: number;
    fixedPromptTokens: number;
    maxInputTokens: number;
    hardInputTokenLimit?: number;
}

export interface AutoSummaryDecision {
    needsAutoSummarize: boolean;
    needsContextFallback: boolean;
    lowSavingsBecauseFixedPromptExceedsThreshold: boolean;
    compressibleHistoryTokens: number;
    minimumUsefulHistoryTokens: number;
}

export function evaluateAutoSummaryNeed(input: AutoSummaryDecisionInput): AutoSummaryDecision {
    const estimatedTotalTokens = Math.max(0, input.estimatedTotalTokens);
    const thresholdTokens = Math.max(0, input.thresholdTokens);
    const fixedPromptTokens = Math.max(0, input.fixedPromptTokens);
    const maxInputTokens = Math.max(1, input.maxInputTokens);
    const compressibleHistoryTokens = Math.max(0, estimatedTotalTokens - fixedPromptTokens);
    const minimumUsefulHistoryTokens = Math.max(
        MIN_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
        Math.min(
            MAX_AUTO_SUMMARY_USEFUL_HISTORY_TOKENS,
            Math.floor(maxInputTokens * AUTO_SUMMARY_USEFUL_HISTORY_RATIO)
        )
    );
    const exceedsSoftThreshold = estimatedTotalTokens > thresholdTokens;
    const lowSavingsBecauseFixedPromptExceedsThreshold =
        exceedsSoftThreshold
        && fixedPromptTokens >= thresholdTokens
        && compressibleHistoryTokens < minimumUsefulHistoryTokens;
    const needsAutoSummarize = exceedsSoftThreshold && !lowSavingsBecauseFixedPromptExceedsThreshold;
    const needsContextFallback =
        !needsAutoSummarize
        && typeof input.hardInputTokenLimit === 'number'
        && estimatedTotalTokens > input.hardInputTokenLimit;

    return {
        needsAutoSummarize,
        needsContextFallback,
        lowSavingsBecauseFixedPromptExceedsThreshold,
        compressibleHistoryTokens,
        minimumUsefulHistoryTokens
    };
}
