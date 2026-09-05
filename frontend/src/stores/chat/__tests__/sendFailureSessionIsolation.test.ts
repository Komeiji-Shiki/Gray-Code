import { describe, expect, test, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { ChatStoreComputed, ConversationSessionSnapshot } from '../types'
import { createChatState } from '../state'
import { sendMessage } from '../messageActions/sendMessageFlow'
import { sendToExtension } from '../../../utils/vscode'

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
})
