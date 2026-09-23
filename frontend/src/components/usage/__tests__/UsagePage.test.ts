import { beforeEach, expect, test, vi } from 'vitest'
import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import UsagePage from '../UsagePage.vue'

const send = vi.hoisted(() => vi.fn())
const settings = reactive({ currentView: 'usage', showChat: vi.fn() })
vi.mock('@/utils/vscode', () => ({ sendToExtension: send }))
vi.mock('@/stores', () => ({ useSettingsStore: () => settings, useChatStore: () => ({ switchConversation: vi.fn() }) }))

const bucket = { promptTokens: 100, candidatesTokens: 20, thoughtsTokens: 0, cacheCreationTokens: 0,
  cacheReadTokens: 0, totalTokens: 120, modelMessages: 1 }
const result = { totals: { ...bucket, conversations: 1, skippedConversations: 0 }, byConversation: [
  { ...bucket, conversationId: 'one', title: '统计样本', updatedAt: 1000 }], byModel: [], byDay: [], generatedAt: 1000 }
beforeEach(() => {
  send.mockReset()
  send.mockImplementation(async (type: string) => type === 'usage.getStats' ? result : {})
})

test('刷新期间保留已显示的结果，切换范围时不显示旧范围的数据', async () => {
  const wrapper = mount(UsagePage, { global: { stubs: { UsageTimeSection: true,
    CustomScrollbar: { template: '<div><slot /></div>' } } } })
  await flushPromises()
  expect(wrapper.get('.total-value').text()).toBe('120')
  let finish!: (value: unknown) => void
  send.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await wrapper.get('.header-actions .header-btn').trigger('click')
  expect(wrapper.get('.total-value').text()).toBe('120')
  expect(wrapper.find('.codicon-modifier-spin').exists()).toBe(true)
  expect(wrapper.find('.state-hint').exists()).toBe(false)
  finish(result); await flushPromises()
  await wrapper.findAll('.range-btn')[1].trigger('click')
  expect(wrapper.find('.total-value').exists()).toBe(false)
  finish({ ...result, totals: { ...result.totals, totalTokens: 60 } }); await flushPromises()
  expect(wrapper.get('.total-value').text()).toBe('60')
  wrapper.unmount()
})
