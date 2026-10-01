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

test('历史工具按动作显示摘要，没有查询参数的 list/windows 也有说明', () => {
  const format = getToolConfig('context_history')!.descriptionFormatter
  expect(format({ action: 'list', limit: 5 })).toBe('列出最近消息')
  expect(format({ action: 'windows' })).toBe('列出上下文窗口')
  expect(format({ action: 'search', query: 'fileDetails' })).toBe('搜索历史 · fileDetails')
  expect(format({ action: 'read', messageId: 'message-1', offset: 600 })).toBe('读取消息 · message-1 · offset=600')
  expect(format({})).toBe('')
})

test('三类工具使用专用懒加载面板而非默认模板', () => {
  for (const name of ['agent_send_message', 'context_notes', 'context_history']) {
    expect(getToolConfig(name)?.contentComponent).not.toBe(DefaultToolResult)
  }
})

test('关联笔记的记录、召回和明确重读展示正文、真实来源与缺失依据', () => {
  const record = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action: 'record', entries: [
    { key: ' plan ', kind: 'task', text: ' 保留任务目标 ', sources: [{ messageId: 'last_user' }] },
  ] }, result: { success: true, noteEvent: { version: 1, records: [{ key: 'plan', id: 'note-plan', sources: [{ messageId: 'real-source' }] }] } } } })
  const recall = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action: 'recall' }, result: { success: true, data: {
    items: [{ id: 'note-decision', kind: 'decision', text: '本次召回的决定' }], alreadyProvided: [{ id: 'note-plan', messageId: 'real-source', reason: 'recorded' }],
    missingDependencies: ['missing-note'], omitted: ['budget-note'], estimatedTokens: 240, tokenBudget: 256, truncated: true,
  } } } })
  const inspect = mount(ContextToolPanel, { props: { toolName: 'context_notes', args: { action: 'inspect' }, result: { success: true,
    id: 'note-plan', kind: 'task', state: 'current', text: '明确重读正文', truncated: true, nextOffset: 12 } } })
  try {
    expect(record.find('.document-text').text()).toBe('保留任务目标')
    expect(record.find('.note-sources').text()).toContain('real-source')
    expect(record.find('.note-sources').text()).not.toContain('last_user')
    expect(recall.find('.document-text').text()).toBe('本次召回的决定')
    expect(recall.text()).toContain('real-source')
    expect(recall.text()).toContain('missing-note')
    expect(recall.text()).toContain('budget-note')
    expect(recall.find('.context-empty').exists()).toBe(false)
    expect(inspect.find('.document-text').text()).toBe('明确重读正文')
    expect(inspect.find('.context-warning').text()).toContain('12')
  } finally { record.unmount(); recall.unmount(); inspect.unmount() }
})
