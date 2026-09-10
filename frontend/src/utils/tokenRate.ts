export { calculateTokenRate, getTokenRateTokenCount } from '../../../shared/tokenRate'

export const DUPLICATE_DURATION_TOLERANCE_MS = 50

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
