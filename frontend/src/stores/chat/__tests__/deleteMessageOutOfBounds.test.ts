/**
 * deleteMessage / deleteSingleMessage 后端索引越界兜底测试（INVALID_TARGET_INDEX 防护）
 *
 * 背景：前端窗口可能包含「后端并不存在」的尾部消息——典型场景是流式异常后
 * localOnly 标记丢失（后端未持久化但前端窗口保留），或数据文件被外部修改后
 * 前后端消息数不一致。此时按前端索引走后端删除会命中 INVALID_TARGET_INDEX
 * （后端校验 targetIndex >= historyBeforeDelete.length 直接拒绝）。
 *
 * 覆盖：
 * - deleteMessage：backendIndex >= totalMessages 时不调后端，走本地删除
 * - deleteSingleMessage：targetIndex >= totalMessages 时不调后端，仅本地移除
 * - backendIndex 未越界时保持原有后端删除路径（不破坏正常删除）
 */
import { ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '../../../types'
import type { ChatStoreState } from '../types'
import { deleteMessage, deleteSingleMessage } from '../messageActions'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

vi.mock('../conversationActions', () => ({
  loadCheckpoints: vi.fn().mockResolvedValue(undefined),
  refreshCurrentConversationBuildSession: vi.fn().mockResolvedValue(undefined),
  loadHistory: vi.fn().mockResolvedValue(undefined)
}))

import { sendToExtension } from '../../../utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

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
    pendingConfigIdOverride: ref<string | null>(null),
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
    ...overrides
  } as unknown as ChatStoreState
}

describe('deleteMessage 后端索引越界兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('backendIndex >= totalMessages 时本地删除，不调用后端 deleteMessage', async () => {
    const state = createState({
      totalMessages: ref(2),
      allMessages: ref([
        createMessage({ backendIndex: 0, content: 'a' }),
        createMessage({ backendIndex: 1, content: 'b' }),
        // 越界：后端历史只有 2 条，此条前端窗口有但后端不存在
        createMessage({ backendIndex: 2, content: 'c' })
      ])
    })

    await deleteMessage(state, 2, async () => {})

    expect(mockSend).not.toHaveBeenCalledWith('deleteMessage', expect.anything())
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value.map(m => m.content)).toEqual(['a', 'b'])
  })

  it('backendIndex 未越界时保持原有后端删除路径', async () => {
    mockSend.mockResolvedValue({ success: true })
    const state = createState({
      totalMessages: ref(3),
      allMessages: ref([
        createMessage({ backendIndex: 0, content: 'a' }),
        createMessage({ backendIndex: 1, content: 'b' }),
        createMessage({ backendIndex: 2, content: 'c' })
      ])
    })

    await deleteMessage(state, 1, async () => {})

    expect(mockSend).toHaveBeenCalledWith('deleteMessage', expect.objectContaining({ targetIndex: 1 }))
  })
})

describe('deleteSingleMessage 后端索引越界兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('targetIndex >= totalMessages 时仅本地移除，不调用后端 deleteSingleMessage', async () => {
    const state = createState({
      totalMessages: ref(2),
      allMessages: ref([
        createMessage({ backendIndex: 0, content: 'a' }),
        createMessage({ backendIndex: 1, content: 'b' }),
        createMessage({ backendIndex: 2, content: 'c' })
      ])
    })

    await deleteSingleMessage(state, 2, async () => {})

    expect(mockSend).not.toHaveBeenCalledWith('deleteSingleMessage', expect.anything())
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value.map(m => m.content)).toEqual(['a', 'b'])
  })

  it('targetIndex 未越界时保持原有后端删除路径', async () => {
    mockSend.mockResolvedValue({ success: true })
    const state = createState({
      totalMessages: ref(3),
      allMessages: ref([
        createMessage({ backendIndex: 0, content: 'a' }),
        createMessage({ backendIndex: 1, content: 'b' }),
        createMessage({ backendIndex: 2, content: 'c' })
      ])
    })

    await deleteSingleMessage(state, 1, async () => {})

    expect(mockSend).toHaveBeenCalledWith('deleteSingleMessage', expect.objectContaining({ targetIndex: 1 }))
  })
})
