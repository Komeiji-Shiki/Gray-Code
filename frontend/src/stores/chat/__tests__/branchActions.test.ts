/**
 * branchActions 测试（TREE-07 切换后派生状态重建 + TREE-10 分支图数据源）
 *
 * 覆盖：
 * - loadBranchGraph：成功写入 / 无图 / 损坏降级 / 无会话短路
 * - buildCandidateGroupAt：按父节点推导候选组（≥2 候选；过滤已删除、按 createdAt 排序、活跃下标）
 * - buildCandidateGroupForNode：按消息节点推导所属候选组（切换器跟随活跃候选，而非父节点）
 * - switchBranchCandidate 成功：调用 IPC → 清理流式/错误残留 → TODO/Build 重置 →
 *   重载历史（重建 messageIndexById/toolResponseIndex）→ 检查点刷新 → 分支图刷新
 * - switchBranchCandidate 失败：回滚 UI 快照 + 错误条写入
 * - BRANCH_BUSY：流式中切换/删除被前端拦截，不发 IPC
 * - deleteBranchCandidate：成功后仅刷新分支图
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { ChatStoreState, BranchGraphData, BranchNodeData } from '../types'
import {
  loadBranchGraph,
  refreshBranchGraph,
  buildCandidateGroupAt,
  buildCandidateGroupForNode,
  buildActivePathIds,
  buildChildrenIndex,
  switchBranchCandidate,
  deleteBranchCandidate,
  restoreBranchCandidate,
  renameBranchCandidate,
  needsWorkspaceConfirm,
  BRANCH_BUSY_MESSAGE
} from '../branchActions'
import { pendingDirtyConfirm, clearPendingDirtyConfirm } from '../dirtyConfirmState'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '../../../utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref(null),
    allMessages: ref([]),
    messageIndexById: ref(new Map()),
    toolResponseIndex: ref(new Map()),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    persistedConversationIds: ref([]),
    persistedConversationsLoaded: ref(0),
    isLoadingMoreConversations: ref(false),
    windowStartIndex: ref(0),
    totalMessages: ref(0),
    isLoadingMoreMessages: ref(false),
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    configId: ref(''),
    selectedModelId: ref(''),
    currentConfig: ref(null),
    isLoading: ref(false),
    isStreaming: ref(false),
    isLoadingConversations: ref(false),
    error: ref(null),
    streamingMessageId: ref(null),
    activeStreamId: ref(null),
    isWaitingForResponse: ref(false),
    retryStatus: ref(null),
    autoSummaryStatus: ref(null),
    checkpoints: ref([]),
    mergeUnchangedCheckpoints: ref(true),
    deletingConversationIds: ref(new Set()),
    currentWorkspaceUri: ref(null),
    inputValue: ref(''),
    workspaceFilter: ref('current'),
    editorNodes: ref([]),
    attachments: ref([]),
    currentPromptModeId: ref('code'),
    activeBuild: ref(null),
    pendingModelOverride: ref(null),
    pendingConfigIdOverride: ref<string | null>(null),
    messageQueue: ref([]),
    _lastCancelledStreamId: ref(null),
    _lastApprovalGatedStreamId: ref(null),
    _failedStreamMessageId: ref(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
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

function makeNode(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: 0, ...overrides }
}

function makeGraph(nodes: Record<string, BranchNodeData>, activeTailNodeId: string): BranchGraphData {
  return { version: 1, rootNodeId: 'u1', activeTailNodeId, nodes }
}

describe('loadBranchGraph / refreshBranchGraph（TREE-10 数据源）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('成功后写入 branchGraph', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    const graph = makeGraph({ n1: makeNode('n1', null) }, 'n1')
    mockSend.mockResolvedValue({ graph })

    await loadBranchGraph(state)

    expect(mockSend).toHaveBeenCalledWith('conversation.getBranchGraph', { conversationId: 'c1' })
    expect(state.branchGraph.value).toEqual(graph)
    expect(state.branchGraphLoading.value).toBe(false)
  })

  it('无图（线性模式）→ branchGraph 置 null', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockResolvedValue({ graph: null })

    await loadBranchGraph(state)

    expect(state.branchGraph.value).toBeNull()
  })

  it('损坏（BRANCH_STORAGE_CORRUPT）→ 读取侧降级为 null，不抛错', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSend.mockResolvedValue({ graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT', errorMessage: 'semantic validation failed' })

    await loadBranchGraph(state)

    expect(state.branchGraph.value).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('只读失败保留旧值（不打断对话）', async () => {
    const graph = makeGraph({ n1: makeNode('n1', null) }, 'n1')
    const state = createState({
      currentConversationId: ref('c1'),
      branchGraph: ref(graph)
    })
    mockSend.mockRejectedValue(new Error('ipc down'))

    await loadBranchGraph(state)

    expect(state.branchGraph.value).toEqual(graph)
  })

  it('无当前对话 → 置 null 且不发 IPC', async () => {
    const state = createState({ currentConversationId: ref(null) })

    await loadBranchGraph(state)

    expect(mockSend).not.toHaveBeenCalled()
    expect(state.branchGraph.value).toBeNull()
  })

  it('refreshBranchGraph 是 loadBranchGraph 的别名', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    const graph = makeGraph({ n1: makeNode('n1', null) }, 'n1')
    mockSend.mockResolvedValue({ graph })

    const result = await refreshBranchGraph(state)

    expect(result).toEqual(graph)
    expect(state.branchGraph.value).toEqual(graph)
  })
})

describe('buildCandidateGroupAt（按父节点推导候选组）', () => {
  it('null 图 → null', () => {
    expect(buildCandidateGroupAt(null, 'u1')).toBeNull()
  })

  it('未知父节点 → null', () => {
    expect(buildCandidateGroupAt(makeGraph({}, 'missing'), 'u1')).toBeNull()
  })

  it('单候选 → null（无分支点，切换器不显示）', () => {
    const graph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    expect(buildCandidateGroupAt(graph, 'u1')).toBeNull()
  })

  it('多候选：过滤已删除、按 createdAt 升序、活跃下标取活跃路径子候选', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a2' }),
        a1: makeNode('a1', 'u1', { createdAt: 100, parts: [{ text: 'first' }] }),
        a2: makeNode('a2', 'u1', { createdAt: 300, parts: [{ text: 'second' }] }),
        a3: makeNode('a3', 'u1', { createdAt: 200, parts: [{ text: 'third' }] }),
        aDeleted: makeNode('aDeleted', 'u1', { createdAt: 400, deleted: true }),
        other: makeNode('other', 'a1', { createdAt: 50 })
      },
      'a2'
    )

    const group = buildCandidateGroupAt(graph, 'u1')

    expect(group).not.toBeNull()
    expect(group!.candidates.map(c => c.id)).toEqual(['a1', 'a3', 'a2'])
    expect(group!.activeIndex).toBe(2)
    expect(group!.parentNodeId).toBe('u1')
  })

  it('多个分支点各自独立推导（非活跃分支点也能出组）', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: makeNode('a1', 'u1', { role: 'model', activeChildId: 'u2' }),
        a2: makeNode('a2', 'u1', { role: 'model' }),
        u2: makeNode('u2', 'a1', { role: 'user', activeChildId: 'c1' }),
        c1: makeNode('c1', 'u2', { role: 'model' }),
        c2: makeNode('c2', 'u2', { role: 'model' })
      },
      'c1'
    )

    // u1 下候选 a1/a2，活跃路径走 a1
    const groupU1 = buildCandidateGroupAt(graph, 'u1')
    expect(groupU1!.candidates.map(c => c.id)).toEqual(['a1', 'a2'])
    expect(groupU1!.activeIndex).toBe(0)

    // u2 下候选 c1/c2，活跃路径走 c1
    const groupU2 = buildCandidateGroupAt(graph, 'u2')
    expect(groupU2!.candidates.map(c => c.id)).toEqual(['c1', 'c2'])
    expect(groupU2!.activeIndex).toBe(0)
  })

  it('活跃候选不在组内（数据不一致）→ null（防御性隐藏）', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'x' }),
        a1: makeNode('a1', 'u1', { createdAt: 100 }),
        a2: makeNode('a2', 'u1', { createdAt: 200 })
      },
      'a2'
    )
    expect(buildCandidateGroupAt(graph, 'u1')).toBeNull()
  })
})

describe('buildCandidateGroupForNode（按消息节点推导所属候选组，TREE-10 切换器挂载语义）', () => {
  it('null 图 → null', () => {
    expect(buildCandidateGroupForNode(null, 'a2')).toBeNull()
  })

  it('未知节点 → null', () => {
    expect(buildCandidateGroupForNode(makeGraph({}, 'missing'), 'a2')).toBeNull()
  })

  it('根节点（自身无父节点）→ null', () => {
    const graph = makeThreeNodeGraph('a2')
    expect(buildCandidateGroupForNode(graph, 'u1')).toBeNull()
  })

  it('活跃候选 → 返回所属候选组（挂在被重试的消息上）', () => {
    // 模拟 user:1 → ai:2 → ai:3，重试 3 后候选组 {3, 3'} 挂在父节点 2 下；
    // 切换器应显示在活跃候选（3' 的位置）上，即 nodeId 为候选本身。
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a2' }),
        a2: makeNode('a2', 'u1', { role: 'model', activeChildId: 'b2' }),
        b1: makeNode('b1', 'a2', { role: 'model', createdAt: 100, parts: [{ text: '旧回答' }] }),
        b2: makeNode('b2', 'a2', { role: 'model', createdAt: 200, parts: [{ text: '新回答' }] })
      },
      'b2'
    )

    // 活跃候选 b2（重试后生成的新回答）：切换器跟随它
    const group = buildCandidateGroupForNode(graph, 'b2')
    expect(group).not.toBeNull()
    expect(group!.candidates.map(c => c.id)).toEqual(['b1', 'b2'])
    expect(group!.activeIndex).toBe(1)
    expect(group!.parentNodeId).toBe('a2')

    // 父节点 a2（候选组的父，自己不是成员）：不显示切换器
    expect(buildCandidateGroupForNode(graph, 'a2')).toBeNull()
  })

  it('非活跃候选 → null（旧候选不在主历史 UI）', () => {
    const graph = makeThreeNodeGraph('a2')
    // 活跃是 a2，a1 非活跃
    expect(buildCandidateGroupForNode(graph, 'a1')).toBeNull()
  })

  it('单候选（无分支点）→ null', () => {
    const graph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    expect(buildCandidateGroupForNode(graph, 'a1')).toBeNull()
  })

  it('软删候选 → null', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a2' }),
        a1: makeNode('a1', 'u1', { deleted: true }),
        a2: makeNode('a2', 'u1')
      },
      'a2'
    )
    expect(buildCandidateGroupForNode(graph, 'a1')).toBeNull()
  })

  it('深层活跃路径：切换器跟随末尾活跃候选', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: makeNode('a1', 'u1', { role: 'model', activeChildId: 'u2' }),
        a2: makeNode('a2', 'u1', { role: 'model' }),
        u2: makeNode('u2', 'a1', { role: 'user', activeChildId: 'c2' }),
        c1: makeNode('c1', 'u2', { role: 'model' }),
        c2: makeNode('c2', 'u2', { role: 'model' })
      },
      'c2'
    )

    // u2 下的候选组 {c1, c2}：活跃成员 c2 上显示切换器
    const group = buildCandidateGroupForNode(graph, 'c2')
    expect(group!.candidates.map(c => c.id)).toEqual(['c1', 'c2'])
    expect(group!.activeIndex).toBe(1)
    // 非活跃 c1 不显示
    expect(buildCandidateGroupForNode(graph, 'c1')).toBeNull()
    // 更上层 u1 下的候选组 {a1, a2}：活跃成员 a1 上显示切换器（另一处分支点）
    const groupU1 = buildCandidateGroupForNode(graph, 'a1')
    expect(groupU1!.candidates.map(c => c.id)).toEqual(['a1', 'a2'])
    expect(groupU1!.activeIndex).toBe(0)
  })
})

function makeThreeNodeGraph(activeTailNodeId: string): BranchGraphData {
  return makeGraph(
    {
      u1: makeNode('u1', null, { role: 'user', activeChildId: activeTailNodeId }),
      a1: makeNode('a1', 'u1', { createdAt: 100, parts: [{ text: '回答一' }] }),
      a2: makeNode('a2', 'u1', { createdAt: 200, parts: [{ text: '回答二' }] }),
      a3: makeNode('a3', 'u1', { createdAt: 300, parts: [{ text: '回答三' }] })
    },
    activeTailNodeId
  )
}

describe('switchBranchCandidate（TREE-07 切换后重建）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('成功：清理残留 → TODO/Build 重置 → 重载历史 → 检查点刷新 → 分支图刷新', async () => {
    const oldGraph = makeGraph({ u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') }, 'a1')
    const newGraph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a2: makeNode('a2', 'u1', { parts: [{ text: 'new' }] }) },
      'a2'
    )
    const state = createState({
      currentConversationId: ref('c1'),
      allMessages: ref([
        { id: 'm1', role: 'user', content: 'hi', timestamp: 1, backendIndex: 0, parts: [{ text: 'hi' }] },
        { id: 'm2', role: 'assistant', content: 'old', timestamp: 2, backendIndex: 1, parts: [{ text: 'old' }] },
        { id: 'fr1', role: 'user', content: '', timestamp: 3, backendIndex: 2, isFunctionResponse: true, parts: [{ functionResponse: { id: 'tool-1', name: 'x', response: { ok: true } } }] }
      ]),
      toolResponseCache: ref(new Map([['tool-1', { ok: true }]])),
      checkpoints: ref([{ id: 'cp_old', messageIndex: 1, phase: 'before' }] as any),
      branchGraph: ref(oldGraph),
      activeBuild: ref({ id: 'build-1', conversationId: 'c1', title: 'B', planContent: 'p', startedAt: 1, status: 'running' } as any),
      error: ref({ code: 'STREAM_ERROR', message: 'boom' }),
      streamingMessageId: ref('m2'),
      activeStreamId: ref('req-1'),
      retryStatus: ref({ isRetrying: true, attempt: 1, maxAttempts: 3 }),
      _lastCancelledStreamId: ref('req-1'),
      _failedStreamMessageId: ref('m2')
    })

    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.switchBranchCandidate') {
        return Promise.resolve({ success: true, nodeId: 'a2', activeTailNodeId: 'a2', activePathIds: ['u1', 'a2'], mainHistoryRewrite: false })
      }
      if (command === 'conversation.getMessagesPaged') {
        return Promise.resolve({
          total: 2,
          messages: [
            { role: 'user', parts: [{ text: 'hi' }], index: 0, id: 'u1' },
            { role: 'model', parts: [{ text: 'new answer' }], index: 1, id: 'a2' }
          ]
        })
      }
      if (command === 'checkpoint.getCheckpoints') {
        return Promise.resolve({ checkpoints: [{ id: 'cp_new', messageIndex: 1, phase: 'before' }] })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: newGraph })
      }
      return Promise.resolve(undefined)
    })

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.switchBranchCandidate', { conversationId: 'c1', nodeId: 'a2', mode: 'chat-only' })
    // 清理错误条 / 流式残留（isStreaming 本就为 false：切换与流式互斥，前端守卫已拒绝流中切换）
    expect(state.error.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.activeStreamId.value).toBeNull()
    expect(state._lastCancelledStreamId.value).toBeNull()
    expect(state._failedStreamMessageId.value).toBeNull()
    expect(state.retryStatus.value).toBeNull()
    // TODO / Build 重置
    expect(state.toolResponseCache.value.size).toBe(0)
    expect(state.activeBuild.value).toBeNull()
    // 重载历史（重建索引）
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value[1].id).toBe('a2')
    expect(state.messageIndexById.value.get('a2')).toBe(1)
    expect(state.totalMessages.value).toBe(2)
    // 检查点刷新
    expect(state.checkpoints.value).toEqual([{ id: 'cp_new', messageIndex: 1, phase: 'before' }])
    // 分支图刷新
    expect(state.branchGraph.value).toEqual(newGraph)
    expect(state.isSwitchingBranch.value).toBe(false)
  })

  it('失败：回滚 UI 快照并写错误条（NODE_NOT_FOUND）', async () => {
    const graph = makeGraph({ u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') }, 'a1')
    const messages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1, backendIndex: 0, parts: [{ text: 'hi' }] }
    ]
    const checkpoints = [{ id: 'cp_old', messageIndex: 0, phase: 'before' }]
    const toolCache = new Map([['tool-1', { ok: true }]])
    const build = { id: 'build-1', conversationId: 'c1', title: 'B', planContent: 'p', startedAt: 1, status: 'running' }

    const state = createState({
      currentConversationId: ref('c1'),
      allMessages: ref(messages as any),
      messageIndexById: ref(new Map([['m1', 0]])),
      toolResponseIndex: ref(new Map()),
      toolResponseCache: ref(toolCache),
      checkpoints: ref(checkpoints as any),
      branchGraph: ref(graph),
      activeBuild: ref(build as any),
      windowStartIndex: ref(0),
      totalMessages: ref(1)
    })

    mockSend.mockRejectedValue(Object.assign(new Error('node not found'), { code: 'NODE_NOT_FOUND' }))

    const ok = await switchBranchCandidate(state, 'missing')

    expect(ok).toBe(false)
    // 回滚（ref 深度响应式：用 toEqual 断言内容一致）
    expect(state.allMessages.value).toEqual(messages)
    expect(state.messageIndexById.value.get('m1')).toBe(0)
    expect(state.checkpoints.value).toEqual(checkpoints)
    expect([...state.toolResponseCache.value.entries()]).toEqual([...toolCache.entries()])
    expect(state.branchGraph.value).toEqual(graph)
    expect(state.activeBuild.value).toEqual(build)
    // 错误条
    expect(state.error.value?.code).toBe('NODE_NOT_FOUND')
    expect(state.error.value?.message).toBe('node not found')
    expect(state.isSwitchingBranch.value).toBe(false)
  })

  it('失败（未知异常）→ 兜底 BRANCH_SWITCH_ERROR', async () => {
    const state = createState({
      currentConversationId: ref('c1'),
      allMessages: ref([{ id: 'm1', role: 'user', content: 'hi', timestamp: 1, parts: [{ text: 'hi' }] }] as any)
    })
    mockSend.mockRejectedValue(new Error('ipc exploded'))

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_SWITCH_ERROR')
    expect(state.allMessages.value).toHaveLength(1)
  })

  it('BRANCH_BUSY：流式中被前端拦截，不发 IPC', async () => {
    const state = createState({
      currentConversationId: ref('c1'),
      isStreaming: ref(true)
    })

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_BUSY')
    expect(state.error.value?.message).toBe(BRANCH_BUSY_MESSAGE)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('BRANCH_BUSY：等待工具确认（isWaitingForResponse）同样拦截', async () => {
    const state = createState({
      currentConversationId: ref('c1'),
      isWaitingForResponse: ref(true)
    })

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_BUSY')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('isSwitchingBranch 置位期间拒绝并发切换', async () => {
    const state = createState({
      currentConversationId: ref('c1'),
      isSwitchingBranch: ref(true)
    })

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('无当前对话 / 非法 nodeId → false 且不发 IPC', async () => {
    const state = createState({ currentConversationId: ref(null) })
    expect(await switchBranchCandidate(state, 'a2')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()

    const state2 = createState({ currentConversationId: ref('c1') })
    expect(await switchBranchCandidate(state2, '')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('deleteBranchCandidate（TREE-09 UI 入口）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('成功：软删除后仅刷新分支图（活跃路径不变）', async () => {
    const graph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1'), a2: makeNode('a2', 'u1') },
      'a1'
    )
    const refreshedGraph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user' }),
        a1: makeNode('a1', 'u1'),
        a2: makeNode('a2', 'u1', { deleted: true })
      },
      'a1'
    )
    const state = createState({
      currentConversationId: ref('c1'),
      branchGraph: ref(graph)
    })

    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.deleteBranchCandidate') {
        return Promise.resolve({ success: true, nodeId: 'a2', deleted: true, clearedParentActiveChild: true })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: refreshedGraph })
      }
      return Promise.resolve(undefined)
    })

    const ok = await deleteBranchCandidate(state, 'a2')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.deleteBranchCandidate', { conversationId: 'c1', nodeId: 'a2' })
    expect(state.branchGraph.value).toEqual(refreshedGraph)
    // 未触发历史重载（非活跃候选删除不影响窗口）
    expect(mockSend.mock.calls.some((c: any[]) => c[0] === 'conversation.getMessagesPaged')).toBe(false)
    expect(state.isSwitchingBranch.value).toBe(false)
  })

  it('失败：写错误条并透出错误码', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockRejectedValue(Object.assign(new Error('cannot delete active node'), { code: 'BRANCH_OPERATION_CONFLICT' }))

    const ok = await deleteBranchCandidate(state, 'a1')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_OPERATION_CONFLICT')
    expect(state.error.value?.message).toBe('cannot delete active node')
  })

  it('BRANCH_BUSY：流式中删除被拦截，不发 IPC', async () => {
    const state = createState({
      currentConversationId: ref('c1'),
      isStreaming: ref(true)
    })

    const ok = await deleteBranchCandidate(state, 'a2')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_BUSY')

    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('buildActivePathIds / buildChildrenIndex（TREE-11 分支树面板数据源）', () => {
  it('buildActivePathIds：null / 空图 / 无 root → []', () => {
    expect(buildActivePathIds(null)).toEqual([])
    expect(buildActivePathIds(makeGraph({}, 'tail'))).toEqual([])
  })

  it('buildActivePathIds：沿 activeChildId 从 root 走到活跃尾', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a2' }),
        a1: makeNode('a1', 'u1'),
        a2: makeNode('a2', 'u1', { activeChildId: 'a2c' }),
        a2c: makeNode('a2c', 'a2')
      },
      'a2c'
    )
    expect(buildActivePathIds(graph)).toEqual(['u1', 'a2', 'a2c'])
  })

  it('buildActivePathIds：活跃尾中途截止（尾为祖先节点）', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: makeNode('a1', 'u1', { activeChildId: 'a1c' }),
        a1c: makeNode('a1c', 'a1')
      },
      'a1'
    )
    expect(buildActivePathIds(graph)).toEqual(['u1', 'a1'])
  })

  it('buildActivePathIds：环 / 链上节点缺失 → 保守返回已走部分（不抛错）', () => {
    const cyclic = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: makeNode('a1', 'u1', { activeChildId: 'u1' })
      },
      'a1'
    )
    expect(buildActivePathIds(cyclic)).toEqual(['u1', 'a1'])

    const dangling = makeGraph(
      { u1: makeNode('u1', null, { role: 'user', activeChildId: 'missing' }) },
      'missing'
    )
    expect(buildActivePathIds(dangling)).toEqual(['u1'])
  })

  it('buildChildrenIndex：按 parentId 分组、createdAt 升序、同毫秒按 id 字典序、含软删节点', () => {
    const graph = makeGraph(
      {
        u1: makeNode('u1', null, { role: 'user' }),
        a2: makeNode('a2', 'u1', { createdAt: 200 }),
        a1: makeNode('a1', 'u1', { createdAt: 100 }),
        aDel: makeNode('aDel', 'u1', { createdAt: 150, deleted: true }),
        b1: makeNode('b1', 'a1', { createdAt: 50 }),
        b2: makeNode('b2', 'a1', { createdAt: 50 })
      },
      'a2'
    )
    const index = buildChildrenIndex(graph)
    expect(index.get('u1')!.map(n => n.id)).toEqual(['a1', 'aDel', 'a2'])
    expect(index.get('a1')!.map(n => n.id)).toEqual(['b1', 'b2'])
    expect(index.has('b1')).toBe(false)
    expect(index.has('missing')).toBe(false)
  })

  it('buildChildrenIndex：null 图 → 空 Map', () => {
    expect(buildChildrenIndex(null).size).toBe(0)
  })
})

describe('restoreBranchCandidate / renameBranchCandidate（TREE-11 面板入口）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('restore 成功：调用 IPC 后仅刷新分支图', async () => {
    const graph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1', { deleted: true }) },
      'u1'
    )
    const restoredGraph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') },
      'u1'
    )
    const state = createState({ currentConversationId: ref('c1'), branchGraph: ref(graph) })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.restoreBranchCandidate') {
        return Promise.resolve({ success: true, nodeId: 'a1' })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: restoredGraph })
      }
      return Promise.resolve(undefined)
    })

    const ok = await restoreBranchCandidate(state, 'a1')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.restoreBranchCandidate', { conversationId: 'c1', nodeId: 'a1' })
    expect(state.branchGraph.value).toEqual(restoredGraph)
    expect(state.isSwitchingBranch.value).toBe(false)
  })

  it('restore 失败：写错误条并透出错误码', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockRejectedValue(Object.assign(new Error('node not found'), { code: 'NODE_NOT_FOUND' }))

    const ok = await restoreBranchCandidate(state, 'missing')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('NODE_NOT_FOUND')
  })

  it('restore：流式中被拦截（BRANCH_BUSY），不发 IPC', async () => {
    const state = createState({ currentConversationId: ref('c1'), isStreaming: ref(true) })

    const ok = await restoreBranchCandidate(state, 'a1')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_BUSY')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('rename 成功：调用 IPC（label 规范化）后仅刷新分支图', async () => {
    const graph = makeGraph({ u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') }, 'a1')
    const renamedGraph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1', { label: '新版回答' }) },
      'a1'
    )
    const state = createState({ currentConversationId: ref('c1'), branchGraph: ref(graph) })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.renameBranchCandidate') {
        return Promise.resolve({ success: true, nodeId: 'a1' })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: renamedGraph })
      }
      return Promise.resolve(undefined)
    })

    const ok = await renameBranchCandidate(state, 'a1', '  新版回答  ')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.renameBranchCandidate', {
      conversationId: 'c1',
      nodeId: 'a1',
      label: '新版回答'
    })
    expect(state.branchGraph.value).toEqual(renamedGraph)
  })

  it('rename：流式中被拦截（BRANCH_BUSY），不发 IPC', async () => {
    const state = createState({ currentConversationId: ref('c1'), isWaitingForResponse: ref(true) })

    const ok = await renameBranchCandidate(state, 'a1', 'x')

    expect(ok).toBe(false)
    expect(state.error.value?.code).toBe('BRANCH_BUSY')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('无当前对话 / 非法参数 → false 且不发 IPC', async () => {
    const state = createState({ currentConversationId: ref(null) })
    expect(await restoreBranchCandidate(state, 'a1')).toBe(false)
    expect(await renameBranchCandidate(state, 'a1', 'x')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()

    const state2 = createState({ currentConversationId: ref('c1') })
    expect(await restoreBranchCandidate(state2, '')).toBe(false)
    expect(await renameBranchCandidate(state2, '', 'x')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

describe('BCP-03/04/05 切换模式与 dirty 确认（branchActions）', () => {
  beforeEach(() => {
    mockSend.mockReset()
    clearPendingDirtyConfirm()
  })

  it('needsWorkspaceConfirm：wroteToWorkspace / hasWorkspaceState 命中（决策 1 判据）', () => {
    expect(needsWorkspaceConfirm(makeNode('n1', null, { wroteToWorkspace: true }))).toBe(true)
    expect(needsWorkspaceConfirm(makeNode('n1', null, { hasWorkspaceState: true }))).toBe(true)
    expect(needsWorkspaceConfirm(makeNode('n1', null))).toBe(false)
    expect(needsWorkspaceConfirm(makeNode('n1', null, { wroteToWorkspace: false, hasWorkspaceState: false }))).toBe(false)
    expect(needsWorkspaceConfirm(null)).toBe(false)
    expect(needsWorkspaceConfirm(undefined)).toBe(false)
  })

  it('chat-and-workspace：IPC 携带 mode，成功后正常重建且不登记 dirty 确认', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.switchBranchCandidate') {
        return Promise.resolve({ success: true, workspaceRestored: true, restoredSummary: { restored: 1, deleted: 0, skipped: 0 } })
      }
      if (command === 'conversation.getMessagesPaged') {
        return Promise.resolve({ total: 1, messages: [{ role: 'user', parts: [{ text: 'hi' }], index: 0, id: 'u1' }] })
      }
      if (command === 'checkpoint.getCheckpoints') {
        return Promise.resolve({ checkpoints: [] })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: null })
      }
      return Promise.resolve(undefined)
    })

    const ok = await switchBranchCandidate(state, 'a2', { mode: 'chat-and-workspace' })

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.switchBranchCandidate', {
      conversationId: 'c1',
      nodeId: 'a2',
      mode: 'chat-and-workspace'
    })
    expect(pendingDirtyConfirm.value).toBeNull()
  })

  it('chat-and-workspace dirty 拦截：返回 dirtyFiles → 登记待确认动作，不写错误条，不发后续 IPC', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockResolvedValue({ success: false, dirtyFiles: ['C:/ws/a.ts', 'C:/ws/b.ts'] })

    const ok = await switchBranchCandidate(state, 'a2', { mode: 'chat-and-workspace' })

    expect(ok).toBe(false)
    expect(state.error.value).toBeNull()
    expect(pendingDirtyConfirm.value).toMatchObject({
      kind: 'switch',
      files: ['C:/ws/a.ts', 'C:/ws/b.ts'],
      switch: { nodeId: 'a2' }
    })
    // 未进入重建流程（只发了切换请求）
    expect(mockSend.mock.calls.length).toBe(1)
    expect(mockSend.mock.calls[0][0]).toBe('conversation.switchBranchCandidate')
  })

  it('chat-only 模式 dirty 响应不登记待确认（后端仅 chat-and-workspace 检测）', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.switchBranchCandidate') {
        return Promise.resolve({ success: true })
      }
      if (command === 'conversation.getMessagesPaged') {
        return Promise.resolve({ total: 0, messages: [] })
      }
      if (command === 'checkpoint.getCheckpoints') {
        return Promise.resolve({ checkpoints: [] })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: null })
      }
      return Promise.resolve(undefined)
    })

    const ok = await switchBranchCandidate(state, 'a2')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.switchBranchCandidate', {
      conversationId: 'c1',
      nodeId: 'a2',
      mode: 'chat-only'
    })
    expect(pendingDirtyConfirm.value).toBeNull()
  })

  it('confirmedDiscardDirty=true：IPC 携带 confirmedDiscardDirty', async () => {
    const state = createState({ currentConversationId: ref('c1') })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.switchBranchCandidate') {
        return Promise.resolve({ success: true, workspaceRestored: true })
      }
      if (command === 'conversation.getMessagesPaged') {
        return Promise.resolve({ total: 0, messages: [] })
      }
      if (command === 'checkpoint.getCheckpoints') {
        return Promise.resolve({ checkpoints: [] })
      }
      if (command === 'conversation.getBranchGraph') {
        return Promise.resolve({ graph: null })
      }
      return Promise.resolve(undefined)
    })

    const ok = await switchBranchCandidate(state, 'a2', { mode: 'chat-and-workspace', confirmedDiscardDirty: true })

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.switchBranchCandidate', {
      conversationId: 'c1',
      nodeId: 'a2',
      mode: 'chat-and-workspace',
      confirmedDiscardDirty: true
    })
    expect(pendingDirtyConfirm.value).toBeNull()
  })
})
})
