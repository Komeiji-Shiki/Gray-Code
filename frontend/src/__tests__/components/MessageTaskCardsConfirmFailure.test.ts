/**
 * 计划/设计卡片确认请求失败时必须给出可见反馈：只写控制台再恢复按钮，
 * 用户看到的就是“点击执行没有反应”。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import MessageTaskCards from '../../components/message/MessageTaskCards.vue'
import type { ToolUsage } from '../../types'

const runtime = vi.hoisted(() => ({
  store: undefined as any,
  sendToExtension: vi.fn(),
  showNotification: vi.fn(),
  refreshPlanSourceStatuses: vi.fn()
}))
vi.mock('@/stores', () => ({ useChatStore: () => runtime.store }))
vi.mock('@/utils/vscode', () => ({
  sendToExtension: runtime.sendToExtension,
  showNotification: runtime.showNotification,
  saveState: vi.fn(),
  onExtensionCommand: vi.fn(() => vi.fn())
}))
vi.mock('@/composables/useTaskCardChannels', () => ({
  PLAN_EXECUTION_MODE_STATE_KEY: 'plan-mode',
  PLAN_GENERATION_MODE_STATE_KEY: 'design-mode',
  useTaskCardChannels: () => ({
    selectedChannelId: ref('channel'), selectedPlanExecutionModeId: ref('code'), selectedPlanGenerationModeId: ref('plan'),
    selectedModelId: ref('model'), modelOptions: ref([]), isLoadingChannels: ref(false), isLoadingModes: ref(false),
    promptModeOptions: ref([]), isLoadingModels: ref(false), channelOptions: ref([]), openModeSettings: vi.fn(),
    getModeIdForKind: () => 'code', handleModeChange: vi.fn(), loadPromptModes: vi.fn(), loadChannels: vi.fn()
  })
}))
vi.mock('@/composables/usePlanSourceStatus', () => ({
  usePlanSourceStatus: () => ({
    refreshPlanSourceStatuses: runtime.refreshPlanSourceStatuses, getPlanSourceState: () => undefined, isPlanSourceBlocked: () => false,
    getPlanSourceLabel: () => '', getPlanBlockedReason: () => ''
  })
}))
vi.mock('../../i18n', async importOriginal => ({
  ...await importOriginal<typeof import('../../i18n')>(),
  useI18n: () => ({ t: (key: string) => key })
}))

const stubs = ['ModeSelector', 'ChannelSelector', 'ModelSelector', 'MarkdownRenderer', 'CustomScrollbar', 'ReviewTaskCard', 'ProgressTaskCard']
const cards: Record<'plan' | 'design', ToolUsage> = {
  plan: { id: 'plan-call', name: 'create_plan', status: 'success', args: { path: '.graycode/plans/a.md', plan: '# Plan' } },
  design: { id: 'design-call', name: 'create_design', status: 'success', args: { path: '.graycode/design/a.md', design: '# Design' } }
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  runtime.showNotification.mockResolvedValue(undefined)
  runtime.store = {
    currentConversationId: 'conversation', getToolResponseById: () => ({ success: true }),
    sendMessage: vi.fn().mockResolvedValue(true), setActiveBuild: vi.fn(), setCurrentPromptModeId: vi.fn()
  }
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

describe('任务卡片确认失败的可见反馈', () => {
  test.each(['plan', 'design'] as const)('%s 确认请求被拒绝时通知原因并允许重试', async kind => {
    runtime.sendToExtension.mockImplementation((type: string) => type.endsWith('.confirmExecution') || type.endsWith('.confirmPlanGeneration')
      ? Promise.reject(new Error('Conversation is not accessible')) : Promise.resolve(undefined))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      wrapper = mount(MessageTaskCards, { props: { tools: [cards[kind]] }, global: { stubs } })
      await wrapper.get('.task-btn').trigger('click')
      await flushPromises()
      expect(runtime.showNotification).toHaveBeenCalledWith('Conversation is not accessible', 'error')
      expect(runtime.store.sendMessage).not.toHaveBeenCalled()
      expect(runtime.store.setActiveBuild).not.toHaveBeenCalled()
      expect(wrapper.get('.task-btn').attributes('disabled')).toBeUndefined()
    } finally { log.mockRestore() }
  })

  // 新的用户消息会让宿主清除旧确认请求；卡片不能继续显示一个必然失败的执行按钮。
  test.each(['plan', 'design'] as const)('%s 确认请求已失效时禁用按钮并说明原因', async kind => {
    runtime.sendToExtension.mockImplementation((type: string) => type.endsWith('.confirmExecution') || type.endsWith('.confirmPlanGeneration')
      ? Promise.resolve({ success: false, error: '当前对话没有对应的文档确认请求。' }) : Promise.resolve(undefined))
    wrapper = mount(MessageTaskCards, { props: { tools: [cards[kind]] }, global: { stubs } })
    await wrapper.get('.task-btn').trigger('click')
    await flushPromises()
    const button = wrapper.get('.task-btn')
    expect(runtime.showNotification).toHaveBeenCalledWith('当前对话没有对应的文档确认请求。', 'warning')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toBe('当前对话没有对应的文档确认请求。')
    expect(button.text()).toBe(`components.message.tool.${kind}Card.expired`)
    expect(runtime.store.sendMessage).not.toHaveBeenCalled()
  })

  test('来源文档阻断仍按来源状态处理，不标记为失效', async () => {
    runtime.sendToExtension.mockImplementation((type: string) => type === 'plan.confirmExecution'
      ? Promise.resolve({ success: false, blocked: true, blockReason: 'source_missing', error: 'missing' }) : Promise.resolve(undefined))
    wrapper = mount(MessageTaskCards, { props: { tools: [cards.plan] }, global: { stubs } })
    runtime.refreshPlanSourceStatuses.mockClear()
    await wrapper.get('.task-btn').trigger('click')
    await flushPromises()
    expect(runtime.refreshPlanSourceStatuses).toHaveBeenCalled()
    expect(wrapper.get('.task-btn').text()).not.toBe('components.message.tool.planCard.expired')
  })

  test.each(['plan', 'design'] as const)('%s 在当前任务仍运行或等待审批时提示等待，不发起确认', async kind => {
    runtime.store.activeStreamId = 'live-run'
    runtime.sendToExtension.mockResolvedValue({ success: true, approvalId: 'gate', prompt: 'go' })
    wrapper = mount(MessageTaskCards, { props: { tools: [cards[kind]] }, global: { stubs } })
    await wrapper.get('.task-btn').trigger('click')
    await flushPromises()
    expect(runtime.showNotification).toHaveBeenCalledWith('components.message.tool.waitForCurrentTask', 'warning')
    expect(runtime.sendToExtension.mock.calls.some(([type]) => String(type).includes('.confirm'))).toBe(false)
    expect(runtime.store.sendMessage).not.toHaveBeenCalled()
    expect(wrapper.get('.task-btn').text()).not.toContain('expired')
  })

  test('来源状态查询携带当前对话', () => {
    runtime.sendToExtension.mockResolvedValue(undefined)
    wrapper = mount(MessageTaskCards, { props: { tools: [cards.plan] }, global: { stubs } })
    expect(runtime.refreshPlanSourceStatuses).toHaveBeenCalledWith(expect.any(Array), 'conversation')
  })
})
