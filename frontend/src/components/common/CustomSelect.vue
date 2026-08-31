<script setup lang="ts">
/**
 * 自定义下拉选择框组件
 * 支持 v-model 双向绑定
 *
 * 选项面板 Teleport 到 body 后按视口坐标定位：对话框的 overflow 滚动容器、
 * 带 contain / transform 的祖先元素都不会再裁掉它或改写它的定位参照。
 */

import { ref, computed, onMounted, onUnmounted, watch, getCurrentInstance, nextTick } from 'vue'
import CustomScrollbar from './CustomScrollbar.vue'
import type { SelectOption } from './types'
import { t } from '@/i18n'

export type { SelectOption }

const props = withDefaults(defineProps<{
  modelValue: string
  options: SelectOption[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  searchable?: boolean
  dropUp?: boolean  // 强制向上展开；默认由视口剩余空间自动决定展开方向
  compact?: boolean  // 紧凑模式
  dropdownFitContent?: boolean  // 面板宽度按选项内容自适应（默认与触发器等宽）
}>(), {
  placeholder: '',
  ariaLabel: '',
  disabled: false,
  searchable: false,
  dropUp: false,
  compact: false,
  dropdownFitContent: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const isOpen = ref(false)
const searchQuery = ref('')
const highlightedIndex = ref(-1)
const containerRef = ref<HTMLElement>()
const triggerRef = ref<HTMLButtonElement>()
const inputRef = ref<HTMLInputElement>()
const instanceId = getCurrentInstance()?.uid ?? 0
const listboxId = `gc-select-listbox-${instanceId}`

// ==================== 面板定位（挂到 body，按视口坐标摆放） ====================
/** 面板与触发器之间的间距 */
const PANEL_GAP = 4
/** 面板与视口边缘的最小留白 */
const PANEL_VIEWPORT_MARGIN = 8
/** 选项列表期望的最大高度 */
const PANEL_LIST_MAX_HEIGHT = 200
/** 空间再紧也要保证的最低可滚动高度 */
const PANEL_LIST_MIN_HEIGHT = 96
/** searchable 时搜索框连同分隔线占用的高度，用于从面板总高里扣掉 */
const PANEL_SEARCH_ROW_HEIGHT = 40

const dropdownRef = ref<HTMLElement>()
const panelStyle = ref<Record<string, string>>({})
const panelDropUp = ref(false)
const listMaxHeight = ref(PANEL_LIST_MAX_HEIGHT)

function getOptionId(index: number): string {
  return `gc-select-option-${instanceId}-${index}`
}

const selectedOption = computed(() => {
  return props.options.find(opt => opt.value === props.modelValue)
})

// 未传入 placeholder 时回退到 i18n 默认值（跟随语言切换）
const resolvedPlaceholder = computed(() => props.placeholder || t('components.common.customSelect.placeholder'))
const accessibleLabel = computed(() => props.ariaLabel || resolvedPlaceholder.value)
const activeOptionId = computed(() => {
  if (!isOpen.value || highlightedIndex.value < 0 || highlightedIndex.value >= filteredOptions.value.length) {
    return undefined
  }
  return getOptionId(highlightedIndex.value)
})

const filteredOptions = computed(() => {
  if (!searchQuery.value) {
    return props.options
  }
  const query = searchQuery.value.toLowerCase()
  return props.options.filter(opt => 
    opt.label.toLowerCase().includes(query) ||
    opt.description?.toLowerCase().includes(query)
  )
})

/**
 * 按触发器的视口矩形计算面板位置：下方放不下且上方更宽裕时朝上展开，
 * 列表最大高度按剩余空间压缩，保证面板始终完整落在视口内。
 */
function updatePanelPosition() {
  const trigger = triggerRef.value
  if (!trigger || !isOpen.value) return

  const rect = trigger.getBoundingClientRect()
  // 触发器被滚出视口（对话框背景滚动、宿主面板折叠等）时直接收起，避免浮层悬空
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    close()
    return
  }

  const spaceBelow = window.innerHeight - rect.bottom - PANEL_GAP - PANEL_VIEWPORT_MARGIN
  const spaceAbove = rect.top - PANEL_GAP - PANEL_VIEWPORT_MARGIN
  const dropUp = props.dropUp || (spaceBelow < PANEL_LIST_MAX_HEIGHT && spaceAbove > spaceBelow)
  listMaxHeight.value = Math.min(
    PANEL_LIST_MAX_HEIGHT,
    Math.max(PANEL_LIST_MIN_HEIGHT, dropUp ? spaceAbove : spaceBelow)
  )
  const left = Math.min(
    Math.max(rect.left, PANEL_VIEWPORT_MARGIN),
    Math.max(PANEL_VIEWPORT_MARGIN, window.innerWidth - rect.width - PANEL_VIEWPORT_MARGIN)
  )

  const next: Record<string, string> = {
    left: `${left}px`,
    top: dropUp ? 'auto' : `${rect.bottom + PANEL_GAP}px`,
    bottom: dropUp ? `${window.innerHeight - rect.top + PANEL_GAP}px` : 'auto',
    maxHeight: `${listMaxHeight.value + (props.searchable ? PANEL_SEARCH_ROW_HEIGHT : 0)}px`
  }
  // 内容自适应时不写死宽度：交给 shrink-to-fit 取内容宽，再用 min-width 保证不窄于触发器
  if (props.dropdownFitContent) {
    next.minWidth = `${rect.width}px`
  } else {
    next.width = `${rect.width}px`
  }
  panelStyle.value = next
  panelDropUp.value = dropUp
}

/** 内容自适应的面板可能比触发器宽，测量后把右侧溢出拉回视口内 */
function clampPanelIntoViewport() {
  const panel = dropdownRef.value
  if (!panel) return
  const box = panel.getBoundingClientRect()
  const overflow = box.right - (window.innerWidth - PANEL_VIEWPORT_MARGIN)
  if (overflow <= 0) return
  panelStyle.value = {
    ...panelStyle.value,
    left: `${Math.max(PANEL_VIEWPORT_MARGIN, box.left - overflow)}px`
  }
}

function refreshPanelPosition() {
  updatePanelPosition()
  if (props.dropdownFitContent) {
    nextTick(clampPanelIntoViewport)
  }
}

let positionTracked = false

/** 视口尺寸或任意祖先容器滚动时，面板要跟着触发器走 */
function startTrackingPosition() {
  if (positionTracked) return
  positionTracked = true
  window.addEventListener('resize', refreshPanelPosition)
  window.addEventListener('scroll', refreshPanelPosition, true)
}

function stopTrackingPosition() {
  if (!positionTracked) return
  positionTracked = false
  window.removeEventListener('resize', refreshPanelPosition)
  window.removeEventListener('scroll', refreshPanelPosition, true)
}

function open() {
  if (props.disabled) return
  isOpen.value = true
  highlightedIndex.value = props.options.findIndex(opt => opt.value === props.modelValue)
  if (props.searchable) {
    searchQuery.value = ''
    nextTick(() => inputRef.value?.focus())
  }
  startTrackingPosition()
  nextTick(refreshPanelPosition)
}

function close(options: { restoreFocus?: boolean } = {}) {
  isOpen.value = false
  searchQuery.value = ''
  highlightedIndex.value = -1
  stopTrackingPosition()
  if (options.restoreFocus) {
    nextTick(() => triggerRef.value?.focus())
  }
}

watch(
  () => [props.dropUp, props.dropdownFitContent, props.searchable],
  () => {
    if (isOpen.value) refreshPanelPosition()
  }
)

function toggle() {
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

function selectOption(option: SelectOption) {
  emit('update:modelValue', option.value)
  close({ restoreFocus: true })
}

function handleKeydown(event: KeyboardEvent) {
  if (!isOpen.value) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      open()
    }
    return
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      highlightedIndex.value = Math.min(
        highlightedIndex.value + 1,
        filteredOptions.value.length - 1
      )
      break
    case 'ArrowUp':
      event.preventDefault()
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0)
      break
    case 'Enter':
      event.preventDefault()
      if (highlightedIndex.value >= 0 && highlightedIndex.value < filteredOptions.value.length) {
        selectOption(filteredOptions.value[highlightedIndex.value])
      }
      break
    case 'Home':
      event.preventDefault()
      highlightedIndex.value = 0
      break
    case 'End':
      event.preventDefault()
      highlightedIndex.value = Math.max(filteredOptions.value.length - 1, 0)
      break
    case 'Escape':
      event.preventDefault()
      // 浮层打开时 Esc 只收浮层，不能把承载它的对话框一起关掉
      event.stopPropagation()
      close({ restoreFocus: true })
      break
    case 'Tab':
      close()
      break
  }
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node
  // 面板被 Teleport 到 body，不再属于容器子树，点击面板内部同样算「没点外面」
  if (containerRef.value?.contains(target) || dropdownRef.value?.contains(target)) {
    return
  }
  close()
}

