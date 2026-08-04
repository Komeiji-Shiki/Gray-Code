/**
 * 用户消息插入（U1）前端投递路径测试
 *
 * 覆盖：
 * - 忙时（isStreaming || isWaitingForResponse）sendMessage 改走 chat.sendInterruptMessage：
 *   不排队、不乐观插入窗口、不修改流式状态、不触发 chatStream；
 * - 空闲时保持原有发送路径（chatStream + 乐观插入 user/assistant 消息）；
 * - 忙时隐藏发送（functionResponse）、带附件、超长文本、无会话、后端拒绝均不回退插入路径。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreState, ChatStoreComputed, CheckpointRecord } from '../../stores/chat/types'
import { sendMessage, INTERRUPT_MESSAGE_MAX_LENGTH, recentInterruptDeliveries, clearInterruptDeliveries } from '../../stores/chat/messageActions'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ success: true })
}))

import { sendToExtension } from '../../utils/vscode'

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

describe('sendMessage 忙时走 interrupt 路径（U1）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    recentInterruptDeliveries.value = []
  })

  it('isStreaming 时改走 chat.sendInterruptMessage，不乐观插入窗口', async () => {
    const history = { id: 'm1', role: 'user', content: '旧问题', timestamp: 1 } as Message
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([history]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '  快点处理  ')

    expect(result).toBe(true)
    const call = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')
    expect(call).toBeDefined()
    expect(call![1]).toEqual({ conversationId: 'conv_1', text: '快点处理' })
    // 不乐观插入 user 消息 / assistant 占位
    expect(state.allMessages.value).toHaveLength(1)
    expect(state.allMessages.value[0].id).toBe('m1')
    // 流式状态不被修改
    expect(state.isStreaming.value).toBe(true)
    expect(state.isWaitingForResponse.value).toBe(true)
    // 不触发 chatStream
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')).toBeUndefined()
  })

  it('isWaitingForResponse（未流式）同样走 interrupt 路径', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(false),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '补充信息')

    expect(result).toBe(true)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeDefined()
  })

  it('空闲时保持原有发送路径（chatStream + 乐观插入）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(false),
      isWaitingForResponse: ref(false),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } as any])
    })

    const result = await sendMessage(state, createComputed(), '普通问题')

    expect(result).toBe(true)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')).toBeDefined()
    // 空闲路径会创建 user 消息 + assistant 占位
    expect(state.allMessages.value).toHaveLength(2)
    expect(state.allMessages.value.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('后台任务回执来源随 chatStream 请求传给后端', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(false),
      isWaitingForResponse: ref(false),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } as any])
    })

    const result = await sendMessage(state, createComputed(), '[Background task completed]', undefined, {
      source: 'background_task'
    })

    expect(result).toBe(true)
    const call = vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')
    expect(call?.[1]).toMatchObject({ source: 'background_task' })
    expect(state.allMessages.value[0].source).toBe('background_task')
  })

  it('忙时带附件 → 不回退插入路径（返回 false，不投递）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const att = { id: 'att_1', name: 'x.png', type: 'image', size: 1, mimeType: 'image/png', data: '' } as any

    const result = await sendMessage(state, createComputed(), '看图', [att])

    expect(result).toBe(false)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')).toBeUndefined()
  })

  it('忙时隐藏发送（functionResponse）不走 interrupt 路径', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '', undefined, {
      hidden: { functionResponse: { id: 'fr_1', name: 'create_plan', response: {} } }
    })

    expect(result).toBe(false)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeUndefined()
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chatStream')).toBeUndefined()
  })

  it('忙时超长文本不回退插入路径（返回 false）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), 'x'.repeat(INTERRUPT_MESSAGE_MAX_LENGTH + 1))

    expect(result).toBe(false)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeUndefined()
  })

  it('忙时无会话 → 返回 false 不投递', async () => {
    const state = createState({
      currentConversationId: ref(null),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '任意')

    expect(result).toBe(false)
    expect(vi.mocked(sendToExtension).mock.calls.find(c => c[0] === 'chat.sendInterruptMessage')).toBeUndefined()
  })

  it('投递被后端拒绝（如频率限制）→ 返回 false，不打断进行中的回合', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({
      success: false,
      error: { code: 'INTERRUPT_MESSAGE_RATE_LIMITED', message: 'too fast' }
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '太快了')

    expect(result).toBe(false)
    // 状态未被破坏、不落错误条（避免打断进行中的回合）
    expect(state.isStreaming.value).toBe(true)
    expect(state.error.value).toBeNull()
  })
})

describe('忙时投递轻量回显（M3-1）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    recentInterruptDeliveries.value = []
  })

  it('投递成功记录 delivered 提示（conversationId + 文本）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '补充信息')

    expect(result).toBe(true)
    expect(recentInterruptDeliveries.value).toHaveLength(1)
    const notice = recentInterruptDeliveries.value[0]
    expect(notice.kind).toBe('delivered')
    expect(notice.conversationId).toBe('conv_1')
    expect(notice.text).toBe('补充信息')
    // 不写错误条（不打断进行中的回合）
    expect(state.error.value).toBeNull()
  })

  it('投递被拒绝（INTERRUPT_MESSAGE_RATE_LIMITED）记录 error 提示且不写错误条', async () => {
    vi.mocked(sendToExtension).mockResolvedValue({
      success: false,
      error: { code: 'INTERRUPT_MESSAGE_RATE_LIMITED', message: 'too fast' }
    })
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    const result = await sendMessage(state, createComputed(), '太快了')

    expect(result).toBe(false)
    expect(recentInterruptDeliveries.value).toHaveLength(1)
    const notice = recentInterruptDeliveries.value[0]
    expect(notice.kind).toBe('error')
    expect(notice.errorCode).toBe('INTERRUPT_MESSAGE_RATE_LIMITED')
    expect(notice.errorMessage).toBe('too fast')
    expect(state.error.value).toBeNull()
    expect(state.isStreaming.value).toBe(true)
  })

  it('同会话同类型提示只保留最新一条（去重）', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    await sendMessage(state, createComputed(), '第一条')
    await sendMessage(state, createComputed(), '第二条')

    const delivered = recentInterruptDeliveries.value.filter(n => n.kind === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe('第二条')
  })

  it('忙时带附件/超长文本/无会话不回退插入，也不记录投递提示', async () => {
    const att = { id: 'att_1', name: 'x.png', type: 'image', size: 1, mimeType: 'image/png', data: '' } as any
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    await sendMessage(state, createComputed(), '看图', [att])
    expect(recentInterruptDeliveries.value).toHaveLength(0)

    await sendMessage(state, createComputed(), 'x'.repeat(INTERRUPT_MESSAGE_MAX_LENGTH + 1))
    expect(recentInterruptDeliveries.value).toHaveLength(0)

    const noConv = createState({
      currentConversationId: ref(null),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    await sendMessage(noConv, createComputed(), '任意')
    expect(recentInterruptDeliveries.value).toHaveLength(0)
  })

  it('clearInterruptDeliveries 只清除指定会话的提示', async () => {
    const state = createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })
    const state2 = createState({
      currentConversationId: ref('conv_2'),
      allMessages: ref([]),
      isStreaming: ref(true),
      isWaitingForResponse: ref(true)
    })

    await sendMessage(state, createComputed(), 'A 会话')
    await sendMessage(state2, createComputed(), 'B 会话')

    clearInterruptDeliveries('conv_1')
    expect(recentInterruptDeliveries.value.map(n => n.conversationId)).toEqual(['conv_2'])
  })
})

describe('upsertHiddenFunctionResponseMessage 索引重建（M3-2）', () => {
  beforeEach(() => {
    vi.mocked(sendToExtension).mockClear()
    vi.mocked(sendToExtension).mockResolvedValue({ success: true })
    recentInterruptDeliveries.value = []
  })

  function createStateWithIndex() {
    return createState({
      currentConversationId: ref('conv_1'),
      allMessages: ref([]),
      messageIndexById: ref(new Map()),
      toolResponseIndex: ref(new Map()),
      isStreaming: ref(false),
      isWaitingForResponse: ref(false),
      conversations: ref([{ id: 'conv_1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } as any])
    })
  }

  it('隐藏发送追加 functionResponse 后 messageIndexById/toolResponseIndex 同步更新', async () => {
    const state = createStateWithIndex()

    const result = await sendMessage(state, createComputed(), '', undefined, {
      hidden: { functionResponse: { id: 'fr_1', name: 'create_plan', response: { ok: true } } }
    })

    expect(result).toBe(true)
    const frMsg = state.allMessages.value.find(m => m.isFunctionResponse)
    expect(frMsg).toBeDefined()
    expect(state.messageIndexById.value.get(frMsg!.id)).toBe(0)
    expect(state.toolResponseIndex.value.get('fr_1')).toBe(0)
  })

  it('隐藏发送命中已有同 id functionResponse 时原地合并并重建索引', async () => {
    const existing = {
      id: 'msg_fr',
      role: 'user',
      content: '',
      timestamp: 1,
      backendIndex: 0,
      isFunctionResponse: true,
      parts: [{ functionResponse: { id: 'fr_1', name: 'create_plan', response: { ok: true } } }]
    } as Message
    const state = createStateWithIndex()
    state.allMessages.value = [existing]
    state.messageIndexById.value.set('msg_fr', 0)
    state.toolResponseIndex.value.set('fr_1', 0)

    const result = await sendMessage(state, createComputed(), '', undefined, {
      hidden: { functionResponse: { id: 'fr_1', name: 'create_plan', response: { planExecutionPrompt: '继续' } } }
    })

    expect(result).toBe(true)
    // 原地合并（不新增 functionResponse 消息），索引保持一致
    expect(state.allMessages.value.filter(m => m.isFunctionResponse)).toHaveLength(1)
    expect(state.allMessages.value[0].id).toBe('msg_fr')
    expect(state.messageIndexById.value.get('msg_fr')).toBe(0)
    expect(state.toolResponseIndex.value.get('fr_1')).toBe(0)
  })
})
