/**
 * tokenRate 工具单元测试
 *
 * 覆盖：
 * - getTokenRateTokenCount：分子只取 candidatesTokenCount，不重复累加思考 token
 * - calculateTokenRate：分母优先 responseDuration，chunkCount/duration/token 守卫
 * - shouldShowStreamDuration：同源时长容差内隐藏 streamDuration
 */
import { calculateTokenRate, getTokenRateTokenCount, shouldShowStreamDuration } from '../../utils/tokenRate'
import type { MessageMetadata, UsageMetadata } from '../../types'

describe('getTokenRateTokenCount', () => {
  it('returns 0 when usage is missing', () => {
    expect(getTokenRateTokenCount(undefined)).toBe(0)
  })

  it('returns candidates count only', () => {
    const usage: UsageMetadata = { candidatesTokenCount: 64768 }
    expect(getTokenRateTokenCount(usage)).toBe(64768)
  })

  it('does not double count thought tokens when candidates already includes them', () => {
    // 回归用例：Anthropic output_tokens / OAI 兼容 completion_tokens 已含思考 token，
    // 旧实现把 thoughtsTokenCount 再叠加一次导致速率虚高近一倍（64768 + 64657 = 129425）。
    const usage: UsageMetadata = {
      candidatesTokenCount: 64768,
      thoughtsTokenCount: 64657
    }
    expect(getTokenRateTokenCount(usage)).toBe(64768)
  })

  it('treats undefined candidates as 0', () => {
    const usage: UsageMetadata = { thoughtsTokenCount: 100 }
    expect(getTokenRateTokenCount(usage)).toBe(0)
  })
})

describe('calculateTokenRate', () => {
  it('returns undefined when metadata is missing', () => {
    expect(calculateTokenRate(undefined)).toBeUndefined()
  })

  it('returns undefined when chunkCount <= 1', () => {
    const metadata: MessageMetadata = { chunkCount: 1, responseDuration: 1000 }
    expect(calculateTokenRate(metadata)).toBeUndefined()
  })

  it('returns undefined when duration is missing', () => {
    const metadata: MessageMetadata = { chunkCount: 5 }
    expect(calculateTokenRate(metadata)).toBeUndefined()
  })

  it('returns undefined when no output tokens', () => {
    const metadata: MessageMetadata = { chunkCount: 5, responseDuration: 1000 }
    expect(calculateTokenRate(metadata)).toBeUndefined()
  })

  it('computes rate with visible output tokens only, ignoring thought tokens', () => {
    // 界面数据：输出 64768（已含思考）、响应耗时 629.5s → 64768 / 629.5 ≈ 102.9 t/s
    const metadata: MessageMetadata = { chunkCount: 42, responseDuration: 629500 }
    const usage: UsageMetadata = {
      candidatesTokenCount: 64768,
      thoughtsTokenCount: 64657
    }
    const rate = calculateTokenRate(metadata, usage)
    expect(rate).toBeCloseTo(64768 / 629.5, 5)
    expect(rate).not.toBeCloseTo((64768 + 64657) / 629.5, 5)
  })

  it('prefers responseDuration over streamDuration', () => {
    const metadata: MessageMetadata = {
      chunkCount: 3,
      responseDuration: 10000,
      streamDuration: 1000
    }
    const usage: UsageMetadata = { candidatesTokenCount: 100 }
    expect(calculateTokenRate(metadata, usage)).toBeCloseTo(100 / 10, 5)
  })

  it('falls back to streamDuration when responseDuration is missing', () => {
    const metadata: MessageMetadata = { chunkCount: 3, streamDuration: 2000 }
    const usage: UsageMetadata = { candidatesTokenCount: 100 }
    expect(calculateTokenRate(metadata, usage)).toBeCloseTo(100 / 2, 5)
  })
})

describe('shouldShowStreamDuration', () => {
  it('returns false when streamDuration is missing', () => {
    expect(shouldShowStreamDuration(1000, undefined)).toBe(false)
  })

  it('returns true when responseDuration is missing', () => {
    expect(shouldShowStreamDuration(undefined, 1000)).toBe(true)
  })

  it('hides streamDuration when values are within tolerance', () => {
    expect(shouldShowStreamDuration(100000, 100010)).toBe(false)
  })

  it('shows streamDuration when values differ significantly', () => {
    expect(shouldShowStreamDuration(629500, 315000)).toBe(true)
  })
})
