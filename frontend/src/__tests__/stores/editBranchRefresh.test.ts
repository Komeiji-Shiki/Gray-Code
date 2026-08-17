/**
 * 编辑分支流结束后刷新分支图回归测试（主人实测：点「保存」后 BranchSwitcherBar 不显示，
 * 切换对话再切回才显示——怀疑 complete 终结事件未消费 _pendingBranchRefreshAfterStream）。
 *
 * 覆盖链路（TREE-03 前端接入）：
 * editAndRetry('branch') → 置位 _pendingBranchRefreshAfterStream → 流式 chunk 到达
 * → complete 终结事件 → finishBranchStreamTracking → maybeRefreshBranchAfterStream
 * → loadBranchGraph → state.branchGraph 更新 → BranchSwitcherBar 显示候选切换器。
 */
import { ref } from 'vue'
import { vi, describe, expect, beforeEach } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, ChatStoreComputed, CheckpointRecord, BranchGraphData, BranchNodeData } from '../../stores/chat/types'
import { handleStreamChunk } from '../../stores/chat/streamHandler'
import { editAndRetry } from '../../stores/chat/messageActions'
import { buildCandidateGroupForNode } from '../../stores/chat/branchActions'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

vi.mock('../../stores/chat/conversationActions', async () => {
  const actual = await vi.importActual<typeof import('../../stores/chat/conversationActions')>('../../stores/chat/conversationActions')
  return {
    ...actual,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadCheckpoints: vi.fn().mockResolvedValue(undefined)
  }
})

import { sendToExtension } from '../../utils/vscode'

function createMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg_' + Math.random().toString(36).slice(2, 8),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides
  } as Message
}

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref('conv_1'),
    allMessages: ref([]),
    messageIndexById: undefined as unknown as ReturnType<typeof ref<Map<string, number>>>,
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
    branchGraph: ref<BranchGraphData | null>(null),
    branchGraphLoading: ref(false),
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

function createComputed(): ChatStoreComputed {
  return {
    currentModelName: ref('test-model')
  } as unknown as ChatStoreComputed
}

/** 编辑后后端分支图：P(u0) → [旧 user u1(候选1), 新 user u2(候选2, 活跃)] → 模型候选 m2 */
function makeEditedGraph(): BranchGraphData {
  const u0: BranchNodeData = {
    id: 'msg_u0', parentId: null, role: 'user', kind: 'normal',
    parts: [{ text: '问题' }], createdAt: 1, activeChildId: 'msg_u2'
  }
  const u1: BranchNodeData = {
    id: 'msg_u1', parentId: 'msg_u0', role: 'user', kind: 'normal',
    parts: [{ text: '追问' }], createdAt: 2
  }
  const u2: BranchNodeData = {
    id: 'msg_u2', parentId: 'msg_u0', role: 'user', kind: 'edit',
    parts: [{ text: '新回答' }], createdAt: 3
  }
  const m2: BranchNodeData = {
    id: 'msg_m2', parentId: 'msg_u2', role: 'model', kind: 'reroll',
    parts: [{ text: '模型新回答' }], createdAt: 4
  }
  return {
    version: 1,
    rootNodeId: 'msg_u0',
    activeTailNodeId: 'msg_m2',
    nodes: { msg_u0: u0, msg_u1: u1, msg_u2: u2, msg_m2: m2 },
    candidateSummaries: []
  }
}

