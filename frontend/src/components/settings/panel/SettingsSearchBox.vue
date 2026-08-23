<script setup lang="ts">
/**
 * SettingsSearchBox - 设置项搜索框 + 结果下拉
 *
 * 从 SettingsPanel.vue 模板拆分（T12 批次，纯结构性拆分，行为零变化）：
 * - 纯展示组件：query / focused / activeIndex / results 均由父组件通过 props 注入
 *   （v-model 协议回写），自身不持有任何业务状态；
 * - 仅保留模板 ref 与 DOM 副作用：外部点击关闭下拉、选中项滚动跟随、
 *   Esc/回车/方向键的键盘交互（通过 emits 回传父组件处理）。
 */
import { computed, getCurrentInstance, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { t } from '@/i18n'
import type { SettingsTab } from '@/stores/settingsStore'
import type { SearchIndexEntry } from './types'

const props = defineProps<{
  query: string
  focused: boolean
  activeIndex: number
  searchActive: boolean
  results: SearchIndexEntry[]
  tabIcon: (tabId: SettingsTab) => string
}>()

const emit = defineEmits<{
  (e: 'update:query', value: string): void
  (e: 'update:focused', value: boolean): void
  (e: 'update:activeIndex', value: number): void
  (e: 'open', entry: SearchIndexEntry): void
  (e: 'move', delta: number): void
}>()

const searchRootRef = ref<HTMLElement>()
const searchInputRef = ref<HTMLInputElement>()
const instanceId = getCurrentInstance()?.uid ?? 0
const resultsId = `gc-settings-search-results-${instanceId}`

function getResultId(index: number): string {
  return `gc-settings-search-result-${instanceId}-${index}`
}

const activeResultId = computed(() => {
  if (!props.focused || !props.searchActive || props.results.length === 0) return undefined
  return getResultId(Math.min(props.activeIndex, props.results.length - 1))
})

// M-2：键盘导航/鼠标悬停时让选中项保持在下拉可视区域内（结果超出 max-height 时跟随滚动）
watch(() => props.activeIndex, () => {
  nextTick(() => {
    searchRootRef.value?.querySelector('.settings-search-result.active')?.scrollIntoView({ block: 'nearest' })
  })
})

function closeDropdown() {
  emit('update:focused', false)
}

// Esc：关闭下拉并清空查询
function handleEsc() {
  closeDropdown()
  emit('update:query', '')
  emit('update:activeIndex', 0)
}

function clearSearch() {
  emit('update:query', '')
  emit('update:activeIndex', 0)
  searchInputRef.value?.focus()
}

// Enter：打开当前选中项
function openSelection() {
  const list = props.results
  if (list.length === 0) return
  emit('open', list[Math.min(props.activeIndex, list.length - 1)])
}

function handleOutsideClick(event: MouseEvent) {
  if (!props.focused) return
  const root = searchRootRef.value
  if (root && !root.contains(event.target as Node)) {
    closeDropdown()
  }
}

onMounted(() => {
  document.addEventListener('click', handleOutsideClick)
})

onUnmounted(() => {
  document.removeEventListener('click', handleOutsideClick)
})
</script>

<template>
  <div ref="searchRootRef" class="settings-search-root">
    <div
      class="settings-search-box"
      :class="{ focused, 'has-query': !!query }"
    >
      <i class="codicon codicon-search settings-search-icon" aria-hidden="true"></i>
      <input
        ref="searchInputRef"
        :value="query"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        :aria-label="t('components.settings.settingsPanel.search.placeholder')"
        :aria-expanded="focused"
        :aria-controls="resultsId"
        :aria-activedescendant="activeResultId"
        :placeholder="t('components.settings.settingsPanel.search.placeholder')"
        @focus="emit('update:focused', true)"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        @keydown.down.prevent="emit('move', 1)"
        @keydown.up.prevent="emit('move', -1)"
        @keydown.enter.prevent="openSelection"
        @keydown.esc="handleEsc"
      />
      <button
        v-if="query"
        type="button"
        class="settings-search-clear"
        :title="t('components.settings.settingsPanel.search.clear')"
        :aria-label="t('components.settings.settingsPanel.search.clear')"
        @click="clearSearch"
      >
        <i class="codicon codicon-close" aria-hidden="true"></i>
      </button>
    </div>
    <Transition name="settings-search-dropdown">
      <div
        v-if="focused"
        :id="resultsId"
        class="settings-search-results"
        role="listbox"
        :aria-label="t('components.settings.settingsPanel.search.placeholder')"
        :class="{ 'is-empty': searchActive && results.length === 0 }"
      >
        <template v-if="searchActive && results.length > 0">
          <div
            v-for="(result, index) in results"
            :id="getResultId(index)"
            :key="result.key"
            class="settings-search-result"
            role="option"
            :aria-selected="index === activeIndex"
            :class="{ active: index === activeIndex }"
            @mousedown.prevent="emit('open', result)"
            @mouseenter="emit('update:activeIndex', index)"
          >
            <i :class="['codicon', tabIcon(result.tab)]" aria-hidden="true"></i>
            <span class="settings-search-result-label">{{ t(result.labelKey) }}</span>
            <span class="settings-search-result-tab">{{ t(`components.settings.tabs.${result.tab}`) }}</span>
          </div>
        </template>
        <div v-else-if="searchActive" class="settings-search-no-results" role="status">
          <i class="codicon codicon-search"></i>
          {{ t('components.settings.settingsPanel.search.noResults') }}
        </div>
        <div v-else class="settings-search-no-results" role="status">
          <i class="codicon codicon-search"></i>
          {{ t('components.settings.settingsPanel.search.hint') }}
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ===== 设置项搜索 ===== */

.settings-search-root {
  position: relative;
  flex: 1;
  max-width: 380px;
  margin: 0 12px;
}

.settings-search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--vscode-input-background, var(--gc-surface-base));
  color: var(--vscode-input-foreground, var(--gc-text-primary));
  transition:
    border-color var(--gc-duration-fast) var(--gc-ease-standard),
    box-shadow var(--gc-duration-fast) var(--gc-ease-standard);
}

