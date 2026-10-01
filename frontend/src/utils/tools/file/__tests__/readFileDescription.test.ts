import { afterEach, beforeEach, describe, expect } from 'vitest'
import { setLanguage } from '../../../../i18n'
import type { ToolUsage } from '../../../../types'
import { formatReadFileDescription } from '../read_file'

beforeEach(() => setLanguage('zh-CN'))
afterEach(() => setLanguage('auto'))

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

  test('与后端别名一致，file_path 写法也显示文件名', () => {
    expect(formatReadFileDescription({ file_path: 'src/alias.ts', startLine: 3 })).toBe('src/alias.ts [L3+]')
    expect(formatReadFileDescription({ files: [{ file_path: 'src/batch.ts' }] })).toBe('src/batch.ts')
  })

  test('参数缺少路径时改用结果里的实际文件，都没有时明确显示无文件', () => {
    const tool = { id: 't', name: 'read_file', args: {}, status: 'error',
      result: { success: false, data: { results: [{ path: 'missing.ts', success: false, error: 'ENOENT' }] } } } as ToolUsage
    expect(formatReadFileDescription({}, tool)).toBe('missing.ts')
    expect(formatReadFileDescription({})).toBe('无文件')
    expect(formatReadFileDescription({}, { ...tool, result: { success: false, error: 'Either `path` or `files` is required.' } })).toBe('无文件')
  })
})
