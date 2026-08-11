import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { SmoothStreamer, SMOOTH_PRESETS } from '../../utils/smoothStream'

interface Commit {
  graphemes: string[]
  frameDurMs: number
  instant: boolean
}

function collect() {
  const commits: Commit[] = []
  return {
    commits,
    onCommit: (graphemes: string[], frameDurMs: number, instant: boolean) =>
      commits.push({ graphemes, frameDurMs, instant })
  }
}

const joined = (commits: Commit[]) => commits.map((c) => c.graphemes.join('')).join('')

describe('SmoothStreamer', () => {
  test('flush outputs the entire backlog synchronously with instant=true (no tail loss)', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('hello world')
    s.flush()
    expect(joined(commits)).toBe('hello world')
    expect(commits.every((c) => c.instant)).toBe(true)
  })

  test('flush on empty queue emits nothing', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit)
    s.flush()
    expect(commits).toEqual([])
  })

  test('switchPart flushes previous segment then starts fresh', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('abc')
    s.switchPart()
    s.push('def')
    s.flush()
    expect(joined(commits)).toBe('abcdef')
  })

  test('panic fast-forwards excess backlog as instant commit', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10, panic: 5 })
    // 10 字符超过 panic 5：超出部分立即直通提交（instant），剩余进入匀速队列
    s.push('0123456789')
    expect(joined(commits)).toBe('01234')
    expect(commits[0].instant).toBe(true)
    s.flush()
    expect(joined(commits)).toBe('0123456789')
  })

  test('dispose clears internal state without emitting', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('abc')
    s.dispose()
    expect(commits).toEqual([])
  })

  test('presets expose ordered lookahead tiers', () => {
    expect(SMOOTH_PRESETS.smooth.lookahead).toBeLessThan(SMOOTH_PRESETS.balanced.lookahead)
    expect(SMOOTH_PRESETS.balanced.lookahead).toBeLessThan(SMOOTH_PRESETS.silky.lookahead)
  })
})

/**
 * rAF tick 路径测试。
 * 用 vitest fake timers（fake performance.now）+ mock requestAnimationFrame 手动驱动帧，
 * 帧时间戳与假时钟同步推进，验证速率累积、dt 钳 100ms、panic 快进、高帧率逐帧输出。
 */
describe('SmoothStreamer tick path (rAF)', () => {
  let scheduled: FrameRequestCallback | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] })
    scheduled = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      scheduled = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      scheduled = null
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** 推进假时钟 dtMs 并执行一帧（tick 时间戳 = 当前假时钟，保证单调） */
  function frame(dtMs: number): void {
    vi.advanceTimersByTime(dtMs)
    const cb = scheduled
    scheduled = null
    cb?.(performance.now())
  }

  test('速率累积：每秒放字数按积压自适应，逐帧匀速输出（30 字符 3 帧放完）', () => {
    const { commits, onCommit } = collect()
    // cps 恒为 100（min=max）：lookahead=1000ms 时每 100ms 帧输出 10 字符
    const s = new SmoothStreamer(onCommit, { minCps: 100, maxCps: 100, lookahead: 1000 })
    s.push('x'.repeat(30))
    frame(100)
    frame(100)
    frame(100)
    expect(joined(commits)).toBe('x'.repeat(30))
    expect(scheduled).toBeNull() // 积压放完不再调度
    expect(commits.every((c) => c.frameDurMs === 100)).toBe(true)
  })

  test('高帧率（180Hz 模拟）：每帧少量输出，frameDurMs 传实测 dt', () => {
    const { commits, onCommit } = collect()
    // cps 恒为 180：5.56ms 帧 → 每帧约 1 字符；20 字符约 20 帧放完
    const s = new SmoothStreamer(onCommit, { minCps: 180, maxCps: 180, lookahead: 1000 })
    s.push('x'.repeat(20))
    let frames = 0
    while (scheduled && frames < 100) {
      frame(5.56)
      frames += 1
    }
    expect(joined(commits)).toBe('x'.repeat(20))
    expect(frames).toBeGreaterThanOrEqual(18)
    expect(frames).toBeLessThanOrEqual(22)
    expect(commits[0].frameDurMs).toBeCloseTo(5.56, 1)
  })

  test('dt 钳 100ms：rAF 长时间停顿后单帧只按 100ms 计算', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 100, maxCps: 100, lookahead: 1000 })
    s.push('x'.repeat(50))
    // 10s 的帧间隔（如 webview 隐藏节流）：dt 钳到 100ms → 只放 10 字符
    frame(10000)
    expect(joined(commits)).toBe('x'.repeat(10))
    expect(scheduled).not.toBeNull() // 积压仍在，继续调度
    s.flush()
  })

  test('panic 快进：超长 chunk 超出部分同步直通提交，剩余入队按帧放完', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1000, maxCps: 1000, lookahead: 1000, panic: 5 })
    s.push('0123456789')
    expect(joined(commits)).toBe('01234') // 超出 panic 的部分立即直通提交
    expect(commits[0].instant).toBe(true)
    frame(100)
    expect(joined(commits)).toBe('0123456789')
    expect(commits[1].instant).toBe(false)
    expect(scheduled).toBeNull()
  })

  test('积压放完时队列清空、停止调度（不丢尾巴）', () => {
    const { commits, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1000, maxCps: 1000, lookahead: 1000 })
    s.push('abc')
    frame(100)
    expect(joined(commits)).toBe('abc')
    expect(scheduled).toBeNull()
  })
})
