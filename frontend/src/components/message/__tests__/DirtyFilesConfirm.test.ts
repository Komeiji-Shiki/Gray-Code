/**
 * DirtyFilesConfirm 组件测试——丢弃更改确认流程
 *
 * 回归背景：ConfirmDialog 确认时先置 visible=false（同步 emit update:modelValue:false）
 * 再 emit confirm；若组件通过 v-model setter 同步清空 pendingDirtyConfirm，
 * confirmDiscard 读到的恒为 null，「丢弃更改并继续」只关框不执行续作（与
 * ConversationList 删除竞态同根因）。修复后确认必须按 kind 分发续作。
 */
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import DirtyFilesConfirm from '../DirtyFilesConfirm.vue'
import { pendingDirtyConfirm } from '../../../stores/chat/dirtyConfirmState'

const chatStoreMock = {
  switchBranchCandidate: vi.fn().mockResolvedValue(true),
  restoreCheckpoint: vi.fn().mockResolvedValue(true),
  restoreAndRetry: vi.fn().mockResolvedValue(true),
  restoreAndDelete: vi.fn().mockResolvedValue(true),
  restoreAndEdit: vi.fn().mockResolvedValue(true),
  allMessages: [] as { id: string }[]
}

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: () => chatStoreMock
}))

function mountDirty(): VueWrapper {
  return mount(DirtyFilesConfirm, {
    global: {
      stubs: { teleport: true }
    }
  })
}

describe('DirtyFilesConfirm 丢弃更改确认流程', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    pendingDirtyConfirm.value = null
    Object.values(chatStoreMock).forEach(m => {
      if (typeof m === 'function') (m as ReturnType<typeof vi.fn>).mockClear()
    })
    wrapper = mountDirty()
  })

  afterEach(() => {
    wrapper.unmount()
    pendingDirtyConfirm.value = null
    document.body.innerHTML = ''
  })

  test('无待确认动作时不渲染对话框', () => {
    expect(wrapper.find('.dialog').exists()).toBe(false)
  })

  test('确认「丢弃更改并继续」后按 kind=switch 分发续作（回归：确认后动作不再丢失）', async () => {
    pendingDirtyConfirm.value = {
      kind: 'switch',
      files: ['/ws/unsaved.txt'],
      switch: { nodeId: 'n1' }
    }
    await nextTick()

    expect(wrapper.find('.dialog').exists()).toBe(true)
    await wrapper.find('.dialog-btn.confirm').trigger('click')

    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.switchBranchCandidate).toHaveBeenCalledWith('n1', {
      mode: 'chat-and-workspace',
      confirmedDiscardDirty: true,
      confirmedDirtyFiles: ['/ws/unsaved.txt']
    })
    expect(chatStoreMock.restoreCheckpoint).not.toHaveBeenCalled()
    await nextTick()
    expect(wrapper.find('.dialog').exists()).toBe(false)
  })

  test('确认后按 kind=restore 的 entry=restore 分发续作', async () => {
    pendingDirtyConfirm.value = {
      kind: 'restore',
      files: ['/ws/a.txt'],
      restore: { entry: 'restore', checkpointId: 'cp-1', deleteUntrackedFiles: false }
    }
    await nextTick()

    await wrapper.find('.dialog-btn.confirm').trigger('click')

    expect(chatStoreMock.restoreCheckpoint).toHaveBeenCalledWith('cp-1', false, true, undefined, ['/ws/a.txt'])
    expect(chatStoreMock.switchBranchCandidate).not.toHaveBeenCalled()
  })

  test('确认后按 kind=restore 的 entry=delete 分发续作（含消息定位）', async () => {
    chatStoreMock.allMessages = [{ id: 'msg-3' }, { id: 'msg-7' }, { id: 'msg-9' }]
    pendingDirtyConfirm.value = {
      kind: 'restore',
      files: [],
      restore: { entry: 'delete', checkpointId: 'cp-2', deleteUntrackedFiles: true, messageId: 'msg-7' }
    }
    await nextTick()

    await wrapper.find('.dialog-btn.confirm').trigger('click')

    expect(chatStoreMock.restoreAndDelete).toHaveBeenCalledWith(1, 'cp-2', true, true, undefined, [])
  })

  test('取消按钮清空待确认动作且不执行任何续作', async () => {
    pendingDirtyConfirm.value = {
      kind: 'switch',
      files: ['/ws/unsaved.txt'],
      switch: { nodeId: 'n1' }
    }
    await nextTick()

    await wrapper.find('.dialog-btn.cancel').trigger('click')

    expect(chatStoreMock.switchBranchCandidate).not.toHaveBeenCalled()
    expect(chatStoreMock.restoreCheckpoint).not.toHaveBeenCalled()
    expect(pendingDirtyConfirm.value).toBeNull()
  })

  test('展示文件列表（最多 10 条）与隐藏计数', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `/ws/f${i}.txt`)
    pendingDirtyConfirm.value = {
      kind: 'switch',
      files,
      switch: { nodeId: 'n1' }
    }
    await nextTick()

    expect(wrapper.findAll('.dirty-file-item')).toHaveLength(10)
    expect(wrapper.find('.dirty-file-more').text()).toContain('2')
  })
})
