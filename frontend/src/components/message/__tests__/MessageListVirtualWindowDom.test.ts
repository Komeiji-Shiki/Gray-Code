import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'
import MessageList from '../MessageList.vue'
import { messageListUiStateByTab } from '../messageListUiState'
import type { Message } from '../../../types'

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const CustomScrollbarStub = defineComponent({
  name: 'CustomScrollbar',
  setup(_props, { expose }) {
    const container = ref<HTMLElement | null>(null)
    expose({
      getContainer: () => container.value ?? undefined,
      scrollToBottom: vi.fn(),
      scrollToPosition: (top: number) => { if (container.value) container.value.scrollTop = top },
      pauseBottomFollow: vi.fn(),
      isFollowingBottom: () => false,
      update: vi.fn()
    })
    return { container }
  },
  template: '<div ref="container" class="scroll-container-stub"><slot /></div>'
})

const MessageItemStub = defineComponent({
  props: { message: { type: Object, required: true }, inputGroup: String },
  template: '<div class="message-item" :data-message-id="message.id" :data-input-group="inputGroup">{{ message.content }}</div>'
})

const SummaryMessageStub = defineComponent({
  props: { message: { type: Object, required: true } },
  template: '<div class="summary-message" :data-message-id="message.id">{{ message.content }}</div>'
})

const SlotStub = defineComponent({ template: '<div><slot /></div>' })

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    timestamp: index,
    backendIndex: index
  }))
}

describe('MessageList virtual window DOM', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    messageListUiStateByTab.clear()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(() => {
    messageListUiStateByTab.clear()
    vi.unstubAllGlobals()
  })

  test('窗口裁剪后滚动内容只包含真实消息，不生成不可寻址的空白 spacer', async () => {
    const wrapper = mount(MessageList, {
      attachTo: document.body,
      props: { messages: makeMessages(240), tabId: 'tab-dom' },
      global: {
        stubs: {
          CustomScrollbar: CustomScrollbarStub,
          MessageItem: MessageItemStub,
          SummaryMessage: SummaryMessageStub,
          Tooltip: SlotStub,
          DeleteDialog: SlotStub,
          ConfirmDialog: SlotStub,
          DirtyFilesConfirm: SlotStub,
          ChatError: SlotStub
        }
      }
    })

    await nextTick()
    await nextTick()

    const rows = wrapper.findAll('.message-item')
    expect(rows).toHaveLength(40)
    expect(rows[0].attributes('data-message-id')).toBe('m-200')
    expect(rows.at(-1)?.attributes('data-message-id')).toBe('m-239')
    expect(wrapper.find('.virtual-message-spacer').exists()).toBe(false)

    const contentChildren = Array.from(wrapper.get('.messages-container').element.children)
    expect(contentChildren.some(element => element.classList.contains('virtual-message-spacer'))).toBe(false)

    wrapper.unmount()
  })

  test('后台长区跨虚拟窗口时首尾封口，每条仍为独立可寻址行', async () => {
    const messages = makeMessages(240).map(message => ({ ...message, role: 'user' as const, source: 'background_task' as const }))
    const original = JSON.stringify(messages)
    const wrapper = mount(MessageList, {
      attachTo: document.body,
      props: { messages, tabId: 'group-window' },
      global: { stubs: {
        CustomScrollbar: CustomScrollbarStub, MessageItem: MessageItemStub, SummaryMessage: SummaryMessageStub,
        Tooltip: SlotStub, DeleteDialog: SlotStub, ConfirmDialog: SlotStub, DirtyFilesConfirm: SlotStub, ChatError: SlotStub
      } }
    })
    await nextTick()
    await nextTick()
    let rows = wrapper.findAll('.message-item')
    expect(rows).toHaveLength(40)
    expect(rows[0].attributes('data-message-id')).toBe('m-200')
    expect(rows[0].attributes('data-input-group')).toBe('start')
    expect(rows.at(-1)?.attributes('data-input-group')).toBe('end')
    expect(rows.every(row => row.element.parentElement === wrapper.get('.messages-container').element)).toBe(true)
    await wrapper.get('.load-more-container').trigger('click')
    await nextTick()
    rows = wrapper.findAll('.message-item')
    expect(rows).toHaveLength(80)
    expect(rows[0].attributes('data-message-id')).toBe('m-160')
    expect(rows[0].attributes('data-input-group')).toBe('start')
    expect(wrapper.get('[data-message-id="m-200"]').attributes('data-input-group')).toBe('middle')
    expect(rows.at(-1)?.attributes('data-input-group')).toBe('end')
    expect(JSON.stringify(messages)).toBe(original)
    expect(wrapper.find('.virtual-message-spacer').exists()).toBe(false)
    wrapper.unmount()
  })
})
