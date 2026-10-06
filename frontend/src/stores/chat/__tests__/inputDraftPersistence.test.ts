import { afterEach, expect, test, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import type { Attachment } from '../../../types'
import type { HostTransport } from '../../../utils/hostTransport'
import { createChatState } from '../state'
import { createTab, switchTab } from '../tabActions'
import { createInputDraftPersistence } from '../inputDraftPersistence'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()) })

function hostState() {
  let saved: any = { otherSetting: 7 }
  return {
    getState: () => saved,
    setState: vi.fn(value => { saved = JSON.parse(JSON.stringify(value)) }),
    postMessage: vi.fn(),
  } satisfies HostTransport
}

function start(host: HostTransport) {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => {
    const state = createChatState()
    const persistence = createInputDraftPersistence(state, host)
    const initialTabId = createTab(state)!
    state.activeTabId.value = initialTabId
    persistence.restoreTabs()
    return { state, persistence, initialTabId }
  })!
}

test('草稿在编辑时保存，未执行卸载也能在新实例恢复文字、上下文和附件', async () => {
  const host = hostState()
  const first = start(host)
  first.state.inputValue.value = '还没有写完\n'
  first.state.editorNodes.value = [{ type: 'text', text: '还没有写完\n' }, { type: 'context', context: {
    id: 'context', type: 'snippet', title: '引用', content: 'const value = 1', enabled: true, addedAt: 1,
  } }]
  first.state.attachments.value.push({ id: 'image', name: 'image.png', type: 'image', size: 3, mimeType: 'image/png', data: 'YWJj' })
  await nextTick()
  expect(host.setState).toHaveBeenCalled()
  expect(host.getState().otherSetting).toBe(7)

  // 新实例只读取已经保存的宿主状态；旧实例不触发退出或卸载事件。
  const restarted = start(host)
  const recoveredTab = restarted.persistence.takeActiveTab()!
  switchTab(restarted.state, recoveredTab, vi.fn())
  expect(restarted.state.currentConversationId.value).toBeNull()
  expect(restarted.state.editorNodes.value).toEqual(first.state.editorNodes.value)
  expect(restarted.state.attachments.value).toEqual(first.state.attachments.value)
  expect(restarted.state.inputValue.value).toBe('还没有写完\n')
  expect(restarted.state.allMessages.value).toEqual([])
})

test('输入文字时不重新序列化未变化的附件内容，保存的附件仍然完整', async () => {
  const host = hostState()
  const first = start(host)
  let reads = 0
  const attachment = { id: 'large', name: 'large.png', type: 'image', size: 3, mimeType: 'image/png' } as Attachment
  Object.defineProperty(attachment, 'data', { enumerable: true, get: () => { reads++; return 'YWJj' } })
  first.state.attachments.value.push(attachment)
  await nextTick()
  const afterAdding = reads
  for (const text of ['一', '一二', '一二三']) {
    first.state.inputValue.value = text
    await nextTick()
  }
  expect(reads).toBe(afterAdding)
  expect(host.getState().inputDrafts.drafts[0].input).toMatchObject({ inputValue: '一二三', attachments: [{ id: 'large', data: 'YWJj' }] })
})

test('各对话草稿独立保存，切换期间不会把正文写入另一个对话', async () => {
  const host = hostState()
  const first = start(host)
  first.state.currentConversationId.value = 'conversation-a'
  first.state.editorNodes.value = [{ type: 'text', text: 'A 的草稿' }]
  first.state.inputValue.value = 'A 的草稿'
  const secondTab = createTab(first.state, { conversationId: 'conversation-b' })!
  switchTab(first.state, secondTab, vi.fn())
  first.state.editorNodes.value = [{ type: 'text', text: 'B 的草稿' }]
  first.state.inputValue.value = 'B 的草稿'
  await nextTick()

  const restarted = start(host)
  switchTab(restarted.state, restarted.persistence.takeActiveTab()!, vi.fn())
  expect(restarted.state.currentConversationId.value).toBe('conversation-b')
  expect(restarted.state.inputValue.value).toBe('B 的草稿')
  const tabA = restarted.state.openTabs.value.find(tab => tab.conversationId === 'conversation-a')!
  switchTab(restarted.state, tabA.id, vi.fn())
  expect(restarted.state.inputValue.value).toBe('A 的草稿')
})

test('发送或清空后的草稿不再恢复，后台草稿的迟到恢复也会保存', async () => {
  const host = hostState()
  const first = start(host)
  first.state.editorNodes.value = [{ type: 'text', text: '待发送' }]
  first.state.inputValue.value = '待发送'
  await nextTick()
  first.state.editorNodes.value = []
  first.state.inputValue.value = ''
  await nextTick()
  expect(host.getState().inputDrafts.drafts).toEqual([])

  const secondTab = createTab(first.state)!
  switchTab(first.state, secondTab, vi.fn())
  const background = first.state.sessionSnapshots.value.get(first.initialTabId)!
  background.editorNodes = [{ type: 'text', text: '发送失败后恢复' }]
  background.inputValue = '发送失败后恢复'
  await nextTick()
  const restarted = start(host)
  const restored = restarted.state.sessionSnapshots.value.get(first.initialTabId)!
  expect(restored.inputValue).toBe('发送失败后恢复')
})
