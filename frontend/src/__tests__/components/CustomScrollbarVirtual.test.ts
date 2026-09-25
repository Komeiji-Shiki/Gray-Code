import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CustomScrollbar from '../../components/common/CustomScrollbar.vue'

describe('CustomScrollbar virtual message track', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('全局 marker 点击与拖动都发出绝对消息索引', async () => {
    const wrapper = mount(CustomScrollbar, {
      attachTo: document.body,
      props: {
        markerSelector: '.user-message',
        virtualTotal: 1000,
        virtualStart: 800,
        virtualEnd: 1000,
        virtualMarkers: [
          { index: 100, preview: 'older' },
          { index: 900, preview: 'current' }
        ]
      },
      slots: { default: '<div class="user-message">current</div>' }
    })

    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    const track = wrapper.get('.scroll-track-v').element as HTMLElement
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(track, 'clientHeight', { configurable: true, value: 100 })
    ;(wrapper.vm as any).update()
    ;(wrapper.vm as any).updateMarkers()
    await nextTick()

    const markers = wrapper.findAll('.scroll-marker')
    expect(markers).toHaveLength(2)
    await markers[0].trigger('click')
    expect(wrapper.emitted('seek')?.[0]).toEqual([100])

    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 100, left: 0, right: 10, width: 10, height: 100,
      x: 0, y: 0, toJSON: () => ({})
    })
    await wrapper.get('.scroll-track-v').trigger('click', { clientY: 50 })
    expect(wrapper.emitted('seek')?.[1]?.[0]).toEqual(expect.any(Number))

    const thumb = wrapper.get('.scroll-thumb-v')
    await thumb.trigger('mousedown', { clientY: 0 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 40 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    const seeks = wrapper.emitted('seek') || []
    expect(seeks.length).toBeGreaterThanOrEqual(2)
    expect(seeks.at(-1)?.[0]).toEqual(expect.any(Number))
    expect(Number(seeks.at(-1)?.[0])).toBeGreaterThan(0)
    wrapper.unmount()
  })
})

/**
 * 虚拟窗口长消息下的滚动几何（回归）。
 *
 * 旧实现用「全局行号 × 估算行高 + 真实 scrollTop」估算窗口在整段历史中的像素位置，
 * 而真实内容高度与「行数 × 96px」无关：长消息（长思考）下估算总高度远小于真实高度，
 * 估算值被钳制在 maxScrollTop。后果是窗口尾部一大段范围内滑块钉在底部不动，
 * 距底距离也被算成 0 而误判「仍在贴底」，内容继续增长时把用户拉回底部。
 */
describe('CustomScrollbar 虚拟窗口长消息的滚动几何', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function raf(): Promise<void> {
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }

  /** 尾部窗口（800..1000 行）+ 真实内容 30000px 的容器（视口 500px） */
  async function mountTallTail() {
    const wrapper = mount(CustomScrollbar, {
      attachTo: document.body,
      props: { stickyBottom: true, stickyThreshold: 50, virtualTotal: 1000, virtualStart: 800, virtualEnd: 1000 },
      slots: { default: '<div class="item">tail</div>' }
    })
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 30000 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 500 })
    const track = wrapper.get('.scroll-track-v').element as HTMLElement
    Object.defineProperty(track, 'clientHeight', { configurable: true, value: 100 })
    ;(wrapper.vm as any).update()
    await nextTick()
    return { wrapper, container }
  }

  /** jsdom 设置 scrollTop 不会自动派发 scroll 事件，手动派发后按 rAF 合帧 */
  async function scrollTo(container: HTMLElement, top: number): Promise<void> {
    container.scrollTop = top
    container.dispatchEvent(new Event('scroll'))
    await nextTick()
    await raf()
  }

  function thumbTop(wrapper: { get: (selector: string) => { element: HTMLElement } }): number {
    const matched = /translateY\(([-\d.]+)px\)/.exec(wrapper.get('.scroll-thumb-v').element.style.transform)
    return matched ? Number(matched[1]) : Number.NaN
  }

  test('窗口尾部滚离底部后内容继续增长不拉回', async () => {
    const { wrapper, container } = await mountTallTail()
    // 用户从底部（29500）向上滚到窗口中部
    await scrollTo(container, 25000)
    expect(container.scrollTop).toBe(25000)

    // 长思考继续输出：真实内容变高
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 32000 })
    container.appendChild(document.createElement('div'))
    await nextTick()
    await raf()

    expect(container.scrollTop).toBe(25000)
    wrapper.unmount()
  })

  test('窗口内上滚时滑块随之移动，不会被估算高度铑制在底部', async () => {
    const { wrapper, container } = await mountTallTail()
    await scrollTo(container, 29500)
    const atBottom = thumbTop(wrapper)

    await scrollTo(container, 25000)
    const scrolled = thumbTop(wrapper)

    expect(Number.isFinite(atBottom)).toBe(true)
    expect(scrolled).toBeLessThan(atBottom)
    wrapper.unmount()
  })
})
