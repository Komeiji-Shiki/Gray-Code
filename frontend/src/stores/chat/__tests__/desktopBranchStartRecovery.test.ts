import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import { createChatState } from '../state'
import { snapshotCurrentSession } from '../tabActions'
import { retryFromMessage, editAndRetry } from '../messageActions/retryFlows'
import { cancelStream } from '../toolActions'
import { sendToExtension } from '../../../utils/vscode'
import type { ChatStoreComputed } from '../types'

vi.mock('../../../utils/vscode', () => ({ sendToExtension: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

const operations = [
  { name: '重生成', run: (state: ReturnType<typeof createChatState>, computed: ChatStoreComputed) => retryFromMessage(state, computed, 1, async () => {}) },
  { name: '编辑重发', run: (state: ReturnType<typeof createChatState>, computed: ChatStoreComputed) => editAndRetry(state, computed, 0, '编辑后的输入', undefined, async () => {}) }
]
const persisted = { total: 2, messages: [
  { id: 'saved-user', role: 'user', index: 0, parts: [{ text: '原始输入' }] },
  { id: 'saved-model', role: 'model', index: 1, parts: [{ text: '原始回复' }] }
] }
const cancelled = () => Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED_ERROR' })

function preparingState() {
  const state = createChatState()
  state.currentConversationId.value = 'conversation-a'
  state.configId.value = 'config'
  state.inputValue.value = '保留的草稿'
  state.allMessages.value = [
    { id: 'saved-user', role: 'user', content: '原始输入', timestamp: 1, backendIndex: 0, parentId: null },
    { id: 'saved-model', role: 'assistant', content: '原始回复', timestamp: 2, backendIndex: 1, localOnly: false }
  ]
  return state
}

describe('独立宿主分支请求启动恢复的归属', () => {
  let previousHost: typeof window.__GRAYCODE_HOST
  let start: ReturnType<typeof deferred<unknown>>
  let history: ReturnType<typeof deferred<unknown>>
  const computed = { currentModelName: ref('测试模型') } as ChatStoreComputed
  beforeEach(() => {
    previousHost = window.__GRAYCODE_HOST
    window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof previousHost>
    start = deferred()
    history = deferred()
    vi.mocked(sendToExtension).mockReset().mockImplementation((type: string) => {
      if (['chat.rerollStream', 'chat.editBranchStream', 'retryStream'].includes(type)) return start.promise
      if (type === 'conversation.getMessagesPaged') return history.promise
      return Promise.resolve({ success: true, checkpoints: [] })
    })
  })
  afterEach(() => { window.__GRAYCODE_HOST = previousHost })

  async function waitForRecovery() {
    await vi.waitFor(() => expect(sendToExtension).toHaveBeenCalledWith('conversation.getMessagesPaged', expect.anything()))
  }

  test.each(operations)('$name 准备阶段被停止，恢复原历史且不显示假失败', async operation => {
    const state = preparingState()
    const request = operation.run(state, computed)
    start.reject(cancelled())
    await waitForRecovery()
    expect(state.isStreaming.value).toBe(false)
    expect(state.isWaitingForResponse.value).toBe(false)
    history.resolve(persisted)
    await request
    expect(state.allMessages.value.map(message => message.id)).toEqual(['saved-user', 'saved-model'])
    expect(state.allMessages.value[0].content).toBe('原始输入')
    expect(state.error.value).toBeNull()
    expect(state.inputValue.value).toBe('保留的草稿')
    expect(state.isLoading.value).toBe(false)
  })

  test.each(operations)('$name 的取消回执早于原请求拒绝，仍恢复原回复', async operation => {
    const state = preparingState()
    const request = operation.run(state, computed)
    await cancelStream(state, computed)
    start.reject(cancelled())
    await waitForRecovery()
    history.resolve(persisted)
    await request
    expect(state.allMessages.value.map(message => message.id)).toEqual(['saved-user', 'saved-model'])
    expect(state.error.value).toBeNull()
    expect(state.isStreaming.value).toBe(false)
  })

  test.each(operations)('$name 旧历史读取期间切会话，不能覆盖新窗口或清掉新等待', async operation => {
    const state = preparingState()
    const request = operation.run(state, computed)
    start.reject(new Error('启动失败'))
    await waitForRecovery()
    state.currentConversationId.value = 'conversation-b'
    state.allMessages.value = [{ id: 'b-message', role: 'assistant', content: 'B 的回复', timestamp: 3 }]
    state.activeStreamId.value = 'b-stream'
    state.streamingMessageId.value = 'b-message'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    state.isLoading.value = true
    state.error.value = null
    history.resolve(persisted)
    await request
    expect(state.allMessages.value.map(message => message.id)).toEqual(['b-message'])
    expect(state.activeStreamId.value).toBe('b-stream')
    expect(state.isStreaming.value).toBe(true)
    expect(state.isLoading.value).toBe(true)
    expect(state.error.value).toBeNull()
  })

  test.each(operations)('$name 旧恢复期间同会话新运行已开始，丢弃迟到历史并保留新分支标记', async operation => {
    const state = preparingState()
    const request = operation.run(state, computed)
    start.reject(new Error('启动失败'))
    await waitForRecovery()
    state.allMessages.value = [{ id: 'next-message', role: 'assistant', content: '新运行', timestamp: 3 }]
    state.activeStreamId.value = 'next-stream'
    state.streamingMessageId.value = 'next-message'
    state.isStreaming.value = true
    state.isWaitingForResponse.value = true
    state.isLoading.value = true
    state._pendingBranchRefreshAfterStream.value = 'conversation-a'
    state.error.value = null
    history.resolve(persisted)
    await request
    expect(state.allMessages.value.map(message => message.id)).toEqual(['next-message'])
    expect(state.activeStreamId.value).toBe('next-stream')
    expect(state.isLoading.value).toBe(true)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conversation-a')
  })

  test.each(operations)('$name 原请求迟到拒绝时已有后续运行，不再启动旧恢复', async operation => {
    const state = preparingState()
    const request = operation.run(state, computed)
    state.activeStreamId.value = 'next-stream'
    state.streamingMessageId.value = 'next-message'
    state._pendingBranchRefreshAfterStream.value = 'conversation-a'
    start.reject(cancelled())
    await request
    expect(sendToExtension).not.toHaveBeenCalledWith('conversation.getMessagesPaged', expect.anything())
    expect(state.activeStreamId.value).toBe('next-stream')
    expect(state.isLoading.value).toBe(true)
    expect(state._pendingBranchRefreshAfterStream.value).toBe('conversation-a')
    expect(state.error.value).toBeNull()
  })

  test.each(operations)('$name 准备中止时已切到后台，解除原快照等待且保留新会话', async operation => {
    const state = preparingState()
    state.openTabs.value = [{ id: 'tab-a', conversationId: 'conversation-a', title: 'A', isStreaming: true }]
    const request = operation.run(state, computed)
    const snapshot = snapshotCurrentSession(state)
    state.sessionSnapshots.value.set('tab-a', snapshot)
    state.currentConversationId.value = 'conversation-b'
    state.allMessages.value = [{ id: 'b-message', role: 'assistant', content: 'B 的回复', timestamp: 3 }]
    state.activeStreamId.value = 'b-stream'
    state.streamingMessageId.value = 'b-message'
    state.inputValue.value = 'B 的草稿'
    start.reject(cancelled())
    await request
    expect(snapshot.isStreaming).toBe(false)
    expect(snapshot.isWaitingForResponse).toBe(false)
    expect(snapshot.activeStreamId).toBeNull()
    expect(snapshot.pendingBranchRefreshAfterStream).toBeNull()
    expect(snapshot.allMessages.every(message => message.role !== 'assistant')).toBe(true)
    expect(snapshot.inputValue).toBe('保留的草稿')
    expect(state.openTabs.value[0].isStreaming).toBe(false)
    expect(state.allMessages.value.map(message => message.id)).toEqual(['b-message'])
    expect(state.activeStreamId.value).toBe('b-stream')
    expect(state.isLoading.value).toBe(true)
    expect(state.inputValue.value).toBe('B 的草稿')
    expect(sendToExtension).not.toHaveBeenCalledWith('conversation.getMessagesPaged', expect.anything())
  })

  test('本地空占位重试准备中止，只移除未保存空气泡', async () => {
    const state = preparingState()
    state.allMessages.value[1] = { ...state.allMessages.value[1], content: '', localOnly: true }
    const request = retryFromMessage(state, computed, 1, async () => {})
    start.reject(cancelled())
    await request
    expect(state.allMessages.value.map(message => message.id)).toEqual(['saved-user'])
    expect(state.error.value).toBeNull()
    expect(state.isWaitingForResponse.value).toBe(false)
  })
})
