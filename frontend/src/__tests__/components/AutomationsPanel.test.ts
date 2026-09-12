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
  completedRuns: 1, updatedAt: 1, configuration: { modelOverride: 'model' },
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, requests: 1, estimatedRequests: 0, unknownRequests: 0 }, ...extra })
beforeEach(() => {
  rows = []; rpc.mockReset()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  rpc.mockImplementation(async method => {
    if (method === 'automations.list') return rows
    if (method === 'automations.options') return { agents: [{ id: 'default', name: 'GrayCode' }], providers: [{ id: 'provider', name: '测试渠道', model: 'model', models: [] }],
      workspaces: [], promptModes: [{ id: 'preset', name: '预设' }], current: { conversationId: 'current-chat', agentId: 'default', providerId: 'provider', modelId: 'model', promptModeId: 'preset' } }
    if (method === 'automations.create') { const value = record({ status: 'active' }); rows = [value]; return value }
    if (method === 'automations.resume') { rows = [record({ status: 'active' })]; return rows[0] }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  dialogMethods.forEach((name, index) => {
    if (dialogDescriptors[index]) Object.defineProperty(HTMLDialogElement.prototype, name, dialogDescriptors[index]!)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  })
})

describe('自动任务的创建与继续', () => {
  test('创建目标保留当前对话和目标内容，无需填写 Token 上限', async () => {
    const wrapper = mount(AutomationsPanel, { props: { open: true } }); await flushPromises()
    await wrapper.get('[aria-label="自动任务目标"]').setValue('整理和验证项目资料')
    expect(wrapper.find('[aria-label="自动任务 Token 预算"]').exists()).toBe(false)
    await wrapper.get('form').trigger('submit'); await flushPromises()
    const created = rpc.mock.calls.find(call => call[0] === 'automations.create')?.[1]
    expect(created).toMatchObject({ conversationId: 'current-chat', objective: '整理和验证项目资料' })
    expect(created).not.toHaveProperty('tokenBudget')
    expect(wrapper.find('[role=alert]').exists()).toBe(false); wrapper.unmount()
  })
  test('暂停的目标可以直接继续，用量仍正常显示', async () => {
    rows = [record()]
    const wrapper = mount(AutomationsPanel, { props: { open: true } }); await flushPromises()
    expect(wrapper.get('.automation-statistics').text()).toContain('120')
    await wrapper.findAll('button').find(button => button.text() === '继续')!.trigger('click'); await flushPromises()
    expect(rpc.mock.calls.find(call => call[0] === 'automations.resume')?.[1]).toEqual({ id: 'goal' })
    expect(wrapper.find('[role=alert]').exists()).toBe(false); wrapper.unmount()
  })
})
