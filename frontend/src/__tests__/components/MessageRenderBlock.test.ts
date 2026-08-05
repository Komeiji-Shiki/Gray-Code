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

    const wrapper = mount(MessageRenderBlock, {
      props: {
        block: { type: 'thought', text: 'base ', partKey: 'thought:0', partCount: 1 },
        messageId: 'thought-message',
        messageRole: 'assistant',
        isStreaming: true,
        isThoughtExpanded: false,
        isThinking: true,
        thinkingTimeDisplay: '1.0s',
        smoothDisplayActive: true,
        toggleThought: vi.fn()
      },
      global: {
        stubs: {
          MarkdownRenderer: {
            name: 'MarkdownRenderer',
            template: '<div class="markdown-stub"></div>'
          },
          InlineContextMessage: true,
          ToolMessage: true
        }
      }
    })

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
})
