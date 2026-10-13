import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import ToolItem from '../toolMessage/ToolItem.vue'
import { setLanguage } from '../../../i18n'
import '../../../utils/tools/file/insert_code'
import '../../../utils/tools/terminal/execute_command'
import '../../../utils/tools/platform'

vi.mock('../../../stores', () => ({ useChatStore: () => ({ currentConversationId: 'fixture' }) }))

afterEach(() => setLanguage('auto'))

test('问答工具通过注册配置显示问题标题，并省略重复摘要', async () => {
  setLanguage('zh-CN')
  const wrapper = mount(ToolItem, { props: {
    tool: { id: 'question', name: 'ask_user', args: { questions: [{ title: '要保存到哪里？' }] }, status: 'executing' },
    isExpanded: false, isExpandable: true, showContent: false, isProcessing: false,
    showStreamingPreview: false, streamingPreviewText: '', pendingDiffs: [], diffGuardWarning: null,
    contentHost: { template: '<div />' }, registerStreamingPreviewRef: () => {},
  } })
  try {
    expect(wrapper.get('.tool-name').text()).toBe('要保存到哪里？')
    expect(wrapper.find('.tool-description').exists()).toBe(false)
    expect(wrapper.find('.codicon-comment-discussion').exists()).toBe(true)
    await wrapper.setProps({ tool: { id: 'question', name: 'ask_user', args: {
      questions: [{ title: '保存位置？' }, { title: '文件名称？' }]
    }, status: 'executing' } })
    expect(wrapper.get('.tool-name').text()).toContain('2')
    expect(wrapper.find('.tool-description').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

test('没有专用渲染器的工具卡片随语言切换名称和说明，未知工具保留通用展示', async () => {
  setLanguage('zh-CN')
  const wrapper = mount(ToolItem, { props: {
    tool: { id: 'notes', name: 'context_notes', args: { action: 'list' }, status: 'success' },
    isExpanded: false, isExpandable: false, showContent: false, isProcessing: false,
    showStreamingPreview: false, streamingPreviewText: '', pendingDiffs: [], diffGuardWarning: null,
    contentHost: { template: '<div />' }, registerStreamingPreviewRef: () => {},
  } })
  try {
    expect(wrapper.find('.tool-name').text()).toBe('任务笔记')
    expect(wrapper.find('.tool-description').text()).toContain('跨上下文窗口')
    setLanguage('en'); await nextTick()
    expect(wrapper.find('.tool-name').text()).toBe('Task Notes')
    expect(wrapper.find('.tool-description').text()).toContain('across context windows')
    setLanguage('ja'); await nextTick()
    expect(wrapper.find('.tool-name').text()).toBe('タスクノート')
    await wrapper.setProps({ tool: { id: 'external', name: 'custom_tool', args: {}, status: 'success' } })
    expect(wrapper.find('.tool-name').text()).toBe('Custom Tool')
    expect(wrapper.find('.tool-description').text()).not.toContain('toolDescriptions.')
  } finally { wrapper.unmount() }
})

test.each([
  { name: 'insert_code', label: '插入代码', args: { files: [{ path: 'src/' + 'nested/'.repeat(80) + 'MessageItem.vue', line: 10, content: '示例' }] }, expected: 'nested/' },
  { name: 'execute_command', label: '执行命令', args: { command: 'npm run ' + 'very-long-command-'.repeat(40), cwd: 'frontend', shell: 'powershell' }, expected: 'very-long-command-' },
])('长参数仍保留 $name 名称、状态、完整摘要与展开操作', async ({ name, label, args, expected }) => {
  setLanguage('zh-CN')
  const wrapper = mount(ToolItem, { props: {
    tool: { id: name, name, args, status: 'success', duration: 123 },
    isExpanded: false, isExpandable: true, showContent: false, isProcessing: false,
    showStreamingPreview: false, streamingPreviewText: '', pendingDiffs: [], diffGuardWarning: null,
    contentHost: { template: '<div />' }, registerStreamingPreviewRef: () => {},
  } })
  try {
    expect(wrapper.get('.tool-name').text()).toBe(label)
    expect(wrapper.get('.tool-description').text()).toContain(expected)
    expect(wrapper.get('.tool-description').text().length).toBeGreaterThan(500)
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('成功')
    expect(wrapper.get('.tool-duration').text()).toBe('123ms')
    const summary = wrapper.get('button.tool-summary')
    expect(summary.attributes('aria-expanded')).toBe('false')
    await summary.trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)

    await wrapper.setProps({ tool: { id: name, name, args, status: 'awaiting_approval' } })
    expect(wrapper.get('.tool-approval-badge').text()).toBe('等待确认')
    await wrapper.get('.confirm-btn').trigger('click')
    await wrapper.get('.reject-btn').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('reject')).toHaveLength(1)
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  } finally { wrapper.unmount() }
})
