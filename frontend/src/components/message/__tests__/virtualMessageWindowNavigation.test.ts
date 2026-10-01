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

function mountWindow(fullWindow = false, start = 800, count = 200) {
  const state = reactive({ messages: messages(start, count), tabId: 'navigation-tab' })
  const chatStore = reactive({
    currentConversationId: 'conversation', totalMessages: start + count, windowStartIndex: start,
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
        ? [h('div', { class: 'message-item', 'data-message-id': row.item.message.id, 'data-input-group': row.inputGroup })] : []))
    }
  }))
  const container = wrapper.element as HTMLElement
  Object.defineProperties(container, {
    clientHeight: { value: 500 }, scrollHeight: { value: 10000 }
  })
  navigation.scrollbarRef.value = {
    getContainer: () => container,
    scrollToBottom: vi.fn(),
    scrollToPosition: (top: number) => { container.scrollTop = Math.max(0, top) },
    pauseBottomFollow: vi.fn(),
    isFollowingBottom: () => container.scrollHeight - container.scrollTop - container.clientHeight <= 50
  } as any
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

  test('连接区内用户与后台跳转仍按各自稳定 ID 定位，不改虚拟消息行上限', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(false, 0, 240)
    state.messages = state.messages.map(message => ({ ...message, source: 'background_task' as const }))
    state.messages[205] = { ...state.messages[205], source: 'user', content: '可编辑用户原文' }
    chatStore.allMessages = state.messages
    await flushPromises()
    expect(wrapper.findAll('.message-item')).toHaveLength(40)
    expect(wrapper.get('[data-message-id="m-200"]').attributes('data-input-group')).toBe('start')
    const container = wrapper.element as HTMLElement
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Array.from(container.children).indexOf(this)
      return new DOMRect(0, this === container ? 0 : index * 20 - container.scrollTop, 100, this === container ? 500 : 20)
    })
    expect(await navigation.jumpToMessage({ id: 'm-205' })).toBe(true)
    expect(container.scrollTop).toBe(3125)
    expect(wrapper.get('[data-message-id="m-205"]').attributes('data-input-group')).toBe('middle')
    expect(await navigation.jumpToMessage({ id: 'm-206' })).toBe(true)
    expect(container.scrollTop).toBe(3145)
    expect(wrapper.get('[data-message-id="m-206"]').attributes('data-input-group')).toBe('middle')
    expect(wrapper.findAll('.message-item')).toHaveLength(200)
    expect(chatStore.loadMessagesAroundIndex).not.toHaveBeenCalled()
    expect(state.messages[205].content).toBe('可编辑用户原文')
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

  test('不可见 functionResponse 已覆盖全局尾部时，不重新读取同一末页', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    chatStore.allMessages = [...state.messages, { ...messages(1000, 1)[0], isFunctionResponse: true }]
    chatStore.totalMessages = 1001
    await flushPromises()
    expect(navigation.virtualWindowEnd.value).toBe(1001)
    const container = wrapper.element as HTMLElement
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Array.from(container.children).indexOf(this)
      const top = this === container ? 0 : index * 20 - container.scrollTop
      return new DOMRect(0, top, 100, this === container ? 500 : 20)
    })
    container.scrollTop = 3500
    for (let i = 0; i < 5; i++) {
      container.dispatchEvent(new Event('scroll'))
      await flushPromises()
    }
    expect(chatStore.loadMessagesAroundIndex).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('前插时数组净长度不增长（后端窗口已裁掉尾部）仍按消息身份向前展开', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    chatStore.loadOlderMessagesPage.mockImplementation(async () => {
      state.messages = messages(760, 200)
      chatStore.windowStartIndex = 760
      return true
    })
    await navigation.loadMore()
    expect(chatStore.loadOlderMessagesPage).toHaveBeenCalledOnce()
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-760')
    expect(wrapper.find('[data-message-id="m-800"]').exists()).toBe(true)
    wrapper.unmount()
  })

  test('超过 store 常规预算的长历史来回展开仍保持 200 行上限，不因等长分页重读', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(false, 800, 1200)
    await flushPromises()
    for (let i = 0; i < 29; i++) await navigation.loadMore()
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-800')
    expect(chatStore.loadOlderMessagesPage).not.toHaveBeenCalled()
    chatStore.loadOlderMessagesPage.mockImplementation(async () => {
      const start = chatStore.windowStartIndex - 200
      state.messages = messages(start, 1200) // 同步丢弃另一端，净长度不变
      chatStore.allMessages = state.messages
      chatStore.windowStartIndex = start
      return true
    })
    await navigation.loadMore()
    expect(chatStore.loadOlderMessagesPage).toHaveBeenCalledOnce()
    expect(wrapper.findAll('.message-item')).toHaveLength(200)
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-760')
    expect(wrapper.find('[data-message-id="m-800"]').exists()).toBe(true)
    for (let i = 0; i < 5; i++) await navigation.loadMore()
    expect(chatStore.loadOlderMessagesPage).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.message-item')).toHaveLength(200)
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-560')
    wrapper.unmount()
  })

  test('只有隐藏内容的旧页按游标有界补读，原位/程序 scroll 不会重启循环', async () => {
    const { wrapper, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    chatStore.loadOlderMessagesPage.mockImplementation(async () => {
      chatStore.windowStartIndex -= 10
      return true
    })
    await navigation.loadMore()
    expect(chatStore.loadOlderMessagesPage).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 10; i++) wrapper.element.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(chatStore.loadOlderMessagesPage).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  test('阅读历史时尾部新增不把渲染起点推走，真正贴底时才跟随新增', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    state.messages = [...state.messages, ...messages(1000, 1)]
    chatStore.allMessages = state.messages
    chatStore.totalMessages++
    await flushPromises()
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-800')
    expect(wrapper.find('[data-message-id="m-1000"]').exists()).toBe(false)
    // 用户回到最后一屏：通过已有全局定位进入尾部，然后追加。
    await navigation.jumpToMessage({ conversationId: 'conversation', index: 1000 })
    const scrollbar = navigation.scrollbarRef.value as any
    scrollbar.isFollowingBottom = () => true
    state.messages = [...state.messages, ...messages(1001, 1)]
    chatStore.allMessages = state.messages
    chatStore.totalMessages++
    await flushPromises()
    expect(wrapper.find('[data-message-id="m-1001"]').exists()).toBe(true)
    expect(wrapper.findAll('.message-item')).toHaveLength(200)
    wrapper.unmount()
  })

  test('贴底时折叠/视口扩张引起向上的程序 scroll，不启动历史分页', async () => {
    const { wrapper, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    const container = wrapper.element as HTMLElement
    container.scrollTop = 9000
    container.dispatchEvent(new Event('scroll'))
    ;(navigation.scrollbarRef.value as any).isFollowingBottom = () => true
    container.scrollTop = 10
    container.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(chatStore.loadOlderMessagesPage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  test('旧会话在途分页结算不能改变新会话的渲染窗口与滚动位置', async () => {
    const { wrapper, state, chatStore, navigation } = mountWindow(true)
    await flushPromises()
    let resolve!: (loaded: boolean) => void
    chatStore.loadOlderMessagesPage.mockReturnValue(new Promise<boolean>(r => { resolve = r }))
    const loading = navigation.loadMore()
    expect(navigation.isLoadingMore.value).toBe(true)
    chatStore.currentConversationId = 'other'
    state.messages = messages(2000, 60)
    chatStore.allMessages = state.messages
    chatStore.windowStartIndex = 2000
    chatStore.totalMessages = 2060
    await flushPromises()
    const container = wrapper.element as HTMLElement
    container.scrollTop = 250
    resolve(false)
    await loading
    await flushPromises()
    expect(navigation.isLoadingMore.value).toBe(false)
    expect(wrapper.find('.message-item').attributes('data-message-id')).toBe('m-2020')
    expect(container.scrollTop).toBe(250)
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
