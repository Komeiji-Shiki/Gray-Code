import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, vi } from 'vitest'
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

/** fake timers 版 rAF 等待：推进 20ms 触发 jsdom rAF（16ms 定时器实现） */
async function advanceRaf(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
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

  test('位于底部时内容增长自动贴底', async () => {
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

  test('用户滚离底部后内容增长不再贴底（不打扰）', async () => {
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

  test('贴底写入后 scrollHeight 继续增长不丢吸底（md 异步解析场景）', async () => {
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

  test('wheel 滚动后冷静期内内容增长不拉回（高 tps 抵消滚动距离）', async () => {
    const wrapper = mountSticky()
    await nextTick()
    const container = wrapper.get('.scroll-container').element as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
    container.scrollTop = 400
    container.dispatchEvent(new Event('scroll')) // 在底部
    await raf()

    // 用户滚轮向上滚动：wheel 输入事件（冷静期开始），scrollTop 同步生效；
    // scroll 事件尚未派发（浏览器异步派发滞后，updateLayout 只能看到旧 wasAtBottom）
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))
    container.scrollTop = 300

    // 高 tps：内容同步增长（scrollHeight 500 → 800），贴底目标远高于用户位置
    Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })
    container.appendChild(document.createElement('div'))
    await settleLayout()

    // 冷静期内不贴底：用户位置保持（旧实现在此用陈旧 wasAtBottom 把用户拉回 700）
    expect(container.scrollTop).toBe(300)

    wrapper.unmount()
  })

  test('冷静期过后恢复贴底', async () => {
    // 冷静期判断用 performance.now()：必须把 performance 也纳入 fake 范围
    // （默认 toFake 不含 performance，advanceTimersByTimeAsync 推不动真实时钟）
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date', 'performance']
    })
    try {
      const wrapper = mountSticky()
      await nextTick()
      const container = wrapper.get('.scroll-container').element as HTMLElement
      Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true })
      container.scrollTop = 400
      container.dispatchEvent(new Event('scroll')) // 在底部
      await advanceRaf()

      // 用户滚轮滚动：冷静期开始（wasAtBottom 保持 true，scroll 事件未派发）
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))
      container.scrollTop = 300

      // 冷静期内：内容增长不贴底
      Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })
      container.appendChild(document.createElement('div'))
      await nextTick()
      await advanceRaf()
      expect(container.scrollTop).toBe(300)

      // 冷静期过后：先推进 300ms 让冷静期过期（advanceTimersByTimeAsync 是逐步推进，
      // 过早触发的 rAF 仍会落在冷静期内），再触发新内容增长 → 恢复贴底
      await vi.advanceTimersByTimeAsync(300)
      Object.defineProperty(container, 'scrollHeight', { value: 900, configurable: true })
      container.appendChild(document.createElement('div'))
      await nextTick()
      await advanceRaf()
      expect(container.scrollTop).toBe(800) // 900 - 100

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
