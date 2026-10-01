/**
 * 计划/设计/审查卡片确认（隐藏 functionResponse 发送）失败回滚。
 *
 * 卡片“已执行/已生成”由工具响应里的 continuationPrompt 推导；隐藏发送会在宿主接受前
 * 把确认字段乐观合并进本地响应。宿主拒绝（有活跃任务、确认已失效等）后若不撤回，
 * 按钮会显示已完成却从未执行，且无法重试。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Message } from '../../types'
import type { ChatStoreComputed, ConversationSessionSnapshot } from '../../stores/chat/types'
import { sendMessage } from '../../stores/chat/messageActions'
import { appendMessage, createChatState } from '../../stores/chat/state'
import { getToolResponseById } from '../../stores/chat/toolActions'
import { getPlanExecutionPrompt } from '../../utils/toolContinuations'

vi.mock('../../utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '../../utils/vscode'

const computed = { currentModelName: { value: 'test-model' } } as unknown as ChatStoreComputed
const original = { success: true, data: { path: 'plan.md' } }
const approval = {
  approvalId: 'gate-1', id: 'plan-call', name: 'create_plan',
  response: { continuationApproved: true, continuationIntent: 'implement_now', continuationPrompt: 'Start now', planExecutionPrompt: 'Start now' }
}

function createState(withOriginalResponse = true) {
  const state = createChatState()
  state.currentConversationId.value = 'conversation'
  state.configId.value = 'config'
  if (withOriginalResponse) {
    appendMessage(state, { id: 'model', role: 'assistant', content: '', timestamp: 1, backendIndex: 0,
      parts: [{ functionCall: { id: 'plan-call', name: 'create_plan', args: {} } }] } as Message)
    appendMessage(state, { id: 'response', role: 'user', content: '', timestamp: 2, backendIndex: 1, isFunctionResponse: true,
      parts: [{ functionResponse: { id: 'plan-call', name: 'create_plan', response: original } }] } as Message)
    // 卡片渲染会先读一次响应并回填缓存；回滚必须同时处理窗口消息和缓存。
    expect(getToolResponseById(state, 'plan-call')).toEqual(original)
  }
  state.totalMessages.value = state.allMessages.value.length
  return state
}

function mockChatStream(result: () => Promise<unknown>) {
  vi.mocked(sendToExtension).mockImplementation((type: string) => type === 'chatStream' ? result() : Promise.resolve(undefined))
}

beforeEach(() => vi.mocked(sendToExtension).mockReset())

describe('隐藏确认发送被宿主拒绝', () => {
  test.each([
    ['抛出错误', () => Promise.reject(new Error('请等待当前任务完成后确认文档。'))],
    ['返回 success=false', () => Promise.resolve({ success: false })]
  ])('%s时恢复原工具响应，卡片仍可再次确认', async (_label, result) => {
    const state = createState()
    const before = state.allMessages.value.map(message => message.id)
    mockChatStream(result)

    expect(await sendMessage(state, computed, '', undefined, { hidden: { functionResponse: approval } })).toBe(false)

    expect(state.allMessages.value.map(message => message.id)).toEqual(before)
    expect(state.allMessages.value[1].parts?.[0].functionResponse?.response).toEqual(original)
    expect(getToolResponseById(state, 'plan-call')).toEqual(original)
    expect(getPlanExecutionPrompt(getToolResponseById(state, 'plan-call'))).toBe('')
    expect(state.error.value?.message).toBeTruthy()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
  })

  test('原响应不在窗口时，失败后移除本次追加的隐藏响应', async () => {
    const state = createState(false)
    mockChatStream(() => Promise.reject(new Error('文档确认已失效，请重新打开当前请求。')))

    expect(await sendMessage(state, computed, '', undefined, { hidden: { functionResponse: approval } })).toBe(false)

    expect(state.allMessages.value).toHaveLength(0)
    expect(getToolResponseById(state, 'plan-call')).toBeNull()
  })

  test('发送途中切到其他标签页后被拒绝，撤回原标签页快照里的确认字段', async () => {
    const state = createState()
    state.activeTabId.value = 'tab-a'
    state.openTabs.value = [
      { id: 'tab-a', conversationId: 'conversation', title: 'A', isStreaming: true },
      { id: 'tab-b', conversationId: 'other', title: 'B', isStreaming: false }
    ]
    let reject!: (error: Error) => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    mockChatStream(() => { entered(); return new Promise((_resolve, rejectRequest) => { reject = rejectRequest }) })
    const request = sendMessage(state, computed, '', undefined, { hidden: { functionResponse: approval } })
    await ready

    state.sessionSnapshots.value.set('tab-a', {
      conversationId: 'conversation', allMessages: [...state.allMessages.value], windowStartIndex: 0,
      totalMessages: state.allMessages.value.length, streamingMessageId: state.streamingMessageId.value,
      activeStreamId: state.activeStreamId.value, isLoading: true, isStreaming: true, isWaitingForResponse: true,
      pendingModelOverride: null, pendingConfigIdOverride: null, error: null,
      toolResponseCache: Array.from(state.toolResponseCache.value.entries())
    } as ConversationSessionSnapshot)
    const snapshot = state.sessionSnapshots.value.get('tab-a')!
    state.currentConversationId.value = 'other'
    state.activeTabId.value = 'tab-b'
    state.allMessages.value = []
    state.toolResponseCache.value = new Map()
    reject(new Error('请等待当前任务完成后确认文档。'))

    expect(await request).toBe(false)
    expect(snapshot.allMessages.map(message => message.id)).toEqual(['model', 'response'])
    expect(snapshot.allMessages[1].parts?.[0].functionResponse?.response).toEqual(original)
    expect(new Map(snapshot.toolResponseCache).get('plan-call')).toEqual(original)
    expect(snapshot.error?.message).toBe('请等待当前任务完成后确认文档。')
  })

  // 平台审批 keepStreamOpen：等待审批时 isStreaming=false 但流仍属于原任务。宿主一定拒绝此时的
  // 文档确认；提前发送会覆盖并在失败后清空原任务的流绑定，别处完成审批后界面就收不到后续输出。
  test('任务仍挂着流（等待工具审批）时不发送，也不改动原任务的流状态', async () => {
    const state = createState()
    state.activeStreamId.value = 'live-run'
    state.streamingMessageId.value = 'model'
    state.isStreaming.value = false
    state.isWaitingForResponse.value = true
    mockChatStream(() => Promise.resolve({ success: true }))

    expect(await sendMessage(state, computed, '', undefined, { hidden: { functionResponse: approval } })).toBe(false)

    expect(vi.mocked(sendToExtension)).not.toHaveBeenCalled()
    expect(state.activeStreamId.value).toBe('live-run')
    expect(state.streamingMessageId.value).toBe('model')
    expect(state.isWaitingForResponse.value).toBe(true)
    expect(getToolResponseById(state, 'plan-call')).toEqual(original)
  })

  test('宿主接受时保留确认字段', async () => {
    const state = createState()
    mockChatStream(() => Promise.resolve({ success: true, runId: 'run' }))

    expect(await sendMessage(state, computed, '', undefined, { hidden: { functionResponse: approval } })).toBe(true)

    expect(getPlanExecutionPrompt(getToolResponseById(state, 'plan-call'))).toBe('Start now')
  })
})
