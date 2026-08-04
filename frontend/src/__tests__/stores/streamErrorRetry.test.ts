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
import { handleError } from '../../stores/chat/streamChunkHandlers'
import {
  retryAfterError,
  dismissError,
  rollbackFailedStreamMessage,
  sendMessage
} from '../../stores/chat/messageActions'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

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
    historyFolded: ref(false),
    foldedMessageCount: ref(0),
    toolResponseCache: ref(new Map()),
    conversations: ref([]),
    currentWorkspaceUri: ref(null),
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