watch(searchQuery, () => {
  highlightedIndex.value = 0
})

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  stopTrackingPosition()
})
</script>

<template>
  <div
    ref="containerRef"
    :class="['custom-select', { open: isOpen, disabled, 'drop-up': dropUp, compact }]"
    @keydown="handleKeydown"
  >
    <button
      ref="triggerRef"
      type="button"
      class="select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="accessibleLabel"
      :aria-expanded="isOpen"
      :aria-controls="listboxId"
      :aria-activedescendant="activeOptionId"
      :disabled="disabled"
      @click="toggle"
    >
      <span v-if="selectedOption" class="selected-value">
        <span class="selected-label">{{ selectedOption.label }}</span>
      </span>
      <span v-else class="placeholder">{{ resolvedPlaceholder }}</span>
      <span :class="['select-arrow', isOpen ? 'arrow-up' : 'arrow-down']" aria-hidden="true">▼</span>
    </button>

    <!--
      面板 Teleport 到 body：对话框的 overflow 滚动容器（Modal 的 modal-body）
      不会再把它裁成一条，位置由 updatePanelPosition 写成视口坐标。
    -->
    <Teleport to="body">
      <Transition name="dropdown">
        <div
          v-if="isOpen"
          ref="dropdownRef"
          :class="['select-dropdown', { 'is-drop-up': panelDropUp, 'fit-content': dropdownFitContent }]"
          :style="panelStyle"
          @keydown="handleKeydown"
        >
          <div v-if="searchable" class="search-wrapper">
            <input
              ref="inputRef"
              v-model="searchQuery"
              type="text"
              class="search-input"
              role="combobox"
              aria-autocomplete="list"
              :aria-label="t('common.search')"
              :aria-expanded="isOpen"
              :aria-controls="listboxId"
              :aria-activedescendant="activeOptionId"
              :placeholder="t('components.common.customSelect.searchPlaceholder')"
              @click.stop
            />
          </div>

          <CustomScrollbar :max-height="listMaxHeight" :width="5" :offset="1">
            <div :id="listboxId" class="options-list" role="listbox" :aria-label="accessibleLabel">
              <div
                v-for="(option, index) in filteredOptions"
                :id="getOptionId(index)"
                :key="option.value"
                role="option"
                :aria-selected="option.value === modelValue"
                :class="[
                  'option-item',
                  {
                    selected: option.value === modelValue,
                    highlighted: index === highlightedIndex
                  }
                ]"
                @click="selectOption(option)"
                @mouseenter="highlightedIndex = index"
              >
                <div class="option-content">
                  <span class="option-label">{{ option.label }}</span>
                  <span v-if="option.description" class="option-description">{{ option.description }}</span>
                </div>
                <span v-if="option.value === modelValue" class="check-icon" aria-hidden="true">✓</span>
              </div>

              <div v-if="filteredOptions.length === 0" class="empty-state" role="status">
                <span>{{ t('components.common.customSelect.noMatch') }}</span>
              </div>
            </div>
          </CustomScrollbar>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
}

