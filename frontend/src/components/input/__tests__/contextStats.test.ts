import { describe, expect, test, vi, beforeEach } from 'vitest'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '@/utils/vscode'
import {
  CONTEXT_REQUESTS,
  extractRpcErrorMessage,
  isMissingHandlerError,
  normalizeDescribePayload,
  normalizeSummaryDetailPayload,
  buildContextUsageRows,
  isPreciseSource,
  toSummaryTokenView,
  fetchContextBreakdown,
  fetchContextDescribe,
  fetchSummaryDetail,
  type ContextBreakdown
} from '../contextStats'

const mockedSend = vi.mocked(sendToExtension)

beforeEach(() => {
  mockedSend.mockReset()
})

function makeDescribeRaw(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    conversationId: 'c1',
    revision: 3,
    tokens: {
      usedTokens: 1200,
      source: 'provider-usage',
      precise: true,
      maxContextTokens: 8000,
      maxInputTokens: 7000,
      contextSource: 'channel',
      tokenUsagePercent: 15,
      localEstimate: 1100,
      localEstimateLabel: 'estimate'
    },
    range: {
      total: 10,
      visibleCount: 8,
      lastSummaryIndex: 2,
      summarizedCount: 2,
      summaryCount: 1,
      fallbackActive: false
    },
    summaries: [
      {
        id: 's1',
        index: 2,
        timestamp: 100,
        isAutoSummary: true,
        summarizedMessageCount: 2,
        summarizedMessageIds: ['m1', 'm2'],
        summaryTokenStats: {
          sourceTokenCount: 1000,
          summaryTokenCount: 200,
          estimatedTokensSaved: 800,
          estimatedContextTokenCountAfter: 1200
        },
        preview: 'preview text'
      }
    ],
    ...overrides
  }
}

describe('contextStats 错误原文与宿主判定', () => {
  test('extractRpcErrorMessage 保留原文', () => {
    expect(extractRpcErrorMessage(new Error('需要提供对话 ID。'))).toBe('需要提供对话 ID。')
    expect(extractRpcErrorMessage({ error: { message: 'nested' } })).toBe('nested')
  })

  test('isMissingHandlerError 识别缺处理器', () => {
    expect(isMissingHandlerError(new Error('Unknown message type: context.describe'))).toBe(true)
    expect(isMissingHandlerError(new Error('桌面宿主尚未接入此接口：context.describe'))).toBe(true)
    expect(isMissingHandlerError(new Error('总结消息已变化。'))).toBe(false)
  })
})

describe('contextStats describe 整形', () => {
  test('完整响应按口径透传（used/上限/使用率/范围/总结明细）', () => {
    const out = normalizeDescribePayload(makeDescribeRaw())
    expect(out.conversationId).toBe('c1')
    expect(out.tokens.usedTokens).toBe(1200)
    expect(out.tokens.maxContextTokens).toBe(8000)
    expect(out.tokens.tokenUsagePercent).toBe(15)
    expect(out.tokens.source).toBe('provider-usage')
    expect(out.range.visibleCount).toBe(8)
    expect(out.range.summarizedCount).toBe(2)
    expect(out.summaries).toHaveLength(1)
    expect(out.summaries[0].isAutoSummary).toBe(true)
    expect(out.summaries[0].summarizedMessageCount).toBe(2)
  })

  test('max 缺失时保持 undefined（由调用方回退 chatStore 口径）', () => {
    const raw = makeDescribeRaw({
      tokens: { usedTokens: 100, source: 'none', precise: false, localEstimate: 100 }
    })
    const out = normalizeDescribePayload(raw)
    expect(out.tokens.maxContextTokens).toBeUndefined()
    expect(out.tokens.tokenUsagePercent).toBeUndefined()
  })

  test('success=false 抛原文', () => {
    expect(() =>
      normalizeDescribePayload({ success: false, error: { message: '需要提供对话 ID。' } })
    ).toThrow('需要提供对话 ID。')
  })

  test('空响应与缺对话 ID 抛错', () => {
    expect(() => normalizeDescribePayload(null)).toThrow()
    expect(() => normalizeDescribePayload({ success: true })).toThrow()
  })

  test('非法总结条目被过滤', () => {
    const raw = makeDescribeRaw({ summaries: [{ id: 'bad' }, null, { id: 's2', index: 5, isAutoSummary: false, preview: 'x' }] })
    const out = normalizeDescribePayload(raw)
    expect(out.summaries).toHaveLength(1)
    expect(out.summaries[0].index).toBe(5)
  })
})

