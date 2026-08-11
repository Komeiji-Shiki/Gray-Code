/**
 * ConversationList 组件测试——删除对话确认流程
 *
 * 回归背景：ConfirmDialog 确认时先置 visible=false（同步 emit update:modelValue:false）
 * 再 emit confirm；若父组件通过 @update:model-value 同步清空 pendingDeleteId，
 * confirmDelete 读到的恒为 null，delete 事件永远不会发出，导致「最近对话无法删除」。
 * 修复后删除事件必须正常发出；取消路径（取消按钮 / Esc / 遮罩）不得触发删除。
 */
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConversationList from '../ConversationList.vue'
import type { Conversation } from '../../../stores'

const chatStoreMock = {
  isDeletingConversation: vi.fn().mockReturnValue(false)
}

vi.mock('../../../stores', () => ({
  useChatStore: () => chatStoreMock
}))

function makeConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `对话 ${id}`,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 2,
    isPersisted: true,
    ...overrides
  }
}

function mountList(conversations: Conversation[] = [makeConversation('c1')], currentId: string | null = null): VueWrapper {
  return mount(ConversationList, {
    props: {
      conversations,
      currentId,
      formatTime: (ts: number) => String(ts)
    },
    global: {
      stubs: { teleport: true }
    }
  })
}

function findTrashButton(wrapper: VueWrapper): ReturnType<VueWrapper['find']> {
  const buttons = wrapper.findAll('.icon-button')
  return buttons.find(b => b.find('.codicon-trash').exists()) ?? wrapper.find('.no-such-button')
}

async function clickTrash(wrapper: VueWrapper): Promise<void> {
  await findTrashButton(wrapper).trigger('click')
  await nextTick()
}

describe('ConversationList 删除确认流程', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    chatStoreMock.isDeletingConversation.mockReturnValue(false)
    wrapper = mountList()
  })

  afterEach(() => {
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  test('点击垃圾桶弹出确认框，确认后发出 delete 事件（回归：确认后 delete 不再丢失）', async () => {
    await clickTrash(wrapper)

    const dialog = wrapper.find('.dialog')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('删除对话')

    const confirmBtn = wrapper.find('.dialog-btn.confirm')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')

    expect(wrapper.emitted('delete')).toEqual([['c1']])
    await nextTick()
    expect(wrapper.find('.dialog').exists()).toBe(false)
  })

  test('取消按钮关闭确认框且不发出 delete 事件', async () => {
    await clickTrash(wrapper)
    expect(wrapper.find('.dialog').exists()).toBe(true)

    await wrapper.find('.dialog-btn.cancel').trigger('click')

    expect(wrapper.emitted('delete')).toBeUndefined()
    await nextTick()
    expect(wrapper.find('.dialog').exists()).toBe(false)
  })

  test('Esc 关闭确认框且不发出 delete 事件', async () => {
    await clickTrash(wrapper)
    await wrapper.find('.dialog').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('delete')).toBeUndefined()
    await nextTick()
    expect(wrapper.find('.dialog').exists()).toBe(false)
  })

  test('确认框确认后再次点击垃圾桶可再次删除（pendingDeleteId 已被清理）', async () => {
    await clickTrash(wrapper)
    await wrapper.find('.dialog-btn.confirm').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['c1']])

    await clickTrash(wrapper)
    await wrapper.find('.dialog-btn.confirm').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['c1'], ['c1']])
  })

  test('删除进行中显示 spinner 且不再渲染垃圾桶按钮', async () => {
    chatStoreMock.isDeletingConversation.mockImplementation((id: string) => id === 'c1')
    wrapper = mountList()

    expect(findTrashButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.deleting-indicator').exists()).toBe(true)
  })

  test('多条对话删除互不干扰：删除 c2 只发出对应 id', async () => {
    wrapper = mountList([makeConversation('c1'), makeConversation('c2')])

    const buttons = wrapper.findAll('.icon-button').filter(b => b.find('.codicon-trash').exists())
    expect(buttons).toHaveLength(2)
    await buttons[1].trigger('click')
    await nextTick()

    await wrapper.find('.dialog-btn.confirm').trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['c2']])
  })
})
