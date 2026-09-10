export interface TokenRateUsage { candidatesTokenCount?: number }
export interface TokenRateMetadata {
  chunkCount?: number;
  responseDuration?: number;
  streamDuration?: number;
  ttft?: number;
  usageMetadata?: TokenRateUsage;
}

/** 输出 token 已包含相应渠道记录的思考部分，不再次累加 thoughtsTokenCount。 */
export function getTokenRateTokenCount(usage?: TokenRateUsage): number {
  return usage?.candidatesTokenCount || 0;
}

/** 与桌面消息一致：输出 token /（完整响应耗时 - TTFT），单块响应不推算速率。 */
export function calculateTokenRate(metadata?: TokenRateMetadata, resolvedUsage?: TokenRateUsage): number | undefined {
  if (!metadata || (metadata.chunkCount || 0) <= 1) return undefined;
  const duration = metadata.responseDuration ?? metadata.streamDuration;
  if (!duration || duration <= 0) return undefined;
  const ttft = typeof metadata.ttft === 'number' && metadata.ttft > 0 ? metadata.ttft : 0;
  const generationDuration = duration - ttft;
  if (generationDuration <= 0) return undefined;
  const tokens = getTokenRateTokenCount(resolvedUsage ?? metadata.usageMetadata);
  return tokens > 0 ? tokens / (generationDuration / 1000) : undefined;
}
