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
import { describe, expect } from 'vitest'
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
  test('最后一条带 usage 的助手消息：返回 totalTokenCount', () => {
    const usedTokens = makeComputed([
      makeMessage('u1'),
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 123 } }
      })
    ])
    expect(usedTokens.value).toBe(123)
  })

  test('总结估算 timestamp 晚于最后一条 usage：返回估算', () => {
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

  test('总结估算 timestamp 早于最后一条 usage：返回 usage', () => {
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

  test('无助手 usage 消息：返回 0（即使存在总结估算）', () => {
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

  test('多条总结取 timestamp 最大者（数组靠后的总结在助手消息之后也计入）', () => {
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

  test('消息同时是总结且带 usage：估算优先', () => {
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


describe('usedTokens 增量缓存（M-1）', () => {
  /** 生产环境语义：消息变更时整体替换数组引用（state.allMessages.value = 新数组） */
  function makeComputedWithState(messages: Message[]) {
    const state = { allMessages: ref(messages) } as unknown as ChatStoreState
    const usedTokens = createChatComputed(state).usedTokens
    return {
      usedTokens,
      replace(next: Message[]) {
        ;(state as { allMessages: { value: Message[] } }).allMessages.value = next
      }
    }
  }

  test('流式追加：尾部新增助手消息后增量扫描返回新的 usage', () => {
    const { usedTokens, replace } = makeComputedWithState([
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 100 } }
      })
    ])
    expect(usedTokens.value).toBe(100)

    // 模拟流式追加（数组只增，前缀引用不变 → 走增量扫描）
    replace([
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 100 } }
      }),
      makeMessage('a2', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 250 } }
      })
    ])
    expect(usedTokens.value).toBe(250)
  })

  test('尾消息原地写入 usageMetadata（流式 done 分支）：下次求值可见', () => {
    const messages = [
      makeMessage('a1', { role: 'assistant' })
    ]
    const { usedTokens, replace } = makeComputedWithState(messages)
    expect(usedTokens.value).toBe(0)

    // 尾消息对象原地补 usage（流式期间对象被改写）；随后整体替换数组引用触发重算
    // （尾消息不纳入缓存前缀，增量扫描会重扫尾部看到新 usage）
    messages[0].metadata = { usageMetadata: { totalTokenCount: 77 } }
    replace([...messages])
    expect(usedTokens.value).toBe(77)
  })

  test('前缀消息被替换（结构变更）→ 回退全量扫描，结果与全量一致', () => {
    const messages = [
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 100 } }
      }),
      makeMessage('a2', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 200 } }
      })
    ]
    const { usedTokens, replace } = makeComputedWithState(messages)
    expect(usedTokens.value).toBe(200)

    // 替换前缀消息（新对象，引用不同 → 前缀校验失败 → 全量重扫）
    replace([
      makeMessage('a1-new', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 999 } }
      }),
      messages[1]
    ])
    // 全量语义：取最后一条带 usage 的助手消息 → a2 的 200
    expect(usedTokens.value).toBe(200)

    // 再替换尾消息 → 增量/全量都应取新值
    replace([
      messages[0],
      makeMessage('a2-new', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 555 } }
      })
    ])
    expect(usedTokens.value).toBe(555)
  })

  test('数组缩短（消息删除）→ 回退全量扫描', () => {
    const { usedTokens, replace } = makeComputedWithState([
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 100 } }
      }),
      makeMessage('a2', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 200 } }
      })
    ])
    expect(usedTokens.value).toBe(200)

    replace([
      makeMessage('a1', {
        role: 'assistant',
        metadata: { usageMetadata: { totalTokenCount: 100 } }
      })
    ])
    expect(usedTokens.value).toBe(100)
  })

  test('增量追加总结消息：估算优先级与全量一致', () => {
    const first = makeMessage('a1', {
      role: 'assistant',
      timestamp: 1000,
      metadata: { usageMetadata: { totalTokenCount: 100 } }
    })
    const { usedTokens, replace } = makeComputedWithState([first])
    expect(usedTokens.value).toBe(100)

    replace([
      first,
      makeMessage('s1', {
        role: 'assistant',
        timestamp: 2000,
        isSummary: true,
        summaryTokenStats: makeSummaryStats(500)
      })
    ])
    expect(usedTokens.value).toBe(500)
  })
})