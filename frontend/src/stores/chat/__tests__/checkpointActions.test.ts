/**
 * checkpointActions 测试
 *
 * 覆盖：
 * - previewRestore 成功透传 / 异常返回错误
 * - restoreCheckpoint 透传 deleteUntrackedFiles（默认 false，#29 保护）
 * - restoreAndRetry 中 deleteMessage 失败中止重试（不调 retryStream、设置错误、重载历史+检查点）
 * - restoreAndRetry 成功路径调用 retryStream
 * - restoreAndDelete 中 deleteMessage 失败设置错误并重载历史+检查点
 * - restoreAndEdit 成功 / 失败重载兜底 / 附件序列化
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Message, Attachment } from '../../../types'
import type { ChatStoreState } from '../types'
import {
  previewRestore,
  restoreCheckpoint,
  restoreAndRetry,
  restoreAndDelete,
  restoreAndEdit,
  // L-2: summarize 职责已迁至 messageActions，此处验证 checkpointActions 的 re-export 兼容路径
  summarizeContext,
  cancelSummarizeRequest,
  // EX-11: checkpoint.getManifest 前端调用方
  getCheckpointManifest
} from '../checkpointActions'
import { pendingDirtyConfirm, clearPendingDirtyConfirm } from '../dirtyConfirmState'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

vi.mock('../conversationActions', () => ({
  loadCheckpoints: vi.fn().mockResolvedValue(undefined),
  refreshCurrentConversationBuildSession: vi.fn().mockResolvedValue(undefined),
  loadHistory: vi.fn().mockResolvedValue(undefined)
}))

import { sendToExtension } from '../../../utils/vscode'
import { loadHistory, loadCheckpoints } from '../conversationActions'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>
const loadHistoryMock = vi.mocked(loadHistory)
const loadCheckpointsMock = vi.mocked(loadCheckpoints)

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

  it('恢复成功后无条件刷新检查点列表（R3-#14，即使无 autoPrune）', async () => {
    mockSend.mockResolvedValue({ success: true, restored: 1, deleted: 0, skipped: 0 })
    const state = createState()
    await restoreCheckpoint(state, 'cp_1', true)

    expect(loadCheckpointsMock).toHaveBeenCalled()
  })

  it('恢复失败时不刷新检查点列表（R3-#14）', async () => {
    mockSend.mockResolvedValue({ success: false, restored: 0, error: 'boom' })
    const state = createState()
    await restoreCheckpoint(state, 'cp_1', true)

    expect(loadCheckpointsMock).not.toHaveBeenCalled()
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
    // H-3 兼容：restoreAndRetry 的 deleteMessage 失败设置 DELETE_MESSAGE_ERROR
    //（非可重试错误码，错误条不显示“重试”，不会触发 LLM 重新生成）
    expect(state.error.value?.code).toBe('DELETE_MESSAGE_ERROR')
    expect(loadHistoryMock).toHaveBeenCalled()
    // M-2: 失败重载时同步重载检查点，避免存档条消失（前后端不一致）
    expect(loadCheckpointsMock).toHaveBeenCalled()
  })

  it('cancel 期间对话切换后不写入错误（M-8 身份隔离）', async () => {
    mockSend.mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 })

    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ]),
      isStreaming: ref(true)
    })

    // cancel 期间切换到另一个对话：后续写操作必须被身份校验拦截
    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {
      state.currentConversationId.value = 'conv_2'
    })

    expect(state.error.value).toBeNull()
    expect(mockSend.mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
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
    // M-2: 失败重载时同步重载检查点，避免存档条消失（前后端不一致）
    expect(loadCheckpointsMock).toHaveBeenCalled()
  })
})

describe('restoreAndRetry（R3-#13：按 id 定位重算索引）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清空未消费的 mockResolvedValueOnce，避免泄漏到后续测试
    mockSend.mockReset()
  })

  it('cancel 期间数组前插消息后按 id 定位目标并重算索引', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: true }) // deleteMessage

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ]),
      isStreaming: ref(true)
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {
      // cancel 期间数组前插一条消息：原下标 1 现在指向 m0，目标 m1 移到下标 2
      state.allMessages.value = [
        createMessage({ id: 'm_new', role: 'user', content: 'new', backendIndex: 99 }),
        state.allMessages.value[0],
        state.allMessages.value[1]
      ]
    })

    // deleteMessage 应使用 m1 的后端索引（1），而非前插后错位的下标
    expect(mockSend).toHaveBeenCalledWith('deleteMessage', expect.objectContaining({ targetIndex: 1 }))
    // 本地切片保留到 m1 之前（m_new 与 m0 保留，m1 被截断），随后追加流式助手消息
    const ids = state.allMessages.value.map(m => m.id)
    expect(ids.slice(0, 2)).toEqual(['m_new', 'm0'])
    expect(state.allMessages.value[2].streaming).toBe(true)
    // 成功路径仍触发重试
    expect(mockSend).toHaveBeenCalledWith('retryStream', expect.objectContaining({ conversationId: 'conv_1' }))
  })

  it('目标消息已不在数组中时中止（不发送删除/重试）', async () => {
    // 用基础实现（非 Once）：本测试不触发任何 IPC，避免未消费的 Once 泄漏到后续测试
    mockSend.mockResolvedValue({ success: true, restored: 1, deleted: 0, skipped: 0 })

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ]),
      isStreaming: ref(true)
    })

    await restoreAndRetry(state, 1, 'cp_1', 'model-x', async () => {
      // cancel 期间目标消息被移除
      state.allMessages.value = [state.allMessages.value[0]]
    })

    expect(mockSend.mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
    expect(mockSend.mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(loadHistoryMock).not.toHaveBeenCalled()
  })
})

describe('restoreAndDelete（R3-#13：按 id 定位重算索引）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 清空未消费的 mockResolvedValueOnce，避免泄漏到后续测试
    mockSend.mockReset()
  })

  it('cancel 期间数组前插消息后按 id 定位目标并重算索引', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: true }) // deleteMessage

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'assistant', content: 'ok', backendIndex: 1 })
      ]),
      isStreaming: ref(true)
    })

    await restoreAndDelete(state, 1, 'cp_1', async () => {
      // cancel 期间数组前插一条消息：目标 m1 移到下标 2
      state.allMessages.value = [
        createMessage({ id: 'm_new', role: 'user', content: 'new', backendIndex: 99 }),
        state.allMessages.value[0],
        state.allMessages.value[1]
      ]
    })

    expect(mockSend).toHaveBeenCalledWith('deleteMessage', expect.objectContaining({ targetIndex: 1 }))
    expect(state.allMessages.value.map(m => m.id)).toEqual(['m_new', 'm0'])
  })
})

describe('summarizeContext（L-2：实现已迁至 messageActions，checkpointActions re-export）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功后调用后端并重载历史', async () => {
    mockSend.mockResolvedValue({ success: true, summaryContent: '...', summarizedMessageCount: 5 })
    const loadHistoryFn = vi.fn().mockResolvedValue(undefined)
    const state = createState()
    const result = await summarizeContext(state, loadHistoryFn)

    expect(result.success).toBe(true)
    expect(result.summarizedMessageCount).toBe(5)
    expect(mockSend).toHaveBeenCalledWith('summarizeContext', {
      conversationId: 'conv_1',
      configId: 'cfg_1'
    })
    expect(loadHistoryFn).toHaveBeenCalled()
    // 结束后清除总结状态
    expect(state.autoSummaryStatus.value).toBeNull()
  })

  it('后端返回失败时透传错误码与信息', async () => {
    mockSend.mockResolvedValue({ success: false, error: { code: 'SUMMARIZE_BUSY', message: 'boom' } })
    const result = await summarizeContext(createState(), async () => {})
    expect(result).toEqual({ success: false, errorCode: 'SUMMARIZE_BUSY', error: 'boom' })
  })

  it('无对话时直接返回 NO_CONVERSATION', async () => {
    const state = createState({ currentConversationId: ref(null) })
    const result = await summarizeContext(state, async () => {})
    expect(result).toEqual({ success: false, errorCode: 'NO_CONVERSATION', error: 'No conversation selected' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('对话切换后清理写入原对话标签页快照（跨对话隔离）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      openTabs: ref([{ id: 'tab_1', conversationId: 'conv_1' } as any]),
      sessionSnapshots: ref(new Map([['tab_1', { autoSummaryStatus: { isSummarizing: false } } as any]]))
    })
    // 模拟请求期间切换到另一个对话
    mockSend.mockImplementationOnce(async () => {
      state.currentConversationId.value = 'conv_2'
      return { success: true, summaryContent: 's', summarizedMessageCount: 1 }
    })
    await summarizeContext(state, async () => {})

    // 切换后 finally 清理写入原对话标签页快照（而非当前会话），实现跨对话隔离
    expect(state.sessionSnapshots.value.get('tab_1')!.autoSummaryStatus).toBeNull()
  })
})

describe('cancelSummarizeRequest（L-2：re-export 路径）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('调用后端取消接口', async () => {
    await cancelSummarizeRequest(createState())
    expect(mockSend).toHaveBeenCalledWith('cancelSummarizeRequest', { conversationId: 'conv_1' })
  })

  it('无对话时直接返回', async () => {
    await cancelSummarizeRequest(createState({ currentConversationId: ref(null) }))
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('后端异常时静默吞掉（不抛出）', async () => {
    mockSend.mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(cancelSummarizeRequest(createState())).resolves.toBeUndefined()
    spy.mockRestore()
  })
})

describe('getCheckpointManifest（EX-11 / L-9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('透传后端 manifest（含排除统计与规则快照）', async () => {
    const manifest = {
      version: 2,
      checkpointId: 'cp_1',
      excludedCount: 42,
      ignoreSnapshot: {
        version: 2,
        forcedRulesVersion: 1,
        defaultProfileVersion: 1,
        enabledProfiles: { logs: true },
        maxFileSizeBytes: 0,
        customPatterns: []
      }
    }
    mockSend.mockResolvedValue({ manifest })
    const result = await getCheckpointManifest('cp_1')

    expect(result).toEqual({ manifest })
    expect(mockSend).toHaveBeenCalledWith('checkpoint.getManifest', { checkpointId: 'cp_1' })
  })

  it('旧存档（后端返回 manifest null）原样透传，提示不可用', async () => {
    mockSend.mockResolvedValue({ manifest: null })
    const result = await getCheckpointManifest('cp_legacy')
    expect(result).toEqual({ manifest: null })
  })

  it('后端异常时返回错误信息（不抛出）', async () => {
    mockSend.mockRejectedValue(new Error('ipc down'))
    const result = await getCheckpointManifest('cp_1')
    expect(result.manifest).toBeNull()
    expect(result.error).toBe('ipc down')
  })
})

describe('restoreAndEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功后改写本地消息并调用 editAndRetryStream（无附件）', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: true }) // editAndRetryStream

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'user', content: 'old', backendIndex: 1 })
      ])
    })

    await restoreAndEdit(state, 1, 'edited content', undefined, 'cp_1', 'model-x', async () => {})

    const editCall = mockSend.mock.calls.find(c => c[0] === 'editAndRetryStream')
    expect(editCall).toBeDefined()
    expect(editCall![1]).toMatchObject({
      conversationId: 'conv_1',
      messageIndex: 1,
      preserveCheckpointId: 'cp_1',
      newMessage: 'edited content',
      configId: 'cfg_1'
    })
    expect(editCall![1].attachments).toBeUndefined()
    // 本地消息已改写并截断后续消息，随后追加流式助手消息
    expect(state.allMessages.value[1].content).toBe('edited content')
    expect(state.allMessages.value).toHaveLength(3)
    expect(state.allMessages.value[2].role).toBe('assistant')
    expect(state.allMessages.value[2].streaming).toBe(true)
    expect(state.isStreaming.value).toBe(true)
  })

  it('附件序列化为纯对象后透传', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockResolvedValueOnce({ success: true }) // editAndRetryStream

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'user', content: 'old', backendIndex: 1 })
      ])
    })

    const attachments: Attachment[] = [
      { id: 'att_1', name: 'a.png', type: 'image', size: 10, mimeType: 'image/png', data: 'base64data', thumbnail: 'thumb' }
    ]
    await restoreAndEdit(state, 1, 'edited', attachments, 'cp_1', 'model-x', async () => {})

    const editCall = mockSend.mock.calls.find(c => c[0] === 'editAndRetryStream')
    expect(editCall![1].attachments).toEqual([
      { id: 'att_1', name: 'a.png', type: 'image', size: 10, mimeType: 'image/png', data: 'base64data', thumbnail: 'thumb' }
    ])
    expect(state.allMessages.value[1].attachments).toEqual(attachments)
  })

  it('后端调用失败时重置流状态并重载历史 + 检查点（M-9）', async () => {
    mockSend
      .mockResolvedValueOnce({ success: true, restored: 1, deleted: 0, skipped: 0 }) // checkpoint.restore
      .mockRejectedValueOnce(new Error('edit backend failed')) // editAndRetryStream

    const state = createState({
      allMessages: ref([
        createMessage({ id: 'm0', role: 'user', content: 'hi', backendIndex: 0 }),
        createMessage({ id: 'm1', role: 'user', content: 'old', backendIndex: 1 })
      ])
    })

    await restoreAndEdit(state, 1, 'edited content', undefined, 'cp_1', 'model-x', async () => {})

    expect(state.error.value).not.toBeNull()
    expect(state.isStreaming.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    // M-9: 本地已截断改写而后端未变，重载恢复前后端一致
    expect(loadHistoryMock).toHaveBeenCalled()
    expect(loadCheckpointsMock).toHaveBeenCalled()
  })
})


describe('BCP-05（决策 11）dirty 拦截与确认（checkpointActions）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPendingDirtyConfirm()
  })

  it('restoreCheckpoint：后端返回 dirtyFiles → 透传 + 登记待确认（entry=restore），不发确认参数', async () => {
    mockSend.mockResolvedValue({ success: false, restored: 0, deleted: 0, skipped: 0, dirtyFiles: ['C:/ws/a.ts'] })
    const state = createState()

    const result = await restoreCheckpoint(state, 'cp_1', true)

    expect(result.success).toBe(false)
    expect(result.dirtyFiles).toEqual(['C:/ws/a.ts'])
    expect(mockSend).toHaveBeenCalledWith('checkpoint.restore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1',
      deleteUntrackedFiles: true
    })
    expect(pendingDirtyConfirm.value).toMatchObject({
      kind: 'restore',
      files: ['C:/ws/a.ts'],
      restore: { entry: 'restore', checkpointId: 'cp_1', deleteUntrackedFiles: true }
    })
    // 未确认时不应刷新检查点（恢复未执行）
    expect(loadCheckpointsMock).not.toHaveBeenCalled()
  })

  it('restoreCheckpoint：confirmedDiscardDirty=true → IPC 携带确认参数，dirty 响应不再登记待确认', async () => {
    mockSend.mockResolvedValue({ success: true, restored: 0, deleted: 0, skipped: 0 })
    const state = createState()

    await restoreCheckpoint(state, 'cp_1', false, true)

    expect(mockSend).toHaveBeenCalledWith('checkpoint.restore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1',
      deleteUntrackedFiles: false,
      confirmedDiscardDirty: true
    })
    expect(pendingDirtyConfirm.value).toBeNull()
  })

  it('restoreAndRetry：恢复被 dirty 拦截 → 登记待确认（entry=retry + messageId），不写错误、不删消息', async () => {
    const message = createMessage({ id: 'msg_target', content: 'hi' })
    const state = createState({ allMessages: ref([message] as Message[]) })
    mockSend.mockResolvedValue({ success: false, restored: 0, dirtyFiles: ['C:/ws/a.ts'] })

    await restoreAndRetry(state, 0, 'cp_1', 'model-x', async () => {})

    expect(state.error.value).toBeNull()
    expect(state.isLoading.value).toBe(false)
    expect(pendingDirtyConfirm.value).toMatchObject({
      kind: 'restore',
      restore: { entry: 'retry', checkpointId: 'cp_1', messageId: 'msg_target' }
    })
    // 未进入删除/重试流程
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0]).toBe('checkpoint.restore')
  })

  it('restoreAndDelete：恢复被 dirty 拦截 → 登记待确认（entry=delete）', async () => {
    const message = createMessage({ id: 'msg_target', content: 'hi' })
    const state = createState({ allMessages: ref([message] as Message[]) })
    mockSend.mockResolvedValue({ success: false, restored: 0, dirtyFiles: ['C:/ws/a.ts'] })

    await restoreAndDelete(state, 0, 'cp_1', async () => {})

    expect(state.error.value).toBeNull()
    expect(pendingDirtyConfirm.value).toMatchObject({
      kind: 'restore',
      restore: { entry: 'delete', checkpointId: 'cp_1', messageId: 'msg_target' }
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('restoreAndEdit：恢复被 dirty 拦截 → 登记待确认（entry=edit + newContent）', async () => {
    const message = createMessage({ id: 'msg_target', content: 'old' })
    const state = createState({ allMessages: ref([message] as Message[]) })
    mockSend.mockResolvedValue({ success: false, restored: 0, dirtyFiles: ['C:/ws/a.ts'] })

    await restoreAndEdit(state, 0, 'new content', undefined, 'cp_1', 'model-x', async () => {})

    expect(state.error.value).toBeNull()
    expect(pendingDirtyConfirm.value).toMatchObject({
      kind: 'restore',
      restore: { entry: 'edit', checkpointId: 'cp_1', messageId: 'msg_target', newContent: 'new content' }
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('restoreAndRetry：confirmedDiscardDirty=true → 内部恢复调用携带确认参数并继续流程', async () => {
    const message = createMessage({ id: 'msg_target', content: 'hi' })
    const state = createState({ allMessages: ref([message] as Message[]) })
    mockSend.mockImplementation((command: string) => {
      if (command === 'checkpoint.restore') {
        return Promise.resolve({ success: true, restored: 1, deleted: 0, skipped: 0 })
      }
      if (command === 'deleteMessage') {
        return Promise.resolve({ success: true })
      }
      if (command === 'retryStream') {
        return Promise.resolve({ success: true })
      }
      return Promise.resolve(undefined)
    })

    await restoreAndRetry(state, 0, 'cp_1', 'model-x', async () => {}, false, true)

    expect(mockSend).toHaveBeenCalledWith('checkpoint.restore', {
      conversationId: 'conv_1',
      checkpointId: 'cp_1',
      deleteUntrackedFiles: false,
      confirmedDiscardDirty: true
    })
    expect(mockSend).toHaveBeenCalledWith('retryStream', expect.objectContaining({ conversationId: 'conv_1' }))
    expect(pendingDirtyConfirm.value).toBeNull()
  })
})