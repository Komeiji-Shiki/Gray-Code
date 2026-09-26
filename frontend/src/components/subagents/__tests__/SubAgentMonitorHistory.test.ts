import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import type { Content } from '@/types'
import type { SubAgentRunContentWindowState } from '../monitorWindowState'
import SubAgentMonitor from '../SubAgentMonitor.vue'

const bridge = vi.hoisted(() => ({
  send: vi.fn(),
  dispose: vi.fn(),
  listener: undefined as ((message: unknown) => void) | undefined
}))
vi.mock('@/utils/vscode', () => ({
  sendToExtension: bridge.send,
  onMessageFromExtension: (listener: (message: unknown) => void) => {
    bridge.listener = listener
    return bridge.dispose
  },
  showNotification: vi.fn()
}))
vi.mock('@/services/soundEventController', () => ({
  setVscodeWindowFocused: vi.fn(),
  handleSoundEvent: vi.fn()
}))
// 保留真实 CustomScrollbar 的容器/生命周期，只替换与分页无关的重型消息渲染。
vi.mock('../../common', async () => ({
  CustomScrollbar: (await import('../../common/CustomScrollbar.vue')).default
}))
vi.mock('../../message/MessageItem.vue', () => ({
  default: {
    props: ['message'],
    template: '<div class="message-item" :data-message-id="message.id">{{ message.content }}</div>'
  }
}))

type WindowResponse = { window: SubAgentRunContentWindowState; activeRunIds?: string[] }
type PendingPage = {
  runId: string
  options: { limit: number; endIndex: number }
  resolve: (response: WindowResponse) => void
  reject: (error: Error) => void
}

function makeWindow(runId = 'a', startIndex = 40, endIndex = 60, totalCount = 60): SubAgentRunContentWindowState {
  return {
    runId, startIndex, endIndex, totalCount, contentRevision: 1, eventSequence: 1,
    hasMoreBefore: startIndex > 0,
    hasMoreAfter: endIndex < totalCount,
    contents: Array.from({ length: endIndex - startIndex }, (_, offset) => ({
      role: 'model', index: startIndex + offset, timestamp: startIndex + offset,
      parts: [{ text: `${runId} message ${startIndex + offset}` }]
    } as Content))
  }
}

const wrappers: VueWrapper[] = []

