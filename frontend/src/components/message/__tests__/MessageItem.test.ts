/**
 * MessageItem 测试（R3 复审批次 FIX-D）
 *
 * 覆盖：
 * - R3-#5: 后台任务回流消息三段式折叠态按 messageId 模块级持久化，
 *   组件实例重建（滚动/新增消息/重载）后恢复用户上次选择的视图模式
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageItem, {
  backgroundTaskViewModeByMessageId,
  pruneBackgroundTaskViewModes,
  BACKGROUND_TASK_VIEW_MODE_CAP
} from '../MessageItem.vue'
import type { Message } from '../../../types'

// 假 chatStore / settingsStore：MessageItem 仅用到 checkpoints / allMessages /
// appearanceLoadingText（且均为惰性 computed，后台任务消息路径基本不触发）
const chatStoreMock = {
  checkpoints: [],
  allMessages: []
}
const settingsStoreMock = {
  appearanceLoadingText: ''
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => chatStoreMock
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => settingsStoreMock
}))

// 子组件全部打桩：本测试只关心折叠态切换与持久化
// ResponseViewerDialog 用显式桩（不声明 props），避免 value 为 null 时的 prop 校验告警
const GLOBAL_STUBS = {
  MessageActions: true,
  MessageAttachments: true,
  InlineContextMessage: true,
  MessageTaskCards: true,
  ResponseViewerDialog: { template: '<div class="response-viewer-stub" />' },
  MessageRenderBlock: true,
  MarkdownRenderer: true,
  RetryDialog: true,
  EditDialog: true
}

function createBackgroundTaskMessage(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: '后台任务已完成',
    timestamp: Date.now(),
    source: 'background_task',
    backendIndex: 0,
    parts: [{ text: '后台任务已完成' }]
  } as Message
}

function mountItem(message: Message) {
  return mount(MessageItem, {
    props: { message, messageIndex: 0 },
    global: { stubs: GLOBAL_STUBS }
  })
}

describe('R3-#5: 后台任务三段式折叠态持久化', () => {
  beforeEach(() => {
    // 模块级 Map 在测试间隔离
    backgroundTaskViewModeByMessageId.clear()
  })

  it('默认折叠；切换视图后组件重建仍恢复所选模式', async () => {
    const message = createBackgroundTaskMessage('bg_task_1')
    const wrapper = mountItem(message)

    // 默认折叠
    expect(wrapper.find('.bg-task-content').classes()).toContain('view-collapsed')

    // 切到「中展开」
    const buttons = wrapper.findAll('.bg-task-view-btn')
    expect(buttons).toHaveLength(3)
    await buttons[1].trigger('click')
    expect(wrapper.find('.bg-task-content').classes()).toContain('view-medium')

    // 卸载后重建（模拟滚动/新增消息/重载导致的组件实例重建）
    wrapper.unmount()
    const wrapper2 = mountItem(message)
    expect(wrapper2.find('.bg-task-content').classes()).toContain('view-medium')
    wrapper2.unmount()
  })

  it('不同消息 id 的折叠态互不影响', async () => {
    const m1 = createBackgroundTaskMessage('bg_task_a')
    const m2 = createBackgroundTaskMessage('bg_task_b')
    const w1 = mountItem(m1)
    const w2 = mountItem(m2)
    expect(w1.find('.bg-task-content').classes()).toContain('view-collapsed')
    expect(w2.find('.bg-task-content').classes()).toContain('view-collapsed')

    // m1 切到「完全展开」，m2 保持折叠
    await w1.findAll('.bg-task-view-btn')[2].trigger('click')
    expect(w1.find('.bg-task-content').classes()).toContain('view-expanded')
    expect(w2.find('.bg-task-content').classes()).toContain('view-collapsed')
    w1.unmount()
    w2.unmount()
  })
})

describe('M1-1: 视图模式 Map 清理与容量上限', () => {
  beforeEach(() => {
    backgroundTaskViewModeByMessageId.clear()
  })

  it('pruneBackgroundTaskViewModes 只保留活跃消息 ID 的记录', () => {
    backgroundTaskViewModeByMessageId.set('m1', 'expanded')
    backgroundTaskViewModeByMessageId.set('m2', 'medium')
    backgroundTaskViewModeByMessageId.set('m3', 'collapsed')

    pruneBackgroundTaskViewModes(new Set(['m1', 'm3']))

    expect(backgroundTaskViewModeByMessageId.has('m1')).toBe(true)
    expect(backgroundTaskViewModeByMessageId.has('m2')).toBe(false)
    expect(backgroundTaskViewModeByMessageId.has('m3')).toBe(true)
  })

  it('容量达到上限后写入新消息的视图模式会淘汰最旧记录', async () => {
    for (let i = 0; i < BACKGROUND_TASK_VIEW_MODE_CAP; i++) {
      backgroundTaskViewModeByMessageId.set(`m_${i}`, 'collapsed')
    }

    const message = createBackgroundTaskMessage('m_new')
    const wrapper = mountItem(message)
    await wrapper.findAll('.bg-task-view-btn')[2].trigger('click')

    expect(backgroundTaskViewModeByMessageId.size).toBeLessThanOrEqual(BACKGROUND_TASK_VIEW_MODE_CAP)
    expect(backgroundTaskViewModeByMessageId.get('m_new')).toBe('expanded')
    expect(backgroundTaskViewModeByMessageId.has('m_0')).toBe(false)
    wrapper.unmount()
  })
})
