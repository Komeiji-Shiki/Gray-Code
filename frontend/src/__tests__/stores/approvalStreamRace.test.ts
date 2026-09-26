import { nextTick } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import type { Content, StreamChunk } from '../../types'
import { appendMessage, createChatState } from '../../stores/chat/state'
import { handleStreamChunk, type StreamHandlerContext } from '../../stores/chat/streamHandler'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn().mockResolvedValue({ success: true }) }))

const content: Content = { id: 'tool-message', role: 'model', parts: [
  { functionCall: { id: 'delete-call', name: 'delete_file', args: { paths: ['fixture.txt'] } } },
  { functionCall: { id: 'read-call', name: 'read_file', args: {} } }
] }

function approval(overrides: Partial<StreamChunk> = {}): StreamChunk {
  return { type: 'awaitingConfirmation', conversationId: 'conversation', streamId: 'live-stream',
    keepStreamOpen: true, content,
    pendingToolCalls: [{ id: 'delete-call', name: 'delete_file', args: { paths: ['fixture.txt'] }, approvalId: 'approval-1' }],
    ...overrides }
}

function setup() {
  const state = createChatState()
  state.currentConversationId.value = 'conversation'
  state.activeStreamId.value = 'live-stream'
  state.streamingMessageId.value = 'placeholder'
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  appendMessage(state, { id: 'user', role: 'user', content: 'fixture', timestamp: 0, backendIndex: 0 })
  appendMessage(state, { id: 'placeholder', role: 'assistant', content: '', timestamp: 1, backendIndex: 1, streaming: true, localOnly: true })
  const ctx: StreamHandlerContext = { state, currentModelName: () => 'fixture', addCheckpoint: vi.fn(),
    updateConversationAfterMessage: vi.fn(), processQueue: vi.fn(), processQueueAfterAction: vi.fn() }
  const deliver = (chunk: Omit<StreamChunk, 'conversationId'> & { conversationId?: string }) => handleStreamChunk({
    ...chunk, conversationId: chunk.conversationId ?? 'conversation', streamId: chunk.streamId ?? 'live-stream'
  }, ctx)
  deliver(approval())
  const tool = () => state.allMessages.value.find(message => message.id === 'tool-message')?.tools?.[0]
  return { state, ctx, deliver, tool }
}

describe('独立宿主审批流与异步消息竞态', () => {
  test('待审批期间代理消息及重复快照不替换流、不提交选择、不调度新用户回合', async () => {
    const { state, ctx, deliver, tool } = setup()
    const feedback: Content = { id: 'agent-message', role: 'user', source: 'agent_message', parts: [{ text: '补充信息' }] }
    deliver({ type: 'userFeedback', feedbackContent: feedback })
    deliver({ type: 'userFeedback', feedbackContent: feedback })
    deliver(approval())
    await nextTick()
    expect(state.activeStreamId.value).toBe('live-stream')
    expect(state.streamingMessageId.value).toBe('tool-message')
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(tool()).toMatchObject({ status: 'awaiting_approval', approvalId: 'approval-1' })
    expect(state.allMessages.value.filter(message => message.id === 'agent-message')).toHaveLength(1)
    expect(ctx.processQueue).not.toHaveBeenCalled()
    expect(ctx.processQueueAfterAction).not.toHaveBeenCalled()
  })

  test.each([
    { success: true, data: { deleted: ['fixture.txt'] } },
    { success: false, error: 'Operation was declined', code: 'PERMISSION_DENIED' },
    { success: false, error: 'Cancelled', code: 'CANCELLED', cancelled: true }
  ])('用户选择/取消对应的结果得到终态，重复审批不能复活：%j', result => {
    const { state, deliver, tool } = setup()
    deliver({ type: 'toolStatus', toolStatus: true, tool: { id: 'delete-call', name: 'delete_file',
      status: result.success ? 'success' : 'error', result } })
    deliver(approval())
    expect(tool()).toMatchObject({ status: result.success ? 'success' : 'error', result })
    expect(state.activeStreamId.value).toBe('live-stream')
    deliver({ type: 'cancelled', content })
    expect(state.activeStreamId.value).toBeNull()
    expect(state.isWaitingForResponse.value).toBe(false)
    expect(tool()?.result).toEqual(result)
  })

  test('同一审批已进入执行后不能由重复快照复活；新审批 ID 仍可以询问用户', () => {
    const { deliver, tool } = setup()
    deliver({ type: 'toolStatus', toolStatus: true, tool: { id: 'delete-call', name: 'delete_file', status: 'executing' } })
    deliver(approval())
    expect(tool()?.status).toBe('executing')
    deliver(approval({ pendingToolCalls: [{ id: 'delete-call', name: 'delete_file', args: {}, approvalId: 'approval-2' }] }))
    expect(tool()).toMatchObject({ status: 'awaiting_approval', approvalId: 'approval-2' })
  })

  test('已结算工具段的迟到审批不能覆盖下一段模型占位', () => {
    const { state, deliver, tool } = setup()
    deliver({ type: 'toolIteration', content, toolResults: [
      { id: 'delete-call', name: 'delete_file', result: { success: false, error: 'Operation was declined' } },
      { id: 'read-call', name: 'read_file', result: { success: true } }
    ] })
    const nextMessageId = state.streamingMessageId.value
    deliver(approval())
    expect(state.streamingMessageId.value).toBe(nextMessageId)
    expect(state.allMessages.value.filter(message => message.id === 'tool-message')).toHaveLength(1)
    expect(state.isStreaming.value).toBe(true)
    expect(tool()?.status).toBe('error')
  })

  test.each(['error', 'cancelled'] as const)('运行 %s 清理未决审批且保留已完成工具，不再有黄色按钮', type => {
    const { state, deliver, tool } = setup()
    deliver({ type: 'toolStatus', toolStatus: true, tool: { id: 'read-call', name: 'read_file', status: 'success', result: { success: true } } })
    deliver({ type, error: type === 'error' ? { code: 'API_ERROR', message: '运行中断' } : undefined })
    expect(tool()?.status).toBe('error')
    expect(state.allMessages.value.find(message => message.id === 'tool-message')?.tools?.[1]).toMatchObject({ status: 'success', result: { success: true } })
    expect(state.activeStreamId.value).toBeNull()
    expect(state.isWaitingForResponse.value).toBe(false)
    deliver(approval())
    expect(tool()?.status).toBe('error')
    expect(state.activeStreamId.value).toBeNull()
  })

  test('旧运行的审批/终态不能影响新运行', () => {
    const { state, deliver, tool } = setup()
    deliver({ type: 'cancelled' })
    state.activeStreamId.value = 'new-stream'
    state.streamingMessageId.value = 'new-placeholder'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    appendMessage(state, { id: 'new-placeholder', role: 'assistant', content: '', timestamp: 2, streaming: true, localOnly: true })
    deliver(approval())
    deliver({ type: 'error', error: { code: 'API_ERROR', message: '旧错误' } })
    expect(state.activeStreamId.value).toBe('new-stream')
    expect(state.streamingMessageId.value).toBe('new-placeholder')
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(tool()?.status).toBe('error')
  })
})
