/**
 * conversationActions 测试（HIS-09 / HIS-10 / HIS-13 前端部分）
 *
 * 覆盖：
 * - loadMoreConversations 改为一次 IPC 批量拉摘要（conversation.getConversationMetadataBatch）；
 * - updateConversationAfterMessage 合并为一次 conversation.updateSummary 写入；
 * - loadHistory 首屏先渲染最后一页，再异步补拉更早历史（HIS-13）。
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Content, CheckpointRecord } from '../../../types'
import type { ChatStoreState } from '../types'
import {
  loadMoreConversations,
  updateConversationAfterMessage,
  loadHistory,
  loadCheckpoints,
  renameConversationTitle,
  MESSAGES_PAGE_SIZE
} from '../conversationActions'

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
    _pendingBranchRefreshAfterStream: ref<string | null>(null),
    _pendingBranchReplayContext: ref(null),
    openTabs: ref([]),
    activeTabId: ref(null),
    sessionSnapshots: ref(new Map()),
    backgroundStreamBuffers: ref(new Map()),
    ...overrides
  } as unknown as ChatStoreState
}

function makePageContent(index: number, text: string): Content {
  return {
    role: 'user',
    parts: [{ text }],
    index,
    id: `msg-${index}`
  } as unknown as Content
}

describe('loadMoreConversations（HIS-10）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('一次 IPC 批量拉取一页摘要并合并到列表', async () => {
    const state = createState({
      persistedConversationIds: ref(['conv-a', 'conv-b']),
      persistedConversationsLoaded: ref(0)
    })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.getConversationMetadataBatch') {
        return Promise.resolve([
          { id: 'conv-a', title: 'Alpha', createdAt: 1000, updatedAt: 2000, messageCount: 7, preview: 'hi alpha', workspaceUri: 'file:///ws' },
          { id: 'conv-b', title: 'Beta', createdAt: 1001, updatedAt: 2001, messageCount: 3, integrityStatus: 'ok' }
        ])
      }
      return Promise.resolve([])
    })

    await loadMoreConversations(state, { initial: true, pageSize: 30 })

    // 只发了一次批量 IPC
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('conversation.getConversationMetadataBatch', {
      conversationIds: ['conv-a', 'conv-b']
    })

    expect(state.conversations.value).toHaveLength(2)
    const convA = state.conversations.value.find(c => c.id === 'conv-a')!
    expect(convA.title).toBe('Alpha')
    expect(convA.messageCount).toBe(7)
    expect(convA.preview).toBe('hi alpha')
    expect(convA.workspaceUri).toBe('file:///ws')
    expect(convA.isPersisted).toBe(true)
    expect(state.persistedConversationsLoaded.value).toBe(2)
  })

  it('缺失字段回退默认值（title/messageCount），不抛错', async () => {
    const state = createState({
      persistedConversationIds: ref(['conv-x']),
      persistedConversationsLoaded: ref(0)
    })
    mockSend.mockResolvedValue([{ id: 'conv-x' }])

    await loadMoreConversations(state, { initial: true, pageSize: 30 })

    const conv = state.conversations.value[0]
    expect(conv.title).toContain('Chat')
    expect(conv.messageCount).toBe(0)
  })

  it('批量结果少于请求（后端截断/部分返回）时游标按实际返回数量前进（L3）', async () => {
    const state = createState({
      persistedConversationIds: ref(['conv-a', 'conv-b', 'conv-c']),
      persistedConversationsLoaded: ref(0)
    })
    // 后端只返回前 2 条（如 getConversationMetadataBatch 200 截断 / 部分失败）
    mockSend.mockResolvedValue([
      { id: 'conv-a', title: 'Alpha' },
      { id: 'conv-b', title: 'Beta' }
    ])

    await loadMoreConversations(state, { initial: true, pageSize: 30 })

    // 游标前进 2（实际返回数），而不是 3（请求数）——未返回的 conv-c 不会被跳过
    expect(state.persistedConversationsLoaded.value).toBe(2)
    expect(state.conversations.value).toHaveLength(2)

    mockSend.mockResolvedValue([{ id: 'conv-c', title: 'Gamma' }])
    await loadMoreConversations(state, { initial: false, pageSize: 30 })

    expect(state.persistedConversationsLoaded.value).toBe(3)
    expect(state.conversations.value.map(c => c.id).sort()).toEqual(['conv-a', 'conv-b', 'conv-c'])
  })

  it('批量 IPC 返回非数组（异常）时不前进游标，可重试', async () => {
    const state = createState({
      persistedConversationIds: ref(['conv-a', 'conv-b']),
      persistedConversationsLoaded: ref(0)
    })
    mockSend.mockResolvedValue(undefined)

    await loadMoreConversations(state, { initial: true, pageSize: 30 })

    expect(state.persistedConversationsLoaded.value).toBe(0)
    expect(state.conversations.value).toHaveLength(0)
  })
})

describe('updateConversationAfterMessage（HIS-09）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('合并为一次 conversation.updateSummary 写入', async () => {
    const state = createState({
      currentConversationId: ref('conv-1'),
      conversations: ref([{ id: 'conv-1', title: 'T', isPersisted: true, createdAt: 1, updatedAt: 1, messageCount: 0 } as any]),
      allMessages: ref([
        { id: 'm1', role: 'assistant', content: 'reply', isFunctionResponse: false },
        { id: 'm2', role: 'user', content: 'last user msg', isFunctionResponse: false }
      ] as any),
      windowStartIndex: ref(10),
      totalMessages: ref(10)
    })
    mockSend.mockResolvedValue({ success: true })

    await updateConversationAfterMessage(state)

    // 只发一次 IPC（合并 messageCount + preview），不再分别 setCustomMetadata 三次
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('conversation.updateSummary', {
      conversationId: 'conv-1',
      messageCount: 12,
      preview: 'last user msg'
    })
    const conv = state.conversations.value[0]
    expect(conv.preview).toBe('last user msg')
    expect(conv.messageCount).toBe(12)
  })

  it('IPC 失败时不更新本地计数（M3）：避免与后端永久不一致', async () => {
    const state = createState({
      currentConversationId: ref('conv-1'),
      conversations: ref([{ id: 'conv-1', title: 'T', isPersisted: true, createdAt: 1, updatedAt: 1, messageCount: 0 } as any]),
      allMessages: ref([
        { id: 'm1', role: 'assistant', content: 'reply', isFunctionResponse: false },
        { id: 'm2', role: 'user', content: 'last user msg', isFunctionResponse: false }
      ] as any),
      windowStartIndex: ref(10),
      totalMessages: ref(10)
    })
    mockSend.mockRejectedValue(new Error('ipc failed'))

    await updateConversationAfterMessage(state)

    const conv = state.conversations.value[0]
    expect(conv.messageCount).toBe(0)
    expect(conv.updatedAt).toBe(1)
    expect(conv.preview).toBeUndefined()
    expect(state.totalMessages.value).toBe(10)
  })
})

describe('loadHistory 首屏先渲染再异步补拉（HIS-13）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('loadHistory 返回时已渲染最后一页；随后异步补拉更早历史', async () => {
    const state = createState({
      currentConversationId: ref('conv-1')
    })

    mockSend.mockImplementation((command: string, payload: any) => {
      if (command === 'conversation.getMessagesPaged') {
        const beforeIndex: number | undefined = payload?.beforeIndex
        const total = 300
        if (beforeIndex === undefined) {
          // 最后一页：index 290-299
          const messages = Array.from({ length: 10 }, (_, i) => makePageContent(290 + i, `tail-${i}`))
          return Promise.resolve({ total, messages })
        }
        // 补拉更早页：beforeIndex 之前 10 条
        const start = Math.max(0, beforeIndex - 10)
        const messages = Array.from({ length: 10 }, (_, i) => makePageContent(start + i, `older-${start + i}`))
        return Promise.resolve({ total, messages })
      }
      return Promise.resolve(undefined)
    })

    await loadHistory(state)

    // 首屏：只有最后一页 10 条，窗口起点 290
    expect(state.allMessages.value).toHaveLength(10)
    expect(state.windowStartIndex.value).toBe(290)
    expect(state.totalMessages.value).toBeGreaterThanOrEqual(300)

    // 异步补拉完成后窗口扩大（>= MIN_INITIAL_VISIBLE_MESSAGES=40）
    await vi.waitFor(() => {
      expect(state.allMessages.value.length).toBeGreaterThanOrEqual(40)
      expect(state.windowStartIndex.value).toBeLessThan(290)
    }, { timeout: 2000 })
  })

  it('分页 IPC 使用 MESSAGES_PAGE_SIZE', async () => {
    const state = createState({ currentConversationId: ref('conv-1') })
    mockSend.mockImplementation((command: string) => {
      if (command === 'conversation.getMessagesPaged') {
        return Promise.resolve({
          total: 5,
          messages: Array.from({ length: 5 }, (_, i) => makePageContent(i, `m${i}`))
        })
      }
      return Promise.resolve(undefined)
    })

    await loadHistory(state)

    const pageCall = mockSend.mock.calls.find((c: any[]) => c[0] === 'conversation.getMessagesPaged')
    expect(pageCall).toBeTruthy()
    expect(pageCall![1].limit).toBe(MESSAGES_PAGE_SIZE)
  })

  it('补拉失败（返回 null/undefined）不是“已到历史开头”：保留原窗口（L2）', async () => {
    const state = createState({ currentConversationId: ref('conv-1') })
    mockSend.mockImplementation((command: string, payload: any) => {
      if (command === 'conversation.getMessagesPaged') {
        if (payload?.beforeIndex === undefined) {
          return Promise.resolve({
            total: 300,
            messages: Array.from({ length: 10 }, (_, i) => makePageContent(290 + i, `tail-${i}`))
          })
        }
        return Promise.resolve(undefined) // IPC 失败/异常信号
      }
      return Promise.resolve(undefined)
    })

    await loadHistory(state)
    expect(state.allMessages.value).toHaveLength(10)
    expect(state.windowStartIndex.value).toBe(290)

    // 给补拉足够时间完成（失败 → 放弃合并）
    await new Promise(resolve => setTimeout(resolve, 100))
    // 窗口未被“合并”，也没有被误判为已到开头（windowStartIndex 保持 290，不为 0）
    expect(state.allMessages.value).toHaveLength(10)
    expect(state.windowStartIndex.value).toBe(290)
  })

  it('补拉期间窗口被新消息改动：放弃合并，保留新窗口（M6）', async () => {
    const state = createState({ currentConversationId: ref('conv-1') })
    mockSend.mockImplementation((command: string, payload: any) => {
      if (command === 'conversation.getMessagesPaged') {
        const beforeIndex: number | undefined = payload?.beforeIndex
        const total = 300
        if (beforeIndex === undefined) {
          return Promise.resolve({
            total,
            messages: Array.from({ length: 10 }, (_, i) => makePageContent(290 + i, `tail-${i}`))
          })
        }
        // 补拉页延迟返回，给并发修改留出时间窗
        return new Promise(resolve => setTimeout(() => {
          const start = Math.max(0, beforeIndex - 10)
          resolve({
            total,
            messages: Array.from({ length: 10 }, (_, i) => makePageContent(start + i, `older-${start + i}`))
          })
        }, 50))
      }
      return Promise.resolve(undefined)
    })

    await loadHistory(state)
    expect(state.allMessages.value).toHaveLength(10)

    // 模拟流式期间新消息追加（补拉进行中）
    const streamed = { id: 'stream-new', role: 'assistant', content: 'new', isFunctionResponse: false }
    state.allMessages.value.push(streamed as any)

    // 等补拉完成：合并被放弃，新消息仍在窗口末尾，windowStartIndex 未回退
    await vi.waitFor(() => {
      expect(state.allMessages.value.length).toBe(11)
    }, { timeout: 2000 })
    expect(state.allMessages.value[10].id).toBe('stream-new')
    expect(state.windowStartIndex.value).toBe(290)
  })
})

describe('loadCheckpoints（L-8）', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('成功后写入后端检查点列表', async () => {
    mockSend.mockResolvedValue({
      checkpoints: [{ id: 'cp_1', messageIndex: 3, phase: 'before' }]
    })
    const state = createState({ currentConversationId: ref('conv-1') })

    await loadCheckpoints(state)

    expect(mockSend).toHaveBeenCalledWith('checkpoint.getCheckpoints', { conversationId: 'conv-1' })
    expect(state.checkpoints.value).toEqual([{ id: 'cp_1', messageIndex: 3, phase: 'before' }])
  })

  it('加载失败时保留旧值（不静默置空），避免检查点条消失', async () => {
    const existing = [{ id: 'cp_old', messageIndex: 0, phase: 'before' }]
    const state = createState({
      currentConversationId: ref('conv-1'),
      checkpoints: ref(existing as CheckpointRecord[])
    })
    mockSend.mockRejectedValue(new Error('ipc down'))

    await loadCheckpoints(state)

    expect(state.checkpoints.value).toEqual(existing)
  })

  it('无当前对话时清空检查点', async () => {
    const state = createState({
      currentConversationId: ref(null),
      checkpoints: ref([{ id: 'cp_x', messageIndex: 0, phase: 'before' }] as CheckpointRecord[])
    })

    await loadCheckpoints(state)

    expect(state.checkpoints.value).toEqual([])
  })
})

describe('renameConversationTitle', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('IPC 成功后更新列表标题与已打开标签页标题', async () => {
    mockSend.mockResolvedValue({})
    const state = createState({
      conversations: ref([{ id: 'conv-1', title: '旧标题', isPersisted: true } as any]),
      openTabs: ref([{ id: 'tab-1', conversationId: 'conv-1', title: '旧标题' } as any])
    })

    const ok = await renameConversationTitle(state, 'conv-1', '  新标题  ')

    expect(ok).toBe(true)
    expect(mockSend).toHaveBeenCalledWith('conversation.setTitle', {
      conversationId: 'conv-1',
      title: '新标题'
    })
    expect(state.conversations.value[0].title).toBe('新标题')
    expect(state.openTabs.value[0].title).toBe('新标题')
  })

  it('空白标题或未变标题不发送 IPC', async () => {
    const state = createState({
      conversations: ref([{ id: 'conv-1', title: '旧标题', isPersisted: true } as any])
    })

    expect(await renameConversationTitle(state, 'conv-1', '   ')).toBe(false)
    expect(await renameConversationTitle(state, 'conv-1', '旧标题')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('不存在的对话直接返回 false', async () => {
    const state = createState({ conversations: ref([]) })
    expect(await renameConversationTitle(state, 'ghost', '新标题')).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('IPC 失败时标题保持不变并返回 false', async () => {
    mockSend.mockRejectedValue(new Error('ipc down'))
    const state = createState({
      conversations: ref([{ id: 'conv-1', title: '旧标题', isPersisted: true } as any])
    })

    const ok = await renameConversationTitle(state, 'conv-1', '新标题')

    expect(ok).toBe(false)
    expect(state.conversations.value[0].title).toBe('旧标题')
    expect(state.error.value?.code).toBe('RENAME_CONVERSATION_ERROR')
  })
})
