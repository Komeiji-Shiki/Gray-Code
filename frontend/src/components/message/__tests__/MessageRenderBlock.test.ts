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
import { describe, expect, vi } from 'vitest'
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
  test('流式时思考块 MarkdownRenderer 收到 is-streaming=true 且内容透传', () => {
    const wrapper = mountThoughtBlock(true, '```ts\nconst x = 1;\n```')
    const md = wrapper.findComponent(MarkdownRendererStub)
    expect(md.exists()).toBe(true)
    expect(md.props('isStreaming')).toBe(true)
    expect(md.props('content')).toBe('```ts\nconst x = 1;\n```')
    wrapper.unmount()
  })

  test('非流式时思考块 MarkdownRenderer 收到 is-streaming=false', () => {
    const wrapper = mountThoughtBlock(false)
    const md = wrapper.findComponent(MarkdownRendererStub)
    expect(md.exists()).toBe(true)
    expect(md.props('isStreaming')).toBe(false)
    wrapper.unmount()
  })
})

describe('MessageRenderBlock 思考块折叠预览', () => {
  function mountCollapsed(text: string) {
    const block: RenderBlock = { type: 'thought', text, key: '0:thought' }
    return mount(MessageRenderBlock, {
      props: {
        block,
        messageRole: 'assistant',
        isStreaming: false,
        thoughtViewMode: 'collapsed',
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

  test('折叠模式显示思考内容第一行作为预览（多行文本只取第一行）', () => {
    const wrapper = mountCollapsed('第一行思考内容\n第二行\n第三行')
    expect(wrapper.find('.thought-collapsed-text').text()).toBe('第一行思考内容')
    // 折叠模式不渲染中展开/完全展开内容区
    expect(wrapper.find('.thought-medium').exists()).toBe(false)
    expect(wrapper.find('.thought-content').exists()).toBe(false)
    wrapper.unmount()
  })

  test('折叠模式跳过空行，取首个非空行；空文本预览为空', () => {
    const wrapper = mountCollapsed('\n  \n第二行')
    expect(wrapper.find('.thought-collapsed-text').text()).toBe('第二行')
    wrapper.unmount()

    const empty = mountCollapsed('')
    expect(empty.find('.thought-collapsed-text').text()).toBe('')
    empty.unmount()
  })
})
