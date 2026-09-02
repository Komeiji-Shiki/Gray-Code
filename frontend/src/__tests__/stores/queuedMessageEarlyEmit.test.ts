/**
 * P1 排队消息提前投递回归测试。
 *
 * 行为变更：排队消息不再等待整个 LLM 回合完整结束才发出，而是在 LLM 执行完
 * 当前动作（后端发出非终结 toolIteration，即工具结果已全部落盘）后立即投递。
 *
 * 安全模型（防止插入消息前的历史消息丢失）：
 * - 触发边界 = 非终结 toolIteration：后端在 yield 之前已完成工具结果
 *   settleFunctionResponses/addContent 落盘，动作已彻底结束；
 * - 投递方式 = 与 sendQueuedMessageNow 同构：cancelStream({preserveSubAgents:true})
 *   替换当前回合 + sendMessage 开启新回合，后端 H1 写序保证旧流完全退出后才
 *   写入新用户消息，插入点之前的完整历史不丢序；
 * - 终结性 toolIteration（审批门闸/工具取消）与 content-less 终结 chunk 不触发，
 *   排队消息仍走原「回合结束」投递路径。
 */
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { beforeEach, describe, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '../../types'
import type { ChatStoreState, CheckpointRecord } from '../../stores/chat/types'
import { handleStreamChunk, type StreamHandlerContext } from '../../stores/chat/streamHandler'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn(async (type: string) => (
    type === 'getWorkspaceUri' ? null : { success: true }
  )),
  onMessageFromExtension: vi.fn(() => () => {})
}))

import { sendToExtension } from '../../utils/vscode'
import { useChatStore } from '../../stores/chatStore'

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

/** 构造“流继续”的工具迭代 chunk：工具结果无确认/取消要求 */
function buildContinuingToolIteration(streamId = 'stream_1', conversationId = 'conv_1'): any {
  return {
    type: 'toolIteration',
    conversationId,
    streamId,
    content: { role: 'model', parts: [{ text: '已执行' }], timestamp: Date.now() },
    toolResults: [{ id: 't1', name: 'read_file', result: { ok: true } }]
  }
}

