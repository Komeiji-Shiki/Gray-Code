/**
 * MessageActions 渲染测试
 *
 * 覆盖：用户/AI 消息下操作按钮的组合与 tooltip 一致性
 * （四个按钮：编辑、复制、分支、删除 / 复制、查看回复、重试、删除）
 */
import { describe, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageActions from '../MessageActions.vue'
import type { Message } from '../../../types'

// BranchSwitcherBar 依赖 chatStore 分支状态，本测试只关心按钮结构，直接打桩
vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    isSwitchingBranch: false
  })
}))

const GLOBAL_STUBS = {
  BranchSwitcherBar: true,
  IconButton: false // 保留真实 IconButton，验证 tooltip 透传到 title
}

function createMessage(role: 'user' | 'assistant'): Message {
  return {
    id: `msg-${role}`,
    role,
    content: 'hello',
    timestamp: Date.now(),
    backendIndex: 0,
    parts: [{ text: 'hello' }]
  } as Message
}

function mountActions(props: Record<string, unknown>) {
  return mount(MessageActions, {
    props: {
      message: createMessage('user'),
      ...props
    },
    global: { stubs: GLOBAL_STUBS }
  })
}

describe('MessageActions 按钮排列', () => {
  test('用户消息：编辑 / 复制 / 分支 / 删除 四个按钮，tooltip 齐全', () => {
    const wrapper = mountActions({ canEdit: true, canBranch: true })
    const buttons = wrapper.findAll('.icon-button')
    expect(buttons).toHaveLength(4)

    const titles = buttons.map((b) => b.attributes('title'))
    // 编辑按钮悬停提示（此前缺失，与其余按钮保持一致）
    expect(titles[0]).toBe('编辑消息')
    expect(buttons[0].find('i').classes()).toContain('codicon-edit')
    expect(buttons[1].find('i').classes()).toContain('codicon-copy')
    expect(buttons[2].find('i').classes()).toContain('codicon-repo-forked')
    expect(buttons[3].find('i').classes()).toContain('codicon-trash')
    expect(titles[3]).toBe('删除消息')
  })

  test('AI 消息：复制 / 查看回复 / 重试 / 删除，重试按钮有提示', () => {
    const wrapper = mountActions({
      message: createMessage('assistant'),
      canRetry: true,
      canViewResponse: true
    })
    const buttons = wrapper.findAll('.icon-button')
    expect(buttons).toHaveLength(4)

    const classes = buttons.map((b) => b.find('i').classes().find((c) => c.startsWith('codicon-')))
    expect(classes).toEqual([
      'codicon-copy',
      'codicon-eye',
      'codicon-refresh',
      'codicon-trash'
    ])
    expect(buttons[2].attributes('title')).toBe('重新生成')
  })

  test('无分支权限时用户消息为 3 个按钮（编辑 / 复制 / 删除）', () => {
    const wrapper = mountActions({ canEdit: true, canBranch: false })
    expect(wrapper.findAll('.icon-button')).toHaveLength(3)
  })

  test('复制后按钮切换为勾选图标并恢复', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountActions({ canEdit: true, canBranch: true })
      const copyBtn = wrapper.findAll('.icon-button')[1]
      await copyBtn.trigger('click')
      expect(copyBtn.find('i').classes()).toContain('codicon-check')

      vi.advanceTimersByTime(1000)
      await Promise.resolve()
      expect(copyBtn.find('i').classes()).toContain('codicon-copy')
    } finally {
      vi.useRealTimers()
    }
  })
})
