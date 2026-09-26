import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { useVirtualMessageWindow } from '../useVirtualMessageWindow'
import { messageListUiStateByTab } from '../messageListUiState'
import { clearMessageJump, jumpToMessage, peekMessageJump } from '../messageJump'
import type { Message } from '../../../types'

vi.mock('../../../utils/vscode', () => ({
  sendToExtension: vi.fn().mockResolvedValue({ total: 1000, markers: [], floorIndices: [] })
}))

function messages(start: number, count: number): Message[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `m-${start + offset}`, role: 'user', content: 'message', timestamp: 0, backendIndex: start + offset
  }))
}

function mountWindow(fullWindow = false) {
  const state = reactive({ messages: messages(800, 200), tabId: 'navigation-tab' })
  const chatStore = reactive({
    currentConversationId: 'conversation', totalMessages: 1000, windowStartIndex: 800,
    isStreaming: false, isWaitingForResponse: false, isLoadingMoreMessages: false,
    checkpoints: [], openTabs: [{ id: state.tabId }], sessionSnapshots: new Map(),
    allMessages: state.messages,
    loadOlderMessagesPage: vi.fn().mockResolvedValue(false),
    loadMessagesAroundIndex: vi.fn().mockResolvedValue(false)
  })
  if (fullWindow) messageListUiStateByTab.set(state.tabId, {
    scrollTop: 0, visibleCount: 200, windowStart: 0, buildExpanded: false, todoExpanded: false, restoreNotice: null
  })
  let navigation!: ReturnType<typeof useVirtualMessageWindow>
  const wrapper = mount(defineComponent({
    setup() {
      navigation = useVirtualMessageWindow({
        chatStore: chatStore as any, props: state, checkpointsByMsgIndex: computed(() => new Map()),
        showBuildBar: computed(() => false), buildAnchorBackendIndex: computed(() => null),
        showTodoBar: computed(() => false), todoAnchorBackendIndex: computed(() => null),
        isBuildExpanded: ref(false), isTodoExpanded: ref(false), restoreNotice: ref(null),
        restoreTodoExpandedState: vi.fn()
      })
      return () => h('div', navigation.messageRenderRows.value.flatMap(row => row.kind === 'message'
        ? [h('div', { class: 'message-item', 'data-message-id': row.item.message.id })] : []))
    }
  }))
  const container = wrapper.element as HTMLElement
  Object.defineProperties(container, {
    clientHeight: { value: 500 }, scrollHeight: { value: 10000 }
  })
  navigation.scrollbarRef.value = { getContainer: () => container, scrollToBottom: vi.fn() } as any
  return { wrapper, state, chatStore, navigation }
}

describe('消息窗口分页与连续定位', () => {
  beforeEach(() => {
    messageListUiStateByTab.clear()
    clearMessageJump()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })
  afterEach(() => {
    messageListUiStateByTab.clear()
    clearMessageJump()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('本地还有较早消息时只展开 40 条，不提前请求后端', async () => {
    const { wrapper, chatStore, navigation } = mountWindow()
    await flushPromises()
    expect(wrapper.findAll('.message-item')).toHaveLength(40)
    await navigation.loadMore()
    expect(chatStore.loadOlderMessagesPage).not.toHaveBeenCalled()
    expect(wrapper.findAll('.message-item')).toHaveLength(80)
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-920')
    wrapper.unmount()
  })

  test('满窗口前插一大页后，原阅读锚点仍在 200 行渲染窗口内', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    chatStore.loadOlderMessagesPage.mockImplementation(async () => {
      state.messages = [...messages(600, 200), ...state.messages]
      chatStore.windowStartIndex = 600
      return true
    })
    await navigation.loadMore()
    expect(wrapper.findAll('.message-item')).toHaveLength(200)
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-760')
    expect(wrapper.find('[data-message-id="m-800"]').exists()).toBe(true)
    wrapper.unmount()
  })

  test('分页请求在途时再次定位，完成后消费最新目标', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow()
    await flushPromises()
    let finishFirst!: () => void
    chatStore.loadMessagesAroundIndex.mockImplementation((async (index: number) => {
      chatStore.isLoadingMoreMessages = true
      if (index === 100) await new Promise<void>(resolve => { finishFirst = resolve })
      state.messages = messages(index, 40)
      chatStore.windowStartIndex = index
      chatStore.isLoadingMoreMessages = false
      await nextTick()
      return true
    }) as any)
    const firstSeek = navigation.handleVirtualSeek(100)
    await nextTick()
    await navigation.handleVirtualSeek(700)
    expect(chatStore.loadMessagesAroundIndex).toHaveBeenCalledTimes(1)
    finishFirst()
    await firstSeek
    await flushPromises()
    expect(chatStore.loadMessagesAroundIndex.mock.calls).toEqual([[100], [700]])
    expect(wrapper.find('[data-message-id="m-700"]').exists()).toBe(true)
    expect(peekMessageJump('conversation')).toBeNull()
    wrapper.unmount()
  })

  test('稳定页面直接收到定位请求也会消费，不依赖消息数量变化', async () => {
    const { wrapper } = mountWindow()
    await flushPromises()
    jumpToMessage({ conversationId: 'conversation', index: 810 })
    await flushPromises()
    expect(wrapper.find('[data-message-id="m-810"]').exists()).toBe(true)
    expect(peekMessageJump('conversation')).toBeNull()
    wrapper.unmount()
  })

  test('中段向下阅读时分页连续重叠、保留锚点，并最终到达真实尾部', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    chatStore.totalMessages = 1250
    await flushPromises()
    const container = wrapper.element as HTMLElement
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Array.from(container.children).indexOf(this)
      const top = this === container ? 0 : index * 20 - container.scrollTop
      const height = this === container ? 500 : 20
      return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON() {} }
    })
    chatStore.loadMessagesAroundIndex.mockImplementation((async (index: number, options: { pageSize: number }) => {
      const start = index - options.pageSize / 2
      state.messages = messages(start, Math.min(options.pageSize, chatStore.totalMessages - start))
      chatStore.windowStartIndex = start
      await nextTick()
      return true
    }) as any)

    container.scrollTop = 3500
    container.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(wrapper.find('[data-message-id="m-975"]').exists()).toBe(true)
    expect(container.scrollTop).toBe(0)

    for (let step = 0; step < 8 && navigation.virtualWindowEnd.value < 1250; step++) {
      container.scrollTop = wrapper.findAll('.message-item').length * 20 - 500
      container.dispatchEvent(new Event('scroll'))
      await flushPromises()
      const ids = wrapper.findAll('.message-item').map(row => row.attributes('data-message-id'))
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBeLessThanOrEqual(200)
    }
    expect(chatStore.loadMessagesAroundIndex.mock.calls).toEqual([
      [1000, { pageSize: 400 }], [1200, { pageSize: 400 }]
    ])
    expect(navigation.virtualWindowEnd.value).toBe(1250)
    wrapper.unmount()
  })
})
