import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ send: vi.fn(), subscribe: vi.fn(() => vi.fn()) }))
vi.mock('../../../utils/vscode', () => ({
  sendToExtension: runtime.send,
  onMessageFromExtension: runtime.subscribe
}))

import { useChatStore } from '../../chatStore'

let previousHost: typeof window.__GRAYCODE_HOST
let store: ReturnType<typeof useChatStore>

beforeEach(() => {
  previousHost = window.__GRAYCODE_HOST
  window.__GRAYCODE_HOST = { kind: 'desktop', postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() }
  setActivePinia(createPinia())
  runtime.send.mockReset().mockImplementation(async (type: string) => {
    if (type === 'getWorkspaceUri') return null
    if (type === 'chat.resumeConversationStream') return { active: false }
    if (type === 'conversation.loadConversationForView') {
      return { messages: [], totalMessages: 0, checkpoints: [], modelConfig: {}, promptMode: {} }
    }
    return { success: true }
  })
  store = useChatStore()
  store.openTabs = ['a', 'b'].map(id => ({ id, conversationId: null, title: id, isStreaming: false }))
  store.activeTabId = 'a'
})

afterEach(() => {
  store.$dispose()
  window.__GRAYCODE_HOST = previousHost
})

function holdMetadata() {
  const metadata = [{ id: 'late', title: '稍后返回的历史', createdAt: 1, updatedAt: 1, messageCount: 0 }]
  let release!: (value: typeof metadata) => void
  const pending = new Promise<typeof metadata>(resolve => { release = resolve })
  runtime.send.mockImplementationOnce((type: string) => {
    expect(type).toBe('conversation.getConversationMetadataBatch')
    return pending
  })
  const opening = store.openConversationInTab('late')
  return { opening, release: () => release(metadata) }
}

test.each(['新建标签', '复用空白标签', '切换标签', '再次选择当前标签', '关闭活动标签', '新建对话'])(
  '历史摘要尚未返回时%s，迟到的打开请求不能改变当前选择', async action => {
    if (action === '新建标签') store.inputValue = '留在原标签的草稿'
    const pending = holdMetadata()
    if (action === '新建标签' || action === '复用空白标签') store.createNewTab()
    else if (action === '切换标签') store.switchTab('b')
    else if (action === '再次选择当前标签') store.switchTab('a')
    else if (action === '关闭活动标签') store.closeTab('a')
    else await store.createNewConversation()
    const expectedTab = store.activeTabId
    const expectedConversation = store.currentConversationId
    pending.release()
    await pending.opening
    await flushPromises()

    expect(store.activeTabId).toBe(expectedTab)
    expect(store.currentConversationId).toBe(expectedConversation)
    expect(store.openTabs.some(tab => tab.conversationId === 'late')).toBe(false)
    expect(runtime.send).not.toHaveBeenCalledWith('conversation.loadConversationForView', expect.anything())
  }
)

test.each([false, true])('没有后续导航时仍完成历史绑定，期间关闭后台标签=%s', async closeBackground => {
  const pending = holdMetadata()
  if (closeBackground) store.closeTab('b')
  pending.release()
  await pending.opening
  await flushPromises()

  expect(store.activeTabId).toBe('a')
  expect(store.currentConversationId).toBe('late')
  expect(store.openTabs.find(tab => tab.id === 'a')).toMatchObject({ conversationId: 'late', title: '稍后返回的历史' })
})

test('历史已经加载时再次选择当前标签，保持会话绑定且重新打开不创建重复视图', async () => {
  const pending = holdMetadata()
  let entered!: () => void
  const loading = new Promise<void>(resolve => { entered = resolve })
  const view = { messages: [], totalMessages: 0, checkpoints: [], modelConfig: {}, promptMode: {} }
  let release!: (value: typeof view) => void
  const history = new Promise<typeof view>(resolve => { release = resolve })
  runtime.send.mockImplementationOnce((type: string) => {
    expect(type).toBe('conversation.loadConversationForView')
    entered()
    return history
  })
  pending.release()
  await loading
  store.switchTab('a')
  release(view)
  await pending.opening

  expect(store.currentConversationId).toBe('late')
  expect(store.openTabs.find(tab => tab.id === 'a')).toMatchObject({ conversationId: 'late', title: '稍后返回的历史' })
  await store.openConversationInTab('late')
  expect(store.openTabs.map(tab => tab.id)).toEqual(['a', 'b'])
})
