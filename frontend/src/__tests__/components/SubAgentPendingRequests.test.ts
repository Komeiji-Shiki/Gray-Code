import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import SubAgentPendingRequests from '../../components/subagents/SubAgentPendingRequests.vue'

const mock = vi.hoisted(() => ({ send: vi.fn(), changed: undefined as undefined | ((message: any) => void) }))
vi.mock('../../utils/vscode', () => ({
  sendToExtension: mock.send,
  onMessageFromExtension: (handler: (message: any) => void) => { mock.changed = handler; return vi.fn() }
}))

const approval = (id: string) => ({ id, runId: `core-${id}`, actorId: 'owner', toolCallId: `call-${id}`, toolName: 'delete_file',
  args: { paths: ['packages/core/tests/tmp.test.ts'] }, effects: ['data_delete'], subagentRunId: `sub-${id}`, agentName: 'General Worker' })

describe('主对话中的子代理待处理请求', () => {
  let wrapper: ReturnType<typeof mount> | undefined
  beforeEach(() => { vi.useFakeTimers(); mock.send.mockReset() })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() })

  test('显示等待确认的删除文件请求，点击允许后提交审批并刷新列表', async () => {
    let pending = [approval('a')]
    mock.send.mockImplementation(async (type: string) => type === 'subagents.pendingRequests' ? { approvals: pending, questions: [] } : { success: true })
    wrapper = mount(SubAgentPendingRequests, { props: { conversationId: 'main' } })
    await flushPromises()
    expect(mock.send).toHaveBeenCalledWith('subagents.pendingRequests', { conversationId: 'main' })
    expect(wrapper.text()).toContain('General Worker')
    expect(wrapper.text()).toContain('delete_file')
    expect(wrapper.text()).toContain('packages/core/tests/tmp.test.ts')
    pending = []
    await wrapper.findAll('button').find(button => button.text() === '允许执行')!.trigger('click')
    await flushPromises()
    expect(mock.send).toHaveBeenCalledWith('subagents.resolveApproval', { runId: 'sub-a', id: 'a', accepted: true, choiceId: undefined })
    expect(wrapper.find('.subagent-pending').exists()).toBe(false)
  })

  test('子代理审批事件会刷新列表，切换对话后不保留旧对话的请求', async () => {
    let pending: ReturnType<typeof approval>[] = []
    mock.send.mockImplementation(async () => ({ approvals: pending, questions: [] }))
    wrapper = mount(SubAgentPendingRequests, { props: { conversationId: 'main' } })
    await flushPromises()
    expect(wrapper.find('.subagent-pending').exists()).toBe(false)
    pending = [approval('b')]
    mock.changed?.({ type: 'subagentMonitor.event', data: { event: { type: 'approval_requested', runId: 'sub-b' } } })
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(wrapper.text()).toContain('delete_file')
    pending = []
    await wrapper.setProps({ conversationId: 'other' })
    expect(wrapper.find('.subagent-pending').exists()).toBe(false)
    await flushPromises()
    expect(mock.send).toHaveBeenLastCalledWith('subagents.pendingRequests', { conversationId: 'other' })
  })

  test('宿主返回不完整的结果时不显示面板，也不抛出错误', async () => {
    mock.send.mockResolvedValue(undefined)
    wrapper = mount(SubAgentPendingRequests, { props: { conversationId: 'main' } })
    await flushPromises()
    expect(wrapper.find('.subagent-pending').exists()).toBe(false)
  })
})
