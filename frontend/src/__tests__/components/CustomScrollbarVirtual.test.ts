import { afterEach, describe, expect, test } from 'vitest'
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
