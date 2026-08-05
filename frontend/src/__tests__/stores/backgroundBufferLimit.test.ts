/**
 * tabActions bufferBackgroundChunk 缓冲上限回归测试
 *
 * 问题背景：backgroundStreamBuffers 无上限，长工具循环/长文本流在用户停留其他标签页
 * 期间逐 chunk 累积，切回时全量同步回放导致 UI 卡死。
 *
 * 修复：每个会话缓冲设条目上限（2000），超出时丢弃最旧 chunk。
 */
import { ref } from 'vue'
import { describe, it, expect } from 'vitest'
import { bufferBackgroundChunk } from '../../stores/chat/tabActions'
import type { ChatStoreState, ConversationSessionSnapshot, TabInfo } from '../../stores/chat/types'

function mockState(): ChatStoreState {
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
    messageQueue: ref([]),
    _lastCancelledStreamId: ref(null),
    _lastApprovalGatedStreamId: ref(null),
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    openTabs: ref<TabInfo[]>([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map<string, ConversationSessionSnapshot>()),
    backgroundStreamBuffers: ref(new Map<string, unknown[]>()),
    branchGraph: ref(null),
    branchGraphLoading: ref(false),
    isSwitchingBranch: ref(false)
  } as unknown as ChatStoreState
}

function setupBackgroundTab(state: ChatStoreState): void {
  state.openTabs.value = [
    { id: 'tab-1', conversationId: 'conv-1', title: 'A', isStreaming: false }
  ]
  state.sessionSnapshots.value.set('tab-1', {
    conversationId: 'conv-1',
    activeStreamId: 'stream-1',
    isStreaming: true,
    isWaitingForResponse: true
  } as unknown as ConversationSessionSnapshot)
}

function chunk(seq: number): any {
  return {
    type: 'chunk',
    conversationId: 'conv-1',
    streamId: 'stream-1',
    chunk: { delta: [{ text: `t${seq}` }], done: false },
    seq
  }
}

describe('bufferBackgroundChunk 缓冲上限', () => {
  it('超过上限时丢弃最旧 chunk，缓冲区长度保持在上限内', () => {
    const state = mockState()
    setupBackgroundTab(state)

    const total = 2500
    for (let i = 0; i < total; i++) {
      bufferBackgroundChunk(state, chunk(i))
    }

    const buffer = state.backgroundStreamBuffers.value.get('conv-1')!
    expect(buffer.length).toBe(2000)
    // 最旧的 500 条被丢弃，剩余从第 500 条开始，且保持顺序
    expect((buffer[0] as any).seq).toBe(500)
    expect((buffer[buffer.length - 1] as any).seq).toBe(2499)
  })

  it('未超上限时全部保留', () => {
    const state = mockState()
    setupBackgroundTab(state)

    for (let i = 0; i < 10; i++) {
      bufferBackgroundChunk(state, chunk(i))
    }

    const buffer = state.backgroundStreamBuffers.value.get('conv-1')!
    expect(buffer.length).toBe(10)
    expect((buffer[0] as any).seq).toBe(0)
    expect((buffer[9] as any).seq).toBe(9)
  })
})
