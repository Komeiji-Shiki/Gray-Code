/**
 * P2 后台任务回执「完成即插入」回归测试。
 *
 * 行为变更：后台子代理 / 后台命令完成时，回执不再硬等模型回合完整结束——
 * 动作边界（非终结 toolIteration）无排队消息可投时，由
 * chatStore.processQueueAfterAction 转调 backgroundTaskStore.flushReportsAfterAction，
 * cancelStream({preserveSubAgents:true}) 替换当前回合 + sendMessage 开启新回合，
 * 回执立即进入对话历史（与排队消息提前投递同构，复用 H1 写序保证）。
 *
 * 安全模型：
 * - 动作彻底结束：由动作边界（工具结果已落盘）保证；
 * - 跨会话防护：只投递属于当前会话（或无会话归属）的任务；
 * - 投递窗口（cancelStream IPC 往返）内会话切换 / 并发发送者抢先开新流：
 *   放弃本次投递，reported 保持未回流，等待下一动作边界或回合结束补发；
 * - 发送失败回滚 reported，不静默丢弃任务产出；
 * - 排队消息优先：队列非空时只投排队消息，回执等下一个边界。
 */
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore'

function startEvent(taskId: string, taskType: 'terminal' | 'background_subagent', data: Record<string, unknown>) {
  return {
    taskId,
    taskType,
    type: 'start' as const,
    data,
    createdAt: 1000
  }
}

function completeEvent(taskId: string, data: Record<string, unknown> = {}) {
  return {
    taskId,
    taskType: 'background_subagent',
    type: 'complete' as const,
    data,
    createdAt: 2000
  }
}

