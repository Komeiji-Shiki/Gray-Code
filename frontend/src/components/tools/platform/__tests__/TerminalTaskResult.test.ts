import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import TerminalTaskResult from '../TerminalTaskResult.vue'
import ProcessToolResult from '../ProcessToolResult.vue'

const wrappers: VueWrapper[] = []
beforeEach(() => setLanguage('zh-CN'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })
function render(action: string, result?: unknown) {
  const wrapper = mount(TerminalTaskResult, { props: { toolName: 'terminal_task', args: { action }, result } })
  wrappers.push(wrapper); return wrapper
}

test('后台列表直接显示命令与独立终态，查询成功也保留失败退出码和原因', () => {
  const wrapper = render('list', { success: true, data: { total: 2, tasks: [
    { taskId: 'live', command: 'node worker.cjs', status: 'running', exitCode: null },
    { taskId: 'failed', command: 'npm test', status: 'error', exitCode: 7, error: '测试失败' }
  ] } })
  expect(wrapper.findAll('.task-command').map(node => node.text())).toEqual(['node worker.cjs', 'npm test'])
  expect(wrapper.findAll('.task-status').map(node => node.text())).toEqual(['运行中', '错误'])
  expect(wrapper.get('.task-exit-code').text()).toContain('7')
  expect(wrapper.get('.task-error').text()).toBe('测试失败')
  expect(wrapper.find('.process-output').exists()).toBe(false)
})

test('分段读取区分未读输出和早期输出丢失，游标零保留在详情中', async () => {
  const wrapper = render('read', { success: true, data: { taskId: 'done', command: 'node tool.cjs', status: 'completed', running: false,
    output: 'remaining text', outputLost: true, hasMore: true, nextCursor: 0 } })
  expect(wrapper.get('.output-truncated').text()).toContain('截断')
  expect(wrapper.get('.process-continuation').text()).toContain('继续读取')
  expect(wrapper.get('.platform-text').text()).toBe('remaining text')
  const details = wrapper.get<HTMLDetailsElement>('.tool-receipt-details'); details.element.open = true; await details.trigger('toggle')
  expect(details.text()).toContain('0')
})

test('中断状态与待回执分开，缺少结果不会伪造任务或空列表', async () => {
  const wrapper = render('list')
  expect(wrapper.find('.terminal-task').exists()).toBe(false)
  expect(wrapper.find('.platform-empty').exists()).toBe(false)
  await wrapper.setProps({ args: { action: 'status' }, result: { success: true, data: { taskId: 'old', status: 'interrupted', running: false } } })
  expect(wrapper.get('.task-status').text()).toBe('已中断')
  expect(wrapper.find('.process-output').exists()).toBe(false)
  await wrapper.setProps({ result: { success: false, error: '任务不存在' } })
  expect(wrapper.find('.terminal-task').exists()).toBe(false)
  expect(wrapper.get('[role=alert]').text()).toContain('任务不存在')
})

test('列表分批展开，服务端的后续页和本地尚未展开的项目分别显示', async () => {
  const wrapper = render('list', { success: true, data: { tasks: Array.from({ length: 60 }, (_, index) => ({ taskId: `task-${index}`, command: `command-${index}`, status: 'completed' })), total: 100, nextOffset: 60 } })
  expect(wrapper.findAll('.terminal-task')).toHaveLength(40)
  await wrapper.get('.platform-more').trigger('click')
  expect(wrapper.findAll('.terminal-task')).toHaveLength(60)
  expect(wrapper.get('.continuation').text()).toContain('60')
})

test('直接进程读取也显示未读输出，而不是把停止状态当作输出已经读完', () => {
  const wrapper = mount(ProcessToolResult, { props: { toolName: 'process_session', args: { action: 'read' }, result: { success: true, data: { id: 'process', running: false, exitCode: 0, output: 'first page', nextCursor: 10, hasMore: true } } } })
  wrappers.push(wrapper)
  expect(wrapper.get('.process-state').text()).toBe('进程已退出')
  expect(wrapper.get('.process-continuation').text()).toContain('继续读取')
})
