import { describe, expect, test, vi, afterEach, beforeEach } from 'vitest'
import {
  findPromoteCutForTests as findPromoteCut,
  pushSmoothText,
  finishSmoothStream,
  disposeAllSmoothStreams,
  registerSmoothDisplay
} from '../../stores/chat/smoothStreamManager'

type ScanResult = ReturnType<typeof findPromoteCut>

/** 可复现的伪随机数（mulberry32），失败时可按 seed 重放。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 覆盖 fence（反引号/波浪号、不同长度、缩进、info string、带反引号的 info）、表格、
// HTML 块、引用、列表与空行等会影响提升边界的行形态。
const LINE_VOCABULARY = [
  '```', '````', '```js', '~~~', '~~~~', '~~~ python', '   ```', '    ```', '``` a`b',
  '```   ', '~~~`', '| A | B |', '| --- | --- |', 'A | B', ':--- | ---:', '| x | y |',
  '---', '- item', '1. step', '> quote', '> | a | b |', '> | - | - |', '<div>', '</div>',
  '<!--', '-->', '<pre>', '</pre>', '$$', 'x = 1', 'plain text', 'const a = 1',
  '', '', '', '  ', '\t```', '[^1]: note', '  | c | d |',
  // 既像 fence/HTML 起始又可能成为表头的行：delimiter 后到时会改变旧行的判定。
  '~~~ | A | B', '<div> | A | B', '--- | --- | ---'
]

function randomDocument(random: () => number, lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    lines.push(LINE_VOCABULARY[Math.floor(random() * LINE_VOCABULARY.length)])
  }
  const eol = random() < 0.2 ? '\r\n' : '\n'
  return lines.join(eol) + (random() < 0.5 ? eol : 'tail')
}

function countLineBreaks(text: string): number {
  return text.split('\n').length - 1
}

/**
 * 模拟 maybePromote 的提升循环：每个 chunk 后分别做续扫与全量扫描，
 * 两者的提升结果与可续扫状态必须完全一致。
 */
function assertIncrementalMatchesFull(source: string, random: () => number): void {
  let settled = ''
  let promoted = ''
  let promotedLineCount = 0
  let tableContinuation: ScanResult['tableContinuation'] = null
  let previous: ScanResult['scan'] | null = null
  let offset = 0

  while (offset < source.length) {
    const size = 1 + Math.floor(random() * 12)
    settled += source.slice(offset, offset + size)
    offset += size

    const incremental = findPromoteCut(settled, promoted, tableContinuation, promotedLineCount, previous)
    const full = findPromoteCut(settled, promoted, tableContinuation)
    expect(incremental.cut).toBe(full.cut)
    expect(incremental.tableContinuation).toEqual(full.tableContinuation)
    expect(incremental.scan).toEqual(full.scan)

    previous = incremental.scan
    tableContinuation = incremental.tableContinuation
    if (incremental.cut > 0) {
      const lifted = settled.slice(0, incremental.cut)
      promoted += lifted
      promotedLineCount += countLineBreaks(lifted)
      settled = settled.slice(incremental.cut)
      previous = null
    }
  }
}