/** 等待 store 内部异步回流（flushReports）完成 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

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

describe('flushReportsAfterAction：动作边界回执提前投递', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) =>
      type === 'getWorkspaceUri' ? null : { success: true }
    )
  })

  it('回合仍在响应中：先以 preserveSubAgents 取消旧流，再发送回执消息', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper', runId: 'r1' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '调研完成', steps: 3, toolsUsed: ['read_file'] }))
    await settle()
    // 回合正忙：完成事件触发的 flushReports 被挂起，任务保持未回流
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)

    vi.mocked(sendToExtension).mockClear()
    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    const cancelIndex = calls.findIndex(([type]) => type === 'cancelStream')
    const streamIndex = calls.findIndex(([type]) => type === 'chatStream')

    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(streamIndex).toBeGreaterThan(cancelIndex)
    expect(calls[cancelIndex][1]).toEqual({
      conversationId: 'conv_1',
      preserveSubAgents: true
    })
    const streamPayload = calls[streamIndex][1]
    expect(streamPayload).toMatchObject({ conversationId: 'conv_1' })
    const message = JSON.stringify(streamPayload.message)
    expect(message).toContain('[Background task completed]')
    expect(message).toContain('调研完成')
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
  })

  it('无可投递任务时不发起任何 IPC', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true

    const bgStore = useBackgroundTaskStore()
    vi.mocked(sendToExtension).mockClear()
    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
  })

  it('运行中任务 / 已回流任务不重复投递', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true

    const bgStore = useBackgroundTaskStore()
    // t1：运行中；t2：已完成但已回流
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'running-agent' }))
    bgStore.handleTaskEvent(startEvent('t2', 'background_subagent', { agentName: 'done-agent' }))
    bgStore.handleTaskEvent(completeEvent('t2', { response: '已回流' }))
    bgStore.taskList.find(t => t.taskId === 't2')!.reported = true
    await settle()

    vi.mocked(sendToExtension).mockClear()
    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
  })

  it('跨会话任务被跳过，保留未回流等待归属会话', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', {
      agentName: 'other-agent',
      conversationId: 'conv_other'
    }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '别的会话的结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('投递窗口内会话切换：放弃投递，回执保持未回流', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'cancelStream') {
        // 模拟 cancelStream 往返期间用户切到了其他会话
        store.currentConversationId = 'conv_other'
        return { success: true }
      }
      return { success: true }
    })

    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('投递窗口内并发发送者抢先开启新流：放弃投递，不降级为 inbox 中断', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'cancelStream') {
        // 模拟 cancelStream 往返期间手动发送/排队消息抢先开启了一个新流
        store.isStreaming = true
        store.isWaitingForResponse = true
        store.activeStreamId = 'stream_new'
        return { success: true }
      }
      return { success: true }
    })

    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chat.sendInterruptMessage')).toBeUndefined()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('回执发送失败：回滚 reported，等待下次补发', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'chatStream') throw new Error('ipc failed')
      return { success: true }
    })

    await bgStore.flushReportsAfterAction()

    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('回执投递进行中不重入：同一边界只发送一条回执', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'a' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '第一条' }))
    bgStore.handleTaskEvent(startEvent('t2', 'background_subagent', { agentName: 'b' }))
    bgStore.handleTaskEvent(completeEvent('t2', { response: '第二条' }))
    await settle()

    let resolveChatStream: ((value: unknown) => void) | null = null
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return Promise.resolve(null)
      if (type === 'chatStream') return new Promise(resolve => { resolveChatStream = resolve })
      return Promise.resolve({ success: true })
    })

    const firstFlush = bgStore.flushReportsAfterAction()
    await bgStore.flushReportsAfterAction()
    await vi.waitFor(() => {
      expect(resolveChatStream).not.toBeNull()
    })
    resolveChatStream!({ success: true })
    await firstFlush

    const chatStreamCalls = vi.mocked(sendToExtension).mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(1)
    // 两条任务合并为一条回执
    expect(JSON.stringify(chatStreamCalls[0][1].message)).toContain('第一条')
    expect(JSON.stringify(chatStreamCalls[0][1].message)).toContain('第二条')
    expect(bgStore.taskList.every(t => t.reported)).toBe(true)
  })
})

describe('processQueueAfterAction：动作边界编排回执投递', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) =>
      type === 'getWorkspaceUri' ? null : { success: true }
    )
  })

  it('队列为空 + 有挂起回执：动作边界提前投递回执', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '后台结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    const cancelIndex = calls.findIndex(([type]) => type === 'cancelStream')
    const streamIndex = calls.findIndex(([type]) => type === 'chatStream')
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(streamIndex).toBeGreaterThan(cancelIndex)
    expect(calls[cancelIndex][1]).toEqual({ conversationId: 'conv_1', preserveSubAgents: true })
    expect(JSON.stringify(calls[streamIndex][1].message)).toContain('[Background task completed]')
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
  })

  it('队列有排队消息时排队消息优先，回执等下一个边界（保持未回流）', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '后台结果' }))
    await settle()

    store.enqueueMessage('排队的问题')
    vi.mocked(sendToExtension).mockClear()

    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    const streamIndex = calls.findIndex(([type]) => type === 'chatStream')
    expect(streamIndex).toBeGreaterThanOrEqual(0)
    // 投递的是排队消息，不是回执
    expect(JSON.stringify(calls[streamIndex][1].message)).toContain('排队的问题')
    expect(JSON.stringify(calls[streamIndex][1].message)).not.toContain('[Background task completed]')
    expect(store.messageQueue).toHaveLength(0)
    // 回执保持未回流，等待下一个动作边界或回合结束补发
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('动作边界（非终结 toolIteration）触发编排：回执在 LLM 执行完动作后立即投递', async () => {
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

  it('flushReports 先持锁（回合结束补发路径）时动作边界投递跳过，不产生重复回执', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()
    // 完成时忙：回执挂起未回流
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)

    // 回合结束（流已结束、store 空闲）：补发路径先发起（持 flushing 锁，awaitConversationIdle 挂起中）
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.activeStreamId = null
    let resolveIdle: ((value: unknown) => void) | null = null
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return Promise.resolve(null)
      if (type === 'chat.awaitConversationIdle') return new Promise(resolve => { resolveIdle = resolve })
      return Promise.resolve({ success: true })
    })
    const pendingFlush = bgStore.flushReports()
    await vi.waitFor(() => {
      expect(resolveIdle).not.toBeNull()
    })

    // 动作边界投递被 flushing 拦截：不发 IPC、不标记
    await bgStore.flushReportsAfterAction()
    expect(vi.mocked(sendToExtension).mock.calls.filter(([type]) => type === 'cancelStream')).toHaveLength(0)
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)

    // 放行回合结束补发：只有一条回执
    resolveIdle!({ success: true })
    await pendingFlush
    const chatStreamCalls = vi.mocked(sendToExtension).mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(1)
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
  })

  it('sendMessage 返回 false（会话校验未过）：回滚 reported，等待下次补发', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'chatStream') {
        // sendMessage 的 chatStream IPC 返回后做会话身份校验：
        // 模拟 await 期间会话切换，触发 sendMessage 返回 false（非异常路径）
        store.currentConversationId = 'conv_other'
        return { success: true }
      }
      return { success: true }
    })

    await bgStore.flushReportsAfterAction()

    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('迟到调度（已非等待响应）：直接投递回执，不再 cancelStream', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()
    // 任务完成时忙 → 回执挂起；流结束后才轮到迟到的动作边界调度（isStreaming 已清理）
    store.isStreaming = false
    store.isWaitingForResponse = false
    store.activeStreamId = null

    vi.mocked(sendToExtension).mockClear()
    await bgStore.flushReportsAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'cancelStream')).toBeUndefined()
    expect(calls.find(([type]) => type === 'chatStream')).toBeDefined()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
  })

  it('编排路径（processQueueAfterAction）投递窗口内会话切换：回执保持未回流', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'cancelStream') {
        store.currentConversationId = 'conv_other'
        return { success: true }
      }
      return { success: true }
    })

    await store.processQueueAfterAction()

    const calls = vi.mocked(sendToExtension).mock.calls
    expect(calls.find(([type]) => type === 'chatStream')).toBeUndefined()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)
  })

  it('回执发送失败回滚后，下一动作边界重试投递成功（恢复链）', async () => {
    const store = useChatStore()
    store.currentConversationId = 'conv_1'
    store.isStreaming = true
    store.isWaitingForResponse = true
    store.activeStreamId = 'stream_1'

    const bgStore = useBackgroundTaskStore()
    bgStore.handleTaskEvent(startEvent('t1', 'background_subagent', { agentName: 'helper' }))
    bgStore.handleTaskEvent(completeEvent('t1', { response: '结果' }))
    await settle()

    let shouldFail = true
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockImplementation(async (type: string) => {
      if (type === 'getWorkspaceUri') return null
      if (type === 'chatStream') {
        if (shouldFail) {
          shouldFail = false
          throw new Error('ipc failed')
        }
        return { success: true }
      }
      return { success: true }
    })

    // 第一次投递失败：回滚
    await bgStore.flushReportsAfterAction()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(false)

    // 下一动作边界重试：投递成功（第一次失败的 chatStream 调用 + 第二次成功的调用）
    await bgStore.flushReportsAfterAction()
    expect(bgStore.taskList.find(t => t.taskId === 't1')?.reported).toBe(true)
    const chatStreamCalls = vi.mocked(sendToExtension).mock.calls.filter(([type]) => type === 'chatStream')
    expect(chatStreamCalls).toHaveLength(2)
  })
})
