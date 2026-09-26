import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import { DefaultToolResult, getToolConfig } from '../../../../utils/toolRegistry'
import '../../../../utils/tools/context'
import ContextToolPanel from '../ContextToolPanel.vue'
import AgentMessagePanel from '../../subagents/AgentMessagePanel.vue'

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => setLanguage('auto'))

test('发送消息展开后正文与收件方直接可见，ID留在未挂载的详情中', () => {
  const wrapper = mount(AgentMessagePanel, { props: { toolName: 'agent_send_message', args: { targetAgentName: 'main', message: '第一行\n第二行' },
    result: { success: true, data: { messageId: 'technical-message-id', threadId: 'technical-thread-id', toRunId: '__main__', hopDepth: 2 } } } })
  try {
    expect(wrapper.find('.message-text').text()).toBe('第一行\n第二行')
    expect(wrapper.find('.recipient').text()).toContain('主模型')
    expect(wrapper.find('.delivery-note').text()).toContain('等待接收方')
    expect(wrapper.find<HTMLDetailsElement>('.tool-receipt-details').element.open).toBe(false)
    expect(wrapper.find('.tool-receipt-details').text()).not.toContain('technical-message-id')
    expect(wrapper.find<HTMLDetailsElement>('.result-parameters').element.open).toBe(false)
  } finally { wrapper.unmount() }
})

test('发送、失败和等待状态分别展示；长正文直接可见', () => {
  const text = `${'正文'.repeat(3000)}末尾`
  const failed = mount(AgentMessagePanel, { props: { args: { message: text, targetRunId: 'worker-id' }, result: { success: false, error: '收件方已结束' } } })
  const waiting = mount(AgentMessagePanel, { props: { args: { message: '待发送' }, status: 'executing' } })
  try {
    expect(failed.find('.message-text').text()).toBe(text)
    expect(failed.find('[role="alert"]').text()).toContain('收件方已结束')
    expect(failed.find('.delivery-note').exists()).toBe(false)
    expect(waiting.find('[role="status"]').exists()).toBe(true)
    expect(waiting.find('.message-text').text()).toBe('待发送')
    expect(waiting.find('.delivery-note').exists()).toBe(false)
  } finally { failed.unmount(); waiting.unmount() }
})

test('旧历史缺失正文时明确说明，HTML作为文字呈现', () => {
  const missing = mount(AgentMessagePanel, { props: { result: { success: true, data: { toRunId: 'worker' } } } })
  const html = mount(AgentMessagePanel, { props: { args: { message: '<img src=x onerror=alert(1)>' } } })
  try {
    expect(missing.find('.unavailable').text()).toContain('未保存消息正文')
    expect(html.find('img').exists()).toBe(false)
    expect(html.find('.message-text').text()).toContain('<img')
  } finally { missing.unmount(); html.unmount() }
})

test.each(['write', 'append'])('任务笔记%s显示本次提交正文，不只显示字符回执', action => {
  const wrapper = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action, name: 'checkpoint', text: '目标\n下一步' },
    result: { success: true, name: 'checkpoint', characters: 5071 } } })
  try {
    expect(wrapper.find('.document-name').text()).toBe('checkpoint')
    expect(wrapper.find('.document-text').text()).toBe('目标\n下一步')
    expect(wrapper.find('.character-count').text()).toBe('6 字符')
    expect(wrapper.find('header strong').text()).toBe(action === 'append' ? '本次追加内容' : '笔记正文')
  } finally { wrapper.unmount() }
})

test('读取显示返回正文和失效/截断状态，不复用旧写入参数', () => {
  const wrapper = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action: 'read', text: '过期原文' },
    result: { success: true, name: 'checkpoint', text: '当前有效的片段', invalidated: true, truncated: true, totalChars: 10000 } } })
  try {
    expect(wrapper.find('.document-text').text()).toBe('当前有效的片段')
    expect(wrapper.find('.context-document').text()).not.toContain('过期原文')
    expect(wrapper.findAll('.context-warning')).toHaveLength(2)
  } finally { wrapper.unmount() }
})

test('笔记目录和历史查询分别显示名称与消息片段，支持data信封', async () => {
  const notes = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action: 'list' }, result: { success: true, notes: [{ name: 'plan' }, { name: 'checks' }] } } })
  const history = mount(ContextToolPanel, { props: { toolName: 'context_history', args: { action: 'search' },
    result: { success: true, data: { items: [{ messageId: 'message-1', role: 'user', text: '历史内容' }], nextBeforeId: 'message-1' } } } })
  try {
    expect(notes.findAll('.context-list article')).toHaveLength(2)
    expect(history.find('.context-list pre').text()).toBe('历史内容')
    expect(history.find('.context-warning').text()).toContain('更早记录')
    setLanguage('en'); await history.vm.$nextTick()
    expect(history.find('h4').text()).toBe('History')
  } finally { notes.unmount(); history.unmount() }
})

test('三类工具使用专用懒加载面板而非默认模板', () => {
  for (const name of ['agent_send_message', 'context_notes', 'context_history']) {
    expect(getToolConfig(name)?.contentComponent).not.toBe(DefaultToolResult)
  }
})