describe('编辑分支流结束 → 分支图刷新链路（主人实测回归）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  })

  test('complete 终结 chunk 消费刷新标记并拉取分支图（branchGraph 更新）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    // getBranchGraph 返回编辑后的分支图（含新 edit 候选 + 模型候选）
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')

    // 发起后：标记置位 + 流式占位 + activeStreamId
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
    const streamId = state.activeStreamId.value
    expect(streamId).toBeTruthy()
    const placeholderId = state.streamingMessageId.value
    expect(placeholderId).toBeTruthy()

    // 后端返回 complete（带 content，模拟工具循环最终输出）
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'complete',
      content: {
        id: 'msg_m2',
        role: 'model',
        timestamp: Date.now(),
        parts: [{ text: '模型新回答' }]
      }
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    // 标记已消费 → loadBranchGraph 被调用 → branchGraph 更新为新图
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    const graphCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')
    expect(graphCall).toBeDefined()
    expect(graphCall![1]).toEqual({ conversationId: 'conv_1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(state.branchGraph.value?.nodes['msg_u2']).toBeDefined()
    expect(state.branchGraph.value?.nodes['msg_u2']?.kind).toBe('edit')
  })

  test('cancelled 终结 chunk 同样消费刷新标记', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')

    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'cancelled',
      content: undefined
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
  })

  test('工具迭代终结（审批门闸）消费刷新标记', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')

    // 工具迭代带审批门闸结果（hasApprovalStop）：handleToolIteration 内部置空 activeStreamId，
    // streamHandler 检测到终结后消费刷新标记
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'toolIteration',
      content: {
        id: 'msg_m2',
        role: 'model',
        timestamp: Date.now(),
        parts: [{ text: '模型回答', functionCall: [{ id: 'tool_1', name: 'write_file', args: {} }] }]
      },
      toolResults: [{
        id: 'tool_1',
        name: 'write_file',
        result: { requiresUserConfirmation: true }
      }]
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    expect(state.activeStreamId.value).toBeNull()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')).toBeDefined()
  })

  test('awaitingConfirmation 终结（工具待确认）同样消费刷新标记（主人实测回归）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')

    // 编辑分支流停在工具确认：awaitingConfirmation 终结（activeStreamId 被置空）
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'awaitingConfirmation',
      content: {
        id: 'msg_m2',
        role: 'model',
        timestamp: Date.now(),
        parts: [{ text: '模型回答', functionCall: [{ id: 'tool_1', name: 'write_file', args: {} }] }]
      },
      pendingToolCalls: [{ id: 'tool_1', name: 'write_file', args: {} }],
      toolResults: []
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    // 流终结：activeStreamId 已清空；刷新标记必须被消费并拉取分支图
    expect(state.activeStreamId.value).toBeNull()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    const graphCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getBranchGraph')
    expect(graphCall).toBeDefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(state.branchGraph.value?.nodes['msg_u2']?.kind).toBe('edit')
  })

  test('complete 后窗口被编辑的用户消息 id 对齐图活跃候选（BranchSwitcherBar 立即显示回归）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    // getBranchGraph 返回编辑后的分支图（含新 edit 候选 + 模型候选）
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value

    // 后端返回 complete（带 content）：占位消息被替换为持久化 id msg_m2
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'complete',
      content: {
        id: 'msg_m2',
        role: 'model',
        timestamp: Date.now(),
        parts: [{ text: '模型新回答' }]
      }
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    await Promise.resolve()
    await Promise.resolve()

    // 图已刷新
    expect(state.branchGraph.value?.nodes['msg_u2']?.kind).toBe('edit')

    // 窗口中被编辑的用户消息 id 对齐为图活跃候选 msg_u2（BR-01：窗口 id 与后端主历史一致）
    const editedMessage = state.allMessages.value.find(m => m.content === '新回答')
    expect(editedMessage).toBeDefined()
    expect(editedMessage!.id).toBe('msg_u2')

    // BranchSwitcherBar 挂载条件成立：该消息是候选组 {u1, u2} 的活跃成员
    const group = buildCandidateGroupForNode(state.branchGraph.value, editedMessage!.id)
    expect(group).not.toBeNull()
    expect(group!.candidates.map(c => c.id)).toEqual(['msg_u1', 'msg_u2'])
    expect(group!.activeIndex).toBe(1)

    // 旧候选 id 不再命中（对齐前 buildCandidateGroupForNode(msg_u1) 返回 null 是 bug 根源）
    expect(buildCandidateGroupForNode(state.branchGraph.value, 'msg_u1')).toBeNull()
  })

  test('分支流第一个输出到达即提前刷新分支图（标记不消费），终结时再刷新一次（主人实测回归）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(0)

    // 第一个输出：checkpoints（后端在 generate 前 yield；候选 editCandidate 在工具循环前已落盘）
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'checkpoints',
      checkpoints: []
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    // 提前刷新已发生（切换器立即显示），但终结标记保留——终结时还需再刷新更新模型候选内容/摘要
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(1)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')

    // complete 终结：消费标记 + 再刷新一次（模型候选内容已由 finishReroll 回填）
    handleStreamChunk({
      conversationId: 'conv_1',
      streamId,
      type: 'complete',
      content: {
        id: 'msg_m2',
        role: 'model',
        timestamp: Date.now(),
        parts: [{ text: '模型新回答' }]
      }
    } as any, {
      state,
      currentModelName: () => 'test-model',
      addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(),
      processQueue: vi.fn(),
      processQueueAfterAction: vi.fn()
    })

    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(state.branchGraph.value?.nodes['msg_u2']?.kind).toBe('edit')
  })

  test('终结后同一会话再次编辑：新流仍能触发提前刷新（streamId 隔离 + 重置）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    // 第一次编辑：早期刷新 + 终结消费
    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId1 = state.activeStreamId.value
    handleStreamChunk({ conversationId: 'conv_1', streamId: streamId1, type: 'checkpoints', checkpoints: [] } as any, {
      state, currentModelName: () => 'test-model', addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn()
    })
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(1)
    handleStreamChunk({ conversationId: 'conv_1', streamId: streamId1, type: 'complete', content: {
      id: 'msg_m2', role: 'model', timestamp: Date.now(), parts: [{ text: '模型新回答' }]
    } } as any, {
      state, currentModelName: () => 'test-model', addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn()
    })
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()

    // 第二次编辑（窗口已含新候选消息）：新流的第一个输出必须再次提前刷新
    const edited = createMessage({ id: 'msg_u2', role: 'user', content: '新回答', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    state.allMessages.value = [user, edited]
    await editAndRetry(state, createComputed(), 1, '再改一次', undefined, async () => {}, 'branch')
    const streamId2 = state.activeStreamId.value
    expect(streamId2).not.toBe(streamId1)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')

    handleStreamChunk({ conversationId: 'conv_1', streamId: streamId2, type: 'checkpoints', checkpoints: [] } as any, {
      state, currentModelName: () => 'test-model', addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn()
    })

    // 第二次提前刷新已触发：第一次编辑（早期 1 + 终结 2）+ 第二次编辑（早期 3）
    // 未被第一次的 streamId 记录挡住（终结时已重置）
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(3)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
  })

  test('当前会话与标记会话不一致时不提前刷新（会话隔离）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: makeEditedGraph() })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'branch')
    const streamId = state.activeStreamId.value

    // 会话已切走：标记仍属于 conv_1，但当前会话是 conv_2——不提前刷新
    state.currentConversationId.value = 'conv_2'
    handleStreamChunk({ conversationId: 'conv_2', streamId, type: 'checkpoints', checkpoints: [] } as any, {
      state, currentModelName: () => 'test-model', addCheckpoint: vi.fn(),
      updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn()
    })
    expect(vi.mocked(sendToExtension).mock.calls.filter(c => c[0] === 'conversation.getBranchGraph')).toHaveLength(0)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
  })

  test('编辑带附件：chat.editBranchStream 请求携带附件列表（丢图回归）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    const attachment = {
      id: 'att-1', name: 'pic.png', type: 'image' as const, size: 100,
      mimeType: 'image/png', data: 'aGVsbG8=', thumbnail: undefined
    }

    // branch 模式：请求透传 attachments
    await editAndRetry(state, createComputed(), 1, '新回答', [attachment], async () => {}, 'branch')
    const editCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(editCall).toBeDefined()
    expect(editCall![1]).toMatchObject({
      newText: '新回答',
      userNodeId: 'msg_u1',
      mode: 'branch',
      attachments: [attachment]
    })
    // 本地窗口同步保留附件（刷新前编辑后消息仍显示图片）
    expect(state.allMessages.value[1].attachments).toEqual([attachment])
    expect(state.allMessages.value[1].parts).toEqual([{ text: '新回答' }])

    // keep 模式：同样携带附件（真·原地保存也不丢图）
    vi.mocked(sendToExtension).mockClear()
    await editAndRetry(state, createComputed(), 1, '又改了', [attachment], async () => {}, 'keep')
    const keepCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(keepCall).toBeDefined()
    expect(keepCall![1]).toMatchObject({
      newText: '又改了',
      mode: 'keep',
      attachments: [attachment]
    })
  })

  test('编辑无附件：请求仍携带空数组（后端按传入清空附件）', async () => {
    const user = createMessage({ id: 'msg_u0', role: 'user', content: '问题', localOnly: false, backendIndex: 0, parentId: null })
    const target = createMessage({ id: 'msg_u1', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_u0' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {}, 'keep')
    const keepCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(keepCall).toBeDefined()
    expect(keepCall![1]).toMatchObject({
      newText: '新回答',
      mode: 'keep',
      attachments: []
    })
  })
})
