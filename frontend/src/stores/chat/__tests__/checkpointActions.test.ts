/**
 * checkpointActions 测试
 *
 * 覆盖：
 * - previewRestore 成功透传 / 异常返回错误
 * - restoreCheckpoint 透传 deleteUntrackedFiles（默认 false，#29 保护）
 * - restoreAndRetry 中 deleteMessage 失败中止重试（不调 retryStream、设置错误、重载历史）
 * - restoreAndRetry 成功路径调用 retryStream
 * - restoreAndDelete 中 deleteMessage 失败设置错误并重载历史
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '../../../types'
import type { ChatStoreState } from '../types'
import {
  previewRestore,
  restoreCheckpoint,
  restoreAndRetry,
  restoreAndDelete
} from '../checkpointActions'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

vi.mock('../conversationActions', () => ({
  loadCheckpoints: vi.fn().mockResolvedValue(undefined),
  refreshCurrentConversationBuildSession: vi.fn().mockResolvedValue(undefined),
  loadHistory: vi.fn().mockResolvedValue(undefined)
}))

import { sendToExtension } from '../../../utils/vscode'
import { loadHistory } from '../conversationActions'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>
const loadHistoryMock = vi.mocked(loadHistory)

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
    messageIndexById: ref(new Map()),
    windowStartIndex: ref(0),
    totalMessages: ref(0),
    isLoading: ref(false),
    isStreaming: ref(false),
    isWaitingForResponse: ref(false),
    error: ref(null),
    streamingMessageId: ref<string | null>(null),
    activeStreamId: ref<string | null>(null),
    checkpoints: ref([]),
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
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
    ...overrides
  } as unknown as ChatStoreState
}

describe('previewRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('透传后端预览结果（含两类删除清单）', async () => {
    mockSend.mockResolvedValue({
      success: true,
      restored: 2,
      deleted: 1,
      skipped: 3,
      deletablePaths: ['a.txt'],
      untrackedPaths: ['b.txt']
    })
    const state = createState()
    const result = await previewRestore(state, 'cp_1')

    expect(result.success).toBe(true)
    expect(result.deletablePaths).toEqual(['a.txt'])
    expect(result.untrackedPaths).toEqual(['b.txt'])
    expect(mockSend).toHaveBeenCalledWith('checkpoint.previewRestore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1'
    })
  })

  it('后端异常时返回错误结果', async () => {
    mockSend.mockRejectedValue(new Error('boom'))
    const state = createState()
    const result = await previewRestore(state, 'cp_1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
    expect(result.deletablePaths).toEqual([])
  })
})

describe('restoreCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('确认后透传 deleteUntrackedFiles=true', async () => {
    mockSend.mockResolvedValue({ success: true, restored: 1, deleted: 0, skipped: 0 })
    const state = createState()
    await restoreCheckpoint(state, 'cp_1', true)

    expect(mockSend).toHaveBeenCalledWith('checkpoint.restore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1',
      deleteUntrackedFiles: true
    })
  })

  it('未确认时默认 deleteUntrackedFiles=false（#29 保护）', async () => {
    mockSend.mockResolvedValue({ success: true, restored: 1, deleted: 0, skipped: 0 })
    const state = createState()
    await restoreCheckpoint(state, 'cp_1')

    expect(mockSend).toHaveBeenCalledWith('checkpoint.restore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1',
      deleteUntrackedFiles: false
    })
  })
})

describe('restoreAndRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deleteMessage 失败时中止重试、设置错误并重载历史', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: false }) // deleteMessage

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ])
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {})

    // retryStream 不应被调用（中止重试）
    const retryCall = mockSend.mock.calls.find(c => c[0] === 'retryStream')
    expect(retryCall).toBeUndefined()
    // deleteMessage 确实被调用
    expect(mockSend).toHaveBeenCalledWith('deleteMessage', expect.objectContaining({ targetIndex: 1 }))
    // 错误提示 + 历史重载（本地已截断而后端未删，拉回一致）
    expect(state.error.value).not.toBeNull()
    expect(loadHistoryMock).toHaveBeenCalled()
  })

  it('deleteMessage 成功后调用 retryStream', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: true }) // deleteMessage

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ])
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {})

    expect(mockSend).toHaveBeenCalledWith('retryStream', expect.objectContaining({ conversationId: 'conv_1' }))
    // 成功路径不重载历史
    expect(loadHistoryMock).not.toHaveBeenCalled()
  })

  it('未确认时不向 restoreCheckpoint 传递删除快照后新建文件', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 })
      .mockResolvedValueOnce({ success: true })

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ])
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {})

    const restoreCall = mockSend.mock.calls.find(c => c[0] === 'checkpoint.restore')
    expect(restoreCall).toBeDefined()
    expect(restoreCall![1]).toMatchObject({ checkpointId: 'cp_1', deleteUntrackedFiles: false })
  })

  it('确认后向 restoreCheckpoint 传递删除快照后新建文件', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 })
      .mockResolvedValueOnce({ success: true })

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ])
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {}, true)

    const restoreCall = mockSend.mock.calls.find(c => c[0] === 'checkpoint.restore')
    expect(restoreCall![1]).toMatchObject({ checkpointId: 'cp_1', deleteUntrackedFiles: true })
  })
})

describe('restoreAndDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deleteMessage 失败时设置错误并重载历史', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: false }) // deleteMessage

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ])
    })

    await restoreAndDelete(state, 1, 'cp_1', async () => {})

    expect(state.error.value).not.toBeNull()
    expect(loadHistoryMock).toHaveBeenCalled()
  })
})
