<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CustomScrollbar } from '../../common'
import { useI18n } from '../../../i18n'

const { t } = useI18n()

// 自定义 body 项类型
interface CustomBodyItem {
  key: string
  value: string
  enabled: boolean
}

// 自定义 body 配置类型
interface CustomBodyConfig {
  mode: 'simple' | 'advanced'
  items?: CustomBodyItem[]
  json?: string
}

const props = defineProps<{
  customBody: CustomBodyConfig
  enabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:enabled', value: boolean): void
  (e: 'update:config', config: CustomBodyConfig): void
}>()

// 简单模式下的项目列表
const customBodyItems = computed<CustomBodyItem[]>(() => {
  return props.customBody.items || []
})

// 复杂模式下的 JSON - 使用本地状态保持编辑内容
const localJsonValue = ref('')

// JSON 解析错误
const jsonError = ref('')

// 监听配置变化，同步到本地状态
// 配置来源变化（如切换渠道导致 json 变化）时重置本地编辑状态与错误，
// 否则旧渠道的无效 JSON 会残留并阻止新渠道 JSON 的同步（渠道切换残留旧 JSON）
watch(() => props.customBody.json, (newJson) => {
  jsonError.value = ''
  localJsonValue.value = newJson || ''
}, { immediate: true })

// 更新模式
function updateMode(mode: 'simple' | 'advanced') {
  emit('update:config', {
    ...props.customBody,
    mode
  })
}

// 添加新 body 项（简单模式）
function addItem() {
  const items = [...customBodyItems.value, { key: '', value: '', enabled: true }]
  emit('update:config', {
    ...props.customBody,
    items
  })
}

// 删除 body 项
function removeItem(index: number) {
  const items = customBodyItems.value.filter((_, i) => i !== index)
  emit('update:config', {
    ...props.customBody,
    items
  })
}

// 更新 body 项字段
function updateItem(index: number, field: 'key' | 'value' | 'enabled', value: string | boolean) {
  const items = [...customBodyItems.value]
  if (items[index]) {
    items[index] = { ...items[index], [field]: value }
    emit('update:config', {
      ...props.customBody,
      items
    })
  }
}

// 更新本地 JSON 值（实时输入）
function handleJsonInput(e: Event) {
  const target = e.target as HTMLTextAreaElement
  localJsonValue.value = target.value
  
  // 实时验证 JSON
  try {
    if (target.value.trim()) {
      JSON.parse(target.value)
    }
    jsonError.value = ''
  } catch {
    jsonError.value = t('components.channels.customBody.jsonError')
  }
}

// 保存复杂模式 JSON（失焦时）
function saveJson() {
  // 如果有错误，不保存
  if (jsonError.value) {
    return
  }
  
  emit('update:config', {
    ...props.customBody,
    json: localJsonValue.value
  })
}
</script>

