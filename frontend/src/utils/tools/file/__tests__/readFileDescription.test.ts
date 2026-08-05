import { describe, expect, it } from 'vitest'
import { formatReadFileDescription } from '../read_file'

describe('formatReadFileDescription', () => {
  it('批量读取逐行显示全部文件，不折叠为 +N', () => {
    expect(formatReadFileDescription({
      files: [
        { path: 'src/first.ts', startLine: 1, endLine: 10 },
        { path: 'src/second.ts' },
        { path: 'src/third.ts', startLine: 20 }
      ]
    })).toBe([
      'src/first.ts [L1-10]',
      'src/second.ts',
      'src/third.ts [L20+]'
    ].join('\n'))
  })

  it('单文件摘要保持原有行范围格式', () => {
    expect(formatReadFileDescription({ path: 'src/one.ts', endLine: 8 }))
      .toBe('src/one.ts [L1-8]')
  })
})
