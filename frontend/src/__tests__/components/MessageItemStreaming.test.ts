import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../../types'
import MessageItem from '../../components/message/MessageItem.vue'
import { useChatStore } from '../../stores/chatStore'
import {
  disposeAllSmoothStreams,
  finishSmoothStream,
  pushSmoothText
} from '../../stores/chat/smoothStreamManager'

const MessageRenderBlockStub = defineComponent({
  name: 'MessageRenderBlock',
  props: {
    block: { type: Object, required: true },
    smoothDisplayActive: Boolean,
    thoughtViewMode: { type: String, default: '' }
  },
  template: '<div class="render-block-stub">{{ block.text }}</div>'
})

const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: {
    content: { type: String, default: '' }
  },
  emits: ['rendered'],
  setup(props, { emit }) {
    watch(
      () => props.content,
      async (source) => {
        await nextTick()
        emit('rendered', source)
      },
      { immediate: true }
    )
    return {}
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

  it('renders a complete table prefix before the stream ends and keeps only the partial row in CharFlow', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chatStore = useChatStore()
    const messageId = 'streaming-table-message'
    const tableHead = '| Name | Value |\n| --- | --- |\n'
    const completeRow = '| alpha | 1 |\n'
    const partialRow = '| beta | 2'
    const content = tableHead + completeRow + partialRow

    pushSmoothText(messageId, 'text:0', content, 'balanced', '', (id, partKey, text) => {
      chatStore.smoothTexts.set(id, { partKey, text })
    })

    const wrapper = mountMessage({
      id: messageId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      streaming: true,
      parts: [{ text: content }]
    } as Message, pinia)
    await nextTick() // 挂载 CharFlow host 并注册显示目标

    finishSmoothStream(messageId) // flush 积压，但消息仍保持 streaming=true 以验证流中 UI
    const host = wrapper.get('.char-flow-host')
    // Markdown DOM 尚未确认：bridge 维持完整原文，不出现“表格消失”空窗。
    expect(host.element.textContent).toBe(content)

    await nextTick()
    await nextTick()
    await Promise.resolve() // rendered waiter resolve 后释放 raw bridge
    expect(wrapper.get('.markdown-stub').element.textContent).toBe(tableHead + completeRow)
    expect(host.element.textContent).toBe(partialRow)

    wrapper.unmount()
  })

  it('re-registers the reused text host when the active partKey changes after a tool call', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chatStore = useChatStore()
    const messageId = 'text-part-switch-message'
    const onSnapshot = (id: string, partKey: string, text: string) => {
      chatStore.smoothTexts.set(id, { partKey, text })
    }
    const initialMessage = {
      id: messageId,
      role: 'assistant',
      content: 'first',
      timestamp: Date.now(),
      streaming: true,
      parts: [{ text: 'first' }]
    } as Message

    pushSmoothText(messageId, 'text:0', '', 'balanced', 'first', onSnapshot)
    const wrapper = mountMessage(initialMessage, pinia)
    await nextTick()
    expect(wrapper.get('.char-flow-host').element.textContent).toBe('first')

    const functionCall = { id: 'tool-1', name: 'search', args: {} }
    pushSmoothText(messageId, 'text:2', 'next', 'balanced', '', onSnapshot)
    await wrapper.setProps({
      message: {
        ...initialMessage,
        content: 'firstnext',
        parts: [{ text: 'first' }, { functionCall }, { text: 'next' }]
      } as Message
    })
    await nextTick()
    finishSmoothStream(messageId)

    expect(wrapper.get('.char-flow-host').element.textContent).toBe('next')
    expect(wrapper.findAll('.render-block-stub').map(block => block.text())).toContain('first')

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
    // 思维链三段式默认中展开
    expect(block.props('thoughtViewMode')).toBe('medium')
    expect(wrapper.find('.char-flow-host').exists()).toBe(false)
    expect(wrapper.find('.markdown-stub').exists()).toBe(false)
    wrapper.unmount()
  })
})
