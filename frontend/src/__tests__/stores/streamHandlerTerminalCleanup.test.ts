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
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleStreamChunk, type StreamHandlerContext } from '../../stores/chat/streamHandler'
import { handleToolsExecuting, handleChunkType } from '../../stores/chat/streamChunkHandlers'
import {
  disposeAllSmoothStreams,
  hasSmoothStream,
  pushSmoothText
} from '../../stores/chat/smoothStreamManager'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

import { sendToExtension } from '../../utils/vscode'

afterEach(() => {
  disposeAllSmoothStreams()
})

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

function createCtx(state: ChatStoreState, overrides: Partial<StreamHandlerContext> = {}): StreamHandlerContext {
  return {
    state,
    currentModelName: () => 'test-model',
    addCheckpoint: vi.fn(),
    updateConversationAfterMessage: vi.fn(),
    processQueue: vi.fn(),
    processQueueAfterAction: vi.fn(),
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
      pendingModelOverride: ref('model-override'),
      pendingConfigIdOverride: ref('oneoff-config')
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
    // 一次性渠道覆盖随回合终结一并清除，避免泄漏到后续请求
    expect(state.pendingConfigIdOverride.value).toBeNull()

    await nextTick()
    expect(processQueue).toHaveBeenCalled()
  })

  it('content-less toolIteration 无条件复位流式状态并调度 processQueue', async () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1')
    })

    const processQueue = vi.fn()
    handleStreamChunk(
      { type: 'toolIteration', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      createCtx(state, { processQueue })
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()

    await nextTick()
    expect(processQueue).toHaveBeenCalledOnce()
  })

  it('content-less cancelled 无条件复位流式状态并清除回合覆盖', async () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      pendingModelOverride: ref('model-override'),
      pendingConfigIdOverride: ref('oneoff-config')
    })

    handleStreamChunk(
      { type: 'cancelled', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      createCtx(state)
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.pendingModelOverride.value).toBeNull()
    expect(state.pendingConfigIdOverride.value).toBeNull()
  })

  it('content-less error 复位流式状态并清除回合覆盖', async () => {
    const state = createState({
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      pendingModelOverride: ref('model-override'),
      pendingConfigIdOverride: ref('oneoff-config')
    })

    handleStreamChunk(
      {
        type: 'error',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        error: { code: 'API_ERROR', message: 'boom' }
      } as any,
      createCtx(state)
    )

    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.pendingModelOverride.value).toBeNull()
    expect(state.pendingConfigIdOverride.value).toBeNull()
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

  it('toolsExecuting finishes the model text CharFlow and clears migrated smooth state', () => {
    const smoothTexts = new Map<string, { partKey: string; text: string }>()
    const state = createState({
      allMessages: ref<Message[]>([{
        id: 'placeholder-message',
        role: 'assistant',
        content: 'partial answer',
        timestamp: Date.now(),
        streaming: true,
        localOnly: true,
        parts: [{ text: 'partial answer' }]
      }] as Message[]),
      streamingMessageId: ref('placeholder-message'),
      isStreaming: ref(true),
      smoothMode: ref('balanced'),
      smoothTexts: smoothTexts as ChatStoreState['smoothTexts']
    })

    pushSmoothText(
      'placeholder-message',
      'text:0',
      ' answer',
      'balanced',
      'partial',
      (messageId, partKey, text) => smoothTexts.set(messageId, { partKey, text })
    )
    expect(hasSmoothStream('placeholder-message')).toBe(true)

    handleToolsExecuting({
      type: 'toolsExecuting',
      content: {
        id: 'persisted-message',
        role: 'model',
        timestamp: Date.now(),
        parts: [
          { text: 'partial answer' },
          { functionCall: { id: 'tool-1', name: 'search', args: {} } }
        ]
      },
      pendingToolCalls: [{ id: 'tool-1' }]
    } as any, state)

    expect(hasSmoothStream('placeholder-message')).toBe(false)
    expect(hasSmoothStream('persisted-message')).toBe(false)
    expect(smoothTexts.size).toBe(0)
    expect(state.allMessages.value[0].id).toBe('persisted-message')
    expect(state.allMessages.value[0].streaming).toBe(false)
    expect(state.isStreaming.value).toBe(true)
  })

  it('contentSnapshot terminates the stale CharFlow baseline before applying authority', () => {
    const smoothTexts = new Map<string, { partKey: string; text: string }>()
    const state = createState({
      allMessages: ref<Message[]>([{
        id: 'snapshot-message',
        role: 'assistant',
        content: 'local text',
        timestamp: Date.now(),
        streaming: true,
        parts: [{ text: 'local text' }]
      }] as Message[]),
      streamingMessageId: ref('snapshot-message'),
      smoothMode: ref('balanced'),
      smoothTexts: smoothTexts as ChatStoreState['smoothTexts']
    })

    pushSmoothText(
      'snapshot-message',
      'text:0',
      ' text',
      'balanced',
      'local',
      (messageId, partKey, text) => smoothTexts.set(messageId, { partKey, text })
    )

    handleChunkType({
      type: 'chunk',
      chunk: {
        contentSnapshot: {
          role: 'model',
          parts: [{ text: 'authoritative text' }]
        }
      }
    } as any, state)

    expect(hasSmoothStream('snapshot-message')).toBe(false)
    expect(smoothTexts.size).toBe(0)
    expect(state.allMessages.value[0].content).toBe('authoritative text')
    expect(state.allMessages.value[0].parts).toEqual([{ text: 'authoritative text' }])
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

describe('streamHandler reroll 终结后刷新分支图（TREE-01 前端接入）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  })

  it('complete 终结 chunk：消费 _pendingBranchRefreshAfterStream 并拉取分支图', async () => {
    const state = createState({
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      _pendingBranchReplayContext: ref({
        kind: 'reroll',
        conversationId: 'conv_1',
        assistantNodeId: 'msg_old',
        configId: 'cfg_1'
      }),
      activeStreamId: ref('stream_1')
    })
    const ctx = createCtx(state)

    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_1', streamId: 'stream_1', content: undefined } as any,
      ctx
    )
    await nextTick()

    // 刷新分支图（BranchSwitcherBar 数据源），标记复位
    const graphCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')
    expect(graphCall).toBeDefined()
    expect(graphCall![1]).toMatchObject({ conversationId: 'conv_1' })
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(state._pendingBranchReplayContext.value).toBeNull()
  })

  it('REROLL_ERROR 终结 chunk：把重放上下文写入错误对象后清理暂存状态', async () => {
    const replayContext = {
      kind: 'reroll' as const,
      conversationId: 'conv_1',
      assistantNodeId: 'msg_old',
      configId: 'cfg_1'
    }
    const state = createState({
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      _pendingBranchReplayContext: ref(replayContext),
      activeStreamId: ref('stream_1')
    })
    const ctx = createCtx(state)

    handleStreamChunk(
      {
        type: 'error',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        error: { code: 'REROLL_ERROR', message: 'boom', type: 'API_ERROR' }
      } as any,
      ctx
    )
    await nextTick()

    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(state._pendingBranchReplayContext.value).toBeNull()
    expect(state.error.value?.branchReplayContext).toEqual(replayContext)
  })

  it('cancelled 终结 chunk 消费标记（取消后新候选已建，刷新以便切回）', async () => {
    const state = createState({
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      activeStreamId: ref('stream_1')
    })
    const ctx = createCtx(state)

    handleStreamChunk(
      { type: 'cancelled', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      ctx
    )
    await nextTick()

    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
  })

  it('未置位标记时终结 chunk 不拉取分支图（普通流不受影响）', async () => {
    const state = createState({ activeStreamId: ref('stream_1') })
    const ctx = createCtx(state)

    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_1', streamId: 'stream_1', content: undefined } as any,
      ctx
    )
    await nextTick()

    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeUndefined()
  })

  it('标记属于其他会话时不被当前会话的终结 chunk 消费（避免误刷其他会话分支图）', async () => {
    const state = createState({
      currentConversationId: ref('conv_2'),
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      activeStreamId: ref('stream_1')
    })
    const ctx = createCtx(state)

    // conv_2 的当前流正常终结：不应消费 conv_1 的 reroll 标记，也不应拉取分支图
    handleStreamChunk(
      { type: 'complete', conversationId: 'conv_2', streamId: 'stream_1', content: undefined } as any,
      ctx
    )
    await nextTick()

    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeUndefined()
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
  })

  it('toolIteration 带内容且流终结（需用户确认门闸）时消费标记', async () => {
    const state = createState({
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      activeStreamId: ref('stream_1'),
      streamingMessageId: ref('msg_1'),
      allMessages: ref<Message[]>([{
        id: 'msg_1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        localOnly: true,
        parts: []
      }] as Message[])
    })
    const ctx = createCtx(state)

    // 工具执行结果要求用户确认：handleToolIteration 终结路径把 activeStreamId 置空，
    // 后端不再发 complete——此时应消费分支图刷新标记（候选已创建，可切回查看）
    handleStreamChunk(
      {
        type: 'toolIteration',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: '请确认下一步' }], timestamp: Date.now() },
        toolResults: [{ id: 't1', name: 'create_plan', result: { requiresUserConfirmation: true } }]
      } as any,
      ctx
    )
    await nextTick()

    expect(state.activeStreamId.value).toBeNull()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
  })

  it('toolIteration 带内容但流继续（非终结）时提前刷新分支图但不消费标记', async () => {
    const state = createState({
      _pendingBranchRefreshAfterStream: ref('conv_1'),
      activeStreamId: ref('stream_1'),
      streamingMessageId: ref('msg_1'),
      allMessages: ref<Message[]>([{
        id: 'msg_1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        localOnly: true,
        parts: []
      }] as Message[])
    })
    const ctx = createCtx(state)

    // 工具结果无确认/取消要求：handleToolIteration 走继续路径（activeStreamId 保持）。
    // 此输出属于分支流（候选已落盘）：提前刷新分支图让切换器立即显示，
    // 但标记保留——后续 complete 终结时才消费并再次刷新（更新模型候选内容）。
    handleStreamChunk(
      {
        type: 'toolIteration',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: '继续' }], timestamp: Date.now() },
        toolResults: [{ id: 't1', name: 'read_file', result: { ok: true } }]
      } as any,
      ctx
    )
    await nextTick()

    expect(state.activeStreamId.value).toBe('stream_1')
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
  })
})
