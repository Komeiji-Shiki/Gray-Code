import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  pushSmoothText,
  finishSmoothStream,
  hasSmoothStream,
  migrateSmoothStream,
  disposeAllSmoothStreams,
  registerSmoothDisplay,
  unregisterSmoothDisplay
} from '../../stores/chat/smoothStreamManager'

interface Snapshot { partKey: string; text: string }
function collect() {
  const snapshots: Snapshot[] = []
  return {
    snapshots,
    onSnapshot: (_messageId: string, partKey: string, text: string) => snapshots.push({ partKey, text })
  }
}

describe('smoothStreamManager', () => {
  beforeEach(() => {
    disposeAllSmoothStreams()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    disposeAllSmoothStreams()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('keeps one streamer per message id and flushes all on finish', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello ', 'balanced', '', onSnapshot)
    pushSmoothText('m1', 'text:0', 'world', 'balanced', '', onSnapshot)
    expect(hasSmoothStream('m1')).toBe(true)
    // 同一 partKey 复用同一 streamer；finish 时 flush 输出全部积压（不丢尾巴）
    finishSmoothStream('m1')
    expect(snapshots.map(s => s.text).join('')).toBe('hello world')
    expect(snapshots.every(s => s.partKey === 'text:0')).toBe(true)
    expect(hasSmoothStream('m1')).toBe(false)
  })

  it('switchPart flushes the previous segment before starting a new one', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'thought:0', 'thinking ', 'balanced', 'T', onSnapshot)
    // partKey 变化（thought → text）：上一段积压立即输出（旧 partKey/基线），
    // 新段落强制快照新基线（空文本），之后从空开始
    pushSmoothText('m1', 'text:1', 'answer', 'balanced', '', onSnapshot)
    finishSmoothStream('m1')
    expect(snapshots).toEqual([
      { partKey: 'thought:0', text: 'T' },
      { partKey: 'thought:0', text: 'Tthinking ' },
      { partKey: 'text:1', text: '' },
      { partKey: 'text:1', text: 'answer' }
    ])
  })

  it('switchPart publishes a new partKey even when the new baseline text is unchanged', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'thought:0', 'A', 'balanced', '', onSnapshot)
    pushSmoothText('m1', 'text:1', 'B', 'balanced', 'A', onSnapshot)
    finishSmoothStream('m1')

    expect(snapshots).toContainEqual({ partKey: 'thought:0', text: 'A' })
    expect(snapshots).toContainEqual({ partKey: 'text:1', text: 'A' })
    expect(snapshots[snapshots.length - 1]).toEqual({ partKey: 'text:1', text: 'AB' })
  })

  it('separate messages have isolated streamers', () => {
    const a: Snapshot[] = []
    const b: Snapshot[] = []
    const onA = (_messageId: string, partKey: string, text: string) => a.push({ partKey, text })
    const onB = (_messageId: string, partKey: string, text: string) => b.push({ partKey, text })
    pushSmoothText('m1', 'text:0', 'AAA', 'balanced', '', onA)
    pushSmoothText('m2', 'text:0', 'BBB', 'balanced', '', onB)
    finishSmoothStream('m1')
    expect(a.map(s => s.text).join('')).toBe('AAA')
    expect(b).toEqual([{ partKey: 'text:0', text: '' }])
    expect(hasSmoothStream('m2')).toBe(true)
  })

  it('mode change recreates the streamer for the same message', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'aaa', 'smooth', '', onSnapshot)
    // 模式从 smooth 切到 silky：旧实例先 flush 再销毁，新实例接管
    pushSmoothText('m1', 'text:0', 'bbb', 'silky', '', onSnapshot)
    finishSmoothStream('m1')
    expect(snapshots.map(s => s.text).join('')).toBe('aaabbb')
    expect(hasSmoothStream('m1')).toBe(false)
  })

  it('baseText baseline: display text = baseText + committed deltas (H3)', () => {
    const { snapshots, onSnapshot } = collect()
    // 档位 off→on 或实例重建：baseText 为当前 part 已累计真实文本（不含本次 delta）
    pushSmoothText('m1', 'text:0', 'c', 'balanced', 'AB', onSnapshot)
    finishSmoothStream('m1')
    expect(snapshots).toEqual([
      { partKey: 'text:0', text: 'AB' },
      { partKey: 'text:0', text: 'ABc' }
    ])
  })

  it('migrateSmoothStream renames the entry key (H1 placeholder id -> persisted id)', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m_placeholder', 'text:0', 'hello ', 'balanced', '', onSnapshot)
    migrateSmoothStream('m_placeholder', 'm_persisted')
    expect(hasSmoothStream('m_placeholder')).toBe(false)
    expect(hasSmoothStream('m_persisted')).toBe(true)
    // 迁移后继续推送：同一 streamer 复用，积压不丢
    pushSmoothText('m_persisted', 'text:0', 'world', 'balanced', '', onSnapshot)
    finishSmoothStream('m_persisted')
    expect(snapshots.map(s => s.text).join('')).toBe('hello world')
    expect(hasSmoothStream('m_persisted')).toBe(false)
  })

  it('registerSmoothDisplay restores accumulated text into the CharFlow host', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    // 注册时还没有 commit（rAF 未跑）：restore 空累计
    registerSmoothDisplay('m1', host)
    expect(host.textContent).toBe('')
    // finish 时 flush：instant 直通进显示层
    finishSmoothStream('m1')
    expect(host.textContent).toBe('hello')
  })

  it('unregisterSmoothDisplay releases the owned host without affecting snapshots', () => {
    const host = document.createElement('div')
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host)
    unregisterSmoothDisplay('m1', host)
    finishSmoothStream('m1')
    expect(host.textContent).toBe('') // 已注销：显示层不再接收
    expect(snapshots[snapshots.length - 1]?.text).toBe('hello') // 快照不受影响
  })

  it('same-host registration is idempotent and stale hosts cannot unregister the current display', () => {
    const staleHost = document.createElement('div')
    const currentHost = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'thought:0', 'thinking', 'balanced', 'base ', onSnapshot)

    registerSmoothDisplay('m1', staleHost, { followEnd: true })
    registerSmoothDisplay('m1', currentHost, { followEnd: true })
    registerSmoothDisplay('m1', currentHost, { followEnd: true })
    unregisterSmoothDisplay('m1', staleHost)
    finishSmoothStream('m1')

    expect(staleHost.textContent).toBe('')
    expect(currentHost.textContent).toBe('base thinking')
    expect(currentHost.childNodes).toHaveLength(1)
  })

  it('part switch disposes the display; re-register restores the new baseline', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'aaa', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host)
    // 段落切换：旧积压 flush 进显示层，随后显示目标被注销（旧段落由 renderBlocks 接管）
    pushSmoothText('m1', 'text:1', 'bbb', 'balanced', 'B', onSnapshot)
    expect(host.textContent).toBe('')
    // MessageItem 感知 partKey 变化后重新注册：restore 新基线（累计真实文本）
    registerSmoothDisplay('m1', host)
    expect(host.textContent).toBe('B')
    finishSmoothStream('m1')
    expect(host.textContent).toBe('Bbbb')
  })

  it('migrateSmoothStream also renames the display key', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m_placeholder', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m_placeholder', host)
    migrateSmoothStream('m_placeholder', 'm_persisted')
    // 按新 id 终结：display 键已迁移，内容正常定型
    finishSmoothStream('m_persisted')
    expect(host.textContent).toBe('hello')
  })

  it('snapshot is throttled to ~120ms between commits', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    let scheduled: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      scheduled = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      scheduled = null
    })
    const { snapshots, onSnapshot } = collect()
    // cps 恒为 100：10ms 帧 → 每帧放 1 字符，每帧一次 commit
    pushSmoothText('m1', 'text:0', 'x'.repeat(10), 'balanced', '', onSnapshot)
    const frame = (dtMs: number) => {
      vi.advanceTimersByTime(dtMs)
      const cb = scheduled
      scheduled = null
      cb?.(performance.now())
    }
    for (let i = 0; i < 5; i++) frame(10) // 50ms：首个空基线快照已存在，commit 仍受 120ms 节流
    expect(snapshots.length).toBe(1)
    for (let i = 0; i < 15; i++) frame(10) // 再 150ms（累计 200ms，距首次快照 ≥120ms）
    expect(snapshots.length).toBe(2)
  })

  it('disposeAllSmoothStreams clears entries and displays', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host)
    disposeAllSmoothStreams()
    expect(hasSmoothStream('m1')).toBe(false)
    expect(host.textContent).toBe('')
    // 清理后推送：不再有 entry，也不报错
    pushSmoothText('m1', 'text:0', 'world', 'balanced', '', onSnapshot)
    expect(hasSmoothStream('m1')).toBe(true)
  })

  it('noFade display appends text directly without spans', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { noFade: true })
    finishSmoothStream('m1')
    expect(host.textContent).toBe('hello')
    expect(host.querySelectorAll('span').length).toBe(0)
  })

  it('onPromote lifts completed paragraphs out of the CharFlow host', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'para one\n\npara two\n\npara three', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (t) => promoted.push(t) })
    // flush 是 instant 提交：settled 立即含全部文本；只提升 fence 配对（此处无 fence）的完整段落
    finishSmoothStream('m1')
    expect(promoted.join('')).toBe('para one\n\npara two\n\n')
    expect(host.textContent).toBe('para three')
  })

  it('promote skips boundaries inside unclosed fenced code blocks', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    // 最后一个 \n\n 在未闭合的 ```js 块内；回退到更早的合法边界（intro 后）
    pushSmoothText(
      'm1',
      'text:0',
      'intro\n\n```js\nconst a = 1\n\nconst b = 2',
      'balanced',
      '',
      onSnapshot
    )
    registerSmoothDisplay('m1', host, { onPromote: (t) => promoted.push(t) })
    finishSmoothStream('m1')
    expect(promoted.join('')).toBe('intro\n\n')
    expect(host.textContent).toBe('```js\nconst a = 1\n\nconst b = 2')
  })

  it('promote lifts a complete fenced code block as one unit', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const text = 'intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\ntail'
    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (t) => promoted.push(t) })
    finishSmoothStream('m1')
    expect(promoted.join('')).toBe('intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n')
    expect(host.textContent).toBe('tail')
  })

  it('re-register during streaming replays promoted text and restores only the tail', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    let scheduled: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      scheduled = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      scheduled = null
    })

    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const promotedA: string[] = []
    const promotedB: string[] = []
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'para one\n\npara two\n\npara three', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', hostA, { onPromote: (t) => promotedA.push(t) })

    const frame = (dtMs: number) => {
      vi.advanceTimersByTime(dtMs)
      const cb = scheduled
      scheduled = null
      cb?.(performance.now())
    }
    for (let i = 0; i < 100; i++) frame(16) // 驱动 rAF 放完全部字符（~1.6s）

    expect(promotedA.join('')).toBe('para one\n\npara two\n\n')
    expect(hostA.textContent).toBe('para three')

    // 组件重建：新 host 注册时重放已提升文本，CharFlow 只恢复未提升的尾巴
    registerSmoothDisplay('m1', hostB, { onPromote: (t) => promotedB.push(t) })
    expect(promotedB.join('')).toBe('para one\n\npara two\n\n')
    expect(hostB.textContent).toBe('para three')
    expect(hostA.textContent).toBe('') // 旧 host 被 dispose 清空

    disposeAllSmoothStreams()
  })
})
