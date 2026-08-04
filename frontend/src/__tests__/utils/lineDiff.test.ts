import { describe, expect, it } from 'vitest'
import { computeLineDiff, formatDiffLineNumber } from '../../utils/lineDiff'

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
})

describe('formatDiffLineNumber', () => {
  it('pads present and absent line numbers consistently', () => {
    expect(formatDiffLineNumber(7, 3)).toBe('  7')
    expect(formatDiffLineNumber(undefined, 3)).toBe('   ')
  })
})
