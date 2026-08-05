import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../../types'
import MessageItem from '../../components/message/MessageItem.vue'
import { useChatStore } from '../../stores/chatStore'
import { disposeAllSmoothStreams } from '../../stores/chat/smoothStreamManager'

const MessageRenderBlockStub = defineComponent({
  name: 'MessageRenderBlock',
  props: {
    block: { type: Object, required: true },
    smoothDisplayActive: Boolean
  },
  template: '<div class="render-block-stub">{{ block.text }}</div>'
})

const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, default: '' }
  },
  template: '<div class="markdown-stub">{{ content }}</div>'
})

const EmptyStub = defineComponent({
  template: '<div></div>'
})

function mountMessage(message: Message, pinia = createPinia()) {
  setActivePinia(pinia)
  return shallowMount(MessageItem, {
    props: { message, messageIndex: 0 },
    global: {
      plugins: [pinia],
      stubs: {
        MessageRenderBlock: MessageRenderBlockStub,
        MarkdownRenderer: MarkdownRendererStub,
        ResponseViewerDialog: EmptyStub
      }
    }
  })
}

describe('MessageItem streaming render exclusivity', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    disposeAllSmoothStreams()
  })

  afterEach(() => {
    disposeAllSmoothStreams()
    document.body.innerHTML = ''
  })

  it('renders completed parts once without also rendering the content fallback', () => {
    const wrapper = mountMessage({
      id: 'answer-message',
      role: 'assistant',
      content: 'same answer',
      timestamp: Date.now(),
      streaming: false,
      parts: [{ text: 'same answer' }]
    } as Message)

    expect(wrapper.findAll('.render-block-stub')).toHaveLength(1)
    expect(wrapper.get('.render-block-stub').text()).toBe('same answer')
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the previous text visible while a function call is the current tail', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chatStore = useChatStore()
    chatStore.smoothTexts.set('tool-tail-message', { partKey: 'text:0', text: 'hello' })

    const functionCall = { id: 'tool-1', name: 'search', args: {} }
    const baseMessage = {
      id: 'tool-tail-message',
      role: 'assistant',
      content: 'hello',
      timestamp: Date.now(),
      streaming: true,
      parts: [{ text: 'hello' }]
    } as Message
    const wrapper = mountMessage(baseMessage, pinia)

    expect(wrapper.find('.char-flow-host').exists()).toBe(true)
    expect(wrapper.findAll('.render-block-stub')).toHaveLength(0)

    await wrapper.setProps({
      message: {
        ...baseMessage,
        parts: [{ text: 'hello' }, { functionCall }]
      } as Message
    })

    expect(wrapper.find('.char-flow-host').exists()).toBe(false)
    expect(wrapper.findAll('.render-block-stub').map(block => block.text())).toContain('hello')

    chatStore.smoothTexts.set('tool-tail-message', { partKey: 'text:2', text: '' })
    await wrapper.setProps({
      message: {
        ...baseMessage,
        content: 'helloafter',
        parts: [{ text: 'hello' }, { functionCall }, { text: 'after' }]
      } as Message
    })

    expect(wrapper.find('.char-flow-host').exists()).toBe(true)
    expect(wrapper.findAll('.render-block-stub').map(block => block.text())).toContain('hello')
    expect(wrapper.findAll('.render-block-stub').map(block => block.text())).not.toContain('after')
    wrapper.unmount()
  })

  it('marks the active thought tail for CharFlow instead of mounting the text tail host', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chatStore = useChatStore()
    chatStore.smoothTexts.set('thought-message', { partKey: 'thought:0', text: '' })

    const wrapper = shallowMount(MessageItem, {
      props: {
        message: {
          id: 'thought-message',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          streaming: true,
          parts: [{ text: 'thinking', thought: true }]
        } as Message,
        messageIndex: 0
      },
      global: {
        plugins: [pinia],
        stubs: {
          MessageRenderBlock: MessageRenderBlockStub,
          MarkdownRenderer: MarkdownRendererStub,
          ResponseViewerDialog: EmptyStub
        }
      }
    })

    const block = wrapper.getComponent(MessageRenderBlockStub)
    expect(block.props('smoothDisplayActive')).toBe(true)
    expect(wrapper.find('.char-flow-host').exists()).toBe(false)
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)
    wrapper.unmount()
  })
})