<template>
  <div class="custom-body-panel">
    <div class="body-hint">
      {{ t('components.channels.customBody.hint') }}
    </div>
    
    <!-- 模式选择 -->
    <div class="body-mode-selector" :class="{ disabled: !enabled }">
      <label class="radio-option" :class="{ disabled: !enabled }">
        <input
          type="radio"
          name="bodyMode"
          value="simple"
          :checked="customBody.mode === 'simple'"
          :disabled="!enabled"
          @change="updateMode('simple')"
        />
        <span class="radio-mark"></span>
        <span class="radio-text">简单模式</span>
      </label>
      <label class="radio-option" :class="{ disabled: !enabled }">
        <input
          type="radio"
          name="bodyMode"
          value="advanced"
          :checked="customBody.mode === 'advanced'"
          :disabled="!enabled"
          @change="updateMode('advanced')"
        />
        <span class="radio-mark"></span>
        <span class="radio-text">复杂模式</span>
      </label>
    </div>
    
    <!-- 简单模式：键值对列表 -->
    <div v-if="customBody.mode === 'simple'" class="body-items-wrapper" :class="{ disabled: !enabled }">
      <CustomScrollbar :max-height="300" :width="5" :offset="1">
        <div class="body-items-list">
          <div
            v-for="(item, index) in customBodyItems"
            :key="index"
            class="body-item"
          >
        <label class="body-checkbox" :title="item.enabled ? t('components.channels.customBody.enabled') : t('components.channels.customBody.disabled')">
          <input
            type="checkbox"
            :checked="item.enabled"
            :disabled="!enabled"
            @change="(e: any) => updateItem(index, 'enabled', e.target.checked)"
          />
          <span class="body-checkmark"></span>
        </label>
        
        <div class="body-inputs">
          <input
            type="text"
            class="body-key"
            :value="item.key"
            :placeholder="t('components.channels.customBody.keyPlaceholder')"
            :disabled="!enabled"
            @input="(e: any) => updateItem(index, 'key', e.target.value)"
          />
          <textarea
            class="body-value"
            :value="item.value"
            :placeholder="t('components.channels.customBody.valuePlaceholder')"
            :disabled="!enabled"
            rows="3"
            @input="(e: any) => updateItem(index, 'value', e.target.value)"
          ></textarea>
        </div>
        
        <button
          class="body-remove"
          :title="t('components.channels.customBody.deleteTooltip')"
          :disabled="!enabled"
          @click="removeItem(index)"
        >
          <i class="codicon codicon-trash"></i>
        </button>
      </div>
      
          <!-- 空状态 -->
          <div v-if="customBodyItems.length === 0" class="body-empty">
            {{ t('components.channels.customBody.empty') }}
          </div>
        </div>
      </CustomScrollbar>
      
      <!-- 添加按钮 -->
      <button
        class="add-body-btn"
        :disabled="!enabled"
        @click="addItem"
      >
        <i class="codicon codicon-add"></i>
        {{ t('components.channels.customBody.addItem') }}
      </button>
    </div>
    
    <!-- 复杂模式：完整 JSON 编辑器 -->
    <div v-if="customBody.mode === 'advanced'" class="body-json-editor" :class="{ disabled: !enabled }">
      <textarea
        class="json-textarea"
        :class="{ 'has-error': jsonError }"
        :value="localJsonValue"
        :disabled="!enabled"
        placeholder='{
  "extra_body": {
    "google": {
      "thinking_config": {
        "include_thoughts": false
      }
    }
  }
}'
        rows="8"
        @input="handleJsonInput"
        @blur="saveJson"
      ></textarea>
      <span v-if="jsonError" class="json-error">{{ t('components.channels.customBody.jsonError') }}</span>
      <span class="body-json-hint">{{ t('components.channels.customBody.jsonHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.custom-body-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.body-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.body-mode-selector {
  display: flex;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.body-mode-selector.disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* 单选按钮 */
.radio-option {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
}

.radio-option.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.radio-option input {
  display: none;
}

.radio-mark {
  width: 14px;
  height: 14px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 50%;
  background: var(--vscode-input-background);
  position: relative;
  transition: all 0.15s;
}

.radio-option:hover:not(.disabled) .radio-mark {
  border-color: var(--vscode-focusBorder);
}

.radio-option input:checked + .radio-mark {
  border-color: var(--vscode-button-background);
}

.radio-option input:checked + .radio-mark::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-button-background);
}

.radio-text {
  color: var(--vscode-foreground);
}

/* Body 项列表包装器 */
.body-items-wrapper {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.body-items-wrapper.disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* Body 项列表 */
.body-items-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.body-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.body-checkbox {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 28px;
  cursor: pointer;
}

.body-checkbox input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
  height: 0;
  width: 0;
}

.body-checkmark {
  width: 14px;
  height: 14px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  transition: all 0.15s;
}

.body-checkbox:hover .body-checkmark {
  border-color: var(--vscode-focusBorder);
}

.body-checkbox input:checked ~ .body-checkmark {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.body-checkbox input:checked ~ .body-checkmark::after {
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

.body-inputs {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.body-key {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 12px;
}

.body-key:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.body-value {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  resize: vertical;
  min-height: 60px;
}

.body-value:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.body-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0.7;
}

.body-remove:hover:not(:disabled) {
  opacity: 1;
  color: var(--vscode-errorForeground);
  background: var(--vscode-toolbar-hoverBackground);
}

.body-remove:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.body-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.add-body-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.add-body-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.add-body-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-body-btn .codicon {
  font-size: 12px;
}

/* JSON 编辑器 */
.body-json-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.body-json-editor.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.json-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  resize: vertical;
  min-height: 120px;
}

.json-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.json-textarea.has-error {
  border-color: var(--vscode-errorForeground);
}

.json-error {
  font-size: 10px;
  color: var(--vscode-errorForeground);
}

.body-json-hint {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}
</style>