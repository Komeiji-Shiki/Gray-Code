import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, vi } from 'vitest'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const runtime = vi.hoisted(() => ({
  sendToExtension: vi.fn(),
  onMessageFromExtension: vi.fn(() => vi.fn())
}))

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  onMessageFromExtension: runtime.onMessageFromExtension
}))

import { useChatStore } from '../../chatStore'

describe('chatStore 首次初始化竞态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    runtime.sendToExtension.mockReset()
    runtime.onMessageFromExtension.mockClear()
  })

  test('对话列表初始化仍在途时，首条消息可创建会话、绑定标签页并发起 chatStream', async () => {
    const conversationListRequest = deferred<string[]>()
    runtime.sendToExtension.mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return Promise.resolve(null)
      if (type === 'settings.getActiveChannelId') return Promise.resolve({})
      if (type === 'checkpoint.getConfig') return Promise.resolve({ config: {} })
      if (type === 'conversation.listConversations') return conversationListRequest.promise
      if (type === 'conversation.createConversation') return Promise.resolve({ success: true })
      if (type === 'conversation.setCustomMetadata') return Promise.resolve({ success: true })
      if (type === 'chatStream') return Promise.resolve({ started: true })
      return Promise.resolve(undefined)
    })

    const store = useChatStore()
    const initialization = store.initialize()
    await vi.waitFor(() => {
      expect(runtime.sendToExtension).toHaveBeenCalledWith('conversation.listConversations', {})
    })

    const initialTabId = store.activeTabId
    expect(initialTabId).toBeTruthy()

    const sent = await store.sendMessage('hello')

    expect(sent).toBe(true)
    expect(store.currentConversationId).toMatch(/^conv_/)
    expect(store.openTabs.find(tab => tab.id === initialTabId)?.conversationId).toBe(store.currentConversationId)
    expect(store.allMessages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(runtime.sendToExtension).toHaveBeenCalledWith(
      'chatStream',
      expect.objectContaining({
        conversationId: store.currentConversationId,
        message: 'hello'
      })
    )

    // 初始化的旧列表快照随后返回，也不能删除刚创建的会话和消息。
    conversationListRequest.resolve([])
    await initialization

    expect(store.currentConversationId).toMatch(/^conv_/)
    expect(store.allMessages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(store.conversations.some(conversation => conversation.id === store.currentConversationId)).toBe(true)
  })

  test('首次 await 前建立空白标签页，异步加载结束不覆盖期间创建的会话与消息', async () => {
    const workspaceRequest = deferred<string | null>()
    runtime.sendToExtension.mockImplementation((type: string) => {
      if (type === 'getWorkspaceUri') return workspaceRequest.promise
      if (type === 'settings.getActiveChannelId') return Promise.resolve({})
      if (type === 'checkpoint.getConfig') return Promise.resolve({ config: {} })
      if (type === 'conversation.listConversations') return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    const store = useChatStore()
    const initialization = store.initialize()

    // initialize() 返回 Promise 前就必须有可归属的空白标签页；首条消息发送会固化这个 tabId。
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(store.openTabs[0].id)

    // 模拟初始化 IPC 在途期间首条消息已完成本地创建与乐观插入。
    store.currentConversationId = 'conv_during_init'
    store.openTabs[0].conversationId = 'conv_during_init'
    store.allMessages = [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2, localOnly: true }
    ]

    workspaceRequest.resolve('file:///workspace')
    await initialization

    expect(store.currentConversationId).toBe('conv_during_init')
    expect(store.openTabs[0].conversationId).toBe('conv_during_init')
    expect(store.allMessages.map(message => message.id)).toEqual(['user-1', 'assistant-1'])
  })
})
