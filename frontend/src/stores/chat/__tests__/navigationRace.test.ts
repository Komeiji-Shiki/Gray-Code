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

function holdBranch(waitForCancellation: boolean, workspaceUri: string | null = null) {
  store.currentConversationId = 'source'
  store.currentWorkspaceUri = workspaceUri
  store.openTabs[0].conversationId = 'source'
  store.conversations = [{
    id: 'source', title: '来源', createdAt: 1, updatedAt: 1, messageCount: 1,
    isPersisted: true, workspaceUri: workspaceUri || undefined
  }]
  store.isStreaming = waitForCancellation
  store.activeStreamId = waitForCancellation ? 'source-stream' : null
  let releaseCancellation!: () => void
  let rejectCancellation!: (error: Error) => void
  const cancellation = new Promise<void>((resolve, reject) => { releaseCancellation = resolve; rejectCancellation = reject })
  const result = { success: true, conversationId: 'branch', title: '分支', createdAt: 2, updatedAt: 2, messageCount: 1 }
  let releaseResult!: (value: typeof result) => void
  let rejectResult!: (error: Error) => void
  const creation = new Promise<typeof result>((resolve, reject) => { releaseResult = resolve; rejectResult = reject })
  const fallback = runtime.send.getMockImplementation()
  runtime.send.mockImplementation((type: string, data: unknown) => {
    if (type === 'cancelStream') return cancellation.then(() => ({ success: true }))
    if (type === 'conversation.createBranchConversation') return creation
    return fallback?.(type, data)
  })
  return { releaseCancellation, rejectCancellation, releaseResult: () => releaseResult(result), rejectResult }
}

test.each([false, true])('创建分支立即使旧历史导航失效，等待取消=%s', async waitForCancellation => {
  const held = holdBranch(waitForCancellation)
  const pending = holdMetadata()
  const branching = store.branchFromMessage(0)
  try {
    pending.release()
    await pending.opening
    expect(store.currentConversationId).toBe('source')
    expect(store.openTabs.some(tab => tab.conversationId === 'late')).toBe(false)
  } finally {
    held.releaseCancellation()
    held.releaseResult()
    await branching
  }
  expect(store.currentConversationId).toBe('branch')
  expect(store.openTabs.find(tab => tab.id === store.activeTabId)?.conversationId).toBe('branch')
})

test.each([
  { waitForCancellation: false, workspaceUri: null },
  { waitForCancellation: true, workspaceUri: null },
  { waitForCancellation: false, workspaceUri: 'file:///source-project' },
  { waitForCancellation: true, workspaceUri: 'file:///source-project' }
])('创建分支等待期间切换标签，保留来源工作区与后续选择：%j', async ({ waitForCancellation, workspaceUri }) => {
  const held = holdBranch(waitForCancellation, workspaceUri)
  const branching = store.branchFromMessage(0)
  store.switchTab('b')
  store.currentWorkspaceUri = 'file:///later-project'
  held.releaseCancellation()
  held.releaseResult()
  await branching
  await flushPromises()

  expect(runtime.send).toHaveBeenCalledWith('conversation.createBranchConversation', expect.objectContaining({ sourceConversationId: 'source' }))
  expect(store.conversations.find(conversation => conversation.id === 'branch')).toMatchObject({
    id: 'branch', isPersisted: true, workspaceUri: workspaceUri || undefined
  })
  expect(store.activeTabId).toBe('b')
  expect(store.currentConversationId).toBeNull()
  expect(store.openTabs.some(tab => tab.conversationId === 'branch')).toBe(false)
})

test.each([false, true])('分支创建的失败只更新仍属于它的界面，切换标签=%s', async switched => {
  const held = holdBranch(false)
  const branching = store.branchFromMessage(0)
  const currentError = { code: 'CURRENT_ERROR', message: '当前标签自己的错误' }
  if (switched) {
    store.switchTab('b')
    store.error = currentError
  }
  held.rejectResult(Object.assign(new Error('来源已删除'), { code: 'SOURCE_MISSING' }))
  await branching

  expect(store.activeTabId).toBe(switched ? 'b' : 'a')
  expect(store.currentConversationId).toBe(switched ? null : 'source')
  expect(store.error).toEqual(switched ? currentError : { code: 'SOURCE_MISSING', message: '来源已删除' })
})

test.each([false, true])('分支前取消失败不向后续界面抛出通知，切换标签=%s', async switched => {
  const held = holdBranch(true)
  const branching = store.branchFromMessage(0)
  const currentError = { code: 'CURRENT_ERROR', message: '当前标签自己的错误' }
  if (switched) {
    store.switchTab('b')
    store.error = currentError
  }
  held.rejectCancellation(new Error('取消连接失败'))
  if (switched) {
    await expect(branching).resolves.toBeUndefined()
    expect(store.error).toEqual(currentError)
  } else {
    await expect(branching).rejects.toThrow('取消连接失败')
    expect(store.error).toMatchObject({ code: 'CANCEL_ERROR', details: '取消连接失败' })
  }
  expect(runtime.send).not.toHaveBeenCalledWith('conversation.createBranchConversation', expect.anything())
})
