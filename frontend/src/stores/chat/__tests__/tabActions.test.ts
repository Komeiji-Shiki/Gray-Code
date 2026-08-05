import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import {
  closeTab,
  switchTab,
  snapshotCurrentSession,
  restoreSessionFromSnapshot,
  resetConversationState
} from '../tabActions'
import type { ChatStoreState, BranchGraphData, BranchNodeData } from '../types'

/** Creates a minimal mock state with all fields used by tabActions */
function mockState(): ChatStoreState {
  return {
    allMessages: ref([]),
    messageIndexById: ref(new Map()),
    toolResponseIndex: ref(new Map()),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    persistedConversationIds: ref([]),
    persistedConversationsLoaded: ref(0),
    isLoadingMoreConversations: ref(false),
    currentConversationId: ref(null),
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
    messageQueue: ref([]),
    _lastCancelledStreamId: ref(null),
    _lastApprovalGatedStreamId: ref(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map()),
    branchGraph: ref(null),
    branchGraphLoading: ref(false),
    isSwitchingBranch: ref(false)
  } as unknown as ChatStoreState
}

function makeNode(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: 0, ...overrides }
}

function makeGraph(nodes: Record<string, BranchNodeData>, activeTailNodeId: string): BranchGraphData {
  return { version: 1, rootNodeId: 'u1', activeTailNodeId, nodes }
}

function makeQueuedMessage(id: string, conversationId: string | null) {
  return {
    id,
    content: 'queued content',
    attachments: [],
    timestamp: 1,
    conversationId
  }
}

describe('tabActions snapshot lifecycle', () => {
  it('closeTab of the active tab does not leave an orphan snapshot', () => {
    const state = mockState()
    state.openTabs.value = [
      { id: 'tab-1', conversationId: 'conv-1', title: 'A', isStreaming: false },
      { id: 'tab-2', conversationId: 'conv-2', title: 'B', isStreaming: false }
    ]
    state.activeTabId.value = 'tab-1'
    state.currentConversationId.value = 'conv-1'
    state.allMessages.value = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1, parts: [{ text: 'hi' }] }
    ]
    state.messageQueue.value = [makeQueuedMessage('q1', 'conv-1')]

    closeTab(state, 'tab-1', vi.fn())

    expect(state.activeTabId.value).toBe('tab-2')
    expect(state.openTabs.value.map(t => t.id)).toEqual(['tab-2'])
    // 已关闭标签页的快照已删除且未被重新创建（孤儿快照泄漏修复）
    expect(state.sessionSnapshots.value.has('tab-1')).toBe(false)
    // 相邻标签页成为活跃页并恢复其会话
    expect(state.currentConversationId.value).toBe('conv-2')
  })

  it('switchTab snapshots the active tab state with its queue', () => {
    const state = mockState()
    state.openTabs.value = [
      { id: 'tab-1', conversationId: 'conv-1', title: 'A', isStreaming: false },
      { id: 'tab-2', conversationId: null, title: 'New Chat', isStreaming: false }
    ]
    state.activeTabId.value = 'tab-1'
    state.currentConversationId.value = 'conv-1'
    state.messageQueue.value = [makeQueuedMessage('q1', 'conv-1')]

    switchTab(state, 'tab-2', vi.fn())

    // 活跃标签页状态被快照（含排队消息，H6/H7 保留语义）
    const snapshot = state.sessionSnapshots.value.get('tab-1')
    expect(snapshot).toBeDefined()
    expect(snapshot!.messageQueue.map(m => m.id)).toEqual(['q1'])
    // 新标签页为空白会话（新会话不继承队列，resetConversationState 语义）
    expect(state.currentConversationId.value).toBeNull()
    expect(state.messageQueue.value).toEqual([])
  })

  it('closeTab of an inactive tab does not disturb the active tab', () => {
    const state = mockState()
    state.openTabs.value = [
      { id: 'tab-1', conversationId: 'conv-1', title: 'A', isStreaming: false },
      { id: 'tab-2', conversationId: 'conv-2', title: 'B', isStreaming: false }
    ]
    state.activeTabId.value = 'tab-1'
    state.currentConversationId.value = 'conv-1'

    closeTab(state, 'tab-2', vi.fn())

    expect(state.activeTabId.value).toBe('tab-1')
    expect(state.openTabs.value.map(t => t.id)).toEqual(['tab-1'])
    expect(state.sessionSnapshots.value.has('tab-2')).toBe(false)
  })
})


