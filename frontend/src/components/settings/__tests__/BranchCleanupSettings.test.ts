/**
 * BranchCleanupSettings 测试（TREE-09 / MIG-06）
 *
 * 覆盖：
 * - 挂载时加载软删分支数量与保留期配置（conversation.getDeletedBranchCount /
 *   conversation.getBranchRetentionConfig）
 * - 一键清理过期软删（conversation.pruneDeletedBranches）：成功展示结果并刷新数量、失败展示错误
 * - 保留期配置：非法输入禁用保存、保存成功回读后端归一化值、失败展示错误
 */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BranchCleanupSettings from '../BranchCleanupSettings.vue'

vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn()
}))

import { sendToExtension } from '@/utils/vscode'

const mockSend = sendToExtension as unknown as ReturnType<typeof vi.fn>

function defaultSendImplementation() {
  mockSend.mockImplementation((type: string, _payload: any) => {
    switch (type) {
      case 'conversation.getDeletedBranchCount':
        return Promise.resolve({ conversationCount: 2, deletedNodeCount: 5 })
      case 'conversation.getBranchRetentionConfig':
        return Promise.resolve({ retentionDays: 30 })
      default:
        return Promise.resolve({})
    }
  })
}

async function mountSettings() {
  const wrapper = mount(BranchCleanupSettings)
  await flushPromises()
  return wrapper
}

describe('BranchCleanupSettings', () => {
  beforeEach(() => {
    defaultSendImplementation()
  })

  afterEach(() => {
    mockSend.mockReset()
  })

  it('挂载时加载软删分支数量与保留期配置', async () => {
    const wrapper = await mountSettings()

    expect(mockSend).toHaveBeenCalledWith('conversation.getDeletedBranchCount', {})
    expect(mockSend).toHaveBeenCalledWith('conversation.getBranchRetentionConfig', {})
    // 数量展示（2 个对话共 5 个软删节点）
    expect(wrapper.text()).toContain('5')
    expect(wrapper.text()).toContain('2')
    // 保留期输入初始化为 30
    const input = wrapper.find('input.number-input').element as HTMLInputElement
    expect(input.value).toBe('30')
  })

  it('软删数量为 0 时展示空态文案', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'conversation.getDeletedBranchCount') {
        return Promise.resolve({ conversationCount: 0, deletedNodeCount: 0 })
      }
      if (type === 'conversation.getBranchRetentionConfig') {
        return Promise.resolve({ retentionDays: 30 })
      }
      return Promise.resolve({})
    })
    const wrapper = await mountSettings()
    expect(wrapper.find('.deleted-count-value').exists()).toBe(false)
  })

  it('一键清理：调用 prune API，成功后刷新数量并展示清理结果', async () => {
    const calls: string[] = []
    mockSend.mockImplementation((type: string) => {
      calls.push(type)
      switch (type) {
        case 'conversation.getDeletedBranchCount':
          return Promise.resolve({ conversationCount: 1, deletedNodeCount: 0 })
        case 'conversation.getBranchRetentionConfig':
          return Promise.resolve({ retentionDays: 30 })
        case 'conversation.pruneDeletedBranches':
          return Promise.resolve({
            conversationsScanned: 1,
            conversationsChanged: 1,
            prunedNodeCount: 3,
            corruptConversations: [],
            skippedConversations: []
          })
        default:
          return Promise.resolve({})
      }
    })

    const wrapper = await mountSettings()
    await wrapper.find('button.prune-btn').trigger('click')
    await flushPromises()

    expect(calls).toContain('conversation.pruneDeletedBranches')
    expect(wrapper.text()).toContain('3')
    // 清理后数量刷新为 0
    expect(calls.filter(c => c === 'conversation.getDeletedBranchCount').length).toBe(2)
  })

  it('一键清理失败：展示错误文案', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'conversation.pruneDeletedBranches') {
        return Promise.reject(new Error('prune boom'))
      }
      if (type === 'conversation.getDeletedBranchCount') {
        return Promise.resolve({ conversationCount: 1, deletedNodeCount: 1 })
      }
      if (type === 'conversation.getBranchRetentionConfig') {
        return Promise.resolve({ retentionDays: 30 })
      }
      return Promise.resolve({})
    })

    const wrapper = await mountSettings()
    await wrapper.find('button.prune-btn').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('prune boom')
  })

  it('R8c-P4：清理结果含 skippedConversations 时展示提示文案（会话已不存在）', async () => {
    mockSend.mockImplementation((type: string) => {
      switch (type) {
        case 'conversation.getDeletedBranchCount':
          return Promise.resolve({ conversationCount: 0, deletedNodeCount: 0 })
        case 'conversation.getBranchRetentionConfig':
          return Promise.resolve({ retentionDays: 30 })
        case 'conversation.pruneDeletedBranches':
          return Promise.resolve({
            conversationsScanned: 3,
            conversationsChanged: 1,
            prunedNodeCount: 2,
            corruptConversations: [],
            skippedConversations: ['c-orphan-1', 'c-orphan-2']
          })
        default:
          return Promise.resolve({})
      }
    })

    const wrapper = await mountSettings()
    await wrapper.find('button.prune-btn').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('2') // 清理结果 + 跳过数量
    expect(wrapper.find('.skipped-hint').exists()).toBe(true)
    expect(wrapper.text()).toContain('2 个对话的分支数据未清理')
  })

  it('保留期：非法输入（负数/小数）禁用保存按钮并提示', async () => {
    const wrapper = await mountSettings()
    const input = wrapper.find('input.number-input')
    await input.setValue('-1')
    await flushPromises()
    expect(wrapper.find('button.retention-save-btn').attributes('disabled')).toBeDefined()
    await input.setValue('1.5')
    await flushPromises()
    expect(wrapper.find('button.retention-save-btn').attributes('disabled')).toBeDefined()
  })

  it('保留期：保存成功回读后端归一化值', async () => {
    mockSend.mockImplementation((type: string) => {
      switch (type) {
        case 'conversation.getDeletedBranchCount':
          return Promise.resolve({ conversationCount: 0, deletedNodeCount: 0 })
        case 'conversation.getBranchRetentionConfig':
          return Promise.resolve({ retentionDays: 30 })
        case 'conversation.updateBranchRetentionConfig':
          return Promise.resolve({ success: true, retentionDays: 7 })
        default:
          return Promise.resolve({})
      }
    })

    const wrapper = await mountSettings()
    const input = wrapper.find('input.number-input')
    await input.setValue('7')
    await flushPromises()
    await wrapper.find('button.retention-save-btn').trigger('click')
    await flushPromises()

    expect(mockSend).toHaveBeenCalledWith('conversation.updateBranchRetentionConfig', { retentionDays: 7 })
    expect((input.element as HTMLInputElement).value).toBe('7')
  })

  it('保留期：保存失败展示错误且不更新输入', async () => {
    mockSend.mockImplementation((type: string) => {
      if (type === 'conversation.updateBranchRetentionConfig') {
        return Promise.reject(new Error('retention boom'))
      }
      if (type === 'conversation.getDeletedBranchCount') {
        return Promise.resolve({ conversationCount: 0, deletedNodeCount: 0 })
      }
      if (type === 'conversation.getBranchRetentionConfig') {
        return Promise.resolve({ retentionDays: 30 })
      }
      return Promise.resolve({})
    })

    const wrapper = await mountSettings()
    const input = wrapper.find('input.number-input')
    await input.setValue('10')
    await flushPromises()
    await wrapper.find('button.retention-save-btn').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('retention boom')
    expect((input.element as HTMLInputElement).value).toBe('10')
  })
})
