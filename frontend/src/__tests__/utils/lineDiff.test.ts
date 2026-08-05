import { describe, expect, it } from 'vitest'
import { computeLineDiff, computeLineDiffCached, clearLineDiffCache, formatDiffLineNumber } from '../../utils/lineDiff'

describe('computeLineDiff', () => {
  it('preserves unchanged lines and reports inserted and deleted lines', () => {
    const result = computeLineDiff(
      ['alpha', 'beta', 'gamma'].join('\n'),
      ['alpha', 'delta', 'gamma', 'omega'].join('\n')
    )

    expect(result.lines.map(line => [line.type, line.content])).toEqual([
      ['unchanged', 'alpha'],
      ['deleted', 'beta'],
      ['added', 'delta'],
      ['unchanged', 'gamma'],
      ['added', 'omega']
    ])
    expect(result.deleted).toBe(1)
    expect(result.added).toBe(2)
    expect(result.degraded).toBe(false)
  })

  it('uses caller-provided line number origins', () => {
    const result = computeLineDiff('old', 'new', { oldStartLine: 10, newStartLine: 20 })

    expect(result.lines).toEqual([
      { type: 'deleted', content: 'old', oldLineNum: 10 },
      { type: 'added', content: 'new', newLineNum: 20 }
    ])
    expect(result.lineNumberWidth).toBe(2)
  })

  it('falls back to a bounded whole-core replacement when edit distance exceeds the budget', () => {
    const oldContent = Array.from({ length: 100 }, (_, index) => `old-${index}`).join('\n')
    const newContent = Array.from({ length: 100 }, (_, index) => `new-${index}`).join('\n')
    const result = computeLineDiff(oldContent, newContent, { editDistanceLimit: 8 })

    expect(result.degraded).toBe(true)
    expect(result.deleted).toBe(100)
    expect(result.added).toBe(100)
    expect(result.lines).toHaveLength(200)
  })

  it('keeps the default algorithm bounded for completely different large files', () => {
    const oldContent = Array.from({ length: 5000 }, (_, index) => `old-${index}`).join('\n')
    const newContent = Array.from({ length: 5000 }, (_, index) => `new-${index}`).join('\n')
    const result = computeLineDiff(oldContent, newContent)

    expect(result.degraded).toBe(true)
    expect(result.deleted).toBe(5000)
    expect(result.added).toBe(5000)
    expect(result.lines).toHaveLength(10000)
  })

  it('trims large common edges before running the bounded core diff', () => {
    const prefix = Array.from({ length: 1000 }, (_, index) => `prefix-${index}`)
    const suffix = Array.from({ length: 1000 }, (_, index) => `suffix-${index}`)
    const result = computeLineDiff(
      [...prefix, 'old', ...suffix].join('\n'),
      [...prefix, 'new', ...suffix].join('\n'),
      { editDistanceLimit: 4 }
    )

    expect(result.degraded).toBe(false)
    expect(result.deleted).toBe(1)
    expect(result.added).toBe(1)
    expect(result.lines[1000]).toEqual({ type: 'deleted', content: 'old', oldLineNum: 1001 })
    expect(result.lines[1001]).toEqual({ type: 'added', content: 'new', newLineNum: 1001 })
  })

  it('fast-fails to degraded when the core shares no common lines and the distance exceeds the budget', () => {
    // 大文件整体重写：核心区域无任何公共行，且 n+m 超出编辑距离预算，直接退化
    const oldContent = Array.from({ length: 2000 }, (_, index) => `old-${index}`).join('\n')
    const newContent = Array.from({ length: 2000 }, (_, index) => `new-${index}`).join('\n')
    const result = computeLineDiff(oldContent, newContent, { editDistanceLimit: 768 })

    expect(result.degraded).toBe(true)
    expect(result.deleted).toBe(2000)
    expect(result.added).toBe(2000)
    expect(result.lines).toHaveLength(4000)
  })

  it('does not fast-fail when the no-common-line distance stays within the budget', () => {
    // 无公共行但 n+m 未超预算：走 Myers 得到精确结果，degraded 仍为 false（语义不变）
    const result = computeLineDiff('old', 'new', { editDistanceLimit: 768 })
    expect(result.degraded).toBe(false)
    expect(result.deleted).toBe(1)
    expect(result.added).toBe(1)
  })

  it('fast-fail output matches the exhausted-budget fallback', () => {
    // 无公共行且超预算（快速失败）与有小公共行但距离超预算（预算耗尽退化）的输出语义一致：
    // 均为整段核心标记为删除 + 新增，无 unchanged 行混入
    const noCommon = computeLineDiff(
      Array.from({ length: 50 }, (_, index) => `old-${index}`).join('\n'),
      Array.from({ length: 50 }, (_, index) => `new-${index}`).join('\n'),
      { editDistanceLimit: 8 }
    )
    expect(noCommon.degraded).toBe(true)
    expect(noCommon.lines.every(line => line.type !== 'unchanged')).toBe(true)

    const exhausted = computeLineDiff(
      Array.from({ length: 50 }, (_, index) => `old-${index}`).join('\n'),
      Array.from({ length: 50 }, (_, index) => index === 25 ? 'old-0' : `new-${index}`).join('\n'),
      { editDistanceLimit: 8 }
    )
    expect(exhausted.degraded).toBe(true)
    expect(exhausted.deleted).toBe(50)
    expect(exhausted.added).toBe(50)
  })
})

