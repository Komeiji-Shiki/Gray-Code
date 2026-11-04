import { mount, flushPromises } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'
import ContextUsagePanel from '../ContextUsagePanel.vue'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/utils/vscode', () => ({ sendToExtension: rpc }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key })
}))

const breakdown = (model = 'fixture-model') => ({
  categories: [
    { id: 'messages', tokens: 600, items: [{ id: 'user', tokens: 400 }, { id: 'tool:read_file', tokens: 200, label: 'read_file' }] },
    { id: 'mcpTools', tokens: 100, items: [{ id: 'mcp__a__b', tokens: 100, label: 'b', detail: '服务器 A' }] },
    { id: 'memory', tokens: 0, items: [] }
  ],
  totalTokens: 700, maxContextTokens: 1000, maxInputTokens: 1000, softLimitTokens: 800, reservedOutputTokens: 0,
  autoCompactBufferTokens: 200, freeTokens: 100, managementEnabled: true, tokenizer: 'o200k_base', model, notices: [], measuredAt: 1
})
const summary = (preview: string) => ({ id: 'summary', index: 1, isAutoSummary: false, preview })
const describe = (conversationId: string, preview: string) => ({
  conversationId,
  tokens: { usedTokens: 12, source: 'none', precise: false, localEstimate: 12 },
  range: { total: 2, visibleCount: 2, lastSummaryIndex: 1, summarizedCount: 1, summaryCount: 1, fallbackActive: false },
  summaries: [summary(preview)]
})
const request = (conversationId: string | null = 'current') => ({ conversationId, configId: 'channel', modelOverride: 'fixture-model' })
const mountPanel = (props: Record<string, unknown> = {}) => mount(ContextUsagePanel, {
  attachTo: document.body,
  props: { modelValue: true, request: request(), usedTokens: 690, ...props },
  global: { stubs: { IconButton: { template: '<button class="refresh" @click="$emit(\'click\')" />', emits: ['click'] } } }
})

function answerWith(handlers: Record<string, (data: any) => unknown>) {
  rpc.mockReset()
  rpc.mockImplementation((type: string, data: any) => Promise.resolve(handlers[type]?.(data)))
}

test('打开时读取分类：只列有占用的来源，占用条不含剩余空间，展开后显示单项', async () => {
  answerWith({ 'context.breakdown': () => breakdown() })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('context.breakdown', request())
    expect(rpc).not.toHaveBeenCalledWith('context.describe', expect.anything())
    expect(wrapper.findAll('.usage-rows > li').map(row => row.classes()[0])).toEqual([
      'usage-color-messages', 'usage-color-mcpTools', 'usage-color-autoCompactBuffer', 'usage-color-freeSpace'
    ])
    expect(wrapper.findAll('.usage-segment').map(segment => segment.attributes('style'))).toEqual([
      'width: 60%;', 'width: 10%;', 'width: 20%;'
    ])
    expect(wrapper.text()).toContain('"percent":"70.0"')

    await wrapper.findAll('.usage-row')[0].trigger('click')
    expect(wrapper.get('.usage-items').text()).toContain('components.input.contextDetail.items.user')
    expect(wrapper.get('.usage-items').text()).toContain('read_file')
    expect(wrapper.get('.usage-items').text()).toContain('components.input.contextDetail.items.toolResult')

    await wrapper.findAll('.usage-row')[1].trigger('click')
    expect(wrapper.get('.usage-items').text()).toContain('b')
    expect(wrapper.get('.usage-items').text()).toContain('服务器 A')
    await wrapper.findAll('.usage-row')[2].trigger('click')
    expect(wrapper.find('.usage-items').exists()).toBe(true)
  } finally { wrapper.unmount() }
})

test('切换会话后丢弃旧分类，晚到的旧响应不覆盖当前内容', async () => {
  let finishOld!: (value: unknown) => void
  rpc.mockReset()
  rpc.mockImplementation((_type: string, data: any) => data.conversationId === 'old'
    ? new Promise(resolve => { finishOld = resolve })
    : Promise.resolve(breakdown('current-model')))
  const wrapper = mountPanel({ request: request('old') })
  try {
    await wrapper.setProps({ request: request('current') })
    await flushPromises()
    finishOld(breakdown('old-model'))
    await flushPromises()
    expect(wrapper.get('.usage-model').text()).toBe('current-model')
  } finally { wrapper.unmount() }
})

test('新回合完成后刷新分类；没有模型时不发请求；读取失败显示原文', async () => {
  answerWith({ 'context.breakdown': () => breakdown() })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    await wrapper.setProps({ usedTokens: 900 })
    await flushPromises()
    expect(rpc.mock.calls.filter(([type]) => type === 'context.breakdown')).toHaveLength(2)

    rpc.mockReset()
    await wrapper.setProps({ request: { conversationId: 'current' } })
    await flushPromises()
    expect(rpc).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('components.input.contextDetail.noModel')

    rpc.mockRejectedValue(new Error('请选择渠道和模型。'))
    await wrapper.setProps({ request: request() })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('请选择渠道和模型。')
  } finally { wrapper.unmount() }
})

test('总结区展开时才读取，关闭再打开后丢弃在途的旧详情', async () => {
  let finishDetail!: (value: unknown) => void
  rpc.mockReset()
  rpc.mockImplementation((type: string) => {
    if (type === 'context.summaryDetail') return new Promise(resolve => { finishDetail = resolve })
    if (type === 'context.describe') return Promise.resolve(describe('current', '当前会话摘要'))
    return Promise.resolve(breakdown())
  })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    const details = wrapper.get('details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('context.describe', { conversationId: 'current', providerId: 'channel', modelOverride: 'fixture-model' })
    expect(wrapper.text()).toContain('当前会话摘要')

    await wrapper.get('.usage-summary .usage-link').trigger('click')
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    finishDetail({ conversationId: 'current', summary: summary('关闭前请求的旧详情') })
    await flushPromises()
    expect(wrapper.text()).toContain('当前会话摘要')
    expect(wrapper.text()).not.toContain('关闭前请求的旧详情')
    expect(wrapper.get('.usage-summary .usage-link').attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})

test('点击面板外部或按 Esc 关闭，点击入口控件交给控件自己切换', async () => {
  answerWith({ 'context.breakdown': () => breakdown() })
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const wrapper = mountPanel({ anchor })
  try {
    await flushPromises()
    await wrapper.get('.usage-title').trigger('pointerdown')
    anchor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')).toEqual([[false], [false]])
    expect(document.activeElement).toBe(anchor)
  } finally {
    wrapper.unmount()
    anchor.remove()
  }
})