.custom-select.disabled {
  opacity: var(--gc-opacity-disabled);
  pointer-events: none;
}

.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: var(--gc-control-height-lg);
  padding: 6px 10px;
  background: var(--vscode-input-background, var(--gc-surface-base));
  color: var(--vscode-input-foreground, var(--gc-text-primary));
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  font-size: var(--gc-font-size-control);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--gc-duration-fast) var(--gc-ease-standard),
    background-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.select-trigger:hover:not(:disabled) {
  border-color: var(--gc-focus-border);
}

.custom-select.open .select-trigger {
  border-color: var(--gc-focus-border);
}

.selected-value {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.selected-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.select-arrow {
  flex-shrink: 0;
  font-size: var(--gc-font-size-micro);
  margin-left: var(--gc-space-2);
  transition: transform var(--gc-duration-fast) var(--gc-ease-standard);
}

.select-arrow.arrow-up {
  transform: rotate(180deg);
}

/* 面板挂到 body：left / width / top / bottom / max-height 由内联样式按视口坐标写入 */
.select-dropdown {
  position: fixed;
  /* 对话框内部拉出的浮层要压在 Modal 之上，又仍低于通知层 */
  z-index: calc(var(--gc-layer-modal) + 10);
  background: var(--vscode-dropdown-background, var(--gc-surface-raised));
  border: 1px solid var(--vscode-dropdown-border, var(--gc-border-strong));
  border-radius: var(--gc-radius-sm);
  box-shadow: var(--gc-shadow-md);
  overflow: hidden;
}

/* 内容自适应模式：面板最宽不超过视口留白内的上限，超出后选项文案换行而非截断 */
.select-dropdown.fit-content {
  max-width: min(420px, calc(100vw - 16px));
}

.select-dropdown.fit-content .option-label {
  white-space: normal;
  word-break: break-word;
}

/* 紧凑模式 */
.custom-select.compact .select-trigger {
  padding: 4px 8px;
  font-size: var(--gc-font-size-body);
}

.custom-select.compact .select-arrow {
  font-size: 8px;
  margin-left: 6px;
}

.search-wrapper {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-dropdown-border);
  min-width: 0;
  overflow: hidden;
}

