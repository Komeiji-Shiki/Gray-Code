/**
 * 流式失败重试残留回归测试
 *
 * 问题背景：流式过程中后端报错时，后端不会持久化半截 assistant 消息，
 * 但前端窗口会保留有内容的半截消息。点击错误通知上的"重试"（retryAfterError）
 * 之前不会清理该消息，导致重试后窗口/历史出现半截回答残留。
 *
 * 覆盖：
 * - handleError 保留有内容消息并记录 _failedStreamMessageId
 * - handleError 删除空占位消息并清空记录
 * - rollbackFailedStreamMessage 清理半截消息、检查点和记录
 * - dismissError 关闭错误时一并清理半截消息
 * - retryAfterError 重试前回滚半截消息，且不误删"工具响应继续"场景
 * - sendMessage 发送新消息时清理上次失败的半截消息
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, ChatStoreComputed, CheckpointRecord } from '../../stores/chat/types'
import { handleComplete, handleError } from '../../stores/chat/streamChunkHandlers'
import {
  retryAfterError,
  retryFromMessage,
  editAndRetry,
  dismissError,
  rollbackFailedStreamMessage,
  sendMessage,
  RETRYABLE_ERROR_CODES,
  isRetryableError
} from '../../stores/chat/messageActions'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

// FIX-C：mock loadHistory / loadCheckpoints（其余保持真实实现），
// 用于断言 editAndRetry / retryFromMessage 失败路径的重载行为。
vi.mock('../../stores/chat/conversationActions', async () => {
  const actual = await vi.importActual<typeof import('../../stores/chat/conversationActions')>('../../stores/chat/conversationActions')
  return {
    ...actual,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadCheckpoints: vi.fn().mockResolvedValue(undefined)
  }
})

import { sendToExtension } from '../../utils/vscode'
import { loadHistory, loadCheckpoints } from '../../stores/chat/conversationActions'

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
    messageIndexById: undefined as unknown as Ref<Map<string, number>>,
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
    sessionSnapshots: ref(new Map()),
    ...overrides
  } as unknown as ChatStoreState
}

function createComputed(): ChatStoreComputed {
  return {
    currentModelName: ref('test-model')
  } as unknown as ChatStoreComputed
}

const errorChunk = {
  conversationId: 'conv_1',
  type: 'error',
  streamId: 'stream_1',
  error: { code: 'STREAM_ERROR', message: 'network failed' }
} as any

describe('handleError 失败残留记录', () => {
  it('保留有内容的半截消息并记录 _failedStreamMessageId', () => {
    const partial = createMessage({
      id: 'msg_partial',
      role: 'assistant',
      content: '半截回答',
      streaming: true,
      localOnly: true
    })
    const state = createState({
      allMessages: ref([partial]),
      streamingMessageId: ref('msg_partial')
    })

    handleError(errorChunk, state)

    expect(state.allMessages.value).toHaveLength(1)
    expect(state.allMessages.value[0].id).toBe('msg_partial')
    expect(state._failedStreamMessageId.value).toBe('msg_partial')
    expect(state.streamingMessageId.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
  })

  it('删除空占位消息并清空记录', () => {
    const empty = createMessage({
      id: 'msg_empty',
      role: 'assistant',
      content: '',
      streaming: true,
      localOnly: true
    })
    const state = createState({
      allMessages: ref([empty]),
      streamingMessageId: ref('msg_empty')
    })

    handleError(errorChunk, state)

    expect(state.allMessages.value).toHaveLength(0)
    expect(state._failedStreamMessageId.value).toBeNull()
  })

  it('没有 streamingMessageId 时清空记录', () => {
    const state = createState({
      allMessages: ref([createMessage({ id: 'msg_x', content: '历史消息' })]),
      _failedStreamMessageId: ref('stale_id')
    })

    handleError(errorChunk, state)

    expect(state._failedStreamMessageId.value).toBeNull()
  })
})

describe('rollbackFailedStreamMessage', () => {
  it('删除半截消息、清理检查点并清空记录', () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      checkpoints: ref([
        { id: 'cp_0', messageIndex: 0 } as CheckpointRecord,
        { id: 'cp_1', messageIndex: 1 } as CheckpointRecord
      ]),
      totalMessages: ref(2)
    })

    const backendIndex = rollbackFailedStreamMessage(state)

    expect(backendIndex).toBe(1)
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user'])
    expect(state.checkpoints.value.map(cp => cp.messageIndex)).toEqual([0])
    expect(state._failedStreamMessageId.value).toBeNull()
    expect(state.totalMessages.value).toBe(1)
  })

  it('没有记录时返回 -1 且不修改消息', () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const state = createState({
      allMessages: ref([user]),
      _failedStreamMessageId: ref(null)
    })

    expect(rollbackFailedStreamMessage(state)).toBe(-1)
    expect(state.allMessages.value).toHaveLength(1)
  })

  it('记录指向不存在的消息时安全返回 -1', () => {
    const state = createState({
      allMessages: ref([createMessage({ id: 'msg_a', content: 'a' })]),
      _failedStreamMessageId: ref('ghost_id')
    })

    expect(rollbackFailedStreamMessage(state)).toBe(-1)
    expect(state._failedStreamMessageId.value).toBeNull()
  })
})

describe('dismissError', () => {
  it('关闭错误提示时一并清理半截消息', () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      error: ref({ code: 'STREAM_ERROR', message: 'network failed' })
    })

    dismissError(state)

    expect(state.error.value).toBeNull()
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user'])
    expect(state._failedStreamMessageId.value).toBeNull()
  })

  it('没有失败残留时只关闭错误提示', () => {
    const state = createState({
      allMessages: ref([createMessage({ id: 'msg_user', role: 'user', content: '问题' })]),
      error: ref({ code: 'X', message: 'y' })
    })

    dismissError(state)

    expect(state.error.value).toBeNull()
    expect(state.allMessages.value).toHaveLength(1)
  })
})

describe('retryAfterError', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  })

  it('重试前回滚半截消息，重试后窗口只剩历史消息和新占位', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      error: ref({ code: 'STREAM_ERROR', message: 'boom' })
    })

    await retryAfterError(state, createComputed())

    // 半截消息已回滚
    expect(state.allMessages.value.some(m => m.id === 'msg_partial')).toBe(false)
    expect(state._failedStreamMessageId.value).toBeNull()
    // 新占位消息已创建
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value[1].role).toBe('assistant')
    expect(state.allMessages.value[1].streaming).toBe(true)
    // 发起了 retryStream
    const call = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(call).toBeDefined()
  })

  it('没有失败残留时（工具响应继续场景）不删除历史消息', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const toolMsg = createMessage({
      id: 'msg_tool',
      role: 'assistant',
      content: '',
      tools: [{ id: 't1', name: 'write_file', status: 'success' } as any],
      localOnly: false,
      backendIndex: 1
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, toolMsg]),
      _failedStreamMessageId: ref(null)
    })

    await retryAfterError(state, createComputed())

    // 工具消息保留（继续对话语义）
    expect(state.allMessages.value.some(m => m.id === 'msg_tool')).toBe(true)
    expect(state.allMessages.value).toHaveLength(3)
    const call = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(call).toBeDefined()
  })

  it('防御分支：半截消息非 localOnly 时同步删除后端消息', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({
      id: 'msg_partial',
      role: 'assistant',
      content: '半截回答',
      localOnly: false,
      backendIndex: 1
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial')
    })

    await retryAfterError(state, createComputed())

    const deleteCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')
    expect(deleteCall).toBeDefined()
    expect(deleteCall![1]).toMatchObject({ conversationId: 'conv_1', targetIndex: 1 })
  })

  it('H-3：非流式错误码（RESTORE_ERROR）不触发重试、不创建占位消息', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user]),
      error: ref({ code: 'RESTORE_ERROR', message: '恢复检查点失败' })
    })

    await retryAfterError(state, createComputed())

    // 不应发起 retryStream（恢复类错误重试不应触发 LLM 重新生成）
    const retryCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(retryCall).toBeUndefined()
    // 错误保留（由错误条/独立提示展示，不自动清除）
    expect(state.error.value?.code).toBe('RESTORE_ERROR')
    // 不创建新占位、不进入流式状态
    expect(state.allMessages.value).toHaveLength(1)
    expect(state.isStreaming.value).toBe(false)
    expect(state.isLoading.value).toBe(false)
  })

  it('REROLL_ERROR 流式失败重放 reroll，不退回 retryStream', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      error: ref({
        code: 'REROLL_ERROR',
        message: 'boom',
        type: 'API_ERROR',
        branchReplayContext: {
          kind: 'reroll',
          conversationId: 'conv_1',
          assistantNodeId: 'msg_original_answer',
          configId: 'cfg_1',
          promptModeId: 'code'
        }
      })
    })

    await retryAfterError(state, createComputed())

    expect(state.allMessages.value.some(m => m.id === 'msg_partial')).toBe(false)
    const rerollCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.rerollStream')
    expect(rerollCall).toBeDefined()
    expect(rerollCall![1]).toMatchObject({ conversationId: 'conv_1', configId: 'cfg_1' })
    // 流式失败后原目标已进入 sidecar，交给后端按当前活跃路径选择失败候选。
    expect(rerollCall![1]).not.toHaveProperty('assistantNodeId')
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
  })

  it('EDIT_BRANCH_ERROR 流式失败重放编辑分支，并保留编辑文本', async () => {
    const parent = createMessage({ id: 'msg_parent', role: 'assistant', content: '上一条回答' })
    const editedUser = createMessage({ id: 'msg_edited_user', role: 'user', content: '编辑后的问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([parent, editedUser, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      error: ref({
        code: 'EDIT_BRANCH_ERROR',
        message: 'boom',
        type: 'TIMEOUT_ERROR',
        branchReplayContext: {
          kind: 'editBranch',
          conversationId: 'conv_1',
          userNodeId: 'msg_original_user',
          newText: '编辑后的问题',
          configId: 'cfg_1',
          promptModeId: 'code'
        }
      })
    })

    await retryAfterError(state, createComputed())

    const editCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(editCall).toBeDefined()
    expect(editCall![1]).toMatchObject({
      conversationId: 'conv_1',
      newText: '编辑后的问题',
      configId: 'cfg_1'
    })
    expect(editCall![1]).not.toHaveProperty('userNodeId')
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    // 窗口裁剪会移除最前面的孤立 assistant；编辑后的 user 与新占位必须保留。
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_edited_user', expect.any(String)])
  })

  it('方案 B：REROLL_ERROR 无底层 type（reroll 特有错误）时不触发重试', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user]),
      error: ref({ code: 'REROLL_ERROR', message: 'reroll result sync to branch graph failed' })
    })

    await retryAfterError(state, createComputed())

    const retryCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(retryCall).toBeUndefined()
    expect(state.allMessages.value).toHaveLength(1)
  })

  it('H-3：部分失败/警告类恢复错误码同样不触发重试', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user]),
      error: ref({ code: 'RESTORE_PARTIAL_ERROR', message: '恢复部分完成' })
    })

    await retryAfterError(state, createComputed())

    const retryCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(retryCall).toBeUndefined()
    expect(state.allMessages.value).toHaveLength(1)
  })

  it('FIX-C-1：handleError 写入后端 API_ERROR 后错误条可重试（B7 回归）', async () => {
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([partial]),
      streamingMessageId: ref('msg_partial')
    })

    handleError({
      conversationId: 'conv_1',
      type: 'error',
      streamId: 'stream_1',
      error: { code: 'API_ERROR', message: '余额不足' }
    } as any, state)

    expect(state.error.value?.code).toBe('API_ERROR')
    expect(isRetryableError(state.error.value)).toBe(true)
    // 有内容半截消息保留并记录，供 retryAfterError 回滚
    expect(state._failedStreamMessageId.value).toBe('msg_partial')

    await retryAfterError(state, createComputed())

    const retryCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')
    expect(retryCall).toBeDefined()
  })

  it('FIX-C-4：防御性 deleteMessage await 后会话已切换则中止重试', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题' })
    const partial = createMessage({
      id: 'msg_partial',
      role: 'assistant',
      content: '半截回答',
      localOnly: false,
      backendIndex: 1
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      error: ref({ code: 'STREAM_ERROR', message: 'boom' })
    })

    // await deleteMessage 期间用户切换到其他会话
    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'deleteMessage') {
        state.currentConversationId.value = 'conv_2'
        return Promise.resolve({ success: true })
      }
      return Promise.resolve({ success: true })
    })

    await retryAfterError(state, createComputed())

    // 会话已切换：不发起 retryStream、不创建新占位、不进入流式状态
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(state.allMessages.value.some(m => m.streaming)).toBe(false)
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user'])
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.isLoading.value).toBe(false)
  })
})

describe('RETRYABLE_ERROR_CODES / isRetryableError（H-3 契约）', () => {
  it('流式生成类错误码可重试', () => {
    expect(RETRYABLE_ERROR_CODES.has('STREAM_ERROR')).toBe(true)
    expect(RETRYABLE_ERROR_CODES.has('RETRY_ERROR')).toBe(true)
    expect(RETRYABLE_ERROR_CODES.has('EDIT_RETRY_ERROR')).toBe(true)
  })

  it('FIX-C-1：后端流式错误码（ChannelError.type）可重试', () => {
    expect(RETRYABLE_ERROR_CODES.has('API_ERROR')).toBe(true)
    expect(RETRYABLE_ERROR_CODES.has('NETWORK_ERROR')).toBe(true)
    expect(RETRYABLE_ERROR_CODES.has('TIMEOUT_ERROR')).toBe(true)
    expect(RETRYABLE_ERROR_CODES.has('PARSE_ERROR')).toBe(true)
  })

  it('FIX-C-1：用户取消/配置/参数类错误码不可重试', () => {
    expect(RETRYABLE_ERROR_CODES.has('CANCELLED_ERROR')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('CONFIG_ERROR')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('VALIDATION_ERROR')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('UNKNOWN_ERROR')).toBe(false)
  })

  it('恢复/预览类错误码不可重试', () => {
    expect(RETRYABLE_ERROR_CODES.has('RESTORE_ERROR')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('RESTORE_PARTIAL_ERROR')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('RESTORE_UNBACKED_WARNING')).toBe(false)
    expect(RETRYABLE_ERROR_CODES.has('RESTORE_PREVIEW_ERROR')).toBe(false)
  })

  it('isRetryableError 对空/恢复类错误返回 false', () => {
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
    expect(isRetryableError({ code: 'RESTORE_ERROR', message: 'x' })).toBe(false)
    expect(isRetryableError({ code: 'STREAM_ERROR', message: 'x' })).toBe(true)
  })

  it('方案 B：REROLL_ERROR / EDIT_BRANCH_ERROR 可重试性取决于底层 type', () => {
    // 携带可重试底层 type → 可重试
    expect(isRetryableError({ code: 'REROLL_ERROR', message: 'x', type: 'API_ERROR' })).toBe(true)
    expect(isRetryableError({ code: 'REROLL_ERROR', message: 'x', type: 'NETWORK_ERROR' })).toBe(true)
    expect(isRetryableError({ code: 'EDIT_BRANCH_ERROR', message: 'x', type: 'TIMEOUT_ERROR' })).toBe(true)
    expect(isRetryableError({ code: 'EDIT_BRANCH_ERROR', message: 'x', type: 'PARSE_ERROR' })).toBe(true)
    // 无 type（reroll 特有错误，如 REROLL_FINISH_SYNC_FAILED，不属于底层流错误）→ 不可重试
    expect(isRetryableError({ code: 'REROLL_ERROR', message: 'x' })).toBe(false)
    expect(isRetryableError({ code: 'EDIT_BRANCH_ERROR', message: 'x' })).toBe(false)
    // 底层 type 不可重试（CONFIG_ERROR/VALIDATION_ERROR/CANCELLED_ERROR）→ 不可重试
    expect(isRetryableError({ code: 'REROLL_ERROR', message: 'x', type: 'CONFIG_ERROR' })).toBe(false)
    expect(isRetryableError({ code: 'EDIT_BRANCH_ERROR', message: 'x', type: 'VALIDATION_ERROR' })).toBe(false)
    expect(isRetryableError({ code: 'EDIT_BRANCH_ERROR', message: 'x', type: 'CANCELLED_ERROR' })).toBe(false)
  })

  it('方案 B：handleError 写入后端透传的底层 type（REROLL_ERROR + type=API_ERROR → 可重试）', () => {
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([partial]),
      streamingMessageId: ref('msg_partial')
    })

    handleError({
      conversationId: 'conv_1',
      type: 'error',
      streamId: 'stream_1',
      error: { code: 'REROLL_ERROR', message: '余额不足', type: 'API_ERROR' }
    } as any, state)

    expect(state.error.value?.code).toBe('REROLL_ERROR')
    expect(state.error.value?.type).toBe('API_ERROR')
    expect(isRetryableError(state.error.value)).toBe(true)
    // 有内容半截消息保留并记录，供 retryAfterError 回滚
    expect(state._failedStreamMessageId.value).toBe('msg_partial')
  })
})

describe('sendMessage 清理失败残留', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
  })

  it('发送新消息前清理上次失败的半截消息', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '旧问题' })
    const partial = createMessage({ id: 'msg_partial', role: 'assistant', content: '半截回答', localOnly: true })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, partial]),
      _failedStreamMessageId: ref('msg_partial'),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any]),
      isStreaming: ref(false)
    })

    const result = await sendMessage(state, createComputed(), '新问题')

    expect(result).toBe(true)
    expect(state.allMessages.value.some(m => m.id === 'msg_partial')).toBe(false)
    expect(state._failedStreamMessageId.value).toBeNull()
    // 新消息 + 新占位
    const roles = state.allMessages.value.map(m => m.role)
    expect(roles).toEqual(['user', 'user', 'assistant'])
    const chatCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')
    expect(chatCall).toBeDefined()
  })
})

describe('retryFromMessage reroll 主流程（TREE-01）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    vi.mocked(loadHistory).mockClear()
    vi.mocked(loadCheckpoints).mockClear()
  })

  it('流完成后采用后端稳定节点 ID，重试不会再发送前端临时占位 ID', async () => {
    const user = createMessage({ id: 'server-user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const placeholder = createMessage({
      id: '1785860200670_2ojp0foff',
      role: 'assistant',
      content: '',
      streaming: true,
      localOnly: true,
      backendIndex: 1
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, placeholder]),
      streamingMessageId: ref(placeholder.id),
      activeStreamId: ref('stream_1'),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    handleComplete({
      conversationId: 'conv_1',
      type: 'complete',
      streamId: 'stream_1',
      content: {
        id: 'server-assistant-node',
        parentId: 'server-user',
        role: 'model',
        parts: [{ text: '完整回答' }],
        timestamp: 2
      }
    } as any, state, () => {}, vi.fn())

    expect(state.allMessages.value[1]).toMatchObject({
      id: 'server-assistant-node',
      content: '完整回答',
      localOnly: false,
      streaming: false
    })

    await retryFromMessage(state, createComputed(), 1, async () => {})

    const rerollCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.rerollStream')
    expect(rerollCall?.[1]).toMatchObject({
      conversationId: 'conv_1',
      assistantNodeId: 'server-assistant-node'
    })
    expect(rerollCall?.[1]?.assistantNodeId).not.toBe('1785860200670_2ojp0foff')
  })

  it('rerollStream IPC 请求级失败后：重载一致状态并按原目标重放 reroll', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const assistant = createMessage({ id: 'msg_assistant', role: 'assistant', content: '旧回答', localOnly: false, backendIndex: 1 })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, assistant]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'chat.rerollStream') return Promise.reject(new Error('ipc boom'))
      if (type === 'conversation.getMessagesPaged') {
        return Promise.resolve({
          total: 2,
          messages: [
            { id: 'msg_user', role: 'user', content: '问题', index: 0, timestamp: 1, parts: [] },
            { id: 'msg_assistant', role: 'model', content: '旧回答', index: 1, timestamp: 2, parts: [] }
          ]
        })
      }
      return Promise.resolve({ success: true })
    })

    await retryFromMessage(state, createComputed(), 1, async () => {})

    // 错误条展示 RETRY_ERROR（reroll 启动失败，不再继续）
    expect(state.error.value?.code).toBe('RETRY_ERROR')
    expect(state.error.value?.branchReplayContext).toMatchObject({
      kind: 'reroll',
      conversationId: 'conv_1',
      assistantNodeId: 'msg_assistant',
      configId: 'cfg_1'
    })
    // 发起了最后一页重载
    const reloadCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getMessagesPaged')
    expect(reloadCall).toBeDefined()
    expect(reloadCall![1]).toMatchObject({ conversationId: 'conv_1' })
    // 重载检查点
    expect(loadCheckpoints).toHaveBeenCalled()
    // reroll 链路不触碰破坏性删除 / 旧重试接口
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    // 分支图刷新标记已复位（流未启动，不残留）
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    // 流式状态复位
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.isLoading.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()
    // 窗口恢复为后端重载结果
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user', 'msg_assistant'])
    expect(state.allMessages.value[1].backendIndex).toBe(1)

    // 请求尚未启动，重试必须使用原始 assistant 节点，而不是追加普通 retryStream。
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    await retryAfterError(state, createComputed())

    const replayCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.rerollStream')
    expect(replayCall).toBeDefined()
    expect(replayCall![1]).toMatchObject({
      conversationId: 'conv_1',
      assistantNodeId: 'msg_assistant',
      configId: 'cfg_1'
    })
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(state.allMessages.value.map(message => message.id)).toEqual(['msg_user', expect.any(String)])
  })

  it('reroll 成功发起：不 deleteMessage、不 retryStream，截断窗口 + 占位 + 置位刷新标记 + 携带 assistantNodeId', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const assistant = createMessage({ id: 'msg_assistant', role: 'assistant', content: '旧回答', localOnly: false, backendIndex: 1 })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, assistant]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    await retryFromMessage(state, createComputed(), 1, async () => {})

    // 发起 reroll 流（fire-and-forget），携带目标 assistant 节点 ID
    const rerollCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.rerollStream')
    expect(rerollCall).toBeDefined()
    expect(rerollCall![1]).toMatchObject({
      conversationId: 'conv_1',
      assistantNodeId: 'msg_assistant',
      configId: 'cfg_1'
    })
    // 不再调用破坏性删除 / 旧重试接口
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    // 窗口截断到目标消息之前 + 新流式占位
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user', expect.any(String)])
    expect(state.allMessages.value[1].streaming).toBe(true)
    expect(state.streamingMessageId.value).toBe(state.allMessages.value[1].id)
    // 分支图刷新标记置位（流结束后由 streamHandler 按会话消费）
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
    // 流式状态
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
  })

  it('rerollStream IPC 抛异常且会话已切换时：不重载原会话历史（避免污染当前会话窗口）', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const assistant = createMessage({ id: 'msg_assistant', role: 'assistant', content: '旧回答', localOnly: false, backendIndex: 1 })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, assistant]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'chat.rerollStream') {
        // IPC 失败期间用户切换到 conv_2（窗口已由新会话接管）
        state.currentConversationId.value = 'conv_2'
        return Promise.reject(new Error('ipc boom'))
      }
      return Promise.resolve({ success: true })
    })

    await retryFromMessage(state, createComputed(), 1, async () => {})

    // 会话已切换：不得重载原会话最后一页 / 检查点（避免污染 conv_2 的窗口与检查点）
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getMessagesPaged')).toBeUndefined()
    expect(loadHistory).not.toHaveBeenCalled()
    expect(loadCheckpoints).not.toHaveBeenCalled()
    // 分支图刷新标记复位（本次 reroll 已中止，不残留）
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    // 错误不写入当前会话（原会话无标签页快照可写）
    expect(state.error.value).toBeNull()
  })
})

describe('editAndRetry 编辑分支主流程（TREE-03）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    vi.mocked(loadHistory).mockClear()
    vi.mocked(loadCheckpoints).mockClear()
  })

  it('chat.editBranchStream IPC 请求级失败后：恢复原消息并重放原编辑请求', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const target = createMessage({ id: 'msg_target', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_user' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      checkpoints: ref([{ id: 'cp_1', messageIndex: 1 } as CheckpointRecord]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'chat.editBranchStream') return Promise.reject(new Error('ipc boom'))
      if (type === 'conversation.getMessagesPaged') {
        // 模拟后端未变：编辑分支请求未送达，主历史仍是原消息
        return Promise.resolve({
          total: 2,
          messages: [
            { id: 'msg_user', role: 'user', index: 0, timestamp: 1, parts: [{ text: '问题' }] },
            { id: 'msg_target', role: 'user', index: 1, timestamp: 2, parts: [{ text: '追问' }] }
          ]
        })
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {})

    // 错误码 EDIT_RETRY_ERROR（仍可重试；此时本地已与后端一致，重试基于真实历史）
    expect(state.error.value?.code).toBe('EDIT_RETRY_ERROR')
    expect(state.error.value?.branchReplayContext).toMatchObject({
      kind: 'editBranch',
      conversationId: 'conv_1',
      userNodeId: 'msg_target',
      newText: '新回答',
      configId: 'cfg_1'
    })
    // M-9 同款：会话未切换时重载最后一页 + 检查点
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getMessagesPaged')).toBeDefined()
    expect(loadCheckpoints).toHaveBeenCalled()
    // 本地窗口已恢复为后端一致状态（不再保留被截断/改写的本地状态）
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user', 'msg_target'])
    expect(state.allMessages.value[1].content).toBe('追问')
    // 主流程走 editBranchStream，不触碰破坏性删除 / 旧接口
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'editAndRetryStream')).toBeUndefined()
    // 分支图刷新标记已复位（流未启动，不残留）
    expect(state._pendingBranchRefreshAfterStream.value).toBeNull()
    // 流式状态复位
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(state.isLoading.value).toBe(false)
    expect(state.streamingMessageId.value).toBeNull()

    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    await retryAfterError(state, createComputed())

    const replayCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(replayCall).toBeDefined()
    expect(replayCall![1]).toMatchObject({
      conversationId: 'conv_1',
      userNodeId: 'msg_target',
      newText: '新回答',
      configId: 'cfg_1'
    })
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(state.allMessages.value[1].content).toBe('新回答')
    expect(state.allMessages.value[2].streaming).toBe(true)
  })

  it('编辑根节点（parentId=null）走 branch 模式：截断窗口 + 占位 + 重新生成（TREE-03-R）', async () => {
    const root = createMessage({ id: 'msg_root', role: 'user', content: '第一条消息', localOnly: false, backendIndex: 0, parentId: null })
    const answer = createMessage({ id: 'msg_answer', role: 'assistant', content: '回答', localOnly: false, backendIndex: 1 })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([root, answer]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    await editAndRetry(state, createComputed(), 0, '改过的第一条', undefined, async () => {})

    // 根节点（TREE-03-R）：不再降级 keep——branch 模式原样透传（后端原地改写根节点 +
    // 截断其后 + 新建模型候选重新生成；旧回答保留为可切换候选）
    const editCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(editCall).toBeDefined()
    expect(editCall![1]).toMatchObject({
      conversationId: 'conv_1',
      userNodeId: 'msg_root',
      newText: '改过的第一条',
      mode: 'branch'
    })
    // 目标消息改写 + 截断其后 + 新流式占位（与普通编辑一致）
    expect(state.allMessages.value[0].content).toBe('改过的第一条')
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_root', expect.any(String)])
    expect(state.allMessages.value[1].streaming).toBe(true)
    expect(state.streamingMessageId.value).toBe(state.allMessages.value[1].id)
    // 分支图刷新标记置位（流结束后按会话消费，展示新候选切换器）
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
    // 错误重放上下文携带 branch 模式（错误条重试保持同一语义）
    expect(state._pendingBranchReplayContext.value).toMatchObject({ kind: 'editBranch', mode: 'branch' })
    // branch 模式进入流式等待状态
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(state.activeStreamId.value).toBeTruthy()
  })

  it('编辑分支成功发起：不 deleteMessage/retryStream/editAndRetryStream，截断窗口 + 占位 + 置位刷新标记 + 携带 userNodeId/newText', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const target = createMessage({ id: 'msg_target', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_user' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {})

    // 发起编辑分支流（fire-and-forget），携带被编辑用户消息的节点 ID 与编辑后文本
    const editCall = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.editBranchStream')
    expect(editCall).toBeDefined()
    expect(editCall![1]).toMatchObject({
      conversationId: 'conv_1',
      userNodeId: 'msg_target',
      newText: '新回答',
      configId: 'cfg_1',
      streamId: expect.any(String)
    })
    // 不再调用破坏性删除 / 旧重试 / 旧编辑接口
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'deleteMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'retryStream')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'editAndRetryStream')).toBeUndefined()
    // 窗口：目标消息改写 + 截断其后 + 新流式占位
    expect(state.allMessages.value.map(m => m.id)).toEqual(['msg_user', 'msg_target', expect.any(String)])
    expect(state.allMessages.value[0].content).toBe('问题')
    expect(state.allMessages.value[1].content).toBe('新回答')
    expect(state.allMessages.value[2].streaming).toBe(true)
    expect(state.streamingMessageId.value).toBe(state.allMessages.value[2].id)
    // 分支图刷新标记置位（流结束后由 streamHandler 按会话消费）
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conv_1')
    // 流式状态
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
  })

  it('会话已切换时不重载、不写当前会话状态', async () => {
    const user = createMessage({ id: 'msg_user', role: 'user', content: '问题', localOnly: false, backendIndex: 0 })
    const target = createMessage({ id: 'msg_target', role: 'user', content: '追问', localOnly: false, backendIndex: 1, parentId: 'msg_user' })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([user, target]),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } as any])
    })

    vi.mocked(sendToExtension).mockImplementation((type: string) => {
      if (type === 'chat.editBranchStream') {
        state.currentConversationId.value = 'conv_2'
        return Promise.reject(new Error('ipc boom'))
      }
      return Promise.resolve({ success: true })
    })

    await editAndRetry(state, createComputed(), 1, '新回答', undefined, async () => {})

    // 会话已切换：validateSessionIdentity 失败，不重载（含最后一页与检查点）
    expect(loadHistory).not.toHaveBeenCalled()
    expect(loadCheckpoints).not.toHaveBeenCalled()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'conversation.getMessagesPaged')).toBeUndefined()
    // 错误不写入当前会话（原会话无标签页快照可写）
    expect(state.error.value).toBeNull()
  })
})
