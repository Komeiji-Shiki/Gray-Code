/**
 * H4 回归测试：无 streamId 的迟到 error/cancelled chunk 不误删新请求的占位消息
 *
 * 问题背景：后端部分终结事件（error/cancelled）不携带 streamId，handleStreamChunk 的
 * streamId 过滤无法拦截它们。当旧请求的迟到回调在新请求已经开始（activeStreamId 存在）
 * 之后到达时，旧逻辑会把新请求的占位消息误删/误改写，界面状态错乱。
 *
 * 修复：handleError/handleCancelled 删除或修改占位消息前做降级归属判定——chunk 无
 * streamId 且当前流有活跃 streamId 时，按 conversationId + 创建时间判定：
 * - chunk 无 conversationId：无法归属，只记错误不删消息；
 * - chunk.createdAt 早于目标占位消息创建时间：属于旧流迟到，不触碰消息、不复位当前流状态。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleError, handleCancelled } from '../../stores/chat/streamChunkHandlers'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref('conv_1'),
    allMessages: ref<Message[]>([]),
    messageIndexById: undefined as unknown as Ref<Map<string, number>>,
    toolResponseIndex: undefined as unknown as Ref<Map<string, number>>,
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
    sessionSnapshots: ref(new Map()),
    ...overrides
  } as unknown as ChatStoreState
}

/** 新请求刚创建的占位消息：创建时间 2000，晚于旧流的 chunk（createdAt 1000） */
function newRequestState() {
  const placeholder = {
    id: 'msg_new',
    role: 'assistant',
    content: '',
    timestamp: 2000,
    streaming: true,
    localOnly: true,
    parts: []
  } as Message
  const state = createState({
    allMessages: ref<Message[]>([placeholder]),
    streamingMessageId: ref('msg_new'),
    activeStreamId: ref('stream_new'),
    isStreaming: ref(true),
    isWaitingForResponse: ref(true)
  })
  return { state, placeholder }
}

describe('无 streamId 的迟到 error chunk（H4）', () => {
  it('createdAt 早于占位消息创建时间：不删除消息、不复位新流状态', () => {
    const { state } = newRequestState()

    handleError({
      type: 'error',
      conversationId: 'conv_1',
      createdAt: 1000,
      error: { code: 'STREAM_ERROR', message: '旧流报错' }
    } as any, state)

    // 新请求的占位消息保留
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_new'])
    // 当前流状态不被迟到 chunk 复位
    expect(state.streamingMessageId.value).toBe('msg_new')
    expect(state.activeStreamId.value).toBe('stream_new')
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
  })

  it('无 conversationId：只记错误，不删除消息', () => {
    const { state } = newRequestState()

    handleError({
      type: 'error',
      createdAt: 1000,
      error: { code: 'STREAM_ERROR', message: '无法归属的错误' }
    } as any, state)

    // 只记错误
    expect(state.error.value?.code).toBe('STREAM_ERROR')
    // 消息与流状态不被触碰
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_new'])
    expect(state.streamingMessageId.value).toBe('msg_new')
    expect(state.activeStreamId.value).toBe('stream_new')
    expect(state.isStreaming.value).toBe(true)
  })

  it('其他会话的迟到 error chunk：不触碰当前会话消息', () => {
    const { state } = newRequestState()

    handleError({
      type: 'error',
      conversationId: 'conv_other',
      createdAt: 1000,
      error: { code: 'STREAM_ERROR', message: '旧会话报错' }
    } as any, state)

    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_new'])
    expect(state.streamingMessageId.value).toBe('msg_new')
    expect(state.isStreaming.value).toBe(true)
  })

  it('属于当前流的无 streamId error chunk：保持原有删除/记录行为', () => {
    const { state } = newRequestState()

    // createdAt 晚于占位消息创建时间 → 判定为当前流的 chunk
    handleError({
      type: 'error',
      conversationId: 'conv_1',
      createdAt: 3000,
      error: { code: 'STREAM_ERROR', message: '当前流报错' }
    } as any, state)

    // 空占位被删除、状态复位（原有行为不变）
    expect(state.allMessages.value).toHaveLength(0)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.error.value?.code).toBe('STREAM_ERROR')
  })

  it('携带 streamId 的 chunk 不受 H4 守卫影响', () => {
    const { state } = newRequestState()

    // 旧流的 chunk 带 streamId 时由 handleStreamChunk 过滤，处理器内直接正常执行
    handleError({
      type: 'error',
      conversationId: 'conv_1',
      streamId: 'stream_old',
      createdAt: 1000,
      error: { code: 'STREAM_ERROR', message: '旧流报错' }
    } as any, state)

    // 守卫不拦截（isLateTerminalChunkWithoutStreamId 对带 streamId 的 chunk 返回 false）
    expect(state.allMessages.value).toHaveLength(0)
    expect(state.streamingMessageId.value).toBeNull()
  })
})

describe('无 streamId 的迟到 cancelled chunk（H4）', () => {
  it('createdAt 早于占位消息创建时间：不删除消息、不复位新流状态', () => {
    const { state } = newRequestState()

    handleCancelled({
      type: 'cancelled',
      conversationId: 'conv_1',
      createdAt: 1000
    } as any, state)

    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_new'])
    expect(state.streamingMessageId.value).toBe('msg_new')
    expect(state.activeStreamId.value).toBe('stream_new')
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
  })

  it('无 conversationId 的迟到 cancelled chunk：不触碰消息与状态', () => {
    const { state } = newRequestState()

    handleCancelled({
      type: 'cancelled',
      createdAt: 1000
    } as any, state)

    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_new'])
    expect(state.streamingMessageId.value).toBe('msg_new')
    expect(state.isStreaming.value).toBe(true)
  })

  it('属于当前流的无 streamId cancelled chunk：保持原有行为', () => {
    const { state } = newRequestState()

    handleCancelled({
      type: 'cancelled',
      conversationId: 'conv_1',
      createdAt: 3000
    } as any, state)

    // 空占位被删除、状态复位（原有行为不变）
    expect(state.allMessages.value).toHaveLength(0)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
  })

  it('当前流无活跃 streamId 时无 streamId chunk 不受守卫影响', () => {
    const placeholder = {
      id: 'msg_a',
      role: 'assistant',
      content: '',
      timestamp: 2000,
      streaming: true,
      localOnly: true,
      parts: []
    } as Message
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_a'),
      activeStreamId: ref(null),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleCancelled({
      type: 'cancelled',
      conversationId: 'conv_1',
      createdAt: 1000
    } as any, state)

    // 无活跃流时按普通路径处理（空占位删除 + 状态复位）
    expect(state.allMessages.value).toHaveLength(0)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
  })
})
