import type { StreamUsageMetadata } from '../types';

/** OpenAI 兼容渠道共用解析，保留供应方明确返回的零值。 */
export function parseOpenAIUsage(usage: any): StreamUsageMetadata {
    const completionTokens = usage.completion_tokens || 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    // DeepSeek 原生字段和兼容字段表示同一批命中 token，不能相加。
    const cachedTokens = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    return {
        promptTokenCount: usage.prompt_tokens,
        // completion_tokens 已包含 reasoning_tokens，思考数只作为输出的明细。
        candidatesTokenCount: completionTokens > 0 ? completionTokens : undefined,
        totalTokenCount: usage.total_tokens,
        thoughtsTokenCount: reasoningTokens > 0 ? reasoningTokens : undefined,
        ...(typeof cachedTokens === 'number' && Number.isFinite(cachedTokens) && cachedTokens >= 0
            ? { cacheReadTokenCount: cachedTokens, cachedContentTokenCount: cachedTokens } : {}),
    };
}