.search-input {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  padding: 4px 8px;
  color: var(--vscode-input-foreground);
  font-size: var(--gc-font-size-body);
  outline: none;
}

.search-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.options-list {
  padding: 4px 0;
}

.option-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  margin: 0;
  cursor: pointer;
  transition: background-color var(--gc-duration-instant) var(--gc-ease-standard);
}

.option-item:hover,
.option-item.highlighted {
  background: var(--vscode-list-hoverBackground);
}

.option-item.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.option-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-label {
  font-size: var(--gc-font-size-control);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-description {
  font-size: var(--gc-font-size-caption);
  color: var(--gc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-item.selected .option-description {
  color: var(--vscode-list-activeSelectionForeground);
  opacity: 0.8;
}

.check-icon {
  flex-shrink: 0;
  font-size: 14px;
  margin-left: 8px;
}

.empty-state {
  padding: 16px;
  text-align: center;
  font-size: var(--gc-font-size-body);
  color: var(--gc-text-muted);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity var(--gc-duration-fast) var(--gc-ease-standard),
    transform var(--gc-duration-fast) var(--gc-ease-standard);
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 朝上展开时位移方向相反，保证面板始终朝触发器靠 */
.select-dropdown.is-drop-up.dropdown-enter-from,
.select-dropdown.is-drop-up.dropdown-leave-to {
  transform: translateY(4px);
}
</style>