import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import FindFiles from '../find_files.vue'

const wrappers: VueWrapper[] = []
function open(result?: Record<string, unknown>, args: Record<string, unknown> = { patterns: ['**/*.ts'] }, error?: string) {
  const wrapper = mount(FindFiles, {
    props: { args, result, error },
    global: { stubs: { CustomScrollbar: { template: '<div><slot /></div>' } } }
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => setLanguage('en'))
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setLanguage('auto') })

test('legacy single-pattern receipts retain files and line counts without claiming pagination or exclusion defaults', () => {
  const wrapper = open({ data: {
    files: ['src/a.ts', 'empty.ts', 'image.png'],
    fileDetails: [{ path: 'src/a.ts', lineCount: 20 }, { path: 'empty.ts', lineCount: 0 }, { path: 'image.png' }],
    count: 3
  } }, { pattern: '*.ts', exclude: '**/not-necessarily-effective/**', offset: 100 })
  expect(wrapper.get('.pattern-text').text()).toBe('*.ts')
  expect(wrapper.findAll('.file-item')).toHaveLength(3)
  expect(wrapper.findAll('.line-count-badge').map(badge => badge.text())).toEqual(['20 lines', '0 lines'])
  expect(wrapper.get('.stat.success').text()).toBe('1')
  expect(wrapper.get('.stat.total').text()).toBe('3 files returned')
  expect(wrapper.find('.exclusion-policy').exists()).toBe(false)
  expect(wrapper.find('.pagination-info').exists()).toBe(false)
})

test('legacy string-only results still render and count returned paths when count metadata is absent', () => {
  const wrapper = open({ data: { files: ['a.ts', 'nested/b.ts'] } }, { pattern: '*.ts' })
  expect(wrapper.findAll('.file-name').map(item => item.text())).toEqual(['a.ts', 'b.ts'])
  expect(wrapper.get('.stat.total').text()).toBe('2 files returned')
  expect(wrapper.find('.line-count-badge').exists()).toBe(false)
})

test('parameters without a receipt do not report success or no matches', () => {
  const wrapper = open()
  expect(wrapper.find('.stat.success').exists()).toBe(false)
  expect(wrapper.find('.stat.error').exists()).toBe(false)
  expect(wrapper.find('.no-files').exists()).toBe(false)
})

test('tool pagination stays separate from expanding the ten-file local preview', async () => {
  const files = Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`)
  const continuationHint = 'Continue this pattern with offset=32 and unchanged exclude; restart at offset=0 if files or settings changed.'
  const wrapper = open({ success: true, data: {
    results: [{ pattern: '**/*.ts', success: true, files, count: 12, offset: 20, nextOffset: 32, truncated: true, continuationHint }],
    totalFiles: 12, effectiveExclude: '**/node_modules/**', excludeSource: 'fallback'
  } })
  expect(wrapper.get('.page-offset').text()).toBe('This page skips 20 files')
  expect(wrapper.get('.file-count').text()).toBe('12 files on this page')
  expect(wrapper.get('.next-offset').text()).toContain('Call again for the next page: offset=32')
  expect(wrapper.get('.continuation-details p').text()).toBe(continuationHint)
  expect(wrapper.findAll('.file-item')).toHaveLength(10)
  expect(wrapper.get('.expand-btn').text()).toBe('Show 2 more files on this page')
  expect(wrapper.get('.expand-btn').attributes('aria-expanded')).toBe('false')
  await wrapper.get('.expand-btn').trigger('click')
  expect(wrapper.findAll('.file-item')).toHaveLength(12)
  expect(wrapper.get('.expand-btn').attributes('aria-expanded')).toBe('true')
  expect(wrapper.get('.next-offset').text()).toContain('offset=32')
  expect(wrapper.emitted('execute')).toBeUndefined()
  await wrapper.get('.expand-btn').trigger('click')
  expect(wrapper.findAll('.file-item')).toHaveLength(10)
})

test('each pattern displays its own returned cursor, including zero, rather than the submitted offset', () => {
  const wrapper = open({ success: true, data: { results: [
    { pattern: '*.ts', success: true, files: ['a.ts'], offset: 0, nextOffset: 1 },
    { pattern: '*.md', success: true, files: ['a.md'], offset: 5, nextOffset: 6 }
  ] } }, { patterns: ['*.ts', '*.md'], offset: 99 })
  expect(wrapper.findAll('.page-offset').map(item => item.text())).toEqual(['This page skips 0 files', 'This page skips 5 files'])
  expect(wrapper.findAll('.next-offset').map(item => item.text())).toEqual([
    'Call again for the next page: offset=1, with this pattern and exclusions unchanged',
    'Call again for the next page: offset=6, with this pattern and exclusions unchanged'
  ])
})

test('truncated old receipts do not invent a next page from the count or arguments', () => {
  const wrapper = open({ data: { files: ['a.ts'], count: 1, truncated: true } }, { pattern: '*.ts', offset: 30 })
  expect(wrapper.get('.truncated-badge').text()).toBe('Truncated')
  expect(wrapper.find('.next-offset').exists()).toBe(false)
  expect(wrapper.find('.pagination-info').exists()).toBe(false)
})

test.each([
  ['argument', 'Call argument (replaces settings)'],
  ['settings', 'Tool settings'],
  ['fallback', 'Default fallback'],
  ['future-source', 'Source not recorded']
])('effective exclusions expose the actual %s source rather than the submitted argument', (excludeSource, label) => {
  const wrapper = open({ success: true, data: {
    results: [{ pattern: '*.ts', success: true, files: [] }],
    effectiveExclude: '{**/vendor/**,**/generated/**}', excludeSource
  } }, { patterns: ['*.ts'], exclude: '**/argument-that-was-not-applied/**' })
  expect(wrapper.get('.exclude-source').text()).toBe(label)
  expect(wrapper.get('.effective-exclude').text()).toBe('{**/vendor/**,**/generated/**}')
  expect(wrapper.get('.exclusion-policy').text()).not.toContain('excludeSource')
  expect(wrapper.get('.exclusion-policy').text()).not.toContain('effectiveExclude')
})

test('partial workspace failure shows available files, errors and restart guidance together without a success or next-page claim', () => {
  const wrapper = open({ success: false, error: '1 patterns failed to search', data: {
    results: [{
      pattern: '**/*.ts', success: false, files: ['good/src/a.ts'], fileDetails: [{ path: 'good/src/a.ts', lineCount: 7 }],
      count: 1, offset: 0, truncated: true, error: '1 workspace(s) failed to search',
      workspaceErrors: [{ workspace: 'unavailable-root', error: 'Access denied' }],
      continuationHint: 'Resolve the reported search errors, then restart this pattern at offset=0.'
    }], totalFiles: 1, successCount: 0, failCount: 1
  } })
  expect(wrapper.get('.pattern-panel').classes()).toContain('is-error')
  expect(wrapper.get('.partial-badge').text()).toBe('Partial result')
  expect(wrapper.get('.pattern-error').text()).toContain('1 workspace(s) failed to search')
  expect(wrapper.get('.workspace-errors').text()).toContain('unavailable-root: Access denied')
  expect(wrapper.get('.file-name').text()).toBe('a.ts')
  expect(wrapper.get('.line-count-badge').text()).toBe('7 lines')
  expect(wrapper.get('.stat.total').text()).toBe('1 files returned')
  expect(wrapper.get('.stat.error').text()).toBe('1')
  expect(wrapper.find('.stat.success').exists()).toBe(false)
  expect(wrapper.find('.no-files').exists()).toBe(false)
  expect(wrapper.find('.next-offset').exists()).toBe(false)
  expect(wrapper.get('.restart-hint').text()).toContain('restart at offset=0')
  expect(wrapper.get('.continuation-details').text()).toContain('Resolve the reported search errors')
})

test('explicit partial overrides contradictory success summaries and cursors, even with no files', () => {
  const wrapper = open({ success: true, data: {
    results: [{ pattern: '*.ts', success: true, partial: true, files: [], count: 0, offset: 0, nextOffset: 10 }],
    successCount: 1, failCount: 0
  } })
  expect(wrapper.get('.partial-badge').text()).toBe('Partial result')
  expect(wrapper.get('.stat.error').text()).toBe('1')
  expect(wrapper.find('.stat.success').exists()).toBe(false)
  expect(wrapper.find('.no-files').exists()).toBe(false)
  expect(wrapper.find('.next-offset').exists()).toBe(false)
  expect(wrapper.get('.restart-hint').text()).toContain('cannot provide reliable continuation')
})

test('mixed results count real successes independently and retain failed-pattern files', () => {
  const wrapper = open({ success: false, data: { results: [
    { pattern: '*.ts', success: true, files: ['a.ts'], count: 1 },
    { pattern: '*.md', success: false, files: ['a.md'], count: 1, error: 'one root failed' }
  ] } })
  expect(wrapper.get('.stat.success').text()).toBe('1')
  expect(wrapper.get('.stat.error').text()).toBe('1')
  expect(wrapper.get('.stat.total').text()).toBe('2 files returned')
  expect(wrapper.findAll('.file-item')).toHaveLength(2)
})

test('legacy failed receipts keep files without inferring success and escape externally supplied guidance', () => {
  const wrapper = open({ success: false, error: 'Read failed', data: {
    files: ['available.ts'], continuationHint: '<img src=x onerror=alert(1)>'
  } })
  expect(wrapper.get('.pattern-error').text()).toBe('Read failed')
  expect(wrapper.get('.file-name').text()).toBe('available.ts')
  expect(wrapper.find('.stat.success').exists()).toBe(false)
  expect(wrapper.get('.continuation-details p').text()).toBe('<img src=x onerror=alert(1)>')
  expect(wrapper.find('img').exists()).toBe(false)
})

test('validation failures use the result envelope error even without a separate error prop', () => {
  const wrapper = open({ success: false, error: 'offset must be a non-negative safe integer' })
  expect(wrapper.get('.pattern-error').text()).toBe('offset must be a non-negative safe integer')
  expect(wrapper.find('.stat.success').exists()).toBe(false)
  expect(wrapper.find('.no-files').exists()).toBe(false)
  const noPattern = open({ success: false, error: 'patterns is required' }, {})
  expect(noPattern.get('.panel-error').text()).toBe('patterns is required')
})

test('successful empty receipts still report no matches', () => {
  const wrapper = open({ success: true, data: { results: [{ pattern: '*.ts', success: true, files: [], offset: 0 }] } })
  expect(wrapper.get('.no-files').text()).toBe('No matching files found')
  expect(wrapper.find('.pattern-error').exists()).toBe(false)
})

test.each(['zh-CN', 'en', 'ja'] as const)('new presentation labels resolve through the shared %s language source', language => {
  setLanguage(language)
  const wrapper = open({ success: true, data: {
    results: [{ pattern: '*.ts', success: true, files: ['a.ts'], count: 1, offset: 0, nextOffset: 1 }],
    effectiveExclude: '**/vendor/**', excludeSource: 'settings'
  } })
  expect(wrapper.text()).not.toContain('components.tools.')
})