describe('tabActions branchGraph snapshot（TREE-12）', () => {
  it('snapshotCurrentSession 保存 branchGraph 快照', () => {
    const state = mockState()
    const graph = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    state.currentConversationId.value = 'conv-1'
    state.branchGraph.value = graph

    const snapshot = snapshotCurrentSession(state)

    expect(snapshot.branchGraph).toEqual(graph)
  })

  it('snapshotCurrentSession 保存分支流刷新标记与重放上下文', () => {
    const state = mockState()
    state.currentConversationId.value = 'conv-1'
    state._pendingBranchRefreshAfterStream.value = 'conv-1'
    state._pendingBranchReplayContext.value = {
      kind: 'editBranch',
      conversationId: 'conv-1',
      userNodeId: 'user-1',
      newText: 'edited',
      configId: 'cfg-1'
    }

    const snapshot = snapshotCurrentSession(state)
    state._pendingBranchRefreshAfterStream.value = null
    state._pendingBranchReplayContext.value = null
    restoreSessionFromSnapshot(state, snapshot)

    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv-1')
    expect(state._pendingBranchReplayContext.value).toEqual({
      kind: 'editBranch',
      conversationId: 'conv-1',
      userNodeId: 'user-1',
      newText: 'edited',
      configId: 'cfg-1'
    })
  })

  it('switchTab 快照当前标签页分支图，切回后恢复分支视图状态', () => {
    const state = mockState()
    const graphA = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    const graphB = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), b1: makeNode('b1', 'u1') },
      'b1'
    )
    state.openTabs.value = [
      { id: 'tab-1', conversationId: 'conv-1', title: 'A', isStreaming: false },
      { id: 'tab-2', conversationId: 'conv-2', title: 'B', isStreaming: false }
    ]
    state.activeTabId.value = 'tab-1'
    state.currentConversationId.value = 'conv-1'
    state.branchGraph.value = graphA

    // A → B：A 的分支图进快照，B 恢复自己的分支图
    switchTab(state, 'tab-2', vi.fn())
    expect(state.sessionSnapshots.value.get('tab-1')!.branchGraph).toEqual(graphA)

    state.branchGraph.value = graphB
    state.currentConversationId.value = 'conv-2'

    // B → A：A 的分支图恢复回来
    switchTab(state, 'tab-1', vi.fn())
    expect(state.branchGraph.value).toEqual(graphA)
    expect(state.currentConversationId.value).toBe('conv-1')
  })

  it('restoreSessionFromSnapshot：旧快照无 branchGraph 字段时回退 null', () => {
    const state = mockState()
    const snapshot = snapshotCurrentSession(state)
    const legacy = { ...snapshot } as any
    delete legacy.branchGraph
    delete legacy.pendingBranchRefreshAfterStream
    delete legacy.pendingBranchReplayContext

    state.branchGraph.value = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    state._pendingBranchRefreshAfterStream.value = 'conv-1'
    state._pendingBranchReplayContext.value = {
      kind: 'reroll',
      conversationId: 'conv-1',
      assistantNodeId: 'a1',
      configId: 'cfg-1'
    }

    restoreSessionFromSnapshot(state, legacy)

    expect(state.branchGraph.value).toBeNull()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(state._pendingBranchReplayContext.value).toBeNull()
  })

  it('resetConversationState 清空 branchGraph 与分支流暂存状态（新空白标签页无分支状态）', () => {
    const state = mockState()
    state.branchGraph.value = makeGraph(
      { u1: makeNode('u1', null, { role: 'user' }), a1: makeNode('a1', 'u1') },
      'a1'
    )
    state._pendingBranchRefreshAfterStream.value = 'conv-1'
    state._pendingBranchReplayContext.value = {
      kind: 'reroll',
      conversationId: 'conv-1',
      assistantNodeId: 'a1',
      configId: 'cfg-1'
    }

    resetConversationState(state)

    expect(state.branchGraph.value).toBeNull()
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    expect(state._pendingBranchReplayContext.value).toBeNull()
  })
})