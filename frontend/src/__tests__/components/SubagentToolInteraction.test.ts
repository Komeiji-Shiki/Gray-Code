import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { setLanguage } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { sendToExtension } from '../../utils/vscode'
import '../../utils/tools/subagents/subagents'
import ToolItem from '../../components/message/toolMessage/ToolItem.vue'
import SubagentContent from '../../components/tools/subagents/subagents.vue'

vi.mock('../../utils/vscode', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/vscode')>(),
  sendToExtension: vi.fn(async () => ({ success: true })),
  showNotification: vi.fn(),
}))
beforeEach(() => { setActivePinia(createPinia()); setLanguage('zh-CN'); vi.mocked(sendToExtension).mockClear(); vi.stubGlobal('__GRAYCODE_HOST', {}) })
afterEach(() => { setLanguage('auto'); vi.unstubAllGlobals() })

test.each([undefined, { success: true, data: { runId: 'actual-child' } }])('桌面子代理标题只展开；只有详情按钮打开面板（result=%j）', async result => {
  useChatStore().currentConversationId = 'conversation'
  const wrapper = mount(ToolItem, { props: {
    tool: { id: 'call-id', name: 'subagents', args: { agentName: 'General Worker', prompt: '检查代码' }, status: 'executing', result },
    isExpanded: false, isExpandable: true, showContent: false, isProcessing: false, showStreamingPreview: false, streamingPreviewText: '',
    pendingDiffs: [], diffGuardWarning: null, contentHost: defineComponent({ template: '<div>参数</div>' }), registerStreamingPreviewRef: () => {},
  } })
  try {
    await wrapper.get('button.tool-summary').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
    expect(sendToExtension).not.toHaveBeenCalled()
    const details = wrapper.findAll('button').find(button => button.text().includes('打开详情'))!
    expect(details).toBeDefined()
    await details.trigger('click')
    expect(sendToExtension).toHaveBeenCalledWith('subagents.openMonitor', {
      runId: result ? 'actual-child' : undefined, toolId: 'call-id', conversationId: 'conversation',
    })
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

test('展开内容无需再点TaskCard即可看见调用参数、任务与上下文', () => {
  const wrapper = mount(SubagentContent, { props: { toolId: 'call-id', args: {
    agentName: 'General Worker', background: false, maxRuntime: 1200, continueFromRunId: 'prior-run', prompt: '完整任务\n第二行', context: '完整上下文',
  } } })
  try {
    const parameters = wrapper.get('.call-parameters')
    expect(parameters.text()).toContain('General Worker')
    expect(parameters.text()).toContain('1200')
    expect(parameters.text()).toContain('prior-run')
    expect(parameters.findAll('pre').map(node => node.text())).toEqual(expect.arrayContaining(['完整任务\n第二行', '完整上下文']))
    expect(wrapper.find('.task-card').exists()).toBe(false)
    expect(sendToExtension).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})
