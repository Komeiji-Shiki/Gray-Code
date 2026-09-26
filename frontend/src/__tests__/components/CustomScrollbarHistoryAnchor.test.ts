import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CustomScrollbar from '../../components/common/CustomScrollbar.vue'

async function frame() { await nextTick(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) }
afterEach(() => { vi.unstubAllGlobals() })

describe('CustomScrollbar 与历史锚点/异步高度协作', () => {
  test('流式裁顶的浏览器原生锚定和迟到同位置 scroll 不是用户滚离', async () => {
    const wrapper = mount(CustomScrollbar, {
      props: { stickyBottom: true, virtualTotal: 1000, virtualStart: 960, virtualEnd: 1000 },
      slots: { default: '<div>tail</div>' }
    })
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 500 }, clientHeight: { value: 100 }
    })
    container.scrollTop = 400
    container.dispatchEvent(new Event('scroll'))
    // 新消息进入、顶部裁一行：Chrome 先执行自身 scroll anchoring，把当前位置向上移。
    await wrapper.setProps({ virtualStart: 961, virtualEnd: 1001, virtualTotal: 1001 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 800 })
    container.scrollTop = 310
    container.dispatchEvent(new Event('scroll'))
    await frame()
    expect(container.scrollTop).toBe(700)
    // 文本/Markdown 在程序 scroll 事件之前继续增长；相同位置多次事件不能丢吸底。
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 950 })
    container.dispatchEvent(new Event('scroll'))
    container.dispatchEvent(new Event('scroll'))
    container.append(document.createElement('div'))
    await frame()
    expect(container.scrollTop).toBe(850)
    expect(wrapper.vm.isFollowingBottom()).toBe(true)
    // 明确的用户上滚仍优先于布局补偿。
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 })
    container.scrollTop = 750
    container.dispatchEvent(new Event('scroll'))
    container.append(document.createElement('div'))
    await frame()
    expect(container.scrollTop).toBe(750)
    expect(wrapper.vm.isFollowingBottom()).toBe(false)
    wrapper.unmount()
  })

  test('历史窗口前移后，旧的贴底状态不能在 mutation 帧把锚点拉到局部底部', async () => {
    const wrapper = mount(CustomScrollbar, {
      props: { stickyBottom: true, virtualTotal: 1000, virtualStart: 800, virtualEnd: 1000 },
      slots: { default: '<div>history</div>' }
    })
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 }
    })
    container.scrollTop = 800
    container.dispatchEvent(new Event('scroll'))
    await wrapper.setProps({ virtualStart: 760, virtualEnd: 960 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1400 })
    container.append(document.createElement('div'))
    await frame()
    expect(container.scrollTop).toBe(800)
    wrapper.vm.pauseBottomFollow()
    wrapper.vm.scrollToPosition(300)
    container.dispatchEvent(new Event('scroll'))
    container.append(document.createElement('div'))
    await frame()
    expect(container.scrollTop).toBe(300)
    expect(wrapper.vm.isFollowingBottom()).toBe(false)
    wrapper.unmount()
  })

  test('图片/折叠与外部任务条高度变化也跟随；用户离底后保持位置，同尺寸不反复写 scrollTop', async () => {
    const observed: Element[] = []
    let onResize!: ResizeObserverCallback
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { onResize = callback }
      observe(element: Element) { observed.push(element) }
      disconnect() {}
    })
    const wrapper = mount(CustomScrollbar, { props: { stickyBottom: true }, slots: { default: '<div class="content">image</div>' } })
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    let height = 500
    let viewport = 100
    let top = 400
    const writes: number[] = []
    Object.defineProperties(container, {
      scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
      scrollTop: { get: () => top, set: (value: number) => { top = value; writes.push(value) } }
    })
    container.dispatchEvent(new Event('scroll'))
    expect(observed).toContain(container)
    expect(observed).toContain(wrapper.get('.content').element)
    height = 900 // 图片尺寸就绪，没有文本或子节点 mutation
    onResize([], {} as ResizeObserver)
    await frame()
    expect(top).toBe(800)
    container.dispatchEvent(new Event('scroll'))
    for (let i = 0; i < 20; i++) onResize([], {} as ResizeObserver)
    await frame()
    expect(writes).toEqual([800])
    viewport = 200 // 任务条缩短，视口长高
    onResize([], {} as ResizeObserver)
    await frame()
    expect(top).toBe(700)
    height = 500 // 内容折叠
    onResize([], {} as ResizeObserver)
    await frame()
    expect(top).toBe(300)
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
    top = 80
    container.dispatchEvent(new Event('scroll'))
    height = 1200
    onResize([], {} as ResizeObserver)
    await frame()
    expect(top).toBe(80)
    wrapper.unmount()
  })
})
