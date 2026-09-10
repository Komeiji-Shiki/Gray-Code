import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { nextTick } from 'vue'
import ChannelContextManagement from '../ChannelContextManagement.vue'

function createWrapper(threshold: string | number) {
  return mount(ChannelContextManagement, {
    props: {
      show: true,
      contextManagementEnabled: true,
      contextThreshold: threshold,
      contextManagementMode: 'summarize',
      contextManagementModeOptions: [{ value: 'summarize', label: 'summary' }],
      contextThresholdError: false,
      contextBudget: {
        declaredContextTokens: 500000,
        effectiveInputTokens: 372000,
        maxOutputTokens: 128000,
        contextWindowIncludesOutput: true,
        source: 'channel'
      },
      summaryKeepRecentTokens: '50%',
      summaryKeepRecentRounds: 2
    }
  })
}

describe('ChannelContextManagement threshold hover help', () => {
  test('独立平台自动总结直接提供两种方式，并发出渠道设置事件', async () => {
    vi.stubGlobal('__GRAYCODE_HOST', {})
    const wrapper = createWrapper('80%')
    try {
      await wrapper.setProps({ autoSummarizeMethod: 'notes', autoMethodInherited: true })
      const selector = wrapper.findComponent({ name: 'CustomSelect' })
      expect(selector.props('options').map((option: { value: string }) => option.value)).toEqual(['summary', 'notes'])
      expect(selector.props('modelValue')).toBe('notes')
      expect(wrapper.text()).toContain('按该渠道独立保存')
      selector.vm.$emit('update:modelValue', 'summary')
      expect(wrapper.emitted('update:auto-method')).toEqual([['summary']])
      expect(wrapper.emitted('update:mode')).toBeUndefined()
      await wrapper.setProps({ contextManagementEnabled: false })
      expect(selector.props('disabled')).toBe(true)
    } finally { wrapper.unmount(); vi.unstubAllGlobals() }
  })

  test('80% 显示扣除输出预留后的实际触发 token 与大致总结比例', async () => {
    const wrapper = createWrapper('80%')
    await wrapper.get('.tooltip-wrapper').trigger('mouseenter')
    await nextTick()

    const tooltip = wrapper.get('.tooltip.multiline').text()
    expect(tooltip).toContain('372,000')
    expect(tooltip).toContain('297,600')
    expect(tooltip).toContain('128,000')
    expect(tooltip).toContain('50')
  })

  test('绝对 token 阈值按填写值直接展示，并提示超过有效输入预算', async () => {
    const wrapper = createWrapper(500000)
    await wrapper.get('.tooltip-wrapper').trigger('mouseenter')
    await nextTick()

    const tooltip = wrapper.get('.tooltip.multiline').text()
    expect(tooltip).toContain('500,000')
    expect(tooltip).toContain('372,000')
  })
});
