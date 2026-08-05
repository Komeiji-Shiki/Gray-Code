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

  it('does not fast-fail when n + m exactly equals the budget', () => {
    // 边界：n+m === limit 不满足快速失败条件（n+m > limit），走 Myers 得到精确结果。
    // 若误判为“超出预算”会错误退化，且输出与精确结果不一致。
    const result = computeLineDiff('a\nb', 'c\nd', { editDistanceLimit: 4 })
    expect(result.degraded).toBe(false)
    expect(result.deleted).toBe(2)
    expect(result.added).toBe(2)
    expect(result.lines).toEqual([
      { type: 'deleted', content: 'a', oldLineNum: 1 },
      { type: 'deleted', content: 'b', oldLineNum: 2 },
      { type: 'added', content: 'c', newLineNum: 1 },
      { type: 'added', content: 'd', newLineNum: 2 }
    ])
  })

  it('clamps an oversized edit distance limit to bound trace memory', () => {
    // 核心无公共行且 n+m 与 editDistanceLimit 都很大：若未钳制，limit = min(n+m, 100000) = 4200，
    // 不满足快速失败条件（n+m > limit 为假），Myers 会跑完并找到精确距离（degraded=false）。
    // 钳制后 limit = 4096，n+m=4200 > 4096 触发快速失败退化——观测结果证明钳制生效。
    const coreOld = ['shared', ...Array.from({ length: 2100 }, (_, i) => `o-${i}`)]
    const coreNew = ['shared', ...Array.from({ length: 2100 }, (_, i) => `n-${i}`)]
    const result = computeLineDiff(coreOld.join('\n'), coreNew.join('\n'), { editDistanceLimit: 100000 })

    expect(result.degraded).toBe(true)
    expect(result.deleted).toBe(2100)
    expect(result.added).toBe(2100)
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

  it('enforces the shared read-only contract: same reference and stable content across calls', () => {
    // 契约守卫（A-M3）：命中缓存返回同一引用（结果对象与其 lines 数组均共享），
    // 且在不 mutate 的前提下多次调用内容稳定。消费方不得修改共享对象。
    const oldContent = ['alpha', 'beta', 'gamma', 'delta'].join('\n')
    const newContent = ['alpha', 'delta', 'gamma', 'omega'].join('\n')

    const first = computeLineDiffCached(oldContent, newContent)
    const second = computeLineDiffCached(oldContent, newContent)
    expect(second).toBe(first)
    expect(second.lines).toBe(first.lines)
    expect(second.added).toBe(first.added)
    expect(second.deleted).toBe(first.deleted)
    expect(second.degraded).toBe(first.degraded)

    // 快照（复制）后再查询：共享对象未被污染，内容保持一致
    const snapshot = first.lines.map(line => ({ ...line }))
    const third = computeLineDiffCached(oldContent, newContent)
    expect(third).toBe(first)
    expect(third.lines).toEqual(snapshot)
    expect(third.lines).toEqual(first.lines)
  })

  it('normalizes oversized edit distance limits in the cache key', () => {
    // 钳制后的预算参与缓存键：传入超限预算与钳制预算应命中同一结果（引用一致）
    const oldContent = ['alpha', 'beta'].join('\n')
    const newContent = ['alpha', 'gamma'].join('\n')
    const clamped = computeLineDiffCached(oldContent, newContent, { editDistanceLimit: 100000 })
    const capped = computeLineDiffCached(oldContent, newContent, { editDistanceLimit: 4096 })
    expect(capped).toBe(clamped)
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
