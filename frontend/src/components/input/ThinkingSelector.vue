<script setup lang="ts">
/**
 * ThinkingSelector - 思考强度选择器
 * 位于模型选择器旁，按当前渠道提供完整档位列表（Off + 各 API 档位，
 * 与设置页一致不裁剪）。档位文案保持英文不翻译（见 utils/thinkingLevel.ts）。
 */

import { computed, ref } from 'vue'
import { useSearchableDropdown } from '../../composables'
import { THINKING_OFF, type ThinkingLevelOption } from '../../utils/thinkingLevel'

const props = withDefaults(defineProps<{
  modelValue: string
  options: ThinkingLevelOption[]
  disabled?: boolean
}>(), {
  options: () => [],
  disabled: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', level: string): void
}>()

const containerRef = ref<HTMLElement>()

const { isOpen, toggle, close, filteredItems, highlightedIndex, handleKeydown: handleDropdownKeydown } = useSearchableDropdown<ThinkingLevelOption>(containerRef, {
  items: () => props.options,
  getKey: (opt) => opt.value,
  selectedKey: () => props.modelValue,
  disabled: () => !!props.disabled
})

const selectedLabel = computed(() =>
  props.options.find(opt => opt.value === props.modelValue)?.label ?? THINKING_OFF
)

function selectLevel(option: ThinkingLevelOption) {
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
  background: var(--gc-surface-input-bg);
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
  background: var(--gc-surface-dropdown-bg);
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
