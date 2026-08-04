<script setup lang="ts">
/**
 * PatternListEditor - 模式列表编辑器（chips 风格）
 *
 * 用于编辑 gitignore 风格模式清单（如存档排除规则）：
 * - 现有模式以标签卡片展示，悬停可逐个删除；
 * - 输入框回车添加，粘贴多行自动拆分逐条加入；
 * - 重复模式自动去重；
 * - 任何修改立即通过 update:modelValue 通知父组件（是否持久化由父组件决定）。
 */

import { ref } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string[]
  placeholder?: string
  disabled?: boolean
  emptyText?: string
  addLabel?: string
  removeLabel?: string
}>(), {
  placeholder: '',
  disabled: false,
  emptyText: '',
  addLabel: 'Add',
  removeLabel: 'Remove'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

// 输入草稿与 config 解耦：config 更新触发的重渲染不会打断正在输入的内容
const draft = ref('')

// 按行拆分并清理输入（用于回车添加与粘贴多行）
function normalize(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

// 追加模式（自动去重）；有实际变化才 emit
function addPatterns(raw: string) {
  const next = [...props.modelValue]
  let changed = false
  for (const line of normalize(raw)) {
    if (!next.includes(line)) {
      next.push(line)
      changed = true
    }
  }
  if (changed) {
    emit('update:modelValue', next)
  }
}

function addFromDraft() {
  if (!draft.value.trim()) return
  addPatterns(draft.value)
  draft.value = ''
}

// 粘贴多行时直接拆条加入，避免单行输入框吞掉换行符
function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? ''
  if (text.includes('\n') || text.includes('\r')) {
    event.preventDefault()
    addPatterns(text)
  }
}

function removeAt(index: number) {
  const next = props.modelValue.filter((_, i) => i !== index)
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="pattern-editor" :class="{ disabled }">
    <div class="pattern-list">
      <span
        v-for="(pattern, index) in modelValue"
        :key="`${pattern}-${index}`"
        class="pattern-chip"
        :title="pattern"
      >
        <code class="pattern-text">{{ pattern }}</code>
        <button
          class="pattern-remove"
          :disabled="disabled"
          :aria-label="removeLabel"
          :title="removeLabel"
          @click="removeAt(index)"
        >
          <i class="codicon codicon-close"></i>
        </button>
      </span>
      <span v-if="modelValue.length === 0" class="pattern-empty">{{ emptyText }}</span>
    </div>
    <div class="pattern-input-row">
      <input
        v-model="draft"
        class="pattern-input"
        type="text"
        :placeholder="placeholder"
        :disabled="disabled"
        @keydown.enter.prevent="addFromDraft"
        @paste="onPaste"
      />
      <button
        class="pattern-add-btn"
        :disabled="disabled || !draft.trim()"
        @click="addFromDraft"
      >
        {{ addLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.pattern-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pattern-editor.disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* 模式标签列表 */
.pattern-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
}

.pattern-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 8px;
  background: var(--vscode-badge-background, rgba(128, 128, 128, 0.25));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  border-radius: 4px;
  font-size: 12px;
}

.pattern-text {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pattern-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.pattern-remove:hover:not(:disabled) {
  opacity: 1;
  background: rgba(255, 0, 0, 0.2);
}

.pattern-remove .codicon {
  font-size: 11px;
}

.pattern-empty {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 0;
}

/* 输入行 */
.pattern-input-row {
  display: flex;
  gap: 6px;
}

.pattern-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  outline: none;
}

.pattern-input:focus {
  border-color: var(--vscode-focusBorder);
}

.pattern-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.pattern-input:disabled {
  opacity: 0.6;
}

.pattern-add-btn {
  flex-shrink: 0;
  padding: 5px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  cursor: pointer;
}

.pattern-add-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.pattern-add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
