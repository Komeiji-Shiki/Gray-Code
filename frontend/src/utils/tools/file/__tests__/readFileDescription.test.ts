import { describe, expect } from 'vitest'
import { formatReadFileDescription } from '../read_file'

describe('formatReadFileDescription', () => {
  test('批量读取逐行显示全部文件，不折叠为 +N', () => {
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

  test('单文件摘要保持原有行范围格式', () => {
    expect(formatReadFileDescription({ path: 'src/one.ts', endLine: 8 }))
      .toBe('src/one.ts [L1-8]')
  })

  test('空批量参数不会遮蔽同一次调用中的单文件路径', () => {
    expect(formatReadFileDescription({
      files: [],
      path: 'frontend/src/App.vue',
      startLine: 10,
      endLine: 20
    })).toBe('frontend/src/App.vue [L10-20]')
  })
})
