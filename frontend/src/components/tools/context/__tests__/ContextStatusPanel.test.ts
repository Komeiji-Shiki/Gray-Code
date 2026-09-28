import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import { DefaultToolResult, getToolConfig } from '../../../../utils/toolRegistry'
import '../../../../utils/tools/context'
import ContextStatusPanel from '../ContextStatusPanel.vue'

const wrappers: VueWrapper[] = []
const data = {
  measuredAt: 1790620103312, windowId: 'initial', source: 'local-estimate',
  estimatedInputTokens: 142401, maxInputTokens: 672000, maxContextTokens: 800000,
  remainingInputTokens: 529599, reservedOutputTokens: 128000, inputUsagePercent: 21.19,
  fixedPromptTokens: 34142, historyTokens: 108259, threshold: '90%', thresholdTokens: 604800,
  method: 'notes', userMessageRetention: 'first', managementEnabled: true, messageCount: 81,
  budgetSource: 'config.maxContextTokens', pendingWindowSwitch: false,
}
const panel = (value: Record<string, unknown> = data) => {
  const wrapper = mount(ContextStatusPanel, { props: { toolName: 'context_status', args: {}, result: { success: true, data: value } } })
  wrappers.push(wrapper); return wrapper
}
beforeEach(() => setLanguage('zh-CN'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })

test('上下文状态注册专用卡片，说明使用简洁自然的中文', () => {
  const tool = getToolConfig('context_status')!
  expect(tool.contentComponent).not.toBe(DefaultToolResult)
  expect(tool.descriptionFormatter({})).toBe('查询当前token用量与总结策略')
})

test('主视图展示用量与策略，技术字段按需展开且保留原始数据', async () => {
  const wrapper = panel()
  expect(wrapper.find('.usage-total').text()).toContain('142,401')
  expect(wrapper.find('.usage-total').text()).toContain('672,000')
  expect(wrapper.find('.usage-percent').text()).toBe('21.19%')
  expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('21.19')
  expect(wrapper.text()).toContain('529,599'); expect(wrapper.text()).toContain('90%')
  expect(wrapper.text()).toContain('笔记管理'); expect(wrapper.text()).toContain('首条与最近一次')
  expect(wrapper.find('.result-heading').exists()).toBe(false)
  expect(wrapper.find('.usage-details').exists()).toBe(false)
  expect(wrapper.text()).not.toMatch(/measuredAt|budgetSource|换窗|不触发/)
  const details = wrapper.find<HTMLDetailsElement>('.usage-footer details')
  details.element.open = true; await details.trigger('toggle')
  expect(wrapper.find('.usage-details').text()).toContain('固定提示')
  expect(wrapper.find('.usage-details').text()).toContain('34,142')
  expect(wrapper.find('.usage-details').text()).toContain('初始上下文')
  const raw = wrapper.find<HTMLDetailsElement>('.result-raw')
  raw.element.open = true; await raw.trigger('toggle')
  expect(wrapper.find('.result-raw').text()).toContain('"budgetSource": "config.maxContextTokens"')
})

test('超限保留真实百分比，进度条有界并区分阈值与硬上限', async () => {
  const wrapper = panel({ ...data, estimatedInputTokens: 950000, inputUsagePercent: 141.37, remainingInputTokens: 0 })
  expect(wrapper.find('.usage-percent').text()).toBe('141.37%')
  expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
  expect(wrapper.find('.context-status.overBudget').exists()).toBe(true)
  expect(wrapper.text()).toContain('超出输入上限')
  await wrapper.setProps({ result: { success: true, data: { ...data, overThreshold: true } } })
  expect(wrapper.find('.context-status.overThreshold').exists()).toBe(true)
})

test('零值、绝对阈值、缺失字段与非有限数不会伪造成完整用量', async () => {
  const wrapper = panel({ estimatedInputTokens: 0, maxInputTokens: 100, reservedOutputTokens: 0, threshold: 80, thresholdTokens: 80 })
  expect(wrapper.find('.usage-percent').text()).toBe('0%')
  expect(wrapper.find('.usage-stats').text()).toContain('100')
  expect(wrapper.find('.usage-policy').text()).toContain('80')
  expect(wrapper.find('.usage-policy').text()).toContain('未提供')
  await wrapper.setProps({ result: { success: true, data: { maxInputTokens: 0, estimatedInputTokens: Number.NaN, inputUsagePercent: Infinity } } })
  expect(wrapper.find('.usage-percent').text()).toBe('—')
  expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  expect(wrapper.text()).not.toMatch(/NaN|Infinity/)
})

test('开关、等待切换与保留策略按真实状态呈现，语言切换即时更新', async () => {
  const wrapper = panel({ ...data, managementEnabled: false, pendingWindowSwitch: true, method: 'summary', userMessageRetention: 'all' })
  expect(wrapper.text()).toContain('自动管理已关闭'); expect(wrapper.text()).toContain('等待切换上下文')
  expect(wrapper.find('.usage-policy').text()).toContain('全部')
  setLanguage('en'); await wrapper.vm.$nextTick()
  expect(wrapper.text()).toContain('Input token usage'); expect(wrapper.text()).toContain('Summary')
  setLanguage('ja'); await wrapper.vm.$nextTick()
  expect(wrapper.text()).toContain('入力トークン使用量'); expect(wrapper.text()).not.toContain('components.tools')
})

test('失败和等待沿用统一工具反馈，未知旧记录仍可查看原始数据', async () => {
  const wrapper = panel({ legacy: 'record' })
  expect(wrapper.text()).toContain('暂无用量数据')
  await wrapper.setProps({ result: undefined, status: 'executing' })
  expect(wrapper.find('[role="status"]').exists()).toBe(true)
  await wrapper.setProps({ result: { success: false, error: '没有模型渠道' }, status: 'error' })
  expect(wrapper.find('[role="alert"]').text()).toContain('没有模型渠道')
  expect(wrapper.text()).not.toContain('暂无用量数据')
})
