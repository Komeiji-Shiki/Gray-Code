import { describe, expect, it, beforeEach } from 'vitest'
import {
  pushSmoothText,
  finishSmoothStream,
  hasSmoothStream,
  disposeAllSmoothStreams
} from '../../stores/chat/smoothStreamManager'

describe('smoothStreamManager', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
  })

  it('keeps one streamer per message id and flushes all on finish', () => {
    const committed: string[] = []
    pushSmoothText('m1', 'text:0', 'hello ', 'balanced', (t) => committed.push(t))
    pushSmoothText('m1', 'text:0', 'world', 'balanced', (t) => committed.push(t))
    expect(hasSmoothStream('m1')).toBe(true)
    // 同一 partKey 复用同一 streamer；finish 时 flush 输出全部积压（不丢尾巴）
    finishSmoothStream('m1')
    expect(committed.join('')).toBe('hello world')
    expect(hasSmoothStream('m1')).toBe(false)
  })

  it('switchPart flushes the previous segment before starting a new one', () => {
    const committed: string[] = []
    pushSmoothText('m1', 'thought:0', 'thinking ', 'balanced', (t) => committed.push(t))
    // partKey 变化（thought → text）：上一段积压立即输出，新段落从空开始
    pushSmoothText('m1', 'text:1', 'answer', 'balanced', (t) => committed.push(t))
    finishSmoothStream('m1')
    expect(committed.join('')).toBe('thinking answer')
  })

  it('separate messages have isolated streamers', () => {
    const a: string[] = []
    const b: string[] = []
    pushSmoothText('m1', 'text:0', 'AAA', 'balanced', (t) => a.push(t))
    pushSmoothText('m2', 'text:0', 'BBB', 'balanced', (t) => b.push(t))
    finishSmoothStream('m1')
    expect(a.join('')).toBe('AAA')
    expect(b).toEqual([])
    expect(hasSmoothStream('m2')).toBe(true)
  })

  it('mode change recreates the streamer for the same message', () => {
    const committed: string[] = []
    pushSmoothText('m1', 'text:0', 'aaa', 'smooth', (t) => committed.push(t))
    // 模式从 smooth 切到 silky：旧实例先 flush 再销毁，新实例接管
    pushSmoothText('m1', 'text:0', 'bbb', 'silky', (t) => committed.push(t))
    finishSmoothStream('m1')
    expect(committed.join('')).toBe('aaabbb')
    expect(hasSmoothStream('m1')).toBe(false)
  })
})