describe('findPromoteCut incremental scan', () => {
  test('matches the full scan on randomized markdown streams', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = createRandom(seed)
      const source = randomDocument(random, 4 + Math.floor(random() * 40))
      try {
        assertIncrementalMatchesFull(source, random)
      } catch (error) {
        throw new Error(`seed ${seed} diverged for ${JSON.stringify(source)}: ${String(error)}`)
      }
    }
  })

  test.each([
    ['backtick fence closed by a longer fence', '````js\na\n\n```\nb\n``````\n\nafter\n'],
    ['tilde fence ignores backtick closer', '~~~\n```\n\n~~~ not\n~~~\n\nnext\n'],
    ['indented closer and 4-space non-fence', '   ```\ncode\n    ```\n  ```\n\ndone\n'],
    ['table-shaped lines inside a fence', '```md\n| A | B |\n| --- | --- |\n\n| x | y |\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n'],
    ['table header completed by an appended delimiter', 'intro\n\nA | B\n--- | ---\nx | y\n\n'],
    ['html block around blank lines', '<div>\ntext\n\n<pre>\n\n</pre>\n\nend\n'],
    ['fence-like header turned into a table by a later delimiter', '~~~ | A | B\n--- | --- | ---\n| 1 | 2 | 3 |\n\nafter\n'],
    ['html-like header turned into a table by a later delimiter', '<div> | A | B\n--- | --- | ---\n\n<div>\n\nend\n'],
    ['CRLF fence', '```\r\ncode\r\n\r\n```\r\n\r\nafter\r\n']
  ])('matches the full scan for %s', (_label, source) => {
    // 逐字符追加覆盖每一个可能的续扫断点。
    let settled = ''
    let promoted = ''
    let promotedLineCount = 0
    let tableContinuation: ScanResult['tableContinuation'] = null
    let previous: ScanResult['scan'] | null = null
    for (const ch of source) {
      settled += ch
      const incremental = findPromoteCut(settled, promoted, tableContinuation, promotedLineCount, previous)
      const full = findPromoteCut(settled, promoted, tableContinuation)
      expect(incremental.cut).toBe(full.cut)
      expect(incremental.tableContinuation).toEqual(full.tableContinuation)
      expect(incremental.scan).toEqual(full.scan)
      previous = incremental.scan
      tableContinuation = incremental.tableContinuation
      if (incremental.cut > 0) {
        const lifted = settled.slice(0, incremental.cut)
        promoted += lifted
        promotedLineCount += countLineBreaks(lifted)
        settled = settled.slice(incremental.cut)
        previous = null
      }
    }
  })

  test('resumes from the saved fence state instead of rescanning earlier lines', () => {
    const first = findPromoteCut('```js\nconst a = 1\n', '', null)
    expect(first.scan.fence).toEqual({ marker: '`', length: 3 })

    // 同长度、同换行位置但内容不同的文本：只有真正续扫（沿用 fence 内状态）才会得到 cut=0；
    // 这也说明 settled 被改写时调用方必须丢弃 previous。
    const rewritten = 'abcdefghijklmnopq\n\nnext\n'
    expect(findPromoteCut(rewritten, '', null).cut).toBe(19)
    expect(findPromoteCut(rewritten, '', null, 0, first.scan).cut).toBe(0)
  })

  test('falls back to a full scan when the promoted prefix or table context changes', () => {
    const first = findPromoteCut('```js\nconst a = 1\n', '', null)
    const text = 'abcdefghijklmnopq\n\nnext\n'
    expect(findPromoteCut(text, 'intro\n\n', null, 2, first.scan).cut).toBe(19)
    // 上次扫描终点不在行首：说明文本已被替换，必须全量扫描。
    expect(findPromoteCut('abcdefghijklmnopqr\n\nnext\n', '', null, 0, first.scan).cut).toBe(20)
  })
})

describe('smoothStreamManager incremental promote scanning', () => {
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

  test('frame-by-frame streaming of a long fenced block promotes the same text as a one-shot flush', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    let scheduled: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      scheduled = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      scheduled = null
    })
    const frame = (dtMs: number) => {
      vi.advanceTimersByTime(dtMs)
      const cb = scheduled
      scheduled = null
      cb?.(performance.now())
    }

    const body = Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? '' : `line ${i}`)).join('\n')
    const source = `intro\n\n\`\`\`ts\n${body}\n\`\`\`\n\nafter\n\ntail`
    const noop = () => {}

    const oneShotHost = document.createElement('div')
    const oneShot: string[] = []
    pushSmoothText('once', 'text:0', source, 'balanced', '', noop)
    registerSmoothDisplay('once', oneShotHost, { noFade: true, onPromote: (t) => oneShot.push(t) })
    finishSmoothStream('once')

    const streamedHost = document.createElement('div')
    const streamed: string[] = []
    registerSmoothDisplay('streamed', streamedHost, { noFade: true, onPromote: (t) => streamed.push(t) })
    for (let i = 0; i < source.length; i += 9) {
      pushSmoothText('streamed', 'text:0', source.slice(i, i + 9), 'balanced', '', noop)
      frame(16)
      // 未闭合 fence 期间不能提升 fence 内的空行边界（streamer 可能尚未放出 intro）。
      if (i + 9 < source.indexOf('\n```\n')) {
        expect(['', 'intro\n\n']).toContain(streamed.join(''))
      }
    }
    finishSmoothStream('streamed')

    expect(oneShot.join('')).toBe(source.slice(0, -'tail'.length))
    expect(streamed.join('')).toBe(oneShot.join(''))
    expect(streamedHost.textContent).toBe('tail')
    expect(oneShotHost.textContent).toBe('tail')
  })
})
