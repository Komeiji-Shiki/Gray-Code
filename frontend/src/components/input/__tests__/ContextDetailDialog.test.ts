import { mount, flushPromises } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import ContextDetailDialog from '../ContextDetailDialog.vue'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/utils/vscode', () => ({ sendToExtension: rpc }))

const summary = (preview: string) => ({ id: 'summary', index: 1, isAutoSummary: false, preview })
const describe = (conversationId: string, preview: string) => ({
  conversationId,
  tokens: { usedTokens: 12, source: 'none', precise: false, localEstimate: 12 },
  range: { total: 2, visibleCount: 2, lastSummaryIndex: 1, summarizedCount: 1, summaryCount: 1, fallbackActive: false },
  summaries: [summary(preview)],
})

test('首次打开立即读取上下文，切换与重新打开后丢弃旧统计和旧摘要详情', async () => {
  let finishOld!: (value: unknown) => void
  let finishDetail!: (value: unknown) => void
  rpc.mockImplementation((type, data) => {
    if (type === 'context.summaryDetail') return new Promise(resolve => { finishDetail = resolve })
    if (data.conversationId === 'old') return new Promise(resolve => { finishOld = resolve })
    return Promise.resolve(describe('current', '当前会话摘要'))
  })
  const wrapper = mount(ContextDetailDialog, { props: { modelValue: true, conversationId: 'old' },
    global: { stubs: { Modal: { template: '<div><slot /></div>' } } } })
  try {
    expect(rpc).toHaveBeenCalledWith('context.describe', { conversationId: 'old' })
    await wrapper.setProps({ conversationId: 'current' })
    await flushPromises()
    finishOld(describe('old', '旧会话摘要'))
    await flushPromises()
    expect(wrapper.text()).toContain('当前会话摘要')
    expect(wrapper.text()).not.toContain('旧会话摘要')

    await wrapper.get('.summary-actions button').trigger('click')
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    finishDetail({ conversationId: 'current', summary: summary('关闭前请求的旧详情') })
    await flushPromises()
    expect(wrapper.text()).toContain('当前会话摘要')
    expect(wrapper.text()).not.toContain('关闭前请求的旧详情')
    expect(wrapper.get('.summary-actions button').attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})
