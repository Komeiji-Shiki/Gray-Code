import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setLanguage } from '../../../../i18n'
import SearchResult from '../search_in_files.vue'

beforeEach(() => { setActivePinia(createPinia()); setLanguage('zh-CN') })
afterEach(() => setLanguage('auto'))

test('搜索卡片直接展示续查位置和截断原因建议', () => {
  const wrapper = mount(SearchResult, { props: { args: { query: 'hit' }, result: { success: true, data: {
    results: [{ file: 'a.ts', line: 1, column: 1, match: 'hit', context: '1: hit' }], count: 1,
    truncated: true, nextOffset: 1, continuationHint: 'Continue with offset=1 and unchanged search parameters.',
  } } } })
  try {
    expect(wrapper.get('.search-next-offset').text()).toContain('1')
    expect(wrapper.get('.search-continuation').text()).toContain('offset=1')
  } finally { wrapper.unmount() }
})

test('预算截断只有收窄建议，不伪造下一页', () => {
  const wrapper = mount(SearchResult, { props: { args: { query: 'hit' }, result: { success: true, data: {
    results: [], count: 0, truncated: true, continuationHint: 'Output budget omitted matches: narrow query/path/pattern.',
  } } } })
  try {
    expect(wrapper.find('.search-next-offset').exists()).toBe(false)
    expect(wrapper.get('.search-continuation').text()).toContain('narrow')
  } finally { wrapper.unmount() }
})