.settings-search-box.focused {
  border-color: var(--gc-focus-border);
  box-shadow: 0 0 0 1px var(--gc-focus-border);
}

.settings-search-icon {
  font-size: 12px;
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.settings-search-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
}

.settings-search-box input::placeholder {
  color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground, #9d9d9d));
}

.settings-search-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: var(--gc-radius-xs);
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  flex-shrink: 0;
}

.settings-search-clear:hover {
  background: var(--gc-surface-hover);
  color: var(--gc-text-primary);
}

.settings-search-clear .codicon {
  font-size: 11px;
}

.settings-search-results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: var(--gc-layer-popover);
  max-height: 300px;
  overflow-y: auto;
  padding: 4px 0;
  background: var(--vscode-dropdown-background, var(--gc-surface-raised));
  border: 1px solid var(--vscode-dropdown-border, var(--gc-border-strong));
  border-radius: var(--gc-radius-sm);
  box-shadow: var(--gc-shadow-md);
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-primary);
}

.settings-search-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  min-width: 0;
}

.settings-search-result:hover,
.settings-search-result.active {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.settings-search-result .codicon {
  font-size: 12px;
  flex-shrink: 0;
}

.settings-search-result-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-search-result-tab {
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.settings-search-result:hover .settings-search-result-tab,
.settings-search-result.active .settings-search-result-tab {
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
  opacity: 0.8;
}

.settings-search-no-results {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.settings-search-no-results .codicon {
  font-size: 12px;
}

.settings-search-dropdown-enter-active,
.settings-search-dropdown-leave-active {
  transition:
    opacity var(--gc-duration-fast) var(--gc-ease-standard),
    transform var(--gc-duration-fast) var(--gc-ease-standard);
}

.settings-search-dropdown-enter-from,
.settings-search-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
