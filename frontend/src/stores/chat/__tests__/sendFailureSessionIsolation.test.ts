import { describe, expect, test, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { ChatStoreComputed, ConversationSessionSnapshot } from '../types'
import { createChatState } from '../state'
import { sendMessage } from '../messageActions/sendMessageFlow'
import { cancelStream } from '../toolActions'
import { sendToExtension } from '../../../utils/vscode'
import { createAndPersistConversation, syncConversationWorkspaceUri } from '../conversationActions'
import { persistConversationModelConfig, persistConversationPromptMode } from '../configActions'

vi.mock('../../../utils/vscode', () => ({ sendToExtension: vi.fn() }))
vi.mock('../conversationActions', () => ({
  syncConversationWorkspaceUri: vi.fn().mockResolvedValue(undefined),
  createAndPersistConversation: vi.fn()
}))
vi.mock('../configActions', () => ({
  persistConversationModelConfig: vi.fn(), persistConversationPromptMode: vi.fn()
}))
vi.mock('../checkpointActions', () => ({ clearCheckpointsFromIndex: vi.fn() }))
vi.mock('../tabActions', () => ({ updateTabConversationId: vi.fn(), updateTabTitle: vi.fn() }))

function beginSend() {
  const state = createChatState()
  state.currentConversationId.value = 'a'
  state.activeTabId.value = 'tab-a'
  state.openTabs.value = [
    { id: 'tab-a', conversationId: 'a', title: 'A', isStreaming: true },
    { id: 'tab-b', conversationId: 'b', title: 'B', isStreaming: true }
  ]
  state.configId.value = 'config-a'
  let reject!: (error: Error) => void
  let acknowledge!: (result: { success: boolean }) => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(sendToExtension).mockImplementation(() => {
    entered()
    return new Promise((resolve, rejectRequest) => { acknowledge = resolve; reject = rejectRequest })
  })
  const computed = { currentModelName: ref('model-a') } as ChatStoreComputed
  const request = sendMessage(state, computed, 'hello')
  return { state, request, ready, reject: (error: Error) => reject(error), acknowledge: () => acknowledge({ success: true }) }
}

function switchToB(state: ReturnType<typeof createChatState>) {
  const snapshot = {
    conversationId: 'a', allMessages: [...state.allMessages.value],
    windowStartIndex: 0, totalMessages: state.allMessages.value.length,
    streamingMessageId: state.streamingMessageId.value, activeStreamId: state.activeStreamId.value,
    isLoading: true, isStreaming: true, isWaitingForResponse: true,
    pendingModelOverride: 'model-a', pendingConfigIdOverride: 'config-a', error: null
  } as ConversationSessionSnapshot
  state.sessionSnapshots.value.set('tab-a', snapshot)
  state.currentConversationId.value = 'b'
  state.activeTabId.value = 'tab-b'
  state.allMessages.value = [{ id: 'b-message', role: 'assistant', content: 'B is running', timestamp: 2 }]
  state.streamingMessageId.value = 'b-message'
  state.activeStreamId.value = 'b-stream'
  state.isLoading.value = true
  state.pendingModelOverride.value = 'model-b'
  state.pendingConfigIdOverride.value = 'config-b'
  return state.sessionSnapshots.value.get('tab-a')!
}

describe('sendMessage request settlement stays in its origin session', () => {
  beforeEach(() => { vi.clearAllMocks() })

  test('a late rejection clears A snapshot while preserving the active B stream', async () => {
    const send = beginSend()
    await send.ready
    const snapshot = switchToB(send.state)
    send.reject(new Error('A failed'))
    await expect(send.request).resolves.toBe(false)

    expect(send.state.activeStreamId.value).toBe('b-stream')
    expect(send.state.streamingMessageId.value).toBe('b-message')
    expect(send.state.isStreaming.value).toBe(true)
    expect(send.state.isWaitingForResponse.value).toBe(true)
    expect(send.state.isLoading.value).toBe(true)
    expect(send.state.pendingModelOverride.value).toBe('model-b')
    expect(send.state.pendingConfigIdOverride.value).toBe('config-b')
    expect(send.state.error.value).toBeNull()
    expect(snapshot).toMatchObject({
      allMessages: [], totalMessages: 0, activeStreamId: null, streamingMessageId: null,
      isLoading: false, isStreaming: false, isWaitingForResponse: false,
      pendingModelOverride: null, pendingConfigIdOverride: null,
      error: { message: 'A failed' }
    })
  })

  test('a late success clears only A loading flag', async () => {
    const send = beginSend()
    await send.ready
    const snapshot = switchToB(send.state)
    send.acknowledge()
    await expect(send.request).resolves.toBe(true)
    expect(send.state.isLoading.value).toBe(true)
    expect(snapshot.isLoading).toBe(false)
    expect(snapshot.isStreaming).toBe(true)
  })

  test('a closed origin tab cannot reset the current tab', async () => {
    const send = beginSend()
    await send.ready
    switchToB(send.state)
    send.state.openTabs.value = send.state.openTabs.value.filter(tab => tab.id !== 'tab-a')
    send.state.sessionSnapshots.value.delete('tab-a')
    send.reject(new Error('A failed'))
    await send.request
    expect(send.state.activeStreamId.value).toBe('b-stream')
    expect(send.state.isLoading.value).toBe(true)
    expect(send.state.error.value).toBeNull()
  })

  test('an older request cannot clear a successor stream in the same session', async () => {
    const send = beginSend()
    await send.ready
    send.state.streamingMessageId.value = 'new-message'
    send.state.activeStreamId.value = 'new-stream'
    send.reject(new Error('old request failed'))
    await send.request
    expect(send.state.activeStreamId.value).toBe('new-stream')
    expect(send.state.isLoading.value).toBe(true)
    expect(send.state.error.value).toBeNull()
  })

  test('a rejection still cleans the active origin session', async () => {
    const send = beginSend()
    await send.ready
    send.reject(new Error('send failed'))
    await send.request
    expect(send.state.allMessages.value).toEqual([])
    expect(send.state.activeStreamId.value).toBeNull()
    expect(send.state.isStreaming.value).toBe(false)
    expect(send.state.isLoading.value).toBe(false)
    expect(send.state.error.value?.message).toBe('send failed')
  })

  test.each(['before', 'after'])('独立端准备中止在取消回执 %s 到达，不显示发送失败或保留未落库消息', async order => {
    const previousHost = window.__GRAYCODE_HOST
    window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof previousHost>
    try {
      const send = beginSend()
      await send.ready
      let finishCancel!: (value: unknown) => void
      vi.mocked(sendToExtension).mockImplementation(() => new Promise(resolve => { finishCancel = resolve }))
      const cancellation = cancelStream(send.state, {} as ChatStoreComputed)
      send.state.inputValue.value = '停止后正在写的新输入'
      send.state.editorNodes.value = [{ type: 'text', text: '停止后正在写的新输入' }]
      if (order === 'after') { finishCancel({ success: true }); await cancellation }
      send.reject(Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED_ERROR' }))
      expect(await send.request).toBe(false)
      if (order === 'before') { finishCancel({ success: true }); await cancellation }
      expect(send.state.allMessages.value).toEqual([])
      expect(send.state.isStreaming.value).toBe(false)
      expect(send.state.isWaitingForResponse.value).toBe(false)
      expect(send.state.error.value).toBeNull()
      expect(send.state.inputValue.value).toBe('停止后正在写的新输入')
    } finally { window.__GRAYCODE_HOST = previousHost }
  })

  test('准备中止的迟到拒绝只移除未提交消息，保持同会话后续运行和已输入草稿', async () => {
    const previousHost = window.__GRAYCODE_HOST
    window.__GRAYCODE_HOST = { kind: 'desktop' } as NonNullable<typeof previousHost>
    try {
      const send = beginSend()
      await send.ready
      vi.mocked(sendToExtension).mockResolvedValue({ success: true })
      await cancelStream(send.state, {} as ChatStoreComputed)
      send.state.allMessages.value.push(
        { id: 'new-user', role: 'user', content: '新的已提交输入', timestamp: 3, backendIndex: 1 },
        { id: 'new-assistant', role: 'assistant', content: '新回复', timestamp: 4, backendIndex: 2, streaming: true, localOnly: true }
      )
      send.state.activeStreamId.value = 'new-stream'
      send.state.streamingMessageId.value = 'new-assistant'
      send.state.isStreaming.value = true
      send.state.isWaitingForResponse.value = true
      send.state.inputValue.value = '第三条草稿'
      send.reject(Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED_ERROR' }))
      await send.request
      expect(send.state.allMessages.value.map(message => message.id)).toEqual(['new-user', 'new-assistant'])
      expect(send.state.allMessages.value.map(message => message.backendIndex)).toEqual([0, 1])
      expect(send.state.activeStreamId.value).toBe('new-stream')
      expect(send.state.isStreaming.value).toBe(true)
      expect(send.state.error.value).toBeNull()
      expect(send.state.inputValue.value).toBe('第三条草稿')
    } finally { window.__GRAYCODE_HOST = previousHost }
  })

  test('创建期间切换会话时不写新会话的配置，原草稿退出等待状态', async () => {
    const state = createChatState()
    state.activeTabId.value = 'tab-a'
    state.openTabs.value = [{ id: 'tab-a', conversationId: null, title: 'A', isStreaming: true }]
    let finishCreate!: (id: string) => void
    vi.mocked(createAndPersistConversation).mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve }))
    const request = sendMessage(state, { currentModelName: ref('model-a') } as ChatStoreComputed, 'first')
    const snapshot = switchToB(state)
    finishCreate('created-a')
    expect(await request).toBe(false)
    expect(persistConversationModelConfig).not.toHaveBeenCalled()
    expect(persistConversationPromptMode).not.toHaveBeenCalled()
    expect(state.activeStreamId.value).toBe('b-stream')
    expect(snapshot.isLoading).toBe(false)
    expect(snapshot.isWaitingForResponse).toBe(false)
    expect(snapshot.isStreaming).toBe(false)
  })

  test('发送前工作区同步期间切走，原会话的未发送占位和等待状态一起清理', async () => {
    const state = createChatState()
    state.currentConversationId.value = 'a'
    state.activeTabId.value = 'tab-a'
    state.openTabs.value = [{ id: 'tab-a', conversationId: 'a', title: 'A', isStreaming: true }]
    let finishSync!: () => void
    vi.mocked(syncConversationWorkspaceUri).mockImplementationOnce(() => new Promise(resolve => { finishSync = resolve }))
    const request = sendMessage(state, { currentModelName: ref('model-a') } as ChatStoreComputed, 'first')
    const snapshot = switchToB(state)
    finishSync()
    expect(await request).toBe(false)
    expect(snapshot.allMessages).toEqual([])
    expect(snapshot.isStreaming).toBe(false)
    expect(snapshot.isWaitingForResponse).toBe(false)
    expect(state.activeStreamId.value).toBe('b-stream')
  })
})
