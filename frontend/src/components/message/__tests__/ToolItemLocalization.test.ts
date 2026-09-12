import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import ToolItem from '../toolMessage/ToolItem.vue'
import { setLanguage } from '../../../i18n'

vi.mock('../../../stores', () => ({ useChatStore: () => ({ currentConversationId: 'fixture' }) }))

afterEach(() => setLanguage('auto'))

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
