/**
 * Splash 组件状态机测试（fake timers + jsdom matchMedia 打桩）
 *
 * jsdom 未实现 window.matchMedia，而 Splash 在 setup 阶段即调用
 * prefersReducedMotion()，因此每个用例挂载前都需要打桩。
 *
 * 覆盖：
 * - ready 早到仍需等最短展示时长（minDisplayMs）
 * - drawDone 前不淡出（即使 ready 且已过最短时长）
 * - done 只触发一次
 * - 卸载清理定时器：不再触发 done
 * - ready 未到时保持展示，ready 到达后才淡出
 * - ready 后两拍退场：先归一（merged，350ms）再淡出（leaving，350ms）
 * - reduced-motion：无 50ms 静态等待；ready 后按最短时长直接 done（跳过 350ms 淡出）
 * - SVG 装饰性图：保留 aria-hidden、无 role（避免与 aria-hidden 矛盾）
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import Splash from '../../components/Splash.vue'

/** drawDone 完成时刻（与 Splash.vue DRAW_TOTAL_MS 一致） */
const DRAW_TOTAL_MS = 1800
/** 格雷码线完整播完一轮的时刻（与 Splash.vue GRAY_LINE_DELAY + GRAY_LINE_PERIOD 一致） */
const GRAY_LINE_END_MS = 1650
/** 淡出门槛：ready 后需 drawDone 完成且格雷码线播完一轮（两者取晚） */
const FADE_GATE_MS = Math.max(DRAW_TOTAL_MS, GRAY_LINE_END_MS)
/** 归一演出时长（与 Splash.vue MERGE_MS 一致） */
const MERGE_MS = 350
/** 淡出时长（与 Splash.vue FADE_MS 一致） */
const FADE_MS = 350

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(1_000_000)
  stubMatchMedia(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Splash 状态机', () => {
  test('ready 早到也需等最短展示时长', async () => {
    const wrapper = mount(Splash, { props: { ready: true, minDisplayMs: 5000 } })

    // drawDone 在 1800ms 才完成，此前不淡出
    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(wrapper.classes()).not.toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined()

    // drawDone(1800) 后仍需等 minDisplayMs：5000ms 处进入归一（两拍退场第一拍）
    vi.advanceTimersByTime(3000) // t = 5000ms（相对挂载）
    await nextTick()
    expect(wrapper.classes()).toContain('merged')
    expect(wrapper.classes()).not.toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined() // 归一中，未淡出

    vi.advanceTimersByTime(MERGE_MS) // 归一结束 → 开始淡出
    await nextTick()
    expect(wrapper.classes()).toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined() // 淡出中，350ms 后才 done

    vi.advanceTimersByTime(FADE_MS)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  test('drawDone 前不淡出（即使 ready 且已过最短时长）', async () => {
    const wrapper = mount(Splash, { props: { ready: true, minDisplayMs: 0 } })

    vi.advanceTimersByTime(1000) // 已过最短时长，但 drawDone 未完成
    await nextTick()
    expect(wrapper.classes()).not.toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined()

    vi.advanceTimersByTime(GRAY_LINE_END_MS - 1000) // 格雷码线已播完一轮，但 drawDone 未完成
    await nextTick()
    expect(wrapper.classes()).not.toContain('merged')
    expect(wrapper.classes()).not.toContain('leaving')

    vi.advanceTimersByTime(FADE_GATE_MS - GRAY_LINE_END_MS) // drawDone 完成 → 进入归一（第一拍）
    await nextTick()
    expect(wrapper.classes()).toContain('merged')
    expect(wrapper.classes()).not.toContain('leaving')

    vi.advanceTimersByTime(MERGE_MS) // 归一结束 → 开始淡出（第二拍）
    await nextTick()
    expect(wrapper.classes()).toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined()

    vi.advanceTimersByTime(FADE_MS)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  test('done 只触发一次', () => {
    const wrapper = mount(Splash, { props: { ready: true, minDisplayMs: 0 } })

    vi.advanceTimersByTime(FADE_GATE_MS + MERGE_MS + FADE_MS)
    expect(wrapper.emitted('done')).toHaveLength(1)

    vi.advanceTimersByTime(5000)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  test('卸载清理定时器：不再触发 done', () => {
    const wrapper = mount(Splash, { props: { ready: true } })
    wrapper.unmount()

    vi.advanceTimersByTime(10_000)
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  test('ready 未到时保持展示，ready 到达后才淡出', async () => {
    const wrapper = mount(Splash, { props: { ready: false, minDisplayMs: 100 } })

    vi.advanceTimersByTime(FADE_GATE_MS + 100) // 已过 drawDone、最短时长与格雷码一轮
    expect(wrapper.classes()).not.toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined()

    await wrapper.setProps({ ready: true })
    // 已过全部门槛 → 直接进入归一（第一拍）
    expect(wrapper.classes()).toContain('merged')
    expect(wrapper.classes()).not.toContain('leaving')

    vi.advanceTimersByTime(MERGE_MS) // 归一结束 → 开始淡出
    await nextTick()
    expect(wrapper.classes()).toContain('leaving')

    vi.advanceTimersByTime(FADE_MS)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  test('reduced-motion：无 50ms 静态等待，按最短时长直接 done（跳过淡出）', () => {
    stubMatchMedia(true)
    const wrapper = mount(Splash, { props: { ready: true, minDisplayMs: 1000 } })

    // drawDone 同步完成（无 50ms 等待）；未达最短时长前不淡出
    vi.advanceTimersByTime(999)
    expect(wrapper.classes()).not.toContain('leaving')
    expect(wrapper.emitted('done')).toBeUndefined()

    vi.advanceTimersByTime(1) // 达最短时长 → beginFadeOut → reducedMotion → finish（同步）
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  test('reduced-motion + ready + minDisplayMs=0：挂载即 done（同步）', () => {
    stubMatchMedia(true)
    const wrapper = mount(Splash, { props: { ready: true, minDisplayMs: 0 } })
    expect(wrapper.emitted('done')).toHaveLength(1)
  })
})

describe('Splash 可访问性', () => {
  test('SVG 装饰性图：保留 aria-hidden、无 role（与 aria-hidden 不矛盾）', () => {
    const wrapper = mount(Splash)
    const svg = wrapper.get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('role')).toBeUndefined()
  })
})
