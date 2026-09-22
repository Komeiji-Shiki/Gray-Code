import { computed, nextTick, onMounted, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { t } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'
import { getToolDescription, getToolDisplayName } from '@/utils/toolLocalization'
import type { SettingsTab } from '@/stores/settingsStore'
import type { SearchIndexEntry, TabItem } from './types'

interface SearchOptions {
  index: readonly SearchIndexEntry[]
  tabs: ComputedRef<TabItem[]>
  activeTab: () => SettingsTab
  selectTab: (tab: SettingsTab) => void | boolean | Promise<void | boolean>
  container: () => HTMLElement | null | undefined
}

/** 静态设置与运行时工具共用搜索入口，异步页签加载后再定位具体条目。 */
export function useSettingsSearch(options: SearchOptions) {
  const searchQuery = ref('')
  const searchFocused = ref(false)
  const activeSearchIndex = ref(0)
  const tools = ref<Array<{ name: string; description: string }>>([])
  let disposed = false
  let navigation = 0
  let cancelWait: (() => void) | undefined
  let frame: number | undefined
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  let highlighted: HTMLElement | undefined

  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '')
  const normalizedQuery = computed(() => normalize(searchQuery.value.trim()))
  const searchActive = computed(() => normalizedQuery.value.length > 0)
  const toolEntries = computed<SearchIndexEntry[]>(() => tools.value.flatMap(tool => {
    const label = getToolDisplayName(tool.name)
    return (['tools', 'autoExec'] as const).map(tab => ({
      key: `${tab}:${tool.name}`, tab, label,
      labelKey: `components.settings.toolsSettings.toolDisplayNames.${tool.name}`,
      keywords: [tool.name, label, getToolDescription(tool.name, tool.description)],
      anchor: `[data-search-tool="${encodeURIComponent(tool.name)}"]`,
    }))
  }))
  const searchResults = computed(() => {
    const query = normalizedQuery.value
    if (!query) return []
    const tabOrder = new Map(options.tabs.value.map((tab, index) => [tab.id, index]))
    return [...options.index, ...toolEntries.value]
      .filter(entry => normalize(entry.label ?? t(entry.labelKey)).includes(query)
        || entry.keywords.some(keyword => normalize(keyword).includes(query)))
      .sort((a, b) => (tabOrder.get(a.tab) ?? 99) - (tabOrder.get(b.tab) ?? 99))
  })
  const tabsWithMatches = computed(() => new Set(searchResults.value.map(entry => entry.tab)))
  const tabIcon = (tabId: SettingsTab) => options.tabs.value.find(tab => tab.id === tabId)?.icon || 'codicon-settings-gear'

  watch(searchQuery, () => { activeSearchIndex.value = 0 })
  function moveSearchSelection(delta: number) {
    const count = searchResults.value.length
    if (count) activeSearchIndex.value = (activeSearchIndex.value + delta + count) % count
  }
  function cancelNavigation() {
    navigation++
    cancelWait?.(); cancelWait = undefined
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (flashTimer !== undefined) clearTimeout(flashTimer)
    highlighted?.classList.remove('search-flash')
    frame = undefined; flashTimer = undefined; highlighted = undefined
  }
  watch(options.activeTab, cancelNavigation, { flush: 'sync' })

  async function openSearchResult(entry: SearchIndexEntry) {
    cancelNavigation()
    searchFocused.value = false
    if (await options.selectTab(entry.tab) === false || disposed || options.activeTab() !== entry.tab) return
    searchQuery.value = ''; activeSearchIndex.value = 0
    const request = navigation
    await nextTick()
    const container = options.container()
    if (disposed || request !== navigation || !container) return
    const fallback = () => container.querySelector<HTMLElement>('.settings-section h4, .settings-section h3, [data-search-anchor]') ?? container
    const find = () => entry.anchor ? container.querySelector<HTMLElement>(entry.anchor) : fallback()
    const reveal = (target: HTMLElement) => {
      cancelWait?.(); cancelWait = undefined
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (disposed || request !== navigation) return
        const top = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        highlighted = target; target.classList.add('search-flash')
        flashTimer = setTimeout(() => { target.classList.remove('search-flash'); highlighted = undefined; flashTimer = undefined }, 1600)
      })
    }
    const target = find()
    if (target) { reveal(target); return }
    // 页签组件和工具目录会分别异步加载，观察实际条目，避免 nextTick 后立即退回页首。
    const observer = new MutationObserver(() => { const target = find(); if (target) reveal(target) })
    const timeout = setTimeout(() => reveal(fallback()), 4000)
    cancelWait = () => { observer.disconnect(); clearTimeout(timeout) }
    observer.observe(container, { childList: true, subtree: true })
  }

  onMounted(async () => {
    try {
      const response = await sendToExtension<{ tools: Array<{ name: string; description: string }> }>(MESSAGE_NAMES['tools.getTools'], {})
      if (!disposed) tools.value = response?.tools ?? []
    } catch (error) { console.warn('Failed to load tools for settings search:', error) }
  })
  onUnmounted(() => { disposed = true; cancelNavigation() })
  return { searchQuery, searchFocused, activeSearchIndex, searchActive, searchResults, tabsWithMatches, tabIcon, moveSearchSelection, openSearchResult }
}
