import { describe, expect, it } from 'vitest'
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
