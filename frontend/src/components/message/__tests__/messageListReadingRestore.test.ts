import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useVirtualMessageWindow } from '../useVirtualMessageWindow'
import { messageListUiStateByTab } from '../messageListUiState'
import { clearMessageJump } from '../messageJump'
import { createChatState } from '../../../stores/chat/state'
import { snapshotCurrentSession, switchTab } from '../../../stores/chat/tabActions'
import { loadHistory, loadMessagesAroundIndex, loadOlderMessagesPage } from '../../../stores/chat/conversationActions'
import { contentToMessageEnhanced } from '../../../stores/chat/parsers'
import { sendToExtension } from '../../../utils/vscode'
import type { Message } from '../../../types'

vi.mock('../../../utils/vscode', () => ({ sendToExtension: vi.fn() }))

function history(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, index, timestamp: index,
    isUserInput: index % 4 === 0,
    ...(index % 7 === 6 ? { role: 'user', isFunctionResponse: true,
      parts: [{ functionResponse: { name: 'test', response: {} } }] } : { role: index % 4 === 0 ? 'user' : 'model', parts: [{ text: `message ${index}` }] })
  }))
}

type History = ReturnType<typeof history>
const histories = new Map<string, History>()
let gate: ((name: string, data: any) => Promise<void> | undefined) | undefined
let resize: (() => void) | undefined

async function fixture() {
  const state = createChatState()
  const install = (id: string, rows = histories.get(id)!) => {
    state.currentConversationId.value = id
    state.allMessages.value = rows.map(row => contentToMessageEnhanced(row as any))
    state.totalMessages.value = histories.get(id)!.length
    state.windowStartIndex.value = rows[0]?.index ?? 0
  }
  state.openTabs.value = ['A', 'B'].map(id => ({ id, conversationId: id, title: id, isStreaming: false }))
  state.activeTabId.value = 'B'
  install('B')
  state.sessionSnapshots.value.set('B', snapshotCurrentSession(state))
  state.activeTabId.value = 'A'
  install('A')
  const chatStore = reactive({ ...state,
    loadMessagesAroundIndex: (index: number, options?: { pageSize?: number; signal?: AbortSignal }) => loadMessagesAroundIndex(state, index, options),
    loadOlderMessagesPage: () => loadOlderMessagesPage(state)
  })
  let navigation!: ReturnType<typeof useVirtualMessageWindow>
  let following = false
  let viewportHeight = 320
  const writes: number[] = []
  const Child = defineComponent({
    props: ['messages', 'tabId'],
    setup(props) {
      navigation = useVirtualMessageWindow({
        chatStore: chatStore as any, props: props as { messages: Message[]; tabId: string },
        checkpointsByMsgIndex: computed(() => new Map()), showBuildBar: computed(() => false),
        buildAnchorBackendIndex: computed(() => null), showTodoBar: computed(() => false),
        todoAnchorBackendIndex: computed(() => null), isBuildExpanded: ref(false), isTodoExpanded: ref(false),
        restoreNotice: ref(null), restoreTodoExpandedState: vi.fn()
      })
      return () => h('div', { class: 'scroll-wrapper' }, [h('div', { class: 'viewport' }, navigation.messageRenderRows.value.flatMap(row =>
        row.kind === 'message' ? [h('div', { class: 'message-item', 'data-message-id': row.item.message.id })] : []))])
    }
  })
  const wrapper = mount(defineComponent({ setup: () => () => h(Child, {
    messages: state.allMessages.value.filter(message => !message.isFunctionResponse), tabId: state.activeTabId.value
  }) }))
  const container = wrapper.get('.viewport').element as HTMLElement
  const rowHeight = (element: Element) => Number(element.getAttribute('data-message-id')?.split('-').at(-1)) % 3 === 0 ? 44 : 24
  const height = () => Array.from(container.children).reduce((sum, row) => sum + rowHeight(row), 0)
  let scrollTop = 0
  Object.defineProperties(container, {
    clientHeight: { get: () => viewportHeight }, scrollHeight: { get: height },
    // JSDOM 不做布局裁剪；模拟浏览器在换成短窗口后的合法滚动范围。
    scrollTop: { get: () => Math.max(0, Math.min(scrollTop, height() - viewportHeight)), set: (value: number) => { scrollTop = value } }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === container) return new DOMRect(0, 0, 500, viewportHeight)
    const index = Array.from(container.children).indexOf(this)
    const top = Array.from(container.children).slice(0, index).reduce((sum, row) => sum + rowHeight(row), 0) - container.scrollTop
    return new DOMRect(0, top, 500, rowHeight(this))
  })
  navigation.scrollbarRef.value = {
    getContainer: () => container,
    scrollToPosition: (top: number) => {
      container.scrollTop = Math.max(0, Math.min(top, height() - viewportHeight))
      following = height() - container.scrollTop - viewportHeight <= 50
      writes.push(container.scrollTop)
    },
    pauseBottomFollow: () => { following = false },
    isFollowingBottom: () => following
  } as any
  await flushPromises()
  const anchor = () => {
    const row = Array.from(container.children).find(row => row.getBoundingClientRect().bottom > 1)!
    return { id: row.getAttribute('data-message-id'), offset: row.getBoundingClientRect().top }
  }
  const read = async (index: number, offset = -13) => {
    await navigation.jumpToMessage({ index })
    const target = Array.from(container.children).find(row => row.getAttribute('data-message-id') === `${state.currentConversationId.value}-${index}`)!
    following = false
    container.scrollTop += target.getBoundingClientRect().top - offset
    container.dispatchEvent(new Event('scroll'))
    await flushPromises()
    return anchor()
  }
  const switchTo = (id: string, refresh = false) => {
    switchTab(state, id, async () => {})
    if (!refresh) return Promise.resolve()
    state.isLoading.value = true
    return loadHistory(state).finally(() => { state.isLoading.value = false })
  }
  return { wrapper, state, navigation, container, writes, anchor, read, switchTo, install,
    setHeight: (value: number) => { viewportHeight = value }, setFollowing: (value: boolean) => { following = value },
    following: () => following }
}

