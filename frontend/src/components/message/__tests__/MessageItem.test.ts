/**
 * MessageItem 测试（R3 复审批次 FIX-D）
 *
 * 覆盖：
 * - R3-#5: 后台任务回流消息三段式折叠态按 messageId 模块级持久化，
 *   组件实例重建（滚动/新增消息/重载）后恢复用户上次选择的视图模式
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import MessageItem from '../MessageItem.vue'
import {
  backgroundTaskViewModeByMessageId,
  pruneBackgroundTaskViewModes,
  BACKGROUND_TASK_VIEW_MODE_CAP
} from '../messageViewModes'
import type { Message } from '../../../types'

// 假 chatStore / settingsStore：MessageItem 仅用到 checkpoints / allMessages /
// checkpointLookup / appearanceLoadingText（且均为惰性 computed，后台任务消息路径基本不触发）。
// checkpointLookup 的 sorted=false 会让组件走防御性回退路径（原始 filter），语义一致。
const chatStoreMock = {
  checkpoints: [],
  allMessages: [],
  checkpointLookup: {
    sorted: false,
    keys: [],
    groups: new Map(),
    cumEndByKey: null
  }
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
// 捕获 props 的 MessageRenderBlock 桩（验证 thoughtViewMode 自动切换透传）
const MessageRenderBlockCapture = defineComponent({
  name: 'MessageRenderBlock',
  props: {
    block: { type: Object, required: true },
    thoughtViewMode: { type: String, default: 'medium' },
    setThoughtViewMode: { type: Function, default: () => {} }
  },
  template: '<div class="render-block-stub" />'
})

const GLOBAL_STUBS = {
  MessageActions: true,
  MessageAttachments: true,
  InlineContextMessage: true,
  MessageTaskCards: true,
  ResponseViewerDialog: { template: '<div class="response-viewer-stub" />' },
  MessageRenderBlock: MessageRenderBlockCapture,
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

describe('思考块视图自动模式切换', () => {
  function createThoughtMessage(id: string, streaming: boolean): Message {
    return {
      id,
      role: 'assistant',
      content: '思考内容',
      timestamp: Date.now(),
      backendIndex: 0,
      streaming,
      parts: [{ text: '第一行思考\n第二行思考', thought: true }]
    } as Message
  }

  it('已结束消息（非流式）自动折叠为第一行预览', async () => {
    const wrapper = mountItem(createThoughtMessage('thought_ended', false))
    await nextTick()
    const stub = wrapper.findComponent(MessageRenderBlockCapture)
    expect(stub.exists()).toBe(true)
    expect(stub.props('thoughtViewMode')).toBe('collapsed')
    wrapper.unmount()
  })

  it('思考中（流式）默认中展开', async () => {
    const wrapper = mountItem(createThoughtMessage('thought_streaming', true))
    await nextTick()
    const stub = wrapper.findComponent(MessageRenderBlockCapture)
    expect(stub.exists()).toBe(true)
    expect(stub.props('thoughtViewMode')).toBe('medium')
    wrapper.unmount()
  })

  it('思考结束且输出结束后自动折叠；用户手动切换后不再覆盖', async () => {
    const message = createThoughtMessage('thought_manual', true)
    const wrapper = mountItem(message)
    await nextTick()
    expect(wrapper.findComponent(MessageRenderBlockCapture).props('thoughtViewMode')).toBe('medium')

    // 用户手动切到完全展开
    const stub = wrapper.findComponent(MessageRenderBlockCapture)
    ;(stub.props('setThoughtViewMode') as (mode: string) => void)('expanded')
    await nextTick()
    expect(stub.props('thoughtViewMode')).toBe('expanded')

    // 消息流式结束：用户已干预 → 自动折叠不覆盖
    await wrapper.setProps({ message: { ...message, streaming: false } })
    await nextTick()
    expect(wrapper.findComponent(MessageRenderBlockCapture).props('thoughtViewMode')).toBe('expanded')
    wrapper.unmount()
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
