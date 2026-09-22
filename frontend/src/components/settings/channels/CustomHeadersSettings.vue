<script setup lang="ts">
import { CustomScrollbar } from '../../common'
import { useI18n } from '../../../i18n'

const { t } = useI18n()

// 自定义标头类型
interface CustomHeader {
  key: string
  value: string
  enabled: boolean
}

const props = defineProps<{
  headers: CustomHeader[]
  enabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:enabled', value: boolean): void
  (e: 'update:headers', headers: CustomHeader[]): void
}>()

// 检查重复键名
function getDuplicateKeys(): Set<string> {
  const keys = props.headers.map(h => h.key.trim().toLowerCase())
  const duplicates = new Set<string>()
  const seen = new Set<string>()
  
  for (const key of keys) {
    if (key && seen.has(key)) {
      duplicates.add(key)
    }
    seen.add(key)
  }
  
  return duplicates
}

// 检查指定索引的键是否重复
function isKeyDuplicate(index: number): boolean {
  const key = props.headers[index]?.key?.trim().toLowerCase()
  if (!key) return false
  
  const duplicates = getDuplicateKeys()
  return duplicates.has(key)
}

// 添加新标头
function addHeader() {
  const headers = [...props.headers, { key: '', value: '', enabled: true }]
  emit('update:headers', headers)
}

// 删除标头
function removeHeader(index: number) {
  const headers = props.headers.filter((_, i) => i !== index)
  emit('update:headers', headers)
}

// 更新标头字段
function updateHeader(index: number, field: 'key' | 'value' | 'enabled', value: string | boolean) {
  const headers = [...props.headers]
  if (headers[index]) {
    headers[index] = { ...headers[index], [field]: value }
    emit('update:headers', headers)
  }
}
</script>

<template>
  <div class="custom-headers-panel">
    <div class="headers-hint">
      {{ t('components.channels.customHeaders.hint') }}
    </div>
    
    <!-- 标头列表 -->
    <div class="headers-list-wrapper" :class="{ disabled: !enabled }">
      <CustomScrollbar :max-height="300" :width="5" :offset="1">
        <div class="headers-list">
          <div
            v-for="(header, index) in headers"
            :key="index"
            class="header-item"
          >
        <label class="header-checkbox" :title="header.enabled ? t('components.channels.customHeaders.enabled') : t('components.channels.customHeaders.disabled')">
          <input
            type="checkbox"
            :checked="header.enabled"
            :disabled="!enabled"
            @change="(e: any) => updateHeader(index, 'enabled', e.target.checked)"
          />
          <span class="header-checkmark"></span>
        </label>
        
        <div class="header-inputs">
          <div class="header-key-wrapper">
            <input
              type="text"
              class="header-key"
              :class="{ 'has-error': isKeyDuplicate(index) }"
              :value="header.key"
              :placeholder="t('components.channels.customHeaders.keyPlaceholder')"
              :disabled="!enabled"
              @input="(e: any) => updateHeader(index, 'key', e.target.value)"
            />
            <span v-if="isKeyDuplicate(index)" class="key-error">{{ t('components.channels.customHeaders.keyDuplicate') }}</span>
          </div>
          <input
            type="text"
            class="header-value"
            :value="header.value"
            :placeholder="t('components.channels.customHeaders.valuePlaceholder')"
            :disabled="!enabled"
            @input="(e: any) => updateHeader(index, 'value', e.target.value)"
          />
        </div>
        
        <button
          class="header-remove"
          :title="t('components.channels.customHeaders.deleteTooltip')"
          :disabled="!enabled"
          @click="removeHeader(index)"
        >
          <i class="codicon codicon-trash"></i>
        </button>
      </div>
      
          <!-- 空状态 -->
          <div v-if="headers.length === 0" class="headers-empty">
            {{ t('components.channels.customHeaders.empty') }}
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <!-- 添加按钮 -->
    <button
      class="add-header-btn"
      :disabled="!enabled"
      @click="addHeader"
    >
      <i class="codicon codicon-add"></i>
      {{ t('components.channels.customHeaders.addHeader') }}
    </button>
  </div>
</template>

<style scoped>
.custom-headers-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.headers-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.headers-list-wrapper {
  display: flex;
  flex-direction: column;
}

.headers-list-wrapper.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.headers-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.header-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.header-checkbox {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 28px;
  cursor: pointer;
}

.header-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.header-checkmark {
  width: 14px;
  height: 14px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--gc-radius-xs);
  transition: all 0.15s;
}

.header-checkbox:hover .header-checkmark {
  border-color: var(--vscode-focusBorder);
}

.header-checkbox input:checked ~ .header-checkmark {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.header-checkbox input:checked ~ .header-checkmark::after {
  content: '';
  position: absolute;
  left: 8px;
  top: 9px;
  width: 3px;
  height: 6px;
  border: solid var(--vscode-button-foreground);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.header-inputs {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.header-key-wrapper {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-key,
.header-value {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: var(--gc-radius-xs);
  font-size: 12px;
}

.header-key:focus,
.header-value:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.header-key.has-error {
  border-color: var(--vscode-errorForeground);
}

.key-error {
  font-size: 10px;
  color: var(--vscode-errorForeground);
}

.header-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--gc-radius-xs);
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
}

.header-remove:hover:not(:disabled) {
  opacity: 1;
  color: var(--vscode-errorForeground);
  background: var(--vscode-toolbar-hoverBackground);
}

.header-remove:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.headers-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.add-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: var(--gc-radius-xs);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.add-header-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.add-header-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-header-btn .codicon {
  font-size: 12px;
}
</style>