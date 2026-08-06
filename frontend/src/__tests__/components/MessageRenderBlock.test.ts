import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import MessageRenderBlock from '../../components/message/MessageRenderBlock.vue'
import {
  disposeAllSmoothStreams,
  finishSmoothStream,
  pushSmoothText
} from '../../stores/chat/smoothStreamManager'

function stubAnimationFrame(): void {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

function mountBlock(props: Record<string, unknown> = {}) {
  return mount(MessageRenderBlock, {
    props: {
      block: { type: 'thought', text: 'base ', partKey: 'thought:0', partCount: 1 },
      messageId: 'thought-message',
      messageRole: 'assistant',
      isStreaming: true,
      isThoughtExpanded: false,
      isThinking: true,
      thinkingTimeDisplay: '1.0s',
      smoothDisplayActive: true,
      toggleThought: vi.fn(),
      ...props
    },
    global: {
      stubs: {
        MarkdownRenderer: {
          name: 'MarkdownRenderer',
          template: '<div class="markdown-stub">{{ content }}</div>',
          props: ['content', 'isStreaming', 'latexOnly']
        },
        InlineContextMessage: true,
        ToolMessage: true
      }
    }
  })
}

describe('MessageRenderBlock smooth thought display', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
    stubAnimationFrame()
  })

  afterEach(() => {
    disposeAllSmoothStreams()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('uses CharFlow for both collapsed preview and expanded thought content', async () => {
    pushSmoothText('thought-message', 'thought:0', 'thinking', 'balanced', 'base ', () => {})

    const wrapper = mountBlock()

    await nextTick()
    expect(wrapper.get('.thought-flow-preview').element.textContent).toBe('base ')
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)

    await wrapper.setProps({ isThoughtExpanded: true })
    await nextTick()
    expect(wrapper.get('.thought-flow-content').element.textContent).toBe('base ')
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)

    finishSmoothStream('thought-message')
    expect(wrapper.get('.thought-flow-content').text()).toBe('base thinking')

    wrapper.unmount()
  })

  it('collapsed preview registers noFade + squashLineBreaks + tailWindow (single-line flow)', async () => {
    pushSmoothText('thought-message', 'thought:0', '续', 'balanced', '前段\n\n', () => {})

    const wrapper = mountBlock()

    await nextTick()
    // restoreFull：折叠预览显示完整累计文本，且换行已折叠为零宽空格（nowrap 下不占位）
    expect(wrapper.get('.thought-flow-preview').element.textContent).toBe('前段\u200B\u200B')

    finishSmoothStream('thought-message')
    // append 增量同样折叠换行：预览持续显示真实可见字符
    expect(wrapper.get('.thought-flow-preview').element.textContent).toBe('前段\u200B\u200B续')

    wrapper.unmount()
  })

  it('expanded thought renders promoted paragraphs progressively via MarkdownRenderer', async () => {
    pushSmoothText('thought-message', 'thought:0', 'para one\n\npara two', 'balanced', '', () => {})

    const wrapper = mountBlock({ isThoughtExpanded: true })

    await nextTick()
    // 注册时累计文本为空：无已定型段落，markdown 层暂不出现
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)
    expect(wrapper.get('.thought-flow-content').element.textContent).toBe('')

    finishSmoothStream('thought-message')
    await nextTick()
    // flush 后完整段落（\n\n 边界）被提升到渐进渲染层即时出格式，未完成尾巴留在 CharFlow host
    // （用 element.textContent 断言：test-utils 的 .text() 会 trim 尾随换行）
    expect(wrapper.get('.markdown-stub').element.textContent).toBe('para one\n\n')
    expect(wrapper.get('.thought-flow-content').text()).toBe('para two')

    wrapper.unmount()
  })
})
