/**
 * GrayCode - 流式 usage 元数据合并
 *
 * 由 StreamAccumulator 拆分而来：把 usage 的增量合并逻辑抽为纯函数。
 */

import type { UsageMetadata } from '../../conversation';
import type { StreamUsageMetadata } from '../types';

export interface MergedUsageMetadata {
    usageMetadata: UsageMetadata;
    hasProviderTotalTokenCount: boolean;
}

/**
 * 合并增量 usage 信息
 *
 * 某些渠道（如 Anthropic）会把输入输出 token 分别放在不同事件里，
 * 这里需要做增量合并，避免后到达的字段覆盖先到达的字段。
 */
export function mergeUsageMetadata(
    previous: UsageMetadata | undefined,
    hasProviderTotalTokenCount: boolean,
    usage: StreamUsageMetadata
): MergedUsageMetadata {
    if (usage.totalTokenCount !== undefined) {
        hasProviderTotalTokenCount = true;
    }

    const merged: UsageMetadata = {
        promptTokenCount: usage.promptTokenCount ?? previous?.promptTokenCount,
        candidatesTokenCount: usage.candidatesTokenCount ?? previous?.candidatesTokenCount,
        totalTokenCount: usage.totalTokenCount ?? previous?.totalTokenCount,
        cachedContentTokenCount: usage.cachedContentTokenCount ?? previous?.cachedContentTokenCount,
        cacheCreationTokenCount: usage.cacheCreationTokenCount ?? previous?.cacheCreationTokenCount,
        cacheReadTokenCount: usage.cacheReadTokenCount ?? previous?.cacheReadTokenCount,
        thoughtsTokenCount: usage.thoughtsTokenCount ?? previous?.thoughtsTokenCount,
        promptTokensDetails: usage.promptTokensDetails ?? previous?.promptTokensDetails,
        candidatesTokensDetails: usage.candidatesTokensDetails ?? previous?.candidatesTokensDetails
    };

    const hasAnyTokenField = merged.promptTokenCount !== undefined ||
        merged.candidatesTokenCount !== undefined ||
        merged.thoughtsTokenCount !== undefined;

    // 某些流式渠道（如 Anthropic）不会直接给 totalTokenCount。
    // 当未收到过渠道原生total 时，每次合并后都用已知字段重算，
    // 避免出现先收到prompt，后收到 candidates 时total 仍停留在 prompt 的问题。
    if (hasAnyTokenField) {
        const prompt = merged.promptTokenCount ?? 0;
        const candidates = merged.candidatesTokenCount ?? 0;
        const thoughts = merged.thoughtsTokenCount ?? 0;

        if (!hasProviderTotalTokenCount) {
            merged.totalTokenCount = prompt + candidates + thoughts;
        } else if (usage.totalTokenCount === undefined
            && usage.candidatesTokenCount !== undefined
            && previous?.totalTokenCount !== undefined) {
            // Anthropic：message_start 的 total 只含 input（output 恒 0），
            // message_delta 只带 output_tokens。若已有原生 total，把新的
            // candidates 增量合并进去——否则输出 token 从总量中消失，
            // 下游 ContextTrim/Summarize 的 total−prompt 恒为 0。
            // 仅当本事件未带 total（即不是代理返回的完整 usage）时走此分支。
            const prevCandidates = previous.candidatesTokenCount ?? 0;
            merged.totalTokenCount = previous.totalTokenCount - prevCandidates + usage.candidatesTokenCount;
        } else if (merged.totalTokenCount === undefined) {
            // 理论上有原生 total 时不应进入此分支，但为稳健性保底。
            merged.totalTokenCount = prompt + candidates + thoughts;
        }
    }

    return {
        usageMetadata: merged,
        hasProviderTotalTokenCount
    };
}
