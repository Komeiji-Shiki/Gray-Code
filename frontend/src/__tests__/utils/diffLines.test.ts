import { describe, expect, it } from 'vitest'
import { buildHunks, computeDiffLines, diffStats } from '../../utils/diffLines'

describe('computeDiffLines', () => {
  it('returns unchanged lines with both line numbers', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nb\nc')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ type: 'unchanged', content: 'a', oldLineNum: 1, newLineNum: 1 })
    expect(lines[2]).toMatchObject({ type: 'unchanged', content: 'c', oldLineNum: 3, newLineNum: 3 })
  })

  it('marks inserted lines as added', () => {
    const lines = computeDiffLines('a\nc', 'a\nb\nc')
    expect(lines[1]).toMatchObject({ type: 'added', content: 'b', newLineNum: 2 })
    expect(lines[1].oldLineNum).toBeUndefined()
  })

  it('marks removed lines as deleted', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nc')
    expect(lines[1]).toMatchObject({ type: 'deleted', content: 'b', oldLineNum: 2 })
    expect(lines[1].newLineNum).toBeUndefined()
  })

  it('handles replacement (del + add pair)', () => {
    const lines = computeDiffLines('line1\nline2', 'line1-x\nline2')
    expect(lines[0].type).toBe('deleted')
    expect(lines[1].type).toBe('added')
  })

  it('line numbers advance correctly across mixed hunks', () => {
    const lines = computeDiffLines('a\nb\nc\nd', 'a\nx\nc\ny\nd')
    // a, (del b), (add x), c, (add y), d
    const deleted = lines.find((l) => l.type === 'deleted')!
    const added = lines.filter((l) => l.type === 'added')
    expect(deleted).toMatchObject({ content: 'b', oldLineNum: 2 })
    expect(added[0]).toMatchObject({ content: 'x', newLineNum: 2 })
    expect(added[1]).toMatchObject({ content: 'y', newLineNum: 4 })
  })

  it('empty contents are handled without throwing', () => {
    // 注意：''.split('\n') === ['']，因此空文件会产出一条空内容未变行（与旧 modal 行为一致）
    expect(computeDiffLines('', '')).toHaveLength(1)
    const fromEmpty = computeDiffLines('', 'a\nb')
    expect(fromEmpty.filter((l) => l.type === 'added')).toHaveLength(2)
  })
})

describe('buildHunks', () => {
  it('groups change blocks with context into hunks', () => {
    const lines = computeDiffLines('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nx\nd\ne\nf\ng\nh\ni\nj')
    const hunks = buildHunks(lines, 3)
    expect(hunks).toHaveLength(1)
    // 变更后仅 3 行上下文（d/e/f），hunk 结束于 g 之前：@@ -1,6 +1,6 @@
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 6, newStart: 1, newCount: 6 })
    expect(hunks[0].lines[2]).toMatchObject({ type: 'deleted', content: 'c' })
    expect(hunks[0].lines[3]).toMatchObject({ type: 'added', content: 'x' })
  })

  it('splits distant change blocks into separate hunks', () => {
    const lines = computeDiffLines(
      'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt',
      'a\nb\nx\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nY\no\np\nq\nr\ns\nt'
    )
    const hunks = buildHunks(lines, 2)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    // first hunk starts at old line 1 (a), second hunk covers the second change
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[1].oldStart).toBeGreaterThan(1)
  })

  it('keeps context lines around a change', () => {
    const lines = computeDiffLines('a\nb\nc\nd\ne', 'a\nb\nx\nd\ne')
    const hunks = buildHunks(lines, 1)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines[0]).toMatchObject({ type: 'unchanged', content: 'b' })
    expect(hunks[0].lines[hunks[0].lines.length - 1]).toMatchObject({ type: 'unchanged', content: 'd' })
  })

  it('counts old/new lines correctly (context 0 keeps only changed lines)', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nx\nc')
    const hunks = buildHunks(lines, 0)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 2, newStart: 2, oldCount: 1, newCount: 1 })
  })

  it('returns empty array when there are no changes', () => {
    expect(buildHunks(computeDiffLines('a\nb', 'a\nb'))).toHaveLength(0)
  })
})

describe('diffStats', () => {
  it('counts added and deleted lines', () => {
    const lines = computeDiffLines('a\nb\nc', 'a\nx\ny\nc')
    expect(diffStats(lines)).toEqual({ added: 2, deleted: 1 })
  })
})
