<script setup lang="ts">
/**
 * ThinkingSelector - 思考强度选择器
 * 位于模型选择器旁，用统一的 Off/Low/Medium/High 四级快捷控制当前渠道的思考强度。
 * 档位文案刻意保持英文不翻译（见 utils/thinkingLevel.ts）。
 */

import { computed, ref } from 'vue'
import { useSearchableDropdown } from '../../composables'
import { THINKING_LEVELS, THINKING_LEVEL_LABELS, type ThinkingLevel } from '../../utils/thinkingLevel'

interface ThinkingOption {
  value: ThinkingLevel
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: ThinkingLevel
  disabled?: boolean
}>(), {
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', level: ThinkingLevel): void
}>()

const items = computed<ThinkingOption[]>(() =>
  THINKING_LEVELS.map(level => ({ value: level, label: THINKING_LEVEL_LABELS[level] }))
)

const containerRef = ref<HTMLElement>()

const { isOpen, toggle, close, filteredItems, highlightedIndex, handleKeydown: handleDropdownKeydown } = useSearchableDropdown<ThinkingOption>(containerRef, {
  items: () => items.value,
  getKey: (opt) => opt.value,
  selectedKey: () => props.modelValue,
  disabled: () => !!props.disabled
})

const selectedLabel = computed(() => THINKING_LEVEL_LABELS[props.modelValue])

function selectLevel(option: ThinkingOption) {
  emit('update:modelValue', option.value)
  close()
}

function handleKeydown(event: KeyboardEvent) {
  handleDropdownKeydown(event, selectLevel)
}
</script>

<template>
  <div ref="containerRef" :class="['thinking-selector', { open: isOpen, disabled }]">
    <button
      type="button"
      class="thinking-trigger"
      :disabled="disabled"
      @click="toggle"
      @keydown="handleKeydown"
      title="Thinking effort"
    >
      <span class="thinking-label">{{ selectedLabel }}</span>
      <span :class="['select-arrow', isOpen ? 'arrow-up' : 'arrow-down']">▼</span>
    </button>

    <Transition name="dropdown">
      <div v-if="isOpen" class="thinking-dropdown">
        <div class="thinking-list">
          <div
            v-for="(option, index) in filteredItems"
            :key="option.value"
            :class="['thinking-item', { selected: option.value === modelValue, highlighted: index === highlightedIndex }]"
            @click="selectLevel(option)"
            @mouseenter="highlightedIndex = index"
          >
            <span class="thinking-item-label">{{ option.label }}</span>
            <span v-if="option.value === modelValue" class="check-icon">✓</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.thinking-selector {
  position: relative;
  flex-shrink: 0;
}

.thinking-selector.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.thinking-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 76px;
  padding: 4px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background-color 0.15s;
}

.thinking-trigger:hover:not(:disabled) {
  border-color: var(--vscode-focusBorder);
}

.thinking-selector.open .thinking-trigger {
  border-color: var(--vscode-focusBorder);
}

.thinking-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-arrow {
  flex-shrink: 0;
  font-size: 8px;
  transition: transform 0.15s;
}

.select-arrow.arrow-up {
  transform: rotate(180deg);
}

.thinking-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  width: 140px;
  min-width: 140px;
  margin-bottom: 4px;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
  z-index: 1000;
  overflow: visible;
}

.thinking-list {
  padding: 4px 0;
}

.thinking-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.thinking-item:hover,
.thinking-item.highlighted {
  background: var(--vscode-list-hoverBackground);
}

.thinking-item.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.thinking-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-icon {
  flex-shrink: 0;
  font-size: 12px;
  margin-left: 8px;
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