async function mountMonitor(options: { height?: number; hasMore?: boolean } = {}) {
  const pages: PendingPage[] = []
  const tails = new Map(['a', 'b'].map(runId => [runId, makeWindow(runId)]))
  if (options.hasMore === false) tails.get('a')!.hasMoreBefore = false
  bridge.send.mockImplementation((type: string, data: { runId: string; options: PendingPage['options'] & { fromTail?: boolean } }) => {
    if (type === MESSAGE_NAMES['subagents.monitorReady']) {
      return Promise.resolve({
        manifests: ['a', 'b'].map((runId, index) => ({
          runId, agentName: `Agent ${runId}`, status: 'completed', createdAt: 1000 + index,
          updatedAt: 2000, contentCount: 60, eventCount: 0, contentRevision: 1,
          conversationId: `conversation-${runId}`
        })),
        focusRunId: 'a', activeRunIds: []
      })
    }
    if (type === MESSAGE_NAMES['subagents.monitor.getRunWindow']) {
      if (data.options.fromTail) return Promise.resolve({ window: tails.get(data.runId), activeRunIds: [] })
      return new Promise<WindowResponse>((resolve, reject) => pages.push({ runId: data.runId, options: data.options, resolve, reject }))
    }
    return Promise.resolve({})
  })
  const wrapper = mount(SubAgentMonitor, { attachTo: document.body })
  wrappers.push(wrapper)
  const container = wrapper.get('.scroll-container').element as HTMLElement
  const height = options.height ?? 300
  let scrollTop = 0
  let tailGrowth = 0
  const headerHeight = () => container.querySelector('.run-window-note') ? 100 : 80
  const entryHeight = () => container.querySelector('.load-older-row') ? 40 : 0
  const messages = () => Array.from(container.querySelectorAll<HTMLElement>('.message-item'))
  // jsdom 不布局：模拟真实限幅 scrollTop、可变头部和各消息矩形，scroll 仍由用例显式派发。
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, get: () => headerHeight() + entryHeight() + messages().length * 80 + tailGrowth },
    scrollTop: {
      configurable: true, get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, container.scrollHeight - height)) }
    }
  })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === container) return new DOMRect(0, 100, 800, height)
    if (container.contains(this)) {
      if (this.classList.contains('load-older-row')) return new DOMRect(0, 100 + headerHeight() - scrollTop, 800, 40)
      const index = messages().indexOf(this)
      if (index >= 0) return new DOMRect(0, 100 + headerHeight() + entryHeight() + index * 80 - scrollTop, 800, 80)
    }
    return originalRect.call(this)
  })
  await flushPromises()

  function scrollTo(top: number) {
    container.scrollTop = top
    container.dispatchEvent(new Event('scroll'))
  }
  function wheel(deltaY: number) {
    container.dispatchEvent(new WheelEvent('wheel', { deltaY }))
  }
  function anchor() {
    const message = messages().find(element => element.getBoundingClientRect().bottom > 100)!
    return { id: message.dataset.messageId, offset: message.getBoundingClientRect().top - 100 }
  }
  function expectAnchor(expected: ReturnType<typeof anchor>) {
    const message = messages().find(element => element.dataset.messageId === expected.id)!
    expect(message.getBoundingClientRect().top - 100).toBe(expected.offset)
  }
  async function selectRun(runId: string) {
    await wrapper.findAll('.run-tab').find(tab => tab.find('.run-name').text() === `Agent ${runId}`)!.trigger('click')
    await flushPromises()
  }
  return { wrapper, container, pages, scrollTo, wheel, anchor, expectAnchor, selectRun, tails, growTail: (growth: number) => { tailGrowth = growth } }
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listener = undefined
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('SubAgentMonitor 历史上翻分页', () => {
  test('上翻到入口附近自动取上一页；滚动、滚轮和按钮共享 inflight 去重', async () => {
    const view = await mountMonitor()
    expect(view.pages).toHaveLength(0)
    const initialWindowRequests = bridge.send.mock.calls.filter(([type]) => type === MESSAGE_NAMES['subagents.monitor.getRunWindow'])
    expect(initialWindowRequests).toHaveLength(1)
    expect(initialWindowRequests[0][1].runId).toBe('a') // manifest 默认排序首项 b 不应产生过渡请求
    expect(view.wrapper.find('.load-older-btn').exists()).toBe(true)
    view.scrollTo(500) // 入口仍在视口上方很远
    expect(view.pages).toHaveLength(0)
    view.scrollTo(200)
    expect(view.pages).toHaveLength(1)
    expect(view.pages[0]).toMatchObject({ runId: 'a', options: { limit: 20, endIndex: 40 } })
    await flushPromises()
    expect(view.wrapper.get('.load-older-btn').attributes('disabled')).toBeDefined()
    await view.wrapper.get('.load-older-btn').trigger('click')
    view.scrollTo(0)
    view.wheel(-100)
    view.wheel(-100)
    expect(view.pages).toHaveLength(1)
    const anchor = view.anchor()
    view.pages[0].resolve({ window: makeWindow('a', 20, 40) })
    await flushPromises()
    expect(view.wrapper.findAll('.message-item')).toHaveLength(40)
    view.expectAnchor(anchor)
    expect(view.wrapper.get('.load-older-btn').attributes('disabled')).toBeUndefined()
    view.container.dispatchEvent(new Event('scroll')) // prepend 产生的程序滚动，不应连续追读
    await flushPromises()
    expect(view.pages).toHaveLength(1)
    view.scrollTo(200)
    expect(view.pages[1]).toMatchObject({ runId: 'a', options: { limit: 20, endIndex: 20 } })
    view.pages[1].resolve({ window: makeWindow('a', 0, 20) })
    await flushPromises()
    expect(view.wrapper.find('.load-older-btn').exists()).toBe(false)
    view.scrollTo(0)
    view.wheel(-100)
    expect(view.pages).toHaveLength(2)
  })

  test('没有更早消息时上滚/滚轮不请求', async () => {
    const view = await mountMonitor({ hasMore: false })
    view.scrollTo(0)
    view.wheel(-100)
    expect(view.pages).toHaveLength(0)
    expect(view.wrapper.find('.load-older-btn').exists()).toBe(false)
  })

  test('初始不足一屏不主动扫完整历史；向上滚轮每次最多补一页，即使该页没有可见消息', async () => {
    const view = await mountMonitor({ height: 3000 })
    view.scrollTo(0)
    view.wheel(100)
    await flushPromises()
    expect(view.pages).toHaveLength(0)
    view.wheel(-100)
    expect(view.pages).toHaveLength(1)
    const hiddenPage = makeWindow('a', 20, 40)
    hiddenPage.contents.forEach(content => { content.isFunctionResponse = true })
    view.pages[0].resolve({ window: hiddenPage })
    await flushPromises()
    view.container.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(view.wrapper.findAll('.message-item')).toHaveLength(20)
    expect(view.pages).toHaveLength(1)
    await view.wrapper.get('.load-older-btn').trigger('click') // 手动兜底仍可用
    expect(view.pages[1].options.endIndex).toBe(20)
  })

  test('响应前继续阅读并有尾部增长时，保留响应当下的消息锚点；最后一页隐藏入口也不跳动', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    view.scrollTo(350) // 等待期间下读，仍不在底部
    const anchor = view.anchor()
    view.growTail(640) // 并发流式增长位于锚点之后，不能作为 prepend 高度补偿
    view.pages[0].resolve({ window: makeWindow('a', 0, 40) })
    await flushPromises()
    view.expectAnchor(anchor)
    expect(view.wrapper.find('.load-older-btn').exists()).toBe(false)
    expect(view.container.scrollTop).toBe(350 + 40 * 80 - 60) // 顶部 note + 按钮移除
  })

  test('切换 run 后旧分页迟到不串 run、不恢复旧锚点，也不释放新 run 的 inflight', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    await view.selectRun('b')
    view.scrollTo(200)
    expect(view.pages.map(page => page.runId)).toEqual(['a', 'b'])
    const anchor = view.anchor()
    const position = view.container.scrollTop
    view.pages[0].resolve({ window: makeWindow('a', 20, 40) })
    await flushPromises()
    expect(view.container.scrollTop).toBe(position)
    expect(view.wrapper.findAll('.message-item')).toHaveLength(20)
    expect(view.wrapper.find('.message-item').attributes('data-message-id')).toBe('b_40')
    expect(view.wrapper.get('.load-older-btn').attributes('disabled')).toBeDefined()
    view.pages[1].resolve({ window: makeWindow('b', 20, 40) })
    await flushPromises()
    view.expectAnchor(anchor)
    expect(view.wrapper.findAll('.message-item')).toHaveLength(40)
  })

  test('切走再切回同一个 run 也丢弃旧视图请求，且在旧请求结算前不重复发送', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    await view.selectRun('b')
    await view.selectRun('a')
    view.scrollTo(200)
    expect(view.pages).toHaveLength(1)
    view.pages[0].resolve({ window: makeWindow('a', 20, 40) })
    await flushPromises()
    expect(view.wrapper.findAll('.message-item')).toHaveLength(20)
    expect(view.container.scrollTop).toBe(200)
    await view.wrapper.get('.load-older-btn').trigger('click')
    expect(view.pages[1].options.endIndex).toBe(40)
  })

  test('失败不自动重试，保留手动重试；离开 run 后迟到错误不提示到新 run', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    view.pages[0].reject(new Error('history unavailable'))
    await flushPromises()
    expect(view.wrapper.get('.control-notice').text()).toContain('history unavailable')
    view.container.dispatchEvent(new Event('scroll'))
    expect(view.pages).toHaveLength(1)
    await view.wrapper.get('.load-older-btn').trigger('click')
    expect(view.pages).toHaveLength(2)
    await view.selectRun('b')
    view.pages[1].reject(new Error('late error from a'))
    await flushPromises()
    expect(view.wrapper.text()).not.toContain('late error from a')
  })

  test('尾部更新已排队的贴底，在用户上翻后不夺走阅读位置', async () => {
    const view = await mountMonitor()
    const updated = makeWindow('a', 40, 61, 61)
    updated.contentRevision = 2
    view.tails.set('a', updated)
    bridge.listener?.({
      type: 'subagentMonitor.event',
      data: {
        manifest: { runId: 'a', contentCount: 61, contentRevision: 2 },
        event: { runId: 'a', type: 'content_snapshot', timestamp: 3000 },
        activeRunIds: []
      }
    })
    await Promise.resolve() // 尾部请求先写 state，Vue 的贴底 watcher 随后才刷新
    await nextTick(() => view.scrollTo(200))
    await flushPromises()
    expect(view.container.scrollTop).toBe(200)
    expect(view.pages).toHaveLength(1)
  })

  test('不匹配的 run 响应不能前置进任何窗口或改变阅读位置', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    view.pages[0].resolve({ window: makeWindow('b', 20, 40) })
    await flushPromises()
    expect(view.wrapper.findAll('.message-item')).toHaveLength(20)
    expect(view.container.scrollTop).toBe(200)
    await view.selectRun('b')
    expect(view.wrapper.find('.message-item').attributes('data-message-id')).toBe('b_40')
  })

  test('monitorReady 尚未返回时卸载，不再启动窗口请求', async () => {
    let resolveReady!: (value: unknown) => void
    bridge.send.mockReturnValue(new Promise(resolve => { resolveReady = resolve }))
    const wrapper = mount(SubAgentMonitor)
    wrappers.push(wrapper)
    wrapper.unmount()
    resolveReady({ manifests: [{ runId: 'a' }], focusRunId: 'a', activeRunIds: [] })
    await flushPromises()
    expect(bridge.send).toHaveBeenCalledTimes(1)
    expect(bridge.send.mock.calls[0][0]).toBe(MESSAGE_NAMES['subagents.monitorReady'])
  })

  test('卸载移除监听，迟到响应不再修改 DOM、恢复锚点或请求下一页', async () => {
    const view = await mountMonitor()
    view.scrollTo(200)
    const oldText = view.container.textContent
    const position = view.container.scrollTop
    view.wrapper.unmount()
    expect(bridge.dispose).toHaveBeenCalledOnce()
    view.pages[0].resolve({ window: makeWindow('a', 20, 40) })
    await flushPromises()
    expect(view.container.textContent).toBe(oldText)
    expect(view.container.scrollTop).toBe(position)
    view.container.dispatchEvent(new Event('scroll'))
    view.wheel(-100)
    expect(view.pages).toHaveLength(1)
  })
})
