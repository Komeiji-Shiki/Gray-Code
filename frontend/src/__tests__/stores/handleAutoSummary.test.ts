/**
 * handleAutoSummary 逻辑截断同步回归测试
 *
 * 背景：自动总结从「物理删除被总结消息」改为「逻辑截断」（后端打 isSummarized 标记 + 插入总结）。
 * 协议：insertIndex = 总结消息插入位置（= summarizeEndIndex），removedCount = 本次标记的消息数，
 * 被标记区间 = [insertIndex - removedCount, insertIndex)。
 * 前端同步：标记窗口内对应消息（原文保留不删除）、插入总结消息（后续 backendIndex +1）、totalMessages +1。
 */
import { ref } from 'vue'
import { describe, expect } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleAutoSummary } from '../../stores/chat/streamChunkHandlers'

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref('conv_1'),
    allMessages: ref<Message[]>([]),
    messageIndexById: undefined as unknown as ChatStoreState['messageIndexById'],
    toolResponseIndex: undefined as unknown as ChatStoreState['toolResponseIndex'],
    windowStartIndex: ref(0),
    totalMessages: ref(0),
    isLoading: ref(false),
    isStreaming: ref(false),
    isWaitingForResponse: ref(false),
    error: ref(null),
    streamingMessageId: ref<string | null>(null),
    activeStreamId: ref<string | null>(null),
    checkpoints: ref<CheckpointRecord[]>([]),
    mergeUnchangedCheckpoints: ref(true),
    retryStatus: ref(null),
    autoSummaryStatus: ref(null),
    configId: ref('cfg_1'),
    selectedModelId: ref(''),
    currentConfig: ref(null),
    currentPromptModeId: ref('code'),
    pendingModelOverride: ref<string | null>(null),
    pendingConfigIdOverride: ref<string | null>(null),
    _lastCancelledStreamId: ref<string | null>(null),
    _lastApprovalGatedStreamId: ref<string | null>(null),
    _failedStreamMessageId: ref<string | null>(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map()),
    branchGraph: ref(null),
    branchGraphLoading: ref(false),
    isSwitchingBranch: ref(false),
    ...overrides
  } as unknown as ChatStoreState
}

function msg(id: string, backendIndex: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    role: 'user',
    content: id,
    parts: [{ text: id }],
    timestamp: 0,
    backendIndex,
    ...extra
  } as unknown as Message
}

const summaryChunk = (overrides: Record<string, unknown> = {}) => ({
  type: 'autoSummary',
  conversationId: 'conv_1',
  streamId: 'stream_1',
  summaryContent: {
    id: 'summary-1',
    role: 'user',
    parts: [{ text: '[对话总结]' }],
    isSummary: true
  },
  insertIndex: 3,
  removedCount: 2,
  ...overrides
})

describe('handleAutoSummary - 逻辑截断同步', () => {
  test('标记被总结区间 + 插入总结 + 后续消息索引后移', () => {
    const state = createState({
      allMessages: ref([
        msg('m0', 0), // 首条用户消息（不标记）
        msg('m1', 1),
        msg('m2', 2),
        msg('m3', 3)
      ]),
      totalMessages: ref(4)
    })

    handleAutoSummary(summaryChunk() as any, state)

    const messages = state.allMessages.value
    // 原文保留：消息数与索引不删除、不平移
    expect(messages).toHaveLength(5)
    expect(messages[0].id).toBe('m0')
    expect(messages[1].id).toBe('m1')
    expect(messages[2].id).toBe('m2')
    // 被总结区间 [1, 3) 标记
    expect(messages[1].isSummarized).toBe(true)
    expect(messages[2].isSummarized).toBe(true)
    // 首条用户消息与区间外消息不标记
    expect(messages[0].isSummarized).toBeUndefined()
    expect(messages[3].isSummarized).toBeUndefined()
    // 总结消息插入 insertIndex=3，后续消息索引 +1
    expect(messages[3].id).toBe('summary-1')
    expect(messages[3].isSummary).toBe(true)
    expect(messages[3].backendIndex).toBe(3)
    expect(messages[4].id).toBe('m3')
    expect(messages[4].backendIndex).toBe(4)
    expect(state.totalMessages.value).toBe(5)
  })

  test('removedCount 为 0（首条保护导致空标记区间）时仅插入总结', () => {
    const state = createState({
      allMessages: ref([msg('m0', 0), msg('m1', 1)]),
      totalMessages: ref(2)
    })

    handleAutoSummary(summaryChunk({ insertIndex: 1, removedCount: 0 }) as any, state)

    const messages = state.allMessages.value
    expect(messages).toHaveLength(3)
    expect(messages[0].id).toBe('m0')
    expect(messages[0].isSummarized).toBeUndefined()
    expect(messages[1].id).toBe('summary-1')
    expect(messages[1].backendIndex).toBe(1)
    expect(messages[2].id).toBe('m1')
    expect(messages[2].backendIndex).toBe(2)
    expect(state.totalMessages.value).toBe(3)
  })

  test('已存在同 id 总结消息时去重，不重复处理', () => {
    const state = createState({
      allMessages: ref([msg('m0', 0), msg('summary-1', 3, { isSummary: true }), msg('m3', 4)]),
      totalMessages: ref(3)
    })

    handleAutoSummary(summaryChunk() as any, state)

    // 无变化：未插入、未标记、totalMessages 不变
    expect(state.allMessages.value).toHaveLength(3)
    expect(state.allMessages.value[0].isSummarized).toBeUndefined()
    expect(state.totalMessages.value).toBe(3)
  })

  test('插入位置在当前窗口之前时仅维护索引偏移', () => {
    const state = createState({
      allMessages: ref([msg('m5', 5), msg('m6', 6)]),
      windowStartIndex: ref(5),
      totalMessages: ref(7)
    })

    handleAutoSummary(summaryChunk({ insertIndex: 2, removedCount: 1 }) as any, state)

    // 总结在窗口外不插入，已加载消息索引整体 +1，窗口起点 +1
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value[0].backendIndex).toBe(6)
    expect(state.allMessages.value[1].backendIndex).toBe(7)
    expect(state.windowStartIndex.value).toBe(6)
    expect(state.totalMessages.value).toBe(8)
  })
})
