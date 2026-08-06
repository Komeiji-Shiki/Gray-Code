/**
 * MessageRenderBlock 思考块流式透传测试
 *
 * 背景：思考块（thought）内的 MarkdownRenderer 此前未透传 is-streaming，
 * 导致流式期间思考块内的长代码块无法进入 MarkdownRenderer 的流式模式
 * （不限制 max-height，自然展开）。本测试验证透传链路。
 *
 * 覆盖：
 * - 流式时思考块 MarkdownRenderer 收到 is-streaming=true
 * - 非流式时思考块 MarkdownRenderer 收到 is-streaming=false
 * - 思考文本内容正确透传给 MarkdownRenderer
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import MessageRenderBlock from '../MessageRenderBlock.vue'
import type { RenderBlock } from '../renderBlocks'

// 捕获 props 的 MarkdownRenderer 桩（MessageRenderBlock 只负责透传 props）
const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, default: '' },
    latexOnly: { type: Boolean, default: false },
    isStreaming: { type: Boolean, default: false },
    renderProfile: { type: String, default: 'default' }
  },
  template: '<div class="md-stub" />'
})

// 消息相关子组件被桩替换，其 setup 不执行；但模块加载仍会触及其 store 导入，
// 这里补上最小 mock，避免测试环境引入真实 Pinia 依赖。
vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({ checkpoints: [], allMessages: [] })
}))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => ({ appearanceLoadingText: '' })
}))
vi.mock('@/utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ results: {} }),
  showNotification: vi.fn().mockResolvedValue(undefined)
}))

function mountThoughtBlock(isStreaming: boolean, text = 'thinking...') {
  const block: RenderBlock = { type: 'thought', text, key: '0:thought' }
  return mount(MessageRenderBlock, {
    props: {
      block,
      messageRole: 'assistant',
      isStreaming,
      thoughtViewMode: 'expanded',
      isThinking: false,
      thinkingTimeDisplay: null,
      messageBackendIndex: 0,
      setThoughtViewMode: () => {}
    },
    global: {
      stubs: {
        MarkdownRenderer: MarkdownRendererStub,
        ToolMessage: true,
        InlineContextMessage: true
      }
    }
  })
}

describe('MessageRenderBlock 思考块流式透传', () => {
  it('流式时思考块 MarkdownRenderer 收到 is-streaming=true 且内容透传', () => {
    const wrapper = mountThoughtBlock(true, '```ts\nconst x = 1;\n```')
    const md = wrapper.findComponent(MarkdownRendererStub)
    expect(md.exists()).toBe(true)
    expect(md.props('isStreaming')).toBe(true)
    expect(md.props('content')).toBe('```ts\nconst x = 1;\n```')
    wrapper.unmount()
  })

  it('非流式时思考块 MarkdownRenderer 收到 is-streaming=false', () => {
    const wrapper = mountThoughtBlock(false)
    const md = wrapper.findComponent(MarkdownRendererStub)
    expect(md.exists()).toBe(true)
    expect(md.props('isStreaming')).toBe(false)
    wrapper.unmount()
  })
})
