<script setup lang="ts">
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { CustomScrollbar } from '../common'
import { useI18n } from '@/i18n'
import type { ModelInfo } from '@/types'

const { t } = useI18n()

interface Props {
  visible: boolean
  configId: string
  addedModelIds: string[]
}

interface Emits {
  (e: 'update:visible', value: boolean): void
  (e: 'confirm', models: ModelInfo[]): void
  (e: 'remove', modelId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// 状态
const availableModels = ref<ModelInfo[]>([])
const selectedModelIds = ref<Set<string>>(new Set())
const isLoading = ref(false)
const error = ref<string>('')

// 筛选关键词
const filterKeyword = ref('')

// 筛选后的模型列表
const filteredModels = computed(() => {
  if (!filterKeyword.value.trim()) {
    return availableModels.value
  }
  const keyword = filterKeyword.value.toLowerCase().trim()
  return availableModels.value.filter(model =>
    model.id.toLowerCase().includes(keyword) ||
    (model.name && model.name.toLowerCase().includes(keyword)) ||
    (model.description && model.description.toLowerCase().includes(keyword))
  )
})

// 全选/全不选状态（基于筛选后的列表）
const isAllSelected = computed(() => {
  const selectableModels = filteredModels.value.filter(
    m => !props.addedModelIds.includes(m.id)
  )
  return selectableModels.length > 0 &&
         selectableModels.every(m => selectedModelIds.value.has(m.id))
})

// 切换全选/全不选（基于筛选后的列表）
function toggleSelectAll() {
  const selectableModels = filteredModels.value.filter(
    m => !props.addedModelIds.includes(m.id)
  )
  
  if (isAllSelected.value) {
    // 全不选
    selectableModels.forEach(m => selectedModelIds.value.delete(m.id))
  } else {
    // 全选
    selectableModels.forEach(m => selectedModelIds.value.add(m.id))
  }
}

// 切换模型选择状态
function toggleModel(modelId: string, isAdded: boolean) {
  if (isAdded) {
    // 如果已添加，点击时移除
    emit('remove', modelId)
  } else {
    // 未添加则切换选择状态
    if (selectedModelIds.value.has(modelId)) {
      selectedModelIds.value.delete(modelId)
    } else {
      selectedModelIds.value.add(modelId)
    }
  }
}

// 关闭对话框
function close() {
  emit('update:visible', false)
}

// 确认选择
function confirm() {
  const selected = availableModels.value.filter(m => selectedModelIds.value.has(m.id))
  emit('confirm', selected)
  close()
}

// 加载可用模型
async function loadModels() {
  if (!props.configId) return
  
  isLoading.value = true
  error.value = ''
  selectedModelIds.value.clear()
  
  try {
    const models = await sendToExtension<ModelInfo[]>(MESSAGE_NAMES['models.getModels'], {
      configId: props.configId
    })
    availableModels.value = models || []
  } catch (err: any) {
    error.value = err.message || t('components.settings.modelSelectionDialog.error')
    console.error('Failed to load models:', err)
  } finally {
    isLoading.value = false
  }
}

// 监听面板显示状态
watch(() => props.visible, (visible) => {
  if (visible) {
    loadModels()
  } else {
    // 关闭时清空选择
    selectedModelIds.value.clear()
    availableModels.value = []
    error.value = ''
    filterKeyword.value = ''
  }
})
</script>

<template>
  <div v-if="visible" class="dialog-overlay" @click.self="close">
    <div class="dialog">
      <!-- 头部 -->
      <div class="dialog-header">
        <h4>{{ t('components.settings.modelSelectionDialog.title') }}</h4>
        <button
          v-if="availableModels.length > 0"
          class="select-all-btn"
          :title="isAllSelected ? t('components.settings.modelSelectionDialog.deselectAll') : t('components.settings.modelSelectionDialog.selectAll')"
          @click="toggleSelectAll"
        >
          <i :class="['codicon', isAllSelected ? 'codicon-close-all' : 'codicon-check-all']"></i>
          <span>{{ isAllSelected ? t('components.settings.modelSelectionDialog.deselectAll') : t('components.settings.modelSelectionDialog.selectAll') }}</span>
        </button>
        <button class="close-btn" :title="t('components.settings.modelSelectionDialog.close')" @click="close">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
      
      <!-- 内容 -->
      <div class="dialog-body">
        <!-- 错误状态 -->
        <div v-if="error" class="error-state">
          <i class="codicon codicon-error"></i>
          <span>{{ error }}</span>
          <button class="retry-btn" @click="loadModels">{{ t('components.settings.modelSelectionDialog.retry') }}</button>
        </div>
        
        <!-- 加载状态 -->
        <div v-else-if="isLoading" class="loading-state">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
          <span>{{ t('components.settings.modelSelectionDialog.loading') }}</span>
        </div>
        
        <!-- 空状态 -->
        <div v-else-if="availableModels.length === 0" class="empty-state">
          <i class="codicon codicon-info"></i>
          <span>{{ t('components.settings.modelSelectionDialog.empty') }}</span>
        </div>
        
        <!-- 模型列表 -->
        <div v-else class="model-list-wrapper">
          <!-- 筛选输入框 -->
          <div class="filter-input-container">
            <i class="codicon codicon-search"></i>
            <input
              v-model="filterKeyword"
              type="text"
              :placeholder="t('components.settings.modelSelectionDialog.filterPlaceholder')"
              class="filter-input"
            />
            <button
              v-if="filterKeyword"
              class="filter-clear-btn"
              :title="t('components.settings.modelSelectionDialog.clearFilter')"
              @click="filterKeyword = ''"
            >
              <i class="codicon codicon-close"></i>
            </button>
          </div>
          
          <CustomScrollbar :max-height="300" :width="5" :offset="1">
            <div class="model-list">
              <!-- 筛选无结果提示 -->
              <div v-if="filteredModels.length === 0 && filterKeyword" class="no-results">
                <i class="codicon codicon-search"></i>
                <span>{{ t('components.settings.modelSelectionDialog.noResults') }}</span>
              </div>
              
              <div
                v-for="model in filteredModels"
                :key="model.id"
                :class="[
                  'model-item',
                  {
                    selected: selectedModelIds.has(model.id),
                    added: addedModelIds.includes(model.id)
                  }
                ]"
                @click="toggleModel(model.id, addedModelIds.includes(model.id))"
              >
                <div class="model-checkbox">
                  <i
                    :class="[
                      'codicon',
                      selectedModelIds.has(model.id) ? 'codicon-check' : 'codicon-blank'
                    ]"
                  ></i>
                </div>
                <div class="model-info">
                  <span class="model-id">{{ model.id }}</span>
                  <span v-if="model.name && model.name !== model.id" class="model-name">{{ model.name }}</span>
                  <span v-if="model.description" class="model-desc">{{ model.description }}</span>
                </div>
                <button
                  v-if="addedModelIds.includes(model.id)"
                  class="added-badge"
                  @click.stop="emit('remove', model.id)"
                >
                  {{ t('components.settings.modelSelectionDialog.added') }} ×
                </button>
              </div>
            </div>
          </CustomScrollbar>
        </div>
      </div>
      
      <!-- 底部 -->
      <div class="dialog-footer">
        <span class="selection-count">
          {{ t('components.settings.modelSelectionDialog.selectionCount', { count: selectedModelIds.size }) }}
        </span>
        <div class="dialog-actions">
          <button class="btn secondary" @click="close">{{ t('components.settings.modelSelectionDialog.cancel') }}</button>
          <button
            class="btn primary"
            :disabled="selectedModelIds.size === 0"
            @click="confirm"
          >
            {{ t('components.settings.modelSelectionDialog.add', { count: selectedModelIds.size }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  width: 90%;
  max-width: 560px;
  max-height: 80vh;
  background: var(--gc-surface-editor-bg);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 头部 */
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.dialog-header h4 {
  flex: 1;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.select-all-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.select-all-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.select-all-btn .codicon {
  font-size: 12px;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background 0.15s;
}

.close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* 内容 */
.dialog-body {
  flex: 1;
  padding: 8px;
  min-height: 300px;
}

.loading-state,
.empty-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 16px;
  color: var(--vscode-descriptionForeground);
}

.loading-state .codicon,
.empty-state .codicon,
.error-state .codicon {
  font-size: 32px;
}

.error-state {
  color: var(--vscode-errorForeground);
}

.retry-btn {
  margin-top: 8px;
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.retry-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* 旋转动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 筛选输入框 */
.filter-input-container {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  background: var(--vscode-input-background);
}

.filter-input-container .codicon-search {
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.filter-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  background: transparent;
  color: var(--vscode-input-foreground);
  border: none;
  font-size: 12px;
  outline: none;
}

.filter-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.filter-clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  flex-shrink: 0;
}

.filter-clear-btn:hover {
  color: var(--vscode-foreground);
}

.filter-clear-btn .codicon {
  font-size: 12px;
}

/* 无结果提示 */
.no-results {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 16px;
  text-align: center;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.no-results .codicon {
  font-size: 20px;
  opacity: 0.5;
}

/* 模型列表 */
.model-list-wrapper {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--vscode-list-hoverBackground);
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s;
}

.model-item:hover:not(.disabled) {
  background: var(--vscode-list-activeSelectionBackground);
}

.model-item.selected {
  background: color-mix(in srgb, var(--vscode-charts-blue) 15%, var(--vscode-list-hoverBackground));
}

.model-item.added {
  background: color-mix(in srgb, var(--vscode-charts-green) 10%, var(--vscode-list-hoverBackground));
}

.model-item.added:hover {
  background: color-mix(in srgb, var(--vscode-charts-green) 15%, var(--vscode-list-hoverBackground));
}

.model-checkbox {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  background: var(--vscode-input-background);
  transition: all 0.15s;
}

.model-item.selected .model-checkbox {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.model-checkbox .codicon {
  font-size: 14px;
}

.model-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-id {
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
  font-weight: 500;
}

.model-name {
  font-size: 11px;
  color: var(--vscode-foreground);
  opacity: 0.8;
}

.model-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.added-badge {
  flex-shrink: 0;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--vscode-charts-green, #89d185);
  background: color-mix(in srgb, var(--vscode-charts-green) 20%, transparent);
  border: none;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s;
}

.added-badge:hover {
  color: var(--vscode-errorForeground);
  background: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent);
}

/* 底部 */
.dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
}

.selection-count {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.dialog-actions {
  display: flex;
  gap: 8px;
}

.btn {
  padding: 6px 12px;
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
</style>