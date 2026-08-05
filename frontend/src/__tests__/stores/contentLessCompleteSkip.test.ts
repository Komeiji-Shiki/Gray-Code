/**
 * H3 回归测试：content-less 终结 chunk 不触发 batch 跳过优化
 *
 * 问题背景：handleStreamChunkBatch 的 TERMINAL_TYPES 查找只判断 chunk 类型，
 * 后端可能发来 content 为 null/undefined 的终结 chunk（complete/toolIteration 等，
 * 见 resetTerminalStreamState 注释），此时其前序的增量 'chunk' 会被整体跳过——
 * 而终结 chunk 本身又不携带替代内容，消息内容无处落地，整段回答渲染为空白。
 *
 * 修复：终结 chunk 必须“携带 content”才触发“跳过前序增量”优化；
 * content-less 终结 chunk 不跳过，增量正常解析，终结事件只做状态复位。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleStreamChunkBatch, type StreamHandlerContext } from '../../stores/chat/streamHandler'

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
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map()),
    branchGraph: ref(null),
    branchGraphLoading: ref(false),
    isSwitchingBranch: ref(false),
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

function createStreamingPlaceholder(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 1000,
    streaming: true,
    localOnly: true,
    parts: []
  } as Message
}

describe('content-less complete 不跳过前序增量（H3）', () => {
  it('content-less complete + 前序文本增量：增量保留，消息不空白', () => {
    const placeholder = createStreamingPlaceholder('msg_1')
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleStreamChunkBatch([
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: { delta: [{ text: '这是完整回答' }], done: false }
      } as any,
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: undefined
      } as any
    ], createCtx(state))

    // 增量未被跳过：消息内容完整（content-less 终结 chunk 不替换消息，
    // 消息 streaming 标记保持原样，仅全局流式状态复位）
    expect(state.allMessages.value[0].content).toContain('这是完整回答')
    // 终结 chunk 仅复位状态
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
  })

  it('content-less complete + 前序 functionCall 增量：工具调用保留', () => {
    const placeholder = createStreamingPlaceholder('msg_1')
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleStreamChunkBatch([
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: {
          delta: [{ functionCall: { id: 'tool_1', name: 'read_file', args: {} } }],
          done: true
        }
      } as any,
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: undefined
      } as any
    ], createCtx(state))

    // 工具增量未被跳过
    expect(state.allMessages.value[0].tools).toBeDefined()
    expect(state.allMessages.value[0].tools?.[0]).toMatchObject({ id: 'tool_1', name: 'read_file' })
    expect(state.allMessages.value[0].parts?.some(p => p.functionCall)).toBe(true)
  })

  it('content-less toolIteration 同样不跳过前序增量', () => {
    const placeholder = createStreamingPlaceholder('msg_1')
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleStreamChunkBatch([
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: { delta: [{ text: '工具循环中的输出' }], done: false }
      } as any,
      {
        type: 'toolIteration',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: undefined
      } as any
    ], createCtx(state))

    expect(state.allMessages.value[0].content).toContain('工具循环中的输出')
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
  })

  it('携带 content 的 complete 仍跳过前序增量（原优化语义保持）', () => {
    const placeholder = createStreamingPlaceholder('msg_1')
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleStreamChunkBatch([
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: { delta: [{ text: '即将被覆盖的增量' }], done: false }
      } as any,
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: '后端权威最终内容' }], timestamp: 2000 }
      } as any
    ], createCtx(state))

    // 前序增量被跳过，内容来自携带 content 的 complete
    expect(state.allMessages.value[0].content).toContain('后端权威最终内容')
    expect(state.allMessages.value[0].content).not.toContain('即将被覆盖的增量')
    expect(state.allMessages.value[0].streaming).toBe(false)
  })

  it('content-less complete 位于批尾且前序存在多条增量时全部保留', () => {
    const placeholder = createStreamingPlaceholder('msg_1')
    const state = createState({
      allMessages: ref<Message[]>([placeholder]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    handleStreamChunkBatch([
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: { delta: [{ text: '第一段' }], done: false }
      } as any,
      {
        type: 'chunk',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        chunk: { delta: [{ text: '第二段' }], done: false }
      } as any,
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: undefined
      } as any
    ], createCtx(state))

    expect(state.allMessages.value[0].content).toContain('第一段')
    expect(state.allMessages.value[0].content).toContain('第二段')
    expect(state.isStreaming.value).toBe(false)
  })
})
