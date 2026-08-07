import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import CustomScrollbar from '../../components/common/CustomScrollbar.vue'

/**
 * CustomScrollbar sticky-bottom 回归测试。
 *
 * 覆盖两个核心缺陷：
 * 1. 用户滚离底部后，同帧稍后执行的 updateLayout 读到陈旧 wasAtBottom 把用户拉回
 *    （scroll 事件必须同步更新吸底状态，不能等 rAF 合帧）；
 * 2. 程序贴底写入后 scrollHeight 继续增长（大段输出/md 异步解析），scroll 事件
 *    实时复验误判「用户滚离」→ 永久丢吸底（程序写入触发的 scroll 事件必须与
 *    用户滚动区分）。
 *
 * jsdom 不布局，scrollHeight/clientHeight 需要 stub；scroll 事件手动派发
 * （jsdom 设置 scrollTop 不会自动派发），因此时序完全可控。
 */

function raf(): Promise<void> {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

/** 内容变化（MutationObserver 微任务）→ 布局更新（rAF）的完整两拍 */
async function settleLayout(): Promise<void> {
  await nextTick()
  await raf()
}

function mountSticky() {
  return mount(CustomScrollbar, {
    props: { stickyBottom: true, stickyThreshold: 50 },
    slots: { default: '<div class="item">seed</div>' }
  })
}

describe('CustomScrollbar sticky-bottom', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('位于底部时内容增长自动贴底', async () => {
    const wrapper = mountSticky()
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
    container.scrollTop = 400 // 距底 0
    container.dispatchEvent(new Event('scroll')) // 同步记录 wasAtBottom=true
    await raf()

    // 内容增长：scrollHeight 500 → 800
    Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })
    container.appendChild(document.createElement('div'))
    await settleLayout()

    expect(container.scrollTop).toBe(700) // 800 - 100

    wrapper.unmount()
  })

  it('用户滚离底部后内容增长不再贴底（不打扰）', async () => {
    const wrapper = mountSticky()
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
    container.scrollTop = 400
    container.dispatchEvent(new Event('scroll')) // 在底部
    await raf()

    // 用户向上滚到顶部：scrollTop 变化 + scroll 事件 → wasAtBottom 同步置 false
    container.scrollTop = 0
    container.dispatchEvent(new Event('scroll'))
    await raf()

    // 内容增长但用户没动
    Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })
    container.appendChild(document.createElement('div'))
    await settleLayout()

    expect(container.scrollTop).toBe(0) // 不拉回

    wrapper.unmount()
  })

  it('贴底写入后 scrollHeight 继续增长不丢吸底（md 异步解析场景）', async () => {
    const wrapper = mountSticky()
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
    container.scrollTop = 400
    container.dispatchEvent(new Event('scroll')) // 在底部
    await raf()

    // 内容增长到 800 → updateLayout 贴底写入 scrollTop=700
    Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })
    container.appendChild(document.createElement('div'))
    await settleLayout()
    expect(container.scrollTop).toBe(700)

    // 模拟 md 异步解析：贴底写入后 scrollHeight 又涨到 1000，
    // 程序写入触发的 scroll 事件此刻才到达——必须识别为程序写入，不能误判「滚离」
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    container.dispatchEvent(new Event('scroll'))
    await raf()

    // 又一段内容增长：吸底状态必须保持（旧实现在此误判丢吸底，scrollTop 停在 700）
    Object.defineProperty(container, 'scrollHeight', { value: 1200, configurable: true })
    container.appendChild(document.createElement('div'))
    await settleLayout()
    expect(container.scrollTop).toBe(1100) // 1200 - 100

    wrapper.unmount()
  })
})
