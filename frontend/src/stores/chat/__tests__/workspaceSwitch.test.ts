/**
 * 工作区切换（对话内禁止重绑定）回归测试 —— 1.7.3 绑定健壮性修复批次 2。
 *
 * 覆盖：
 * - openWorkspaceInNewConversation：同工作区 no-op / 空白标签重定位 /
 *   已有对话新建绑定标签 / 复用同工作区空白标签（防堆积）/ Auto / IPC 失败；
 * - 对话绑定不被改写：切换工作区不调用 conversation.setWorkspaceUri，
 *   当前对话 workspaceUri 保持不变。
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { ChatStoreState, TabInfo, ConversationSessionSnapshot } from '../types'
import { openWorkspaceInNewConversation } from '../tabActions'
import { setActiveWorkspace as setActiveWorkspaceAction } from '../configActions'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '../../../utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

const WS_A = 'file:///c%3A/Users/foo/ProjectA'
const WS_B = 'file:///c%3A/Users/foo/ProjectB'

function createState(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    currentConversationId: ref(null),
    allMessages: ref([]),
    currentWorkspaceUri: ref(null),
    fsCaseSensitive: ref(false),
    openTabs: ref<TabInfo[]>([]),
    activeTabId: ref<string | null>(null),
    sessionSnapshots: ref(new Map<string, ConversationSessionSnapshot>()),
    ...overrides
  } as unknown as ChatStoreState
}

function blankSnapshot(workspaceUri: string | null): ConversationSessionSnapshot {
  return {
    conversationId: null,
    workspaceUri,
    allMessages: [],
    windowStartIndex: 0,
    totalMessages: 0,
    configId: '',
    selectedModelId: '',
    isLoadingMoreMessages: false,
    isStreaming: false,
    isLoading: false,
    streamingMessageId: null,
    activeStreamId: null,
    isWaitingForResponse: false,
    checkpoints: [],
    activeBuild: null,
    error: null,
    retryStatus: null,
    autoSummaryStatus: null,
    historyFolded: false,
    foldedMessageCount: 0,
    inputValue: '',
    pendingModelOverride: null,
    editorNodes: [],
    attachments: [],
    messageQueue: [],
    currentPromptModeId: 'code',
    toolResponseCache: [],
    pendingBranchRefreshAfterStream: null,
    pendingBranchReplayContext: null,
    failedStreamMessageId: null,
    lastCancelledStreamId: null,
    lastApprovalGatedStreamId: null,
    branchGraph: null
  }
}

describe('openWorkspaceInNewConversation（切换工作区 = 打开绑定新工作区的新对话）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('目标与当前工作区相同：no-op，不发 IPC、不建标签', async () => {
    const state = createState({
      currentConversationId: ref('conv-a'),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([{ id: 'tab-1', conversationId: 'conv-a', title: 'A', isStreaming: false }]),
      activeTabId: ref('tab-1')
    })
    const sendWorkspaceSetActive = vi.fn()
    const switchTab = vi.fn()

    await openWorkspaceInNewConversation(state, WS_A, { switchTab, sendWorkspaceSetActive })

    expect(sendWorkspaceSetActive).not.toHaveBeenCalled()
    expect(switchTab).not.toHaveBeenCalled()
    expect(state.openTabs.value).toHaveLength(1)
  })

  it('空白标签页（未创建对话）：直接重定位工作区上下文，不新建标签', async () => {
    const state = createState({
      currentConversationId: ref(null),
      allMessages: ref([]),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([{ id: 'tab-1', conversationId: null, title: 'New Chat', isStreaming: false }]),
      activeTabId: ref('tab-1')
    })
    const sendWorkspaceSetActive = vi.fn().mockResolvedValue({ activeWorkspaceUri: WS_B })
    const switchTab = vi.fn()

    await openWorkspaceInNewConversation(state, WS_B, { switchTab, sendWorkspaceSetActive })

    expect(sendWorkspaceSetActive).toHaveBeenCalledWith(WS_B)
    expect(state.openTabs.value).toHaveLength(1)
    expect(state.activeTabId.value).toBe('tab-1')
    expect(state.currentWorkspaceUri.value).toBe(WS_B)
  })

  it('已有对话：新建空白标签并切换，当前对话绑定不被改写', async () => {
    const state = createState({
      currentConversationId: ref('conv-a'),
      allMessages: ref([{ id: 'm1' }]),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([{ id: 'tab-1', conversationId: 'conv-a', title: 'A', isStreaming: false }]),
      activeTabId: ref('tab-1')
    })
    const sendWorkspaceSetActive = vi.fn().mockResolvedValue({ activeWorkspaceUri: WS_B })
    let switchedTo: string | null = null
    const switchTab = vi.fn((tabId: string) => {
      switchedTo = tabId
      state.activeTabId.value = tabId
    })

    await openWorkspaceInNewConversation(state, WS_B, { switchTab, sendWorkspaceSetActive })

    expect(state.openTabs.value).toHaveLength(2)
    const newTab = state.openTabs.value[1]
    expect(newTab.conversationId).toBeNull()
    expect(switchedTo).toBe(newTab.id)
    expect(state.currentWorkspaceUri.value).toBe(WS_B)
  })

  it('复用已打开的同工作区空白标签页：不新建标签（防标签堆积）', async () => {
    const state = createState({
      currentConversationId: ref('conv-a'),
      allMessages: ref([{ id: 'm1' }]),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([
        { id: 'tab-1', conversationId: 'conv-a', title: 'A', isStreaming: false },
        { id: 'tab-blank-b', conversationId: null, title: 'New Chat', isStreaming: false }
      ]),
      activeTabId: ref('tab-1'),
      sessionSnapshots: ref(
        new Map<string, ConversationSessionSnapshot>([
          ['tab-blank-b', blankSnapshot(WS_B)]
        ])
      )
    })
    const sendWorkspaceSetActive = vi.fn().mockResolvedValue({ activeWorkspaceUri: WS_B })
    const switchTab = vi.fn()

    await openWorkspaceInNewConversation(state, WS_B, { switchTab, sendWorkspaceSetActive })

    expect(state.openTabs.value).toHaveLength(2)
    expect(switchTab).toHaveBeenCalledWith('tab-blank-b')
    expect(state.currentWorkspaceUri.value).toBe(WS_B)
  })

  it('Auto（null）：已有对话时打开跟随活动编辑器的新空白标签', async () => {
    const state = createState({
      currentConversationId: ref('conv-a'),
      allMessages: ref([{ id: 'm1' }]),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([{ id: 'tab-1', conversationId: 'conv-a', title: 'A', isStreaming: false }]),
      activeTabId: ref('tab-1')
    })
    const sendWorkspaceSetActive = vi.fn().mockResolvedValue({ activeWorkspaceUri: null })
    const switchTab = vi.fn()

    await openWorkspaceInNewConversation(state, null, { switchTab, sendWorkspaceSetActive })

    expect(state.openTabs.value).toHaveLength(2)
    expect(state.currentWorkspaceUri.value).toBeNull()
  })

  it('IPC 失败（返回 null）：不新建标签、不动工作区上下文', async () => {
    const state = createState({
      currentConversationId: ref('conv-a'),
      allMessages: ref([{ id: 'm1' }]),
      currentWorkspaceUri: ref(WS_A),
      openTabs: ref([{ id: 'tab-1', conversationId: 'conv-a', title: 'A', isStreaming: false }]),
      activeTabId: ref('tab-1')
    })
    const sendWorkspaceSetActive = vi.fn().mockResolvedValue(null)
    const switchTab = vi.fn()

    await openWorkspaceInNewConversation(state, WS_B, { switchTab, sendWorkspaceSetActive })

    expect(state.openTabs.value).toHaveLength(1)
    expect(switchTab).not.toHaveBeenCalled()
    expect(state.currentWorkspaceUri.value).toBe(WS_A)
  })
})

describe('setActiveWorkspace（config 层）：不再改写对话绑定', () => {
  it('切换工作区不调用 conversation.setWorkspaceUri，当前对话绑定与 store 保持不变', async () => {
    const state = createState({
      currentConversationId: ref('conv-locked'),
      conversations: ref([
        {
          id: 'conv-locked',
          title: 'T',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
          isPersisted: true,
          workspaceUri: WS_A
        }
      ]),
      currentWorkspaceUri: ref(WS_A)
    }) as ChatStoreState & { conversations: any }
    mockSend.mockResolvedValue({ success: true, activeWorkspaceUri: WS_B })

    const resp = await setActiveWorkspaceAction(state, WS_B)

    expect(resp?.activeWorkspaceUri).toBe(WS_B)
    const rebindCalls = mockSend.mock.calls.filter(c => c[0] === 'conversation.setWorkspaceUri')
    expect(rebindCalls).toHaveLength(0)
    expect(state.conversations.value[0].workspaceUri).toBe(WS_A)
    // store 的工作区上下文由标签页流程在快照之后设置，本函数不触碰
    expect(state.currentWorkspaceUri.value).toBe(WS_A)
  })
})
