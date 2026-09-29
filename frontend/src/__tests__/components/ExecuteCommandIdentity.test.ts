import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import ExecuteCommand from '../../components/tools/terminal/execute_command.vue'
import { useTerminalStore } from '../../stores/terminalStore'
import { messageConversationKey } from '../../composables/messageConversationContext'
import { setLanguage } from '../../i18n'
import { sendToExtension } from '../../utils/vscode'

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), onExtensionCommand: vi.fn(() => () => {}), showNotification: vi.fn() }))
const request = vi.mocked(sendToExtension)
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => { setActivePinia(createPinia()); setLanguage('zh-CN'); request.mockReset(); request.mockResolvedValue({ success: true }) })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })
function render(props: Record<string, unknown>, conversationId = 'A') {
  const wrapper = mount(ExecuteCommand, { props: { args: { command: 'node worker.cjs' }, ...props }, global: {
    provide: { [messageConversationKey as symbol]: ref(conversationId) }, stubs: { CustomScrollbar: { template: '<div><slot /></div>' } }
  } })
  wrappers.push(wrapper); return wrapper
}

test('同名命令按调用和对话归属显示，停止仅指向该卡片的真实终端', async () => {
  const store = useTerminalStore()
  for (const id of ['B', 'A']) {
    store.handleTerminalOutput({ terminalId: `terminal-${id}`, toolId: 'same-call', conversationId: id, type: 'start', command: 'node worker.cjs' } as any)
    store.handleTerminalOutput({ terminalId: `terminal-${id}`, type: 'output', data: `OUTPUT-${id}` })
  }
  const wrapper = render({ toolId: 'same-call', status: 'executing' })
  expect(wrapper.get('.output-code').text()).toBe('OUTPUT-A')
  await wrapper.get('.kill-btn').trigger('click'); await flushPromises()
  expect(request).toHaveBeenCalledWith('terminal.kill', { terminalId: 'terminal-A' })
})

test.each(['streaming', 'queued', 'awaiting_approval'])('尚未启动的 %s 调用不注册假终端或展示停止按钮', status => {
  const wrapper = render({ toolId: 'waiting-call', status })
  expect(useTerminalStore().terminals.size).toBe(0)
  expect(wrapper.find('.kill-btn').exists()).toBe(false)
  expect(wrapper.find('.running-indicator').exists()).toBe(false)
})

test('终端退出回执优先于还未更新的工具执行状态', () => {
  const store = useTerminalStore()
  store.handleTerminalOutput({ terminalId: 'legacy-call', type: 'exit', exitCode: 0 })
  const wrapper = render({ toolId: 'legacy-call', status: 'executing' })
  expect(wrapper.find('.kill-btn').exists()).toBe(false)
  expect(wrapper.get('.status-badge').text()).toBe('成功')
})

test('没有活跃状态的历史后台任务查询真实终态，空输出也能结束运行显示', async () => {
  request.mockResolvedValue({ success: true, running: false, output: '', exitCode: 0 })
  const wrapper = render({ toolId: 'old-call', status: 'success', result: { success: true, data: { terminalId: 'old-terminal', background: true, output: '' } } })
  await flushPromises()
  expect(request).toHaveBeenCalledWith('terminal.getOutput', { terminalId: 'old-terminal' })
  expect(wrapper.find('.kill-btn').exists()).toBe(false)
  expect(wrapper.get('.status-badge').text()).toBe('成功')
})

test('停止失败在卡片中说明原因，切换调用后迟到回执不改写新卡片', async () => {
  request.mockResolvedValueOnce({ success: false, error: '该进程暂时无法停止' })
  const store = useTerminalStore(); store.handleTerminalOutput({ terminalId: 'A', type: 'start' })
  const wrapper = render({ status: 'executing', result: { data: { terminalId: 'A' } } })
  await wrapper.get('.kill-btn').trigger('click'); await flushPromises()
  expect(wrapper.get('.panel-error').text()).toContain('该进程暂时无法停止')
  let finish!: (value: unknown) => void; request.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await wrapper.get('.kill-btn').trigger('click')
  store.handleTerminalOutput({ terminalId: 'B', type: 'start' })
  await wrapper.setProps({ result: { data: { terminalId: 'B' } } })
  finish({ success: true, output: 'old task stopped' }); await flushPromises()
  expect(wrapper.emitted('update-result')).toBeUndefined()
  expect(wrapper.find('.panel-error').exists()).toBe(false)
})

test('恢复期间的新输出优先于迟到快照，已完成输出按原有五分钟周期清理', async () => {
  vi.useFakeTimers()
  const store = useTerminalStore(), dispose = store.initialize()
  try {
    let finish!: (value: unknown) => void
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const restoring = store.restoreTerminal('live')
    store.handleTerminalOutput({ terminalId: 'live', type: 'output', data: 'new output' })
    finish({ success: true, running: false, output: 'old output' }); await restoring
    expect(store.getTerminal('live')).toMatchObject({ running: true, output: 'new output' })
    store.handleTerminalOutput({ terminalId: 'ended', type: 'exit', exitCode: 0 })
    store.handleTerminalOutput({ terminalId: 'visible', type: 'exit', exitCode: 0 })
    const release = store.retainTerminal('visible')
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(store.getTerminal('ended')).toBeUndefined()
    expect(store.getTerminal('live')?.running).toBe(true)
    expect(store.getTerminal('visible')?.exitCode).toBe(0)
    release(); store.cleanup()
    expect(store.getTerminal('visible')).toBeUndefined()
  } finally { dispose(); vi.useRealTimers() }
})