describe('切回长会话恢复阅读位置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    histories.set('A', history('A', 1802))
    histories.set('B', history('B', 1304))
    gate = undefined
    messageListUiStateByTab.clear()
    clearMessageJump()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: (entries: any[]) => void) { resize = () => callback([{ contentRect: { height: 320 } }]) }
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1 })
    vi.mocked(sendToExtension).mockImplementation(async (name: any, data: any) => {
      await gate?.(name, data)
      const rows = histories.get(data?.conversationId) ?? []
      if (name === 'conversation.getMessagePosition') return { index: rows.findIndex(row => row.id === data.messageId) }
      if (name === 'conversation.getMessagesPaged') {
        const start = data.offset ?? Math.max(0, (data.beforeIndex ?? rows.length) - data.limit)
        return { total: rows.length, messages: rows.slice(start, data.beforeIndex ?? start + data.limit) }
      }
      return { total: rows.length, markers: [], floorIndices: [] }
    })
  })
  afterEach(() => {
    messageListUiStateByTab.clear()
    clearMessageJump()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('超过200行的A/B多次往返保存旧DOM锚点/相对偏移，后台新增不抢走阅读位置', async () => {
    const f = await fixture()
    const a = await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    expect(messageListUiStateByTab.get('A')).toMatchObject({ conversationId: 'A', anchorMessageId: a.id,
      anchorBackendIndex: 632, anchorOffset: a.offset, followingBottom: false })
    expect(messageListUiStateByTab.get('A')!.anchorWindowOffset).toBeGreaterThanOrEqual(0)
    const b = await f.read(808, -9)
    for (let i = 0; i < 3; i++) {
      const snapshot = f.state.sessionSnapshots.value.get('A')!
      snapshot.allMessages = [...snapshot.allMessages, { id: `append-${i}`, role: 'assistant', content: 'parallel output', timestamp: 0, backendIndex: 1802 + i }]
      snapshot.totalMessages++
      await f.switchTo('A')
      await flushPromises()
      expect(f.anchor()).toEqual(a)
      expect(f.following()).toBe(false)
      expect(f.wrapper.findAll('.message-item').length).toBeLessThanOrEqual(200)
      await f.switchTo('B')
      await flushPromises()
      expect(f.anchor()).toEqual(b)
    }
    f.wrapper.unmount()
  })

  test('桌面尾页刷新后按稳定ID载入目标页，隐藏functionResponse不污染backendIndex', async () => {
    const f = await fixture()
    const a = await f.read(632, -17)
    await f.switchTo('B')
    await flushPromises()
    // 删除锚点之前的记录会改变backendIndex；ID位置查询必须优先于旧下标。
    histories.set('A', histories.get('A')!.slice(21).map((row, index) => ({ ...row, index })))
    await f.switchTo('A', true)
    await flushPromises()
    expect(f.anchor()).toEqual(a)
    expect(f.state.windowStartIndex.value).toBe(611 - 200)
    expect(f.state.allMessages.value.some(message => message.isFunctionResponse)).toBe(true)
    expect(f.wrapper.findAll('.message-item').length).toBeLessThanOrEqual(200)
    f.wrapper.unmount()
  })

  test('已删除锚点定位同一后端位置的下一条可见消息，不使用scrollTop猜历史', async () => {
    const f = await fixture()
    await f.read(632, -11)
    await f.switchTo('B')
    await flushPromises()
    histories.set('A', histories.get('A')!.filter(row => row.id !== 'A-632').map((row, index) => ({ ...row, index })))
    await f.switchTo('A', true)
    await flushPromises()
    expect(f.anchor()).toEqual({ id: 'A-633', offset: -11 })
    f.wrapper.unmount()
  })

  test('原本贴底的会话切回后跟随后台新增，首次无state仍从最新窗口进入', async () => {
    const f = await fixture()
    expect(f.following()).toBe(true)
    expect(f.navigation.virtualWindowEnd.value).toBe(1802)
    await f.switchTo('B')
    await flushPromises()
    histories.set('A', history('A', 1900))
    await f.switchTo('A', true)
    await flushPromises()
    expect(f.following()).toBe(true)
    expect(f.navigation.virtualWindowEnd.value).toBe(1900)
    expect(f.container.scrollHeight - f.container.scrollTop - f.container.clientHeight).toBe(0)
    f.wrapper.unmount()
  })

  test('布局不可见时不提前写位置，容器可见的ResizeObserver只完成一次恢复', async () => {
    const f = await fixture()
    const a = await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    f.setHeight(0)
    await f.switchTo('A')
    await flushPromises()
    const writes = f.writes.length
    f.setHeight(320)
    resize!()
    await flushPromises()
    expect(f.anchor()).toEqual(a)
    expect(f.writes.length).toBe(writes + 1)
    resize!()
    await flushPromises()
    expect(f.writes.length).toBe(writes + 1)
    f.wrapper.unmount()
  })

  test.each(['wheel', 'touchmove', 'keydown'])('恢复分页在途时%s取消迟到窗口与位置写入', async kind => {
    const f = await fixture()
    await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    let finish!: () => void
    gate = (name, data) => name === 'conversation.getMessagesPaged' && data.offset !== undefined
      ? new Promise<void>(resolve => { finish = resolve }) : undefined
    await f.switchTo('A', true)
    await flushPromises()
    expect(finish).toBeTypeOf('function')
    const before = f.state.allMessages.value
    f.container.dispatchEvent(kind === 'wheel' ? new WheelEvent(kind, { deltaY: -30, bubbles: true })
      : kind === 'keydown' ? new KeyboardEvent(kind, { key: 'PageUp', bubbles: true }) : new Event(kind, { bubbles: true }))
    f.container.scrollTop = 111
    const writes = f.writes.length
    finish()
    await flushPromises()
    expect(f.state.allMessages.value).toBe(before)
    expect(f.state.isLoadingMoreMessages.value).toBe(false)
    expect(f.container.scrollTop).toBe(111)
    expect(f.writes.length).toBe(writes)
    f.wrapper.unmount()
  })

  test('卸载重建仍用同一份UI状态恢复，标签页复用到新会话则保留首次进入行为', async () => {
    const first = await fixture()
    const a = await first.read(633, -12) // 模型回复，isUserInput=false 也可以是阅读锚点。
    first.wrapper.unmount()
    const second = await fixture()
    expect(second.anchor()).toEqual(a)
    expect(second.following()).toBe(false)
    histories.set('C', history('C', 84))
    second.install('C')
    await flushPromises()
    expect(second.navigation.virtualWindowEnd.value).toBe(84)
    expect(second.following()).toBe(true)
    expect(second.container.scrollHeight - second.container.scrollTop - second.container.clientHeight).toBe(0)
    second.wrapper.unmount()
  })

  test('稳定ID位置查询在途时用户已上翻，迟到查询不再发起目标窗口加载', async () => {
    const f = await fixture()
    await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    let finish!: () => void
    gate = name => name === 'conversation.getMessagePosition'
      ? new Promise<void>(resolve => { finish = resolve }) : undefined
    await f.switchTo('A', true)
    await flushPromises()
    const requests = vi.mocked(sendToExtension).mock.calls.length
    const current = f.state.allMessages.value
    f.container.dispatchEvent(new WheelEvent('wheel', { deltaY: -15, bubbles: true }))
    f.container.scrollTop = 123
    finish()
    await flushPromises()
    expect(vi.mocked(sendToExtension).mock.calls.length).toBe(requests)
    expect(f.state.allMessages.value).toBe(current)
    expect(f.container.scrollTop).toBe(123)
    f.wrapper.unmount()
  })

  test('恢复等待布局时显式消息定位优先，后续Resize不把位置拉回旧锚点', async () => {
    const f = await fixture()
    await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    f.setHeight(0)
    await f.switchTo('A')
    await flushPromises()
    f.setHeight(320)
    const target = await f.read(1001, -7)
    resize!()
    await flushPromises()
    expect(f.anchor()).toEqual(target)
    f.wrapper.unmount()
  })

  test('恢复在途切走再切回A，旧请求不覆盖新窗口，未完成的阅读状态不被尾页污染', async () => {
    const f = await fixture()
    const a = await f.read(632)
    await f.switchTo('B')
    await flushPromises()
    const b = await f.read(808)
    let finish!: () => void
    gate = (name, data) => name === 'conversation.getMessagesPaged' && data.offset !== undefined
      ? new Promise<void>(resolve => { finish = resolve }) : undefined
    await f.switchTo('A', true)
    await flushPromises()
    await f.switchTo('B')
    await flushPromises()
    expect(f.anchor()).toEqual(b)
    expect(messageListUiStateByTab.get('A')!.anchorMessageId).toBe(a.id)
    const completeOld = finish
    gate = undefined
    await f.switchTo('A', true)
    await flushPromises()
    expect(f.anchor()).toEqual(a)
    const current = f.state.allMessages.value
    completeOld()
    await flushPromises()
    expect(f.state.allMessages.value).toBe(current)
    expect(f.anchor()).toEqual(a)
    f.wrapper.unmount()
  })
})
