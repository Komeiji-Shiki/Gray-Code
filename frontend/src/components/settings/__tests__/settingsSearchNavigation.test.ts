import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setLanguage } from '../../../i18n'
import { useSettingsSearch } from '../panel/useSettingsSearch'
import { settingsSearchIndex } from '../panel/settingsSearchIndex'
import type { SettingsTab } from '../../../stores/settingsStore'
import type { SearchIndexEntry } from '../panel/types'

vi.mock('../../../utils/vscode', () => ({ sendToExtension: vi.fn(async () => ({
  tools: [{ name: 'context_notes', description: 'Task notes' }],
})) }))

let wrapper: VueWrapper
let search: ReturnType<typeof useSettingsSearch>
let container: HTMLElement
let activeTab: Ref<SettingsTab>
const entry: SearchIndexEntry = {
  key: 'tools:context_notes', tab: 'tools', labelKey: '', label: '任务笔记', keywords: [],
  anchor: '[data-search-tool="context_notes"]',
}

beforeEach(async () => {
  setLanguage('zh-CN')
  container = document.createElement('div')
  container.innerHTML = '<section class="settings-section"><h4>工具</h4></section>'
  container.scrollTo = vi.fn()
  activeTab = ref<SettingsTab>('general')
  wrapper = mount(defineComponent({ setup() {
    search = useSettingsSearch({ index: settingsSearchIndex(true),
      tabs: computed(() => [{ id: 'tools', label: '工具', icon: 'codicon-tools' }, { id: 'autoExec', label: '自动执行', icon: 'codicon-shield' }]),
      activeTab: () => activeTab.value, selectTab: tab => { activeTab.value = tab }, container: () => container,
    })
    return () => h('div')
  } }))
  await flushPromises()
})
afterEach(() => { wrapper.unmount(); setLanguage('auto') })

test('中文名称和原始工具 ID 都可搜索，切换语言后更新显示名', async () => {
  search.searchQuery.value = '任务笔记'
  expect(search.searchResults.value.map(entry => entry.tab)).toEqual(['tools', 'autoExec'])
  search.searchQuery.value = 'context_notes'
  expect(search.searchResults.value[0].label).toBe('任务笔记')
  setLanguage('en'); await nextTick()
  search.searchQuery.value = 'Task Notes'
  expect(search.searchResults.value[0].label).toBe('Task Notes')
})

test('等待异步出现的具体工具条目，不提前跳到页首', async () => {
  await search.openSearchResult(entry)
  expect(container.scrollTo).not.toHaveBeenCalled()
  const target = document.createElement('div'); target.dataset.searchTool = 'context_notes'
  container.querySelector('section')!.append(target)
  await vi.waitFor(() => expect(target.classList.contains('search-flash')).toBe(true))
  expect(container.scrollTo).toHaveBeenCalledOnce()
})

test('账号与 Bot 搜索进入对应分类，旧提示词关键词指向当前条目编辑器', () => {
  search.searchQuery.value = '主人'
  expect(search.searchResults.value.some(entry => entry.tab === 'accounts')).toBe(true)
  search.searchQuery.value = 'QQ'
  expect(search.searchResults.value.some(entry => entry.tab === 'onebot')).toBe(true)
  search.searchQuery.value = '动态上下文'
  expect(search.searchResults.value.find(entry => entry.tab === 'prompt')?.anchor).toBe('[data-search-anchor="prompt-entries"]')
})

test('用户切换页签后，取消仍在等待内容的旧搜索跳转', async () => {
  await search.openSearchResult(entry)
  activeTab.value = 'general'
  const target = document.createElement('div'); target.dataset.searchTool = 'context_notes'
  container.querySelector('section')!.append(target)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(container.scrollTo).not.toHaveBeenCalled()
  expect(target.classList.contains('search-flash')).toBe(false)
})
