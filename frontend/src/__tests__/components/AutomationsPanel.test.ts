import { mount, flushPromises } from '@vue/test-utils'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import AutomationsPanel from '../../../../apps/client/src/components/AutomationsPanel.vue'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/client/src/api', () => ({ call: rpc, subscribe: () => () => {} }))
vi.mock('../../../../apps/client/src/state', () => ({ state: { conversationId: 'current-chat' } }))
vi.mock('../../../../shared/reasoningEffort', () => ({ reasoningLevelsForModel: () => [] }))
let rows: any[]
const dialogMethods = ['showModal', 'close'] as const
const dialogDescriptors = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name))
const record = (extra = {}) => ({ id: 'goal', kind: 'goal', name: '当前目标', objective: '完成目标', conversationId: 'current-chat', status: 'paused', pauseReason: 'user',
  completedRuns: 1, tokenBudget: 200, updatedAt: 1, configuration: { modelOverride: 'model' },
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, requests: 1, estimatedRequests: 0, unknownRequests: 0 }, ...extra })
beforeEach(() => {
  rows = []; rpc.mockReset()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  rpc.mockImplementation(async (method, params) => {
    if (method === 'automations.list') return rows
    if (method === 'automations.options') return { agents: [{ id: 'default', name: 'GrayCode' }], providers: [{ id: 'provider', name: '测试渠道', model: 'model', models: [] }],
      workspaces: [], promptModes: [{ id: 'preset', name: '预设' }], current: { conversationId: 'current-chat', agentId: 'default', providerId: 'provider', modelId: 'model', promptModeId: 'preset' } }
    if (method === 'automations.create') { const value = record({ status: 'active', tokenBudget: params.tokenBudget }); rows = [value]; return value }
    if (method === 'automations.resume') { rows = [record({ status: 'active', tokenBudget: params.tokenBudget })]; return rows[0] }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  dialogMethods.forEach((name, index) => {
    if (dialogDescriptors[index]) Object.defineProperty(HTMLDialogElement.prototype, name, dialogDescriptors[index]!)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  })
})

describe('自动任务的实际数字输入', () => {
  test('填写数字预算后可以创建目标，数字输入不会被当作字符串调用', async () => {
    const wrapper = mount(AutomationsPanel, { props: { open: true } }); await flushPromises()
    await wrapper.get('[aria-label="自动任务目标"]').setValue('整理和验证项目资料')
    await wrapper.get('[aria-label="自动任务 Token 预算"]').setValue('200')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(rpc.mock.calls.find(call => call[0] === 'automations.create')?.[1]).toMatchObject({ tokenBudget: 200, conversationId: 'current-chat', objective: '整理和验证项目资料' })
    expect(wrapper.find('[role=alert]').exists()).toBe(false); wrapper.unmount()
  })
  test('暂停的目标可以通过数字输入增加预算继续', async () => {
    rows = [record()]
    const wrapper = mount(AutomationsPanel, { props: { open: true } }); await flushPromises()
    await wrapper.get('[aria-label="继续时的 Token 预算"]').setValue('500')
    await wrapper.findAll('button').find(button => button.text() === '继续')!.trigger('click'); await flushPromises()
    expect(rpc.mock.calls.find(call => call[0] === 'automations.resume')?.[1]).toEqual({ id: 'goal', tokenBudget: 500 })
    expect(wrapper.find('[role=alert]').exists()).toBe(false); wrapper.unmount()
  })
})
