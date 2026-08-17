import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
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
