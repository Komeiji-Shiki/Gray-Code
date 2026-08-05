import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SmoothStreamer, SMOOTH_PRESETS } from '../../utils/smoothStream'

function collect() {
  const parts: string[] = []
  return {
    parts,
    onCommit: (delta: string) => parts.push(delta)
  }
}

describe('SmoothStreamer', () => {
  it('flush outputs the entire backlog synchronously (no tail loss)', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('hello world')
    s.flush()
    expect(parts.join('')).toBe('hello world')
  })

  it('flush on empty queue emits nothing', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit)
    s.flush()
    expect(parts).toEqual([])
  })

  it('switchPart flushes previous segment then starts fresh', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('abc')
    s.switchPart()
    s.push('def')
    s.flush()
    expect(parts.join('')).toBe('abcdef')
  })

  it('panic fast-forwards excess backlog instead of bursting later', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10, panic: 5 })
    // 10 字符超过 panic 5：超出部分立即提交（快进），剩余进入匀速队列
    s.push('0123456789')
    expect(parts.join('')).toBe('01234')
    s.flush()
    expect(parts.join('')).toBe('0123456789')
  })

  it('dispose clears internal state without emitting', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1, maxCps: 10 })
    s.push('abc')
    s.dispose()
    expect(parts).toEqual([])
  })

  it('presets expose ordered lookahead tiers', () => {
    expect(SMOOTH_PRESETS.smooth.lookahead).toBeLessThan(SMOOTH_PRESETS.balanced.lookahead)
    expect(SMOOTH_PRESETS.balanced.lookahead).toBeLessThan(SMOOTH_PRESETS.silky.lookahead)
  })
})

/**
 * M4：rAF tick 路径测试（此前零覆盖）。
 * 用 vitest fake timers（fake performance.now）+ mock requestAnimationFrame 手动驱动帧，
 * 帧时间戳与假时钟同步推进，验证速率累积、commitIntervalMs 批量、dt 钳 100ms、panic 快进。
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

  it('速率累积：每秒放字数按积压自适应，逐帧匀速输出（30 字符 3 帧放完）', () => {
    const { parts, onCommit } = collect()
    // cps 恒为 100（min=max）：lookahead=1000ms 时每 100ms 帧输出 10 字符
    const s = new SmoothStreamer(onCommit, { minCps: 100, maxCps: 100, lookahead: 1000, commitIntervalMs: 0 })
    s.push('x'.repeat(30))
    frame(100)
    frame(100)
    frame(100)
    expect(parts.join('')).toBe('x'.repeat(30))
    expect(scheduled).toBeNull() // 积压放完不再调度
  })

  it('commitIntervalMs 批量：间隔内多次 drain 合并为一次 commit', () => {
    const { parts, onCommit } = collect()
    // cps 恒为 10：每帧放 1 字符；commitIntervalMs=1000 → 每 10 帧合并提交 10 字符
    const s = new SmoothStreamer(onCommit, { minCps: 10, maxCps: 10, lookahead: 1000, commitIntervalMs: 1000 })
    s.push('x'.repeat(30))
    for (let i = 0; i < 30; i++) frame(100)
    expect(parts.length).toBe(3) // 三次批量提交（10 字符/批）
    expect(parts[0]).toBe('x'.repeat(10))
    expect(parts.join('')).toBe('x'.repeat(30))
  })

  it('dt 钳 100ms：rAF 长时间停顿后单帧只按 100ms 计算', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 100, maxCps: 100, lookahead: 1000, commitIntervalMs: 0 })
    s.push('x'.repeat(50))
    // 10s 的帧间隔（如 webview 隐藏节流）：dt 钳到 100ms → 只放 10 字符
    frame(10000)
    expect(parts.join('')).toBe('x'.repeat(10))
    expect(scheduled).not.toBeNull() // 积压仍在，继续调度
    s.flush()
  })

  it('panic 快进：超长 chunk 超出部分同步提交，剩余入队按帧放完', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1000, maxCps: 1000, lookahead: 1000, panic: 5, commitIntervalMs: 0 })
    s.push('0123456789')
    expect(parts.join('')).toBe('01234') // 超出 panic 的部分立即快进提交
    frame(100)
    expect(parts.join('')).toBe('0123456789')
    expect(scheduled).toBeNull()
  })

  it('积压放完时未提交尾巴立即强制提交（不挂到下一次 push/flush）', () => {
    const { parts, onCommit } = collect()
    const s = new SmoothStreamer(onCommit, { minCps: 1000, maxCps: 1000, lookahead: 1000, commitIntervalMs: 1000 })
    s.push('abc')
    frame(100) // 100ms 内全部放完，但距上次 commit 不足 1000ms → 普通提交被跳过
    expect(parts.join('')).toBe('abc') // 队列清空时尾巴强制提交
    expect(scheduled).toBeNull()
  })
})
