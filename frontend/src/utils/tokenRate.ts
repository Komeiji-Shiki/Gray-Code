import type { MessageMetadata, UsageMetadata } from '../types'

export const DUPLICATE_DURATION_TOLERANCE_MS = 50

/**
 * 修改原因：candidatesTokenCount 在 Anthropic（output_tokens）与多数 OAI 兼容渠道（completion_tokens）
 * 中已包含思考 token；旧实现再叠加 thoughtsTokenCount，会把思考 token 重复计入分子，
 * 导致 token 速率虚高近一倍（例如 64768 输出 + 64657 思考被算成 129425）。
 * 修改方式：分子只取 candidatesTokenCount，与界面 ↓ 展示的输出 token 数保持同一口径。
 * 修改目的：让用户用界面可见的输出 token 数除以响应耗时即可复现速率，避免思考 token 被重复计算。
 */
export function getTokenRateTokenCount(usage?: UsageMetadata): number {
  if (!usage) return 0

  return usage.candidatesTokenCount || 0
}

/**
 * 修改原因：旧实现用 streamDuration 作为唯一分母，遇到上游攒包后会把大量 token 除以极短解析窗口。
 * 修改方式：统一从 MessageMetadata 中选取完整响应耗时；responseDuration 优先，streamDuration 只在旧数据缺失 responseDuration 时兜底。
 * 修改目的：既修复新旧主界面与 Monitor 的速度显示，又保持历史记录在信息不完整时仍能 best-effort 展示。
 *
 * TTFT 剥离：完整响应耗时包含首字等待窗口（从请求发出到第一个 token 到达），
 * 首字等待属于延迟而非吞吐，直接作分母会把速率拉低；因此从分母中减去 ttft（如有）。
 * 旧数据 / 无 ttft 字段时退化为原分母，不改变历史展示。
 */
export function calculateTokenRate(
  metadata?: MessageMetadata,
  resolvedUsage?: UsageMetadata
): number | undefined {
  if (!metadata) return undefined

  const chunkCount = metadata.chunkCount || 0
  if (chunkCount <= 1) return undefined

  const duration = metadata.responseDuration ?? metadata.streamDuration
  if (!duration || duration <= 0) return undefined

  // 剥离首字延迟：速率只反映生成阶段吞吐；ttft 缺失（旧记录）时退化为原分母
  const ttft = typeof metadata.ttft === 'number' && metadata.ttft > 0 ? metadata.ttft : 0
  const generationDuration = duration - ttft
  if (generationDuration <= 0) return undefined

  const totalTokens = getTokenRateTokenCount(resolvedUsage ?? metadata.usageMetadata)
  if (totalTokens <= 0) return undefined

  return totalTokens / (generationDuration / 1000)
}

/**
 * 修改原因：不同 UI 入口需要同样的小数位展示，但单位文案由各自模板控制。
 * 修改方式：只格式化数字精度，不拼接 t/s。
 * 修改目的：复用展示精度，同时避免工具函数耦合具体 UI 文案。
 */
export function formatTokenRate(rate: number): string {
  return rate.toFixed(1)
}

/**
 * 修改原因：修复后 streamDuration 与 responseDuration 在新记录中同源，详情页继续并列展示会造成重复信息。
 * 修改方式：当两者在容差内近似相等时隐藏 streamDuration；差异较大的旧记录或异常记录仍保留诊断价值。
 * 修改目的：减少详情页噪音，同时不丢失历史数据中可能有意义的时长差异。
 */
export function shouldShowStreamDuration(
  responseDuration?: number,
  streamDuration?: number,
  toleranceMs = DUPLICATE_DURATION_TOLERANCE_MS
): boolean {
  if (typeof streamDuration !== 'number' || streamDuration <= 0) return false
  if (typeof responseDuration !== 'number' || responseDuration <= 0) return true
  return Math.abs(streamDuration - responseDuration) > toleranceMs
}
