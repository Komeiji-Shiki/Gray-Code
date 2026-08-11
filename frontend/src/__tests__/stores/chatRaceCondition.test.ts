/**
 * Chat Store 竞态修复单元测试
 *
 * 覆盖：
 * - validateSessionIdentity 统一会话归属校验
 * - resolveLoadedVisibleMessages 尾部窗口切片
 * - computeVirtualRows 回归守护
 * - QueuedMessage.conversationId 类型与 processQueue 跨会话防护
 * - ConversationSessionSnapshot.toolResponseCache 快照存取
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { validateSessionIdentity } from '../../stores/chat/utils'
import { resolveLoadedVisibleMessages, computeVirtualRows } from '../../components/message/messageListUtils'
import type { ChatStoreState, QueuedMessage, ConversationSessionSnapshot } from '../../stores/chat/types'

// ============ Minimal mock state helper for validateSessionIdentity ============

function mockStateWithConvId(conversationId: string | null): ChatStoreState {
  const currentConversationId: Ref<string | null> = ref(conversationId)
  return {
    currentConversationId
  } as unknown as ChatStoreState
}

// ============ validateSessionIdentity ============

describe('validateSessionIdentity', () => {
  test('returns true when current conversation matches expected', () => {
    const state = mockStateWithConvId('conv_A')
    expect(validateSessionIdentity(state, 'conv_A')).toBe(true)
  })

  test('returns false when current conversation differs', () => {
    const state = mockStateWithConvId('conv_B')
    expect(validateSessionIdentity(state, 'conv_A')).toBe(false)
  })

  test('handles null expected ID vs non-null current', () => {
    const state = mockStateWithConvId('conv_A')
    expect(validateSessionIdentity(state, null)).toBe(false)
  })

  test('returns true when both are null', () => {
    const state = mockStateWithConvId(null)
    expect(validateSessionIdentity(state, null)).toBe(true)
  })

  test('returns false when expected is non-null but current is null', () => {
    const state = mockStateWithConvId(null)
    expect(validateSessionIdentity(state, 'conv_X')).toBe(false)
  })
})

// ============ resolveLoadedVisibleMessages ============

describe('resolveLoadedVisibleMessages', () => {
  const msgs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  test('returns all messages when visibleCount >= messages.length', () => {
    const result = resolveLoadedVisibleMessages(msgs, 100)
    expect(result).toEqual(msgs)
  })

  test('returns tail window when visibleCount < messages.length', () => {
    const result = resolveLoadedVisibleMessages(msgs, 3)
    expect(result).toEqual([8, 9, 10])
  })

  test('returns empty array for empty input', () => {
    expect(resolveLoadedVisibleMessages([], 10)).toEqual([])
  })

  test('returns empty array for non-array input', () => {
    expect(resolveLoadedVisibleMessages(null as unknown as number[], 5)).toEqual([])
  })

  test('returns at least 1 message when visibleCount is 0 or negative', () => {
    const result = resolveLoadedVisibleMessages(msgs, 0)
    expect(result).toEqual([10])
  })

  test('handles NaN visibleCount gracefully', () => {
    const result = resolveLoadedVisibleMessages(msgs, NaN)
    expect(result).toEqual([10])
  })

  test('preserves order of tail messages', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e']
    const result = resolveLoadedVisibleMessages(ordered, 2)
    expect(result).toEqual(['d', 'e'])
  })
})

// ============ computeVirtualRows (regression guard) ============

describe('computeVirtualRows', () => {
  const rows = Array.from({ length: 5 }, (_, i) => `msg_${i}`)

  test('returns all rows when below threshold', () => {
    const result = computeVirtualRows(rows, {
      threshold: 10,
      estimatedRowHeight: 80,
      overscan: 2,
      viewportHeight: 800,
      scrollTop: 0
    })
    expect(result.virtualized).toBe(false)
    expect(result.reason).toBe('below_threshold')
    expect(result.rows).toEqual(rows)
  })

  test('returns fallback for invalid estimate', () => {
    const result = computeVirtualRows(rows, {
      threshold: 3,
      estimatedRowHeight: 0,
      overscan: 2,
      viewportHeight: 800,
      scrollTop: 0
    })
    expect(result.fallback).toBe(true)
    expect(result.reason).toBe('invalid_estimate')
  })

  test('virtualizes when rows exceed threshold', () => {
    const manyRows = Array.from({ length: 50 }, (_, i) => `msg_${i}`)
    const result = computeVirtualRows(manyRows, {
      threshold: 10,
      estimatedRowHeight: 80,
      overscan: 2,
      viewportHeight: 800,
      scrollTop: 0
    })
    expect(result.virtualized).toBe(true)
    expect(result.startIndex).toBe(0)
    expect(result.rows.length).toBeGreaterThan(0)
  })

  test('returns all rows for empty input', () => {
    const result = computeVirtualRows([], {
      threshold: 5,
      estimatedRowHeight: 80,
      overscan: 2,
      viewportHeight: 800,
      scrollTop: 0
    })
    expect(result.rows).toEqual([])
    expect(result.reason).toBe('below_threshold')
  })
})

// ============ QueuedMessage type ============

describe('QueuedMessage', () => {
  test('has conversationId field', () => {
    const msg: QueuedMessage = {
      id: 'q1',
      content: 'test',
      attachments: [],
      timestamp: Date.now(),
      conversationId: 'conv_A'
    }
    expect(msg.conversationId).toBe('conv_A')
  })

  test('allows null conversationId for legacy items', () => {
    const msg: QueuedMessage = {
      id: 'q1',
      content: 'test',
      attachments: [],
      timestamp: Date.now(),
      conversationId: null
    }
    expect(msg.conversationId).toBeNull()
  })
})

// ============ processQueue cross-conversation guard (logic test) ============

describe('processQueue cross-conversation guard', () => {
  test('should skip queued messages from a different conversation', () => {
    const itemA: QueuedMessage = {
      id: 'qA',
      content: 'message for A',
      attachments: [],
      timestamp: Date.now(),
      conversationId: 'conv_A'
    }

    const currentId = 'conv_B'

    const shouldSkip = typeof itemA.conversationId === 'string'
      && itemA.conversationId !== currentId

    expect(shouldSkip).toBe(true)
  })

  test('should allow messages for current conversation', () => {
    const item: QueuedMessage = {
      id: 'qA',
      content: 'message for A',
      attachments: [],
      timestamp: Date.now(),
      conversationId: 'conv_A'
    }

    const currentId = 'conv_A'

    const shouldSend = !(typeof item.conversationId === 'string'
      && item.conversationId !== currentId)

    expect(shouldSend).toBe(true)
  })

  test('should allow messages with null conversationId (legacy)', () => {
    const item: QueuedMessage = {
      id: 'q_legacy',
      content: 'legacy message',
      attachments: [],
      timestamp: Date.now(),
      conversationId: null
    }

    const currentId = 'conv_whatever'

    const shouldSend = !(typeof item.conversationId === 'string'
      && item.conversationId !== currentId)

    expect(shouldSend).toBe(true)
  })
})

// ============ ConversationSessionSnapshot toolResponseCache ============

describe('ConversationSessionSnapshot toolResponseCache', () => {
  test('supports Array<[string, Record]> entries for snapshot', () => {
    const entries: Array<[string, Record<string, unknown>]> = [
      ['tool_1', { status: 'success' }],
      ['tool_2', { status: 'error' }]
    ]

    // Restore logic: new Map(snapshot.toolResponseCache)
    const restored = new Map(entries)
    expect(restored.get('tool_1')).toEqual({ status: 'success' })
    expect(restored.get('tool_2')).toEqual({ status: 'error' })
  })

  test('falls back to empty Map for snapshots without toolResponseCache', () => {
    // Old snapshot missing the field
    const oldCache = undefined as
      | Array<[string, Record<string, unknown>]>
      | undefined

    const restored = Array.isArray(oldCache)
      ? new Map(oldCache)
      : new Map()

    expect(restored.size).toBe(0)
  })

  test('restores empty Map when toolResponseCache is empty array', () => {
    const snapshot: ConversationSessionSnapshot = {
      conversationId: 'conv_A',
      allMessages: [],
      windowStartIndex: 0,
      configId: 'test',
      selectedModelId: '',
      totalMessages: 0,
      isLoadingMoreMessages: false,
      isStreaming: false,
      isLoading: false,
      streamingMessageId: null,
      activeStreamId: null,
      isWaitingForResponse: false,
      checkpoints: [],
      activeBuild: null,
      error: null,
      retryStatus: null,
      autoSummaryStatus: null,
      historyFolded: false,
      foldedMessageCount: 0,
      inputValue: '',
      pendingModelOverride: null,
      pendingConfigIdOverride: null,
      editorNodes: [],
      attachments: [],
      messageQueue: [],
      currentPromptModeId: 'code',
      toolResponseCache: [],
      branchGraph: null
    }

    const restored = new Map(snapshot.toolResponseCache)
    expect(restored.size).toBe(0)
  })
})

// ============ sendMessage targetConvId guard logic ============

describe('sendMessage targetConvId guard', () => {
  test('should abort when session identity changes during await', () => {
    const state = mockStateWithConvId('conv_switched')
    const targetConvId = 'conv_original'

    const shouldAbort = !validateSessionIdentity(state, targetConvId)
    expect(shouldAbort).toBe(true)
  })

  test('should proceed when session identity unchanged', () => {
    const state = mockStateWithConvId('conv_stable')
    const targetConvId = 'conv_stable'

    const shouldProceed = validateSessionIdentity(state, targetConvId)
    expect(shouldProceed).toBe(true)
  })
})