describe('computeLineDiffCached', () => {
  it('returns the identical result object for the same content pair', () => {
    const oldContent = ['alpha', 'beta', 'gamma'].join('\n')
    const newContent = ['alpha', 'delta', 'gamma', 'omega'].join('\n')
    const first = computeLineDiffCached(oldContent, newContent)
    const second = computeLineDiffCached(oldContent, newContent)
    expect(second).toBe(first)
  })

  it('honors start line / edit distance in the cache key', () => {
    const oldContent = 'a\nb'
    const newContent = 'a\nc'
    const plain = computeLineDiffCached(oldContent, newContent)
    const shifted = computeLineDiffCached(oldContent, newContent, { oldStartLine: 10, newStartLine: 20 })
    const limited = computeLineDiffCached(oldContent, newContent, { editDistanceLimit: 1 })

    expect(shifted).not.toBe(plain)
    expect(shifted.lines[1]).toEqual({ type: 'deleted', content: 'b', oldLineNum: 11 })
    expect(shifted.lines[2]).toEqual({ type: 'added', content: 'c', newLineNum: 21 })
    expect(limited).not.toBe(plain)
  })

  it('cache keys on content value: same text built differently still hits', () => {
    const oldContent = ['alpha', 'beta'].join('\n')
    const newContent = ['alpha', 'gamma'].join('\n')
    const first = computeLineDiffCached(oldContent, newContent)
    const rebuilt = Array.from(newContent).join('')
    expect(rebuilt).toBe(newContent)
    const second = computeLineDiffCached(oldContent, rebuilt)
    expect(second).toBe(first)
  })

  it('returns a fresh result when the content differs', () => {
    const oldContent = ['alpha', 'beta'].join('\n')
    const first = computeLineDiffCached(oldContent, ['alpha', 'gamma'].join('\n'))
    const second = computeLineDiffCached(oldContent, ['alpha', 'delta'].join('\n'))
    expect(second).not.toBe(first)
    expect(second.lines.map(line => [line.type, line.content])).toEqual([
      ['unchanged', 'alpha'],
      ['deleted', 'beta'],
      ['added', 'delta']
    ])
  })

  it('cache hit keeps results equivalent to the plain function', () => {
    const oldContent = ['x', 'y', 'z'].join('\n')
    const newContent = ['x', 'y2', 'z'].join('\n')
    const cached = computeLineDiffCached(oldContent, newContent)
    const plain = computeLineDiff(oldContent, newContent)
    expect(cached.lines).toEqual(plain.lines)
    expect(cached.degraded).toBe(plain.degraded)
  })

  it('stays exact with zero budget when the core already matches', () => {
    // editDistanceLimit=0：核心区域相同（trim 后为空）时不退化，走 Myers 得到精确结果
    const result = computeLineDiff('a\nb', 'a\nb', { editDistanceLimit: 0 })
    expect(result.degraded).toBe(false)
    expect(result.lines.every(line => line.type === 'unchanged')).toBe(true)
  })

  it('degrades when edit distance limit is zero and content differs', () => {
    // 无公共行且 n+m > 0（limit 为 0）→ 快速失败退化
    const result = computeLineDiff('a', 'b', { editDistanceLimit: 0 })
    expect(result.degraded).toBe(true)
    expect(result.deleted).toBe(1)
    expect(result.added).toBe(1)
  })

  it('degrades on negative edit distance limit', () => {
    // 负预算不可能完成：主循环不执行，直接退化输出
    const result = computeLineDiff('a\nb', 'a\nc', { editDistanceLimit: -1 })
    expect(result.degraded).toBe(true)
  })

  it('evicts the oldest entry after the FIFO cache reaches 32 entries', () => {
    clearLineDiffCache()
    const oldContent = ['seed'].join('\n')
    const first = computeLineDiffCached(oldContent, 'v0')
    for (let i = 1; i <= 32; i++) {
      computeLineDiffCached(oldContent, `v${i}`)
    }
    // 第 33 条插入时挤出最老的 v0：再次查询返回新计算的对象（引用不同）
    const rehit = computeLineDiffCached(oldContent, 'v0')
    expect(rehit).not.toBe(first)
    // 最近一次仍命中缓存（同一对象引用）
    const lastFirst = computeLineDiffCached(oldContent, 'v32')
    const lastHit = computeLineDiffCached(oldContent, 'v32')
    expect(lastHit).toBe(lastFirst)
  })

  it('clearLineDiffCache forces recomputation', () => {
    const oldContent = ['alpha', 'beta'].join('\n')
    const newContent = ['alpha', 'gamma'].join('\n')
    const before = computeLineDiffCached(oldContent, newContent)
    clearLineDiffCache()
    const after = computeLineDiffCached(oldContent, newContent)
    expect(after).not.toBe(before)
    expect(after.lines).toEqual(before.lines)
  })
})

describe('formatDiffLineNumber', () => {
  it('pads present and absent line numbers consistently', () => {
    expect(formatDiffLineNumber(7, 3)).toBe('  7')
    expect(formatDiffLineNumber(undefined, 3)).toBe('   ')
  })
})
