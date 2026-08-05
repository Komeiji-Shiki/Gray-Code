import { describe, expect, it, beforeEach } from 'vitest'
import {
  pushSmoothText,
  finishSmoothStream,
  hasSmoothStream,
  migrateSmoothStream,
  disposeAllSmoothStreams
} from '../../stores/chat/smoothStreamManager'

interface Commit { partKey: string; text: string }
function collect() {
  const commits: Commit[] = []
  return {
    commits,
    onCommit: (partKey: string, text: string) => commits.push({ partKey, text })
  }
}

describe('smoothStreamManager', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
  })

  it('keeps one streamer per message id and flushes all on finish', () => {
    const { commits, onCommit } = collect()
    pushSmoothText('m1', 'text:0', 'hello ', 'balanced', '', onCommit)
    pushSmoothText('m1', 'text:0', 'world', 'balanced', '', onCommit)
    expect(hasSmoothStream('m1')).toBe(true)
    // 同一 partKey 复用同一 streamer；finish 时 flush 输出全部积压（不丢尾巴）
    finishSmoothStream('m1')
    expect(commits.map(c => c.text).join('')).toBe('hello world')
    expect(commits.every(c => c.partKey === 'text:0')).toBe(true)
    expect(hasSmoothStream('m1')).toBe(false)
  })

  it('switchPart flushes the previous segment before starting a new one', () => {
    const { commits, onCommit } = collect()
    pushSmoothText('m1', 'thought:0', 'thinking ', 'balanced', 'T', onCommit)
    // partKey 变化（thought → text）：上一段积压立即输出（旧 partKey/基线），新段落从空开始
    pushSmoothText('m1', 'text:1', 'answer', 'balanced', '', onCommit)
    finishSmoothStream('m1')
    expect(commits.map(c => c.text).join('')).toBe('Tthinking answer')
    // 段落切换瞬间：flush 尾巴带旧 partKey（旧段落块，替换文本相同无视觉变化）
    expect(commits[0]).toEqual({ partKey: 'thought:0', text: 'Tthinking ' })
    expect(commits[1]).toEqual({ partKey: 'text:1', text: 'answer' })
  })

  it('separate messages have isolated streamers', () => {
    const a: Commit[] = []
    const b: Commit[] = []
    const onA = (partKey: string, text: string) => a.push({ partKey, text })
    const onB = (partKey: string, text: string) => b.push({ partKey, text })
    pushSmoothText('m1', 'text:0', 'AAA', 'balanced', '', onA)
    pushSmoothText('m2', 'text:0', 'BBB', 'balanced', '', onB)
    finishSmoothStream('m1')
    expect(a.map(c => c.text).join('')).toBe('AAA')
    expect(b).toEqual([])
    expect(hasSmoothStream('m2')).toBe(true)
  })

  it('mode change recreates the streamer for the same message', () => {
    const { commits, onCommit } = collect()
    pushSmoothText('m1', 'text:0', 'aaa', 'smooth', '', onCommit)
    // 模式从 smooth 切到 silky：旧实例先 flush 再销毁，新实例接管
    pushSmoothText('m1', 'text:0', 'bbb', 'silky', '', onCommit)
    finishSmoothStream('m1')
    expect(commits.map(c => c.text).join('')).toBe('aaabbb')
    expect(hasSmoothStream('m1')).toBe(false)
  })

  it('baseText baseline: display text = baseText + committed deltas (H3)', () => {
    const { commits, onCommit } = collect()
    // 档位 off→on 或实例重建：baseText 为当前 part 已累计真实文本（不含本次 delta）
    pushSmoothText('m1', 'text:0', 'c', 'balanced', 'AB', onCommit)
    finishSmoothStream('m1')
    expect(commits).toEqual([{ partKey: 'text:0', text: 'ABc' }])
  })

  it('migrateSmoothStream renames the entry key (H1 placeholder id -> persisted id)', () => {
    const { commits, onCommit } = collect()
    pushSmoothText('m_placeholder', 'text:0', 'hello ', 'balanced', '', onCommit)
    migrateSmoothStream('m_placeholder', 'm_persisted')
    expect(hasSmoothStream('m_placeholder')).toBe(false)
    expect(hasSmoothStream('m_persisted')).toBe(true)
    // 迁移后继续推送：同一 streamer 复用，积压不丢
    pushSmoothText('m_persisted', 'text:0', 'world', 'balanced', '', onCommit)
    finishSmoothStream('m_persisted')
    expect(commits.map(c => c.text).join('')).toBe('hello world')
    expect(hasSmoothStream('m_persisted')).toBe(false)
  })
})
