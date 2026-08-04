/**
 * streamHandler 终结事件状态复位回归测试
 *
 * 问题背景：complete/toolIteration 终结事件的整个状态清理被 `if (chunk.content)` 包裹，
 * 后端若发来 content 为 null/undefined 的终结 chunk，isStreaming/isWaitingForResponse/
 * streamingMessageId/activeStreamId 永不清理，界面永久卡在“等待响应”。
 *
 * 修复：状态复位无条件执行，仅消息内容替换依赖 chunk.content。
 */
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleStreamChunk, type StreamHandlerContext } from '../../stores/chat/streamHandler'

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
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map()),
    ...overrides
  } as unknown as ChatStoreState
}

function createCtx(state: ChatStoreState, overrides: Partial<StreamHandlerContext> = {}): StreamHandlerContext {
  return {
    state,
    currentModelName: () => 'test-model',
    addCheckpoint: vi.fn(),
    updateConversationAfterMessage: vi.fn(),
    processQueue: vi.fn(),
    ...overrides
  } as unknown as StreamHandlerContext
}

describe('streamHandler 终结事件状态复位', () => {
  it('content-less complete 无条件复位流式状态并调度 processQueue', async () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      autoSummaryStatus: ref({ isSummarizing: true, mode: 'auto', message: 'x' }),
      pendingModelOverride: ref('model-override')
    })
    const processQueue = vi.fn()
    const ctx = createCtx(state, { processQueue })

    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      ctx
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.autoSummaryStatus.value).toBeNull()
    expect(state.pendingModelOverride.value).toBeNull()

    await nextTick()
    expect(processQueue).toHaveBeenCalled()
  })

  it('content-less toolIteration 无条件复位流式状态', () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1')
    })

    handleStreamChunk(
      { type: 'toolIteration', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      createCtx(state)
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
  })

  it('携带 content 的 complete 保持原有行为（消息替换 + 状态复位）', async () => {
    const state = createState({
      allMessages: ref<Message[]>([{
        id: 'msg_1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        localOnly: true,
        parts: []
      }] as Message[]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1')
    })
    const updateConversationAfterMessage = vi.fn()
    const processQueue = vi.fn()
    const ctx = createCtx(state, { updateConversationAfterMessage, processQueue })

    handleStreamChunk(
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: 'final answer' }], timestamp: Date.now() }
      } as any,
      ctx
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.allMessages.value[0].content).toContain('final answer')
    expect(state.allMessages.value[0].streaming).toBe(false)
    expect(updateConversationAfterMessage).toHaveBeenCalled()

    await nextTick()
    expect(processQueue).toHaveBeenCalled()
  })

  it('非当前会话/迟到流的 content-less complete 不触碰当前会话状态', () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1')
    })

    // 迟到流（streamId 不匹配）
    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_1', streamId: 'stale_stream' } as any,
      createCtx(state)
    )
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)

    // 其他会话
    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_other', streamId: 'stream_1' } as any,
      createCtx(state)
    )
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
  })
})