describe('contextStats 占用行与字段口径', () => {
  const breakdown = (overrides: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
    categories: [
      { id: 'messages', tokens: 300, items: [{ id: 'user', tokens: 300 }] },
      { id: 'mcpTools', tokens: 0, items: [] },
      { id: 'memory', tokens: 100, items: [] }
    ],
    totalTokens: 400, maxContextTokens: 1000, maxInputTokens: 900, softLimitTokens: 700, reservedOutputTokens: 100,
    autoCompactBufferTokens: 200, freeTokens: 300, managementEnabled: true, tokenizer: 'o200k_base', model: 'm', notices: [], measuredAt: 1,
    ...overrides
  })

  test('buildContextUsageRows 跳过空分类，各行合计等于整个上下文窗口', () => {
    const rows = buildContextUsageRows(breakdown())
    expect(rows.map(row => row.id)).toEqual(['messages', 'memory', 'reservedOutput', 'autoCompactBuffer', 'freeSpace'])
    expect(rows.reduce((total, row) => total + row.tokens, 0)).toBe(1000)
    expect(rows.reduce((total, row) => total + row.percent, 0)).toBeCloseTo(100)
    expect(rows[0].items).toEqual([{ id: 'user', tokens: 300 }])
  })

  test('buildContextUsageRows 没有缓冲和预留时不显示这两行，剩余空间用尽也保留', () => {
    const rows = buildContextUsageRows(breakdown({ reservedOutputTokens: 0, autoCompactBufferTokens: 0, freeTokens: 0 }))
    expect(rows.map(row => row.id)).toEqual(['messages', 'memory', 'freeSpace'])
    expect(rows.at(-1)?.tokens).toBe(0)
  })

  test('fetchContextBreakdown 透传请求，失败时抛原文', async () => {
    const request = { conversationId: 'c1', configId: 'channel' }
    mockedSend.mockResolvedValueOnce(breakdown())
    expect((await fetchContextBreakdown(request)).totalTokens).toBe(400)
    expect(mockedSend).toHaveBeenCalledWith(CONTEXT_REQUESTS.breakdown, request)
    mockedSend.mockResolvedValueOnce({ success: false, error: { message: '渠道不可用' } })
    await expect(fetchContextBreakdown(request)).rejects.toThrow('渠道不可用')
  })

  test('isPreciseSource 仅 provider-usage 为精确', () => {
    expect(isPreciseSource('provider-usage')).toBe(true)
    expect(isPreciseSource('summary-estimate')).toBe(false)
    expect(isPreciseSource('none')).toBe(false)
  })

  test('toSummaryTokenView 与 SummaryMessage 同字段', () => {
    expect(
      toSummaryTokenView({ sourceTokenCount: 1000, summaryTokenCount: 200, estimatedTokensSaved: 800 })
    ).toEqual({ before: 1000, after: 200, saved: 800 })
    expect(toSummaryTokenView(undefined)).toBeNull()
  })
})

describe('contextStats 总结详情整形', () => {
  test('正常详情透传 preview 与统计', () => {
    const out = normalizeSummaryDetailPayload({
      success: true,
      conversationId: 'c1',
      summary: {
        id: 's1',
        index: 2,
        timestamp: 100,
        isAutoSummary: false,
        summarizedMessageCount: 3,
        summaryTokenStats: {
          sourceTokenCount: 900,
          summaryTokenCount: 100,
          estimatedTokensSaved: 800
        },
        preview: 'detail preview'
      }
    })
    expect(out.summary.preview).toBe('detail preview')
    expect(out.summary.summarizedMessageCount).toBe(3)
  })

  test('非总结/缺失抛“总结消息已变化”', () => {
    expect(() =>
      normalizeSummaryDetailPayload({ success: true, conversationId: 'c1', summary: { id: 'x', index: -1 } })
    ).toThrow()
  })
})

describe('contextStats RPC 透传（只做参数透传，不触发总结）', () => {
  test('fetchContextDescribe 透传 conversationId/providerId/modelOverride', async () => {
    mockedSend.mockResolvedValue(makeDescribeRaw())
    await fetchContextDescribe('c1', { providerId: 'ch1', modelOverride: 'm' })
    expect(mockedSend).toHaveBeenCalledWith(CONTEXT_REQUESTS.describe, {
      conversationId: 'c1',
      providerId: 'ch1',
      modelOverride: 'm'
    })
  })

  test('fetchContextDescribe 缺对话 ID 不发请求', async () => {
    await expect(fetchContextDescribe('')).rejects.toThrow('对话 ID')
    expect(mockedSend).not.toHaveBeenCalled()
  })

  test('fetchSummaryDetail 透传 conversationId/messageId', async () => {
    mockedSend.mockResolvedValue({
      success: true,
      conversationId: 'c1',
      summary: { id: 's1', index: 1, isAutoSummary: false, preview: 'x' }
    })
    await fetchSummaryDetail('c1', 's1')
    expect(mockedSend).toHaveBeenCalledWith(CONTEXT_REQUESTS.summaryDetail, {
      conversationId: 'c1',
      messageId: 's1'
    })
  })
})
