/**
 * CharFlow 测试（jsdom + fake timers 驱动 performance.now）
 *
 * jsdom 不实现 window.matchMedia；CharFlow 的 reducedMotion 通过构造参数显式传入，
 * 默认探测路径单独用 stub 覆盖。
 */
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { CharFlow } from '../../utils/charFlow'

function makeHost(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
}

function chips(host: HTMLElement): HTMLSpanElement[] {
  return Array.from(host.querySelectorAll('span'))
}

describe('CharFlow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  test('append creates one span per grapheme with staggered animation delays', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a', 'b', 'c'], 30, false)
    const spans = chips(host)
    expect(spans.length).toBe(3)
    // 批内错峰：step = 30/3 = 10ms → delay 0 / 10 / 20（jsdom 会把数值规范化）
    expect(parseFloat(spans[0].style.animationDelay)).toBe(0)
    expect(parseFloat(spans[1].style.animationDelay)).toBe(10)
    expect(parseFloat(spans[2].style.animationDelay)).toBe(20)
    expect(spans[0].textContent).toBe('a')
    flow.dispose()
  })

  test('step is clamped to fadeMs for huge single-frame durations', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 100, reducedMotion: false })
    flow.append(['a', 'b'], 500, false)
    const spans = chips(host)
    expect(parseFloat(spans[1].style.animationDelay)).toBe(100) // min(250, 100)
    flow.dispose()
  })

  test('instant append goes straight into the settled text node (no spans)', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['h', 'i'], 16, true)
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('hi')
    flow.dispose()
  })

  test('noFade appends directly without spans (collapsed preview mode)', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true })
    flow.append(['a', 'b', 'c'], 30, false)
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('abc')
    flow.dispose()
  })

  test('squashLineBreaks converts line breaks to zero-width spaces', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true, squashLineBreaks: true })
    flow.append(['前', '段', '\n', '\n', '后', '段'], 30, false)
    expect(host.textContent).toBe('前段\u200B\u200B后段')
    flow.dispose()
  })

  test('squashLineBreaks also applies to the staggered chip path', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, squashLineBreaks: true })
    flow.append(['a', '\n', 'b'], 30, false)
    const spans = chips(host)
    expect(spans.length).toBe(3)
    expect(spans[1].textContent).toBe('\u200B')
    flow.dispose()
  })

  test('tailWindow keeps only the latest characters on append', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true, tailWindow: 4 })
    flow.append(['1', '2', '3'], 30, false)
    expect(host.textContent).toBe('123')
    flow.append(['4', '5'], 30, false)
    expect(host.textContent).toBe('2345') // 头部 1 被裁剪
    flow.dispose()
  })

  test('deferTrim delays trimming until trimNow() is called', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true, tailWindow: 4 })
    flow.append(['1', '2', '3'], 30, false, true)
    expect(host.textContent).toBe('123')
    flow.append(['4', '5'], 30, false, true)
    // deferTrim：本帧不裁剪，内容完整保留（供 promote 先剥离可提升段落）
    expect(host.textContent).toBe('12345')
    flow.trimNow()
    // trimNow 只裁无法提升的尾巴
    expect(host.textContent).toBe('2345')
    flow.dispose()
  })

  test('append without deferTrim keeps legacy immediate trimming', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true, tailWindow: 4 })
    flow.append(['1', '2', '3'], 30, false)
    flow.append(['4', '5'], 30, false)
    expect(host.textContent).toBe('2345')
    flow.dispose()
  })

  test('tailWindow trims restore and finish too', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false, noFade: true, tailWindow: 4 })
    flow.restore('abcdefgh')
    expect(host.textContent).toBe('efgh')
    flow.append(['ij'], 30, false)
    // append 超窗立即裁剪头部（保留最新字符）
    expect(host.textContent).toBe('ghij')
    flow.finish()
    expect(host.textContent).toBe('ghij')
    flow.dispose()
  })

  test('collapse merges finished chips back into the settled text node', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a', 'b', 'c'], 30, false)
    // births: now+110 / now+120 / now+130
    vi.advanceTimersByTime(125) // 前两个 chip 播完
    flow.append(['d'], 30, false) // 下次 append 先 collapse
    // settled 文本节点（host 首位）回收了 a、b；textContent 整体含仍在动画的 span 文本
    expect(host.firstChild?.textContent).toBe('ab')
    const spans = chips(host)
    expect(spans.length).toBe(2) // c + d 仍在动画中
    expect(spans[0].textContent).toBe('c')
    expect(spans[1].textContent).toBe('d')
    flow.dispose()
  })

  test('finish settles everything and leaves no spans', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a', 'b'], 30, false)
    flow.append(['c'], 30, false)
    flow.finish()
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('abc')
    flow.dispose()
  })

  test('idle reflects pending animation state', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    expect(flow.idle()).toBe(true)
    flow.append(['a'], 30, false)
    expect(flow.idle()).toBe(false)
    vi.advanceTimersByTime(120)
    flow.finish()
    expect(flow.idle()).toBe(true)
    flow.dispose()
  })

  test('restore clears existing content and writes settled text directly', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a'], 30, false)
    flow.restore('XYZ')
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('XYZ')
    flow.dispose()
  })

  test('reduced-motion appends directly without spans', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: true })
    flow.append(['a', 'b'], 30, false)
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('ab')
    flow.dispose()
  })

  test('detects reduced motion from matchMedia by default', () => {
    stubMatchMedia(true)
    const host = makeHost()
    const flow = new CharFlow(host)
    flow.append(['a'], 30, false)
    expect(chips(host).length).toBe(0)
    expect(host.textContent).toBe('a')
    flow.dispose()
  })

  test('dispose clears the host entirely', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a'], 30, false)
    flow.append(['b'], 30, false)
    flow.dispose()
    expect(host.textContent).toBe('')
    expect(chips(host).length).toBe(0)
    // dispose 后 append 为 no-op
    flow.append(['c'], 30, false)
    expect(host.textContent).toBe('')
  })

  test('followEnd keeps a single-line preview scrolled to the latest character', () => {
    const host = makeHost()
    Object.defineProperty(host, 'scrollWidth', { configurable: true, value: 240 })
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: true, followEnd: true })

    flow.append(['a', 'b'], 30, false)
    expect(host.scrollLeft).toBe(240)

    host.scrollLeft = 0
    flow.restore('latest')
    expect(host.scrollLeft).toBe(240)
    flow.dispose()
  })

  test('host gets the char-flow class (white-space: pre-wrap)', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    expect(host.classList.contains('char-flow')).toBe(true)
    flow.dispose()
  })

  test('settledText returns the settled prefix (animated chips excluded)', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.append(['a', 'b'], 30, false) // 全在动画中
    expect(flow.settledText).toBe('')
    // births = [now+110, now+125]：130ms 后全部播完
    vi.advanceTimersByTime(130)
    flow.append(['c'], 30, false) // 下次 append 先 collapse：a、b 播完并入 settled
    expect(flow.settledText).toBe('ab')
    flow.dispose()
  })

  test('promote strips a prefix from settled text and returns it', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.restore('para one\n\npara two\n\npara three')
    expect(flow.promote(20)).toBe('para one\n\npara two\n\n')
    expect(flow.settledText).toBe('para three')
    // 超过当前长度的 promote 只剥离现有前缀
    expect(flow.promote(999)).toBe('para three')
    expect(flow.settledText).toBe('')
    flow.dispose()
  })

  test('promoteWithBridge keeps promoted prefixes visible until each bridge is released', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.restore('first\nsecond\ntail')

    const first = flow.promoteWithBridge('first\n'.length)
    const second = flow.promoteWithBridge('second\n'.length)
    expect(first?.text).toBe('first\n')
    expect(second?.text).toBe('second\n')
    expect(flow.settledText).toBe('tail')
    expect(host.textContent).toBe('first\nsecond\ntail')

    first?.release()
    first?.release() // release 必须幂等
    expect(host.textContent).toBe('second\ntail')
    second?.release()
    expect(host.textContent).toBe('tail')

    flow.dispose()
    second?.release() // dispose 后晚到 ack 也是 no-op
  })

  test('promote after dispose and non-positive n are no-ops', () => {
    const host = makeHost()
    const flow = new CharFlow(host, { fadeMs: 110, reducedMotion: false })
    flow.restore('abc')
    expect(flow.promote(0)).toBe('')
    expect(flow.promote(-1)).toBe('')
    flow.dispose()
    expect(flow.promote(1)).toBe('')
  })
})