describe('streamHandler：toolIteration 动作边界触发排队消息提前投递', () => {
  test('非终结 toolIteration（流继续）后调度 processQueueAfterAction', async () => {
    const state = createState({
      allMessages: ref<Message[]>([createStreamingPlaceholder('msg_1')]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const processQueueAfterAction = vi.fn()
    const ctx = createCtx(state, { processQueueAfterAction })

    handleStreamChunk(buildContinuingToolIteration(), ctx)
    await nextTick()

    expect(state.activeStreamId.value).toBe('stream_1')
    expect(processQueueAfterAction).toHaveBeenCalledTimes(1)
  })

  test('终结性 toolIteration（需用户确认门闸）不触发提前投递', async () => {
    const state = createState({
      allMessages: ref<Message[]>([createStreamingPlaceholder('msg_1')]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const processQueueAfterAction = vi.fn()
    const ctx = createCtx(state, { processQueueAfterAction })

    handleStreamChunk(
      {
        type: 'toolIteration',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: '请确认' }], timestamp: Date.now() },
        toolResults: [{ id: 't1', name: 'create_plan', result: { requiresUserConfirmation: true } }]
      } as any,
      ctx
    )
    await nextTick()

    expect(state.activeStreamId.value).toBeNull()
    expect(processQueueAfterAction).not.toHaveBeenCalled()
  })

  test('content-less 终结 toolIteration 调度普通队列而不触发提前投递', async () => {
    const state = createState({
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const processQueue = vi.fn()
    const processQueueAfterAction = vi.fn()
    const ctx = createCtx(state, { processQueue, processQueueAfterAction })

    handleStreamChunk(
      { type: 'toolIteration', conversationId: 'conv_1', streamId: 'stream_1' } as any,
      ctx
    )
    await nextTick()

    expect(state.activeStreamId.value).toBeNull()
    expect(processQueue).toHaveBeenCalledOnce()
    expect(processQueueAfterAction).not.toHaveBeenCalled()
  })

  test('complete 仍只调度 processQueue（回合结束投递路径不受影响）', async () => {
    const state = createState({
      allMessages: ref<Message[]>([createStreamingPlaceholder('msg_1')]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const processQueue = vi.fn()
    const processQueueAfterAction = vi.fn()
    const ctx = createCtx(state, { processQueue, processQueueAfterAction })

    handleStreamChunk(
      {
        type: 'complete',
        conversationId: 'conv_1',
        streamId: 'stream_1',
        content: { role: 'model', parts: [{ text: '完成' }], timestamp: Date.now() }
      } as any,
      ctx
    )
    await nextTick()

    expect(processQueue).toHaveBeenCalledTimes(1)
    expect(processQueueAfterAction).not.toHaveBeenCalled()
  })

  test('非当前会话 / 迟到流的 toolIteration 不触发提前投递', async () => {
    const state = createState({
      allMessages: ref<Message[]>([createStreamingPlaceholder('msg_1')]),
      streamingMessageId: ref('msg_1'),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const processQueueAfterAction = vi.fn()
    const ctx = createCtx(state, { processQueueAfterAction })

    handleStreamChunk(buildContinuingToolIteration('stale_stream'), ctx)
    handleStreamChunk(buildContinuingToolIteration('stream_1', 'conv_other'), ctx)
    await nextTick()

    expect(processQueueAfterAction).not.toHaveBeenCalled()
  })
})

describe('processQueueAfterAction：动作边界自动投递排队消息', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) =>
      type === 'getWorkspaceUri' ? null : { success: true }
    )
  })

  test('当前回合仍在响应中：先以 preserveSubAgents 取消旧流，再发送排队消息', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    store.enqueueMessage('排队的问题')
    vi.mocked(sendToExtension).mockClear()

    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    const cancelIndex = calls.findIndex(([type]) => type === 'cancelStream')
    const streamIndex = calls.findIndex(([type]) => type === 'chatStream')

    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(streamIndex).toBeGreaterThan(cancelIndex)
    expect(calls[cancelIndex][1]).toEqual({
      conversationId: 'conv_1',
      preserveSubAgents: true
    })
    expect(calls[streamIndex][1]).toMatchObject({
      conversationId: 'conv_1',
      message: '排队的问题'
    })
    expect(store.messageQueue).toHaveLength(0)
  })

  test('队列为空时不发起任何 IPC', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true

    vi.mocked(sendToExtension).mockClear()
    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
  })

  test('跨会话排队消息被跳过，保留在队列中等待归属会话', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true

    store.enqueueMessage('其他会话的消息', [], undefined)
    const queued = store.messageQueue[0]
    // 模拟归属其他会话的排队消息（enqueue 默认归属当前会话，这里手工改归属）
    store.messageQueue[0] = { ...queued, conversationId: 'conv_other' }

    vi.mocked(sendToExtension).mockClear()
    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(store.messageQueue).toHaveLength(1)
    expect(store.messageQueue[0].conversationId).toBe('conv_other')
  })

  test('投递窗口内会话切换：放弃投递并放回队列，不发到错误会话', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    store.enqueueMessage('本会话的消息')
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'cancelStream') {
        // 模拟 cancelStream 往返期间用户切到了其他会话
        store.currentConversationId = 'conv_other'
        return {
          cancelled: true,
          foregroundWorkTransition: { terminalCommands: 0, subAgentTasks: 1 }
        }
      }
      return { success: true }
    })

    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(store.messageQueue).toHaveLength(1)
    expect(store.messageQueue[0].content).toBe('本会话的消息')
    expect(store.messageQueue[0].conversationId).toBe('conv_1')
    expect(store.messageQueue[0].sendOptions?.foregroundWorkTransition)
      .toEqual({ terminalCommands: 0, subAgentTasks: 1 })
  })

  test('投递窗口内并发发送者抢先开启新流：放回队列，不降级为 inbox 中断', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    store.enqueueMessage('排队中的消息')
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'cancelStream') {
        // 模拟 cancelStream 往返期间后台回执/手动发送抢先开启了一个新流
        store.isStreaming = true
        store.isWaitingForResponse = true
        store.activeStreamId = 'stream_new'
        return { success: true }
      }
      return { success: true }
    })

    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    // 排队消息没有走 chatStream 成为新回合，也没有降级为 chat.sendInterruptMessage
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chat.sendInterruptMessage')).toBeUndefined()
    expect(store.messageQueue).toHaveLength(1)
    expect(store.messageQueue[0].content).toBe('排队中的消息')
  })

  test('发送失败时把消息放回队首，不静默丢失', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    store.enqueueMessage('会失败的消息')
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'chatStream') throw new Error('ipc failed')
      return { success: true }
    })

    await store.processQueueAfterAction()

    expect(store.messageQueue).toHaveLength(1)
    expect(store.messageQueue[0].content).toBe('会失败的消息')
  })

  test('投递进行中不重入：同一动作边界只发送一条排队消息', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    store.enqueueMessage('第一条')
    store.enqueueMessage('第二条')

    let resolveChatStream: ((value: unknown) => void) | null = null
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return Promise.resolve(null)
      if (type === 'chatStream') return new Promise(resolve => { resolveChatStream = resolve })
      return Promise.resolve({ success: true })
    })

    const firstDrain = store.processQueueAfterAction()
    // 第一条仍在投递中（chatStream 未返回）：第二次调用必须被重入保护拦截
    await store.processQueueAfterAction()
    // 等第一条真正挂起在 chatStream IPC 上（cancelStream/getWorkspaceUri 等微任务推进后）
    await vi.waitFor(() => {
      expect(resolveChatStream).not.toBeNull()
    })
    resolveChatStream!({ success: true })
    await firstDrain

    const chatStreamCalls = vi.mocked(sendToExtension).mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(1)
    expect(store.messageQueue).toHaveLength(1)
    expect(store.messageQueue[0].content).toBe('第二条')
  })
})
