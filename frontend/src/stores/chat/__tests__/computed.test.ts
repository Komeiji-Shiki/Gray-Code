/**
 * computed.ts usedTokens 语义等价性测试（PERF：两趟循环合并为单趟逆序扫描）。
 *
 * 覆盖合并后必须保持的原语义：
 * - 最后一条带 usageMetadata 的助手消息 → 返回其 totalTokenCount；
 * - 全部总结消息中 timestamp 最大的估算 >= 该助手消息 timestamp → 返回估算值；
 * - 估算 timestamp 更早 → 返回 usage；
 * - 无助手 usage 消息 → 返回 0；
 * - 总结消息出现在助手消息之后（数组靠后）且 timestamp 更大 → 仍取该总结估算。
 */
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { Message } from '../../../types'
import type { ChatStoreState } from '../types'
import { createChatComputed } from '../computed'

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: 1000,
    ...overrides
  } as Message
}

function makeComputed(messages: Message[]) {
  const state = { allMessages: ref(messages) } as unknown as ChatStoreState
  return createChatComputed(state).usedTokens
}

function makeSummaryStats(tokens: number) {
  return {
    sourceTokenCount: 0,
    summaryTokenCount: 0,
    estimatedTokensSaved: 0,
    estimatedContextTokenCountAfter: tokens
  }
}

describe('usedTokens', () => {
  it('最后一条带 usage 的助手消息：返回 totalTokenCount', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      })
    ])
    expect(usedTokens.value).toBe(123)
  })

  it('总结估算 timestamp 晚于最后一条 usage：返回估算', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('a1', {
        role: 'assistant',
        timestamp: 1000,
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      }),
      makeMessage('s1', {
        role: 'assistant',
        timestamp: 2000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500)
      })
    ])
    expect(usedTokens.value).toBe(500)
  })

  it('总结估算 timestamp 早于最后一条 usage：返回 usage', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('s1', {
        role: 'assistant',
        timestamp: 1000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500)
      }),
      makeMessage('a1', {
        role: 'assistant',
        timestamp: 2000,
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      })
    ])
    expect(usedTokens.value).toBe(123)
  })

  it('无助手 usage 消息：返回 0（即使存在总结估算）', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('s1', {
        role: 'assistant',
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500)
      })
    ])
    expect(usedTokens.value).toBe(0)
  })

  it('多条总结取 timestamp 最大者（数组靠后的总结在助手消息之后也计入）', () => {
    const usedTokens = makeComputed([
      makeMessage('s1', {
        role: 'assistant',
        timestamp: 1000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500)
      }),
      makeMessage('a1', {
        role: 'assistant',
        timestamp: 1500,
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      }),
      makeMessage('s2', {
        role: 'assistant',
        timestamp: 2000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(700)
      })
    ])
    expect(usedTokens.value).toBe(700)
  })

  it('消息同时是总结且带 usage：估算优先', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('a1', {
        role: 'assistant',
        timestamp: 2000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500),
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      })
    ])
    expect(usedTokens.value).toBe(500)
  })
})
