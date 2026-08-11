import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
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

  test('keeps one streamer per message id and flushes all on finish', () => {
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

  test('switchPart flushes the previous segment before starting a new one', () => {
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

  test('switchPart publishes a new partKey even when the new baseline text is unchanged', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'thought:0', 'A', 'balanced', '', onSnapshot)
    pushSmoothText('m1', 'text:1', 'B', 'balanced', 'A', onSnapshot)
    finishSmoothStream('m1')

    expect(snapshots).toContainEqual({ partKey: 'thought:0', text: 'A' })
    expect(snapshots).toContainEqual({ partKey: 'text:1', text: 'A' })
    expect(snapshots[snapshots.length - 1]).toEqual({ partKey: 'text:1', text: 'AB' })
  })

  test('separate messages have isolated streamers', () => {
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

  test('mode change recreates the streamer for the same message', () => {
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'aaa', 'smooth', '', onSnapshot)
    // 模式从 smooth 切到 silky：旧实例先 flush 再销毁，新实例接管
    pushSmoothText('m1', 'text:0', 'bbb', 'silky', '', onSnapshot)
    finishSmoothStream('m1')
    expect(snapshots.map(s => s.text).join('')).toBe('aaabbb')
    expect(hasSmoothStream('m1')).toBe(false)
  })

  test('baseText baseline: display text = baseText + committed deltas (H3)', () => {
    const { snapshots, onSnapshot } = collect()
    // 档位 off→on 或实例重建：baseText 为当前 part 已累计真实文本（不含本次 delta）
    pushSmoothText('m1', 'text:0', 'c', 'balanced', 'AB', onSnapshot)
    finishSmoothStream('m1')
    expect(snapshots).toEqual([
      { partKey: 'text:0', text: 'AB' },
      { partKey: 'text:0', text: 'ABc' }
    ])
  })

  test('migrateSmoothStream renames the entry key (H1 placeholder id -> persisted id)', () => {
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

  test('registerSmoothDisplay restores accumulated text into the CharFlow host', () => {
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

  test('unregisterSmoothDisplay releases the owned host without affecting snapshots', () => {
    const host = document.createElement('div')
    const { snapshots, onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host)
    unregisterSmoothDisplay('m1', host)
    finishSmoothStream('m1')
    expect(host.textContent).toBe('') // 已注销：显示层不再接收
    expect(snapshots[snapshots.length - 1]?.text).toBe('hello') // 快照不受影响
  })

  test('same-host registration is idempotent and stale hosts cannot unregister the current display', () => {
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

  test('part switch disposes the display; re-register restores the new baseline', () => {
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

  test('migrateSmoothStream also renames the display key', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m_placeholder', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m_placeholder', host)
    migrateSmoothStream('m_placeholder', 'm_persisted')
    // 按新 id 终结：display 键已迁移，内容正常定型
    finishSmoothStream('m_persisted')
    expect(host.textContent).toBe('hello')
  })

  test('snapshot is throttled to ~120ms between commits', () => {
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

  test('disposeAllSmoothStreams clears entries and displays', () => {
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

  test('noFade display appends text directly without spans', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    pushSmoothText('m1', 'text:0', 'hello', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { noFade: true })
    finishSmoothStream('m1')
    expect(host.textContent).toBe('hello')
    expect(host.querySelectorAll('span').length).toBe(0)
  })

  test('onPromote lifts completed paragraphs out of the CharFlow host', () => {
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

  test('keeps a raw bridge visible until an async Markdown render acknowledgement resolves', async () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    let acknowledge!: () => void
    const rendered = new Promise<void>((resolve) => { acknowledge = resolve })

    pushSmoothText('m1', 'text:0', 'para one\n\npara two', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, {
      onPromote: (text) => {
        promoted.push(text)
        return rendered
      }
    })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe('para one\n\n')
    // Markdown 尚未确认落地：promoted 前缀由 bridge 继续显示，不能出现空窗。
    expect(host.textContent).toBe('para one\n\npara two')

    acknowledge()
    await rendered
    await Promise.resolve()
    expect(host.textContent).toBe('para two')
  })

  test('re-registration bridges replayed Markdown until the new renderer is ready', async () => {
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const { onSnapshot } = collect()
    const baseText = 'para one\n\npara two'

    // 用已累计 baseText 建立 entry；注册时即可提升完整首段，无需等待 rAF。
    pushSmoothText('m1', 'text:0', 'pending', 'balanced', baseText, onSnapshot)
    registerSmoothDisplay('m1', hostA, { onPromote: () => {} })
    expect(hostA.textContent).toBe('para two')

    let acknowledge!: () => void
    const rendered = new Promise<void>((resolve) => { acknowledge = resolve })
    const kinds: string[] = []
    registerSmoothDisplay('m1', hostB, {
      onPromote: (_text, kind) => {
        kinds.push(kind)
        return rendered
      }
    })

    expect(kinds).toEqual(['replay'])
    expect(hostA.textContent).toBe('')
    // 新宿主先恢复 promoted bridge + 未提升 tail，视觉上仍是完整原文。
    expect(hostB.textContent).toBe(baseText)

    acknowledge()
    await rendered
    await Promise.resolve()
    expect(hostB.textContent).toBe('para two')
  })


  test('releases the bridge when onPromote throws synchronously', () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()

    pushSmoothText('m1', 'text:0', 'para one\n\npara two', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, {
      onPromote: () => { throw new Error('renderer exploded') }
    })
    finishSmoothStream('m1')

    // 异常路径也释放 bridge：tailRendered 已由 onPromote 同步更新，
    // markdown 层仍会渲染；保留 bridge 只会造成永久 DOM 残留。
    expect(host.textContent).toBe('para two')
  })

  test('releases the bridge when onPromote rejects', async () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()

    pushSmoothText('m1', 'text:0', 'para one\n\npara two', 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, {
      onPromote: () => Promise.reject(new Error('render failed'))
    })
    finishSmoothStream('m1')

    await Promise.resolve()
    await Promise.resolve()
    expect(host.textContent).toBe('para two')
  })

  test('flush with tailWindow promotes the whole table before trimming (order fix)', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| A | B |\n| --- | --- |\n'
    const row1 = '| 1 | 2 |\n'
    const nextRow = '| 4 | y |\n'
    const longPartial = '| 3 | ' + 'x'.repeat(5000)

    // 一次大 chunk + finish flush：旧顺序（trim 先于 promote）会把未提升的
    // 表格头/数据行直接裁掉；修复后 promote 先剥离完整表格，仅裁超长半行。
    pushSmoothText('m1', 'text:0', tableHead + row1 + nextRow + longPartial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (t) => promoted.push(t), noFade: true, tailWindow: 4096 })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(tableHead + row1 + nextRow)
    expect(host.textContent.length).toBeLessThanOrEqual(4096)
    expect(host.textContent.startsWith('|')).toBe(false)
  })
  test('preserves a pending bridge across a smooth-mode rebuild', async () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    const baseText = 'para one\n\npara two'
    let acknowledge!: () => void
    const rendered = new Promise<void>((resolve) => { acknowledge = resolve })

    pushSmoothText('m1', 'text:0', '', 'balanced', baseText, onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: () => rendered })
    expect(host.textContent).toBe(baseText)

    // 档位重建会 restore settled tail；settled 之前的 bridge 必须原样保留。
    pushSmoothText('m1', 'text:0', '', 'silky', baseText, onSnapshot)
    expect(host.textContent).toBe(baseText)

    acknowledge()
    await rendered
    await Promise.resolve()
    expect(host.textContent).toBe('para two')
  })

  test('keeps the promoted prefix in a restoreFull display across a smooth-mode rebuild', () => {
    const expandedHost = document.createElement('div')
    const collapsedHost = document.createElement('div')
    const { onSnapshot } = collect()
    const baseText = 'para one\n\npara two'
    const promoted: string[] = []

    pushSmoothText('m1', 'thought:0', '', 'balanced', baseText, onSnapshot)
    registerSmoothDisplay('m1', expandedHost, { onPromote: (text) => promoted.push(text) })
    expect(promoted.join('')).toBe('para one\n\n')
    expect(expandedHost.textContent).toBe('para two')

    // collapsed/单行预览没有 Markdown 层，必须自行保留完整累计文本。
    registerSmoothDisplay('m1', collapsedHost, { restoreFull: true, noFade: true })
    expect(collapsedHost.textContent).toBe(baseText)

    pushSmoothText('m1', 'thought:0', '', 'silky', baseText, onSnapshot)
    expect(collapsedHost.textContent).toBe(baseText)
  })

  test('releases multiple ordered table bridges from one coalesced render acknowledgement', async () => {
    const host = document.createElement('div')
    const { onSnapshot } = collect()
    const tableHead = '| Name | Value |\n| --- | --- |\n'
    const completeRow = '| alpha | 1 |\n'
    const partialRow = '| beta'
    const promoted: string[] = []
    let acknowledge!: () => void
    const rendered = new Promise<void>((resolve) => { acknowledge = resolve })

    pushSmoothText('m1', 'text:0', '', 'balanced', tableHead, onSnapshot)
    registerSmoothDisplay('m1', host, {
      onPromote: (text) => {
        promoted.push(text)
        return rendered
      }
    })
    pushSmoothText('m1', 'text:0', completeRow + partialRow, 'balanced', tableHead, onSnapshot)
    finishSmoothStream('m1')

    expect(promoted).toEqual([tableHead, completeRow])
    expect(host.textContent).toBe(tableHead + completeRow + partialRow)

    acknowledge()
    await rendered
    await Promise.resolve()
    expect(host.textContent).toBe(partialRow)
  })

  test('promotes a complete GFM table header and each complete data row without waiting for a blank line', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| Name | Value |\n| :--- | ---: |\n'
    const completeRow = '| alpha | 1 |\n'
    const partialRow = '| beta | 2'

    pushSmoothText('m1', 'text:0', tableHead + completeRow + partialRow, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (text) => promoted.push(text) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(tableHead + completeRow)
    expect(host.textContent).toBe(partialRow)
  })

  test('does not promote a table until the delimiter is complete and newline-terminated', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const incompleteTable = '| Name | Value |\n| --- | --'

    pushSmoothText('m1', 'text:0', incompleteTable, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (text) => promoted.push(text) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([])
    expect(host.textContent).toBe(incompleteTable)
  })

  test('allows a paragraph to be interrupted by a table without requiring a blank line', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const text = 'summary\n| Name | Value |\n| --- | --- |\n'

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(text)
    expect(host.textContent).toBe('')
  })

  test.each([
    ['list', '- item\n| Name | Value |\n| --- | --- |\n'],
    ['ordered list', '1. item\n| Name | Value |\n| --- | --- |\n'],
    ['blockquote', '> quote\n| Name | Value |\n| --- | --- |\n']
  ])('does not promote table-shaped lazy continuation inside a %s', (_label, text) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([])
    expect(host.textContent).toBe(text)
  })

  test.each([
    ['escaped pipe in a one-column header', 'plain \\| text\n---\n'],
    ['code span pipe', '`plain | code`\n--- | ---\n'],
    ['list-marker header', '- A | B\n--- | ---\n'],
    ['blockquote-marker header', '> A | B\n--- | ---\n']
  ])('matches markdown-it column splitting for a %s', (_label, text) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(text)
    expect(host.textContent).toBe('')
  })

  test('does not mistake a list-like incomplete delimiter for a table', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const text = 'Name | Value\n- | ---\n'

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([])
    expect(host.textContent).toBe(text)
  })

  test.each([
    ['plain single-cell row', 'plain\n'],
    ['escaped-only row', 'plain \\| value\n'],
    ['code-span row', '`plain | code`\n']
  ])('keeps table continuation through a %s without requiring a structural pipe', (_label, row) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| A | B |\n| --- | --- |\n'
    const nextRow = '| next | row |\n'
    const partial = '| pending'

    pushSmoothText('m1', 'text:0', tableHead + row + nextRow + partial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(tableHead + row + nextRow)
    expect(host.textContent).toBe(partial)
  })

  test.each([
    ['ATX heading', '# heading\n'],
    ['thematic break', '---\n'],
    ['list', '- item\n'],
    ['blockquote', '> quote\n'],
    ['fence', '```\ncode\n```\n'],
    ['math block', '$$\nx\n$$\nafter\n'],
    ['HTML block', '<div>\ninside\n']
  ])('stops table continuation before a %s block', (_label, tail) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| A | B |\n| --- | --- |\n'

    pushSmoothText('m1', 'text:0', tableHead + tail, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([tableHead])
    expect(host.textContent).toBe(tail)
  })

  test.each([
    ['list followed by a heading', '- item\n# heading\n'],
    ['blockquote followed by a heading', '> quote\n# heading\n'],
    ['list followed by a thematic break', '- item\n---\n'],
    ['list followed by a closed fence', '- item\n~~~\ncode\n~~~\n'],
    ['list followed by a closed HTML comment', '- item\n<!-- done -->\n']
  ])('recognizes a root table after a lazy container is terminated by %s', (_label, prefix) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const table = 'A | B\n--- | ---\nx | y\n'
    const text = prefix + table

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(text)
    expect(host.textContent).toBe('')
  })

  test('does not enter fence mode for a backtick info string containing a backtick', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const text = '```foo`bar\nA | B\n--- | ---\nx | y\n'

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(text)
    expect(host.textContent).toBe('')
  })

  test('promotes a table inside a blockquote while preserving the quote markers', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const complete = '> A | B\n> --- | ---\n> x | y\n'
    const partial = '> pending'

    pushSmoothText('m1', 'text:0', complete + partial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(complete)
    expect(host.textContent).toBe(partial)
  })

  test('allows a blockquote paragraph to be interrupted by a nested table', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const complete = '> intro\n> A | B\n> --- | ---\n> x | y\n'
    const partial = '> pending'

    pushSmoothText('m1', 'text:0', complete + partial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(complete)
    expect(host.textContent).toBe(partial)
  })

  test('promotes a normally-indented table inside a list item', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const complete = '- item\n\n  A | B\n  --- | ---\n  x | y\n'
    const partial = '  pending'

    pushSmoothText('m1', 'text:0', complete + partial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(complete)
    expect(host.textContent).toBe(partial)
  })

  test('uses promoted context to keep a deeply-indented ordered-list table parseable', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const prefix = '10. item\n\n'
    const table = '    A | B\n    --- | ---\n    x | y\n'
    const partial = '    pending'

    // 先提升列表前缀，再让表格跨后续 chunk 到达；仅解析 settled 会把 4 空格误当 code。
    pushSmoothText('m1', 'text:0', '', 'balanced', prefix, onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    expect(promoted.join('')).toBe(prefix)

    pushSmoothText('m1', 'text:0', table + partial, 'balanced', prefix, onSnapshot)
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(prefix + table)
    expect(host.textContent).toBe(partial)
  })

  test('detects a blockquote table nested in a deeply-indented list across chunks', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const prefix = '10. item\n\n'
    const table = '    > A | B\n    > --- | ---\n    > x | y\n'
    const partial = '    > pending'

    pushSmoothText('m1', 'thought:0', '', 'balanced', prefix, onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    expect(promoted.join('')).toBe(prefix)

    pushSmoothText('m1', 'thought:0', table + partial, 'balanced', prefix, onSnapshot)
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(prefix + table)
    expect(host.textContent).toBe(partial)
  })

  test('uses renderer footnote rules to promote a table nested in a footnote definition', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const prefix = 'ref[^1]\n\n[^1]: footnote\n\n'
    const table = '    A | B\n    --- | ---\n    x | y\n'
    const partial = '    pending'

    pushSmoothText('m1', 'text:0', '', 'balanced', prefix, onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    expect(promoted.join('')).toBe(prefix)

    pushSmoothText('m1', 'text:0', table + partial, 'balanced', prefix, onSnapshot)
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(prefix + table)
    expect(host.textContent).toBe(partial)
  })

  test('preserves CRLF bytes while promoting an aligned table without outer pipes', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const complete = 'A | B\r\n:--- | ---:\r\nx | y\r\n'
    const partial = 'pending'

    pushSmoothText('m1', 'text:0', complete + partial, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(complete)
    expect(host.textContent).toBe(partial)
  })

  test.each([
    ['blockquote fence', '> ```md\n> A | B\n> --- | ---\n> ```\n'],
    ['HTML block', '<div>\nA | B\n--- | ---\n</div>\n'],
    ['HTML comment', '<!--\nA | B\n--- | ---\n-->\n']
  ])('does not promote a table-shaped sequence inside a %s', (_label, text) => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()

    pushSmoothText('m1', 'text:0', text, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (value) => promoted.push(value) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([])
    expect(host.textContent).toBe(text)
  })

  test('does not promote table-shaped lines inside an unclosed fenced code block', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const code = '```md\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n'

    pushSmoothText('m1', 'text:0', code, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (text) => promoted.push(text) })
    finishSmoothStream('m1')

    expect(promoted).toEqual([])
    expect(host.textContent).toBe(code)
  })

  test('stops table continuation before a list block instead of promoting it as a data row', () => {
    const host = document.createElement('div')
    const promoted: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| Name | Value |\n| --- | --- |\n'
    const tail = '- list item | value\n| not | a continued row |\n'

    pushSmoothText('m1', 'text:0', tableHead + tail, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', host, { onPromote: (text) => promoted.push(text) })
    finishSmoothStream('m1')

    expect(promoted.join('')).toBe(tableHead)
    expect(host.textContent).toBe(tail)
  })

  test('preserves table continuation across mode rebuilds and display re-registration', () => {
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const promotedA: string[] = []
    const promotedB: string[] = []
    const { onSnapshot } = collect()
    const tableHead = '| Name | Value |\n| --- | --- |\n'
    const firstRow = '| alpha | 1 |\n'
    const partialRow = '| beta'
    const accumulated = tableHead + firstRow + partialRow

    pushSmoothText('m1', 'text:0', accumulated, 'balanced', '', onSnapshot)
    registerSmoothDisplay('m1', hostA, { onPromote: (text) => promotedA.push(text) })

    // 切档会 flush 旧 streamer 并重建 entry；已提升表格状态必须随 promotedText 一起继承。
    pushSmoothText('m1', 'text:0', '', 'silky', accumulated, onSnapshot)
    expect(promotedA.join('')).toBe(tableHead + firstRow)
    expect(hostA.textContent).toBe(partialRow)

    // 组件重建时重放已提升前缀，只恢复未提升的半行；后续 chunk 可补齐并逐行提升。
    registerSmoothDisplay('m1', hostB, { onPromote: (text) => promotedB.push(text) })
    expect(promotedB.join('')).toBe(tableHead + firstRow)
    expect(hostB.textContent).toBe(partialRow)

    pushSmoothText('m1', 'text:0', ' | 2 |\n', 'silky', accumulated, onSnapshot)
    finishSmoothStream('m1')

    expect(promotedB.join('')).toBe(tableHead + firstRow + '| beta | 2 |\n')
    expect(hostB.textContent).toBe('')
    expect(hostA.textContent).toBe('')
  })

  test('promote skips boundaries inside unclosed fenced code blocks', () => {
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

  test('promote lifts a complete fenced code block as one unit', () => {
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

  test('re-register during streaming replays promoted text and restores only the tail', () => {
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
