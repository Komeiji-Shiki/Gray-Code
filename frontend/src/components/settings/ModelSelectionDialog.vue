<script setup lang="ts">
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { CustomScrollbar, Modal } from '../common'
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
  <Modal
    :model-value="visible"
    :aria-label="t('components.settings.modelSelectionDialog.title')"
    width="560px"
    initial-focus-selector=".filter-input"
    body-padding="none"
    @close="close"
  >
    <template #header>
      <div class="model-dialog-heading">
        <h3>{{ t('components.settings.modelSelectionDialog.title') }}</h3>
        <button
          v-if="availableModels.length > 0"
          type="button"
          class="select-all-btn"
          :aria-pressed="isAllSelected"
          @click="toggleSelectAll"
        >
          <i :class="['codicon', isAllSelected ? 'codicon-close-all' : 'codicon-check-all']" aria-hidden="true"></i>
          <span>{{ isAllSelected ? t('components.settings.modelSelectionDialog.deselectAll') : t('components.settings.modelSelectionDialog.selectAll') }}</span>
        </button>
      </div>
    </template>

    <div class="dialog-body">
      <div v-if="error" class="error-state" role="alert">
        <i class="codicon codicon-error" aria-hidden="true"></i>
        <span>{{ error }}</span>
        <button type="button" class="retry-btn" @click="loadModels">
          {{ t('components.settings.modelSelectionDialog.retry') }}
        </button>
      </div>

      <div v-else-if="isLoading" class="loading-state" role="status" aria-live="polite">
        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
        <span>{{ t('components.settings.modelSelectionDialog.loading') }}</span>
      </div>

      <div v-else-if="availableModels.length === 0" class="empty-state" role="status">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.settings.modelSelectionDialog.empty') }}</span>
      </div>

      <div v-else class="model-list-wrapper">
        <div class="filter-input-container">
          <i class="codicon codicon-search" aria-hidden="true"></i>
          <input
            v-model="filterKeyword"
            type="text"
            :placeholder="t('components.settings.modelSelectionDialog.filterPlaceholder')"
            :aria-label="t('components.settings.modelSelectionDialog.filterPlaceholder')"
            class="filter-input"
          />
          <button
            v-if="filterKeyword"
            type="button"
            class="filter-clear-btn"
            :title="t('components.settings.modelSelectionDialog.clearFilter')"
            :aria-label="t('components.settings.modelSelectionDialog.clearFilter')"
            @click="filterKeyword = ''"
          >
            <i class="codicon codicon-close" aria-hidden="true"></i>
          </button>
        </div>

        <CustomScrollbar :max-height="300" :width="5" :offset="1">
          <div class="model-list">
            <div v-if="filteredModels.length === 0 && filterKeyword" class="no-results" role="status">
              <i class="codicon codicon-search" aria-hidden="true"></i>
              <span>{{ t('components.settings.modelSelectionDialog.noResults') }}</span>
            </div>

            <button
              v-for="model in filteredModels"
              :key="model.id"
              type="button"
              :class="[
                'model-item',
                {
                  'is-selected': selectedModelIds.has(model.id),
                  added: addedModelIds.includes(model.id)
                }
              ]"
              :aria-pressed="addedModelIds.includes(model.id) ? undefined : selectedModelIds.has(model.id)"
              @click="toggleModel(model.id, addedModelIds.includes(model.id))"
            >
              <span class="model-checkbox" aria-hidden="true">
                <i :class="['codicon', selectedModelIds.has(model.id) ? 'codicon-check' : 'codicon-blank']"></i>
              </span>
              <span class="model-info">
                <span class="model-id">{{ model.id }}</span>
                <span v-if="model.name && model.name !== model.id" class="model-name">{{ model.name }}</span>
                <span v-if="model.description" class="model-desc">{{ model.description }}</span>
              </span>
              <span v-if="addedModelIds.includes(model.id)" class="added-badge">
                {{ t('components.settings.modelSelectionDialog.added') }} ×
              </span>
            </button>
          </div>
        </CustomScrollbar>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer-content">
        <span class="selection-count">
          {{ t('components.settings.modelSelectionDialog.selectionCount', { count: selectedModelIds.size }) }}
        </span>
        <div class="dialog-actions">
          <button type="button" class="btn secondary" @click="close">
            {{ t('components.settings.modelSelectionDialog.cancel') }}
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="selectedModelIds.size === 0"
            @click="confirm"
          >
            {{ t('components.settings.modelSelectionDialog.add', { count: selectedModelIds.size }) }}
          </button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.model-dialog-heading {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.model-dialog-heading h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.select-all-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
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

/* 内容 */
.dialog-body {
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
  width: 100%;
  padding: 10px 12px;
  background: var(--vscode-list-hoverBackground);
  border: none;
  border-radius: 2px;
  font: inherit;
  text-align: left;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background 0.15s;
}

.model-item:hover {
  background: var(--vscode-list-activeSelectionBackground);
}

.model-item.is-selected {
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

.model-item.is-selected .model-checkbox {
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
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s;
}

.added-badge:hover {
  color: var(--vscode-errorForeground);
  background: color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent);
}

/* 底部 */
.dialog-footer-content {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
