<script setup lang="ts">
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed } from 'vue'
import ModelSelectionDialog from './ModelSelectionDialog.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import CustomScrollbar from '../common/CustomScrollbar.vue'
import { sendToExtension, showNotification } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import type { ModelInfo } from '@/types'

const { t } = useI18n()

interface Props {
  configId: string
  models: ModelInfo[]
  selectedModel: string
  /**
   * 打开模型选择对话框前的准备钩子（父组件用于 flush 未保存的配置，如 url/apiKey 防抖编辑）。
   * 准备失败时不打开对话框并提示用户，避免 models.getModels 读取到后端持久化的旧配置。
   */
  prepare?: () => Promise<void>
}

interface Emits {
  (e: 'update:models', models: ModelInfo[]): void
  (e: 'update:selectedModel', modelId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// 对话框状态
const showDialog = ref(false)
const showClearConfirm = ref(false)
const newModelId = ref('')

// 筛选关键词
const filterKeyword = ref('')

// 已添加模型的 ID 列表
const addedModelIds = computed(() => props.models.map(m => m.id))

async function notifyFailure(message: string, error?: unknown) {
  const detail = error instanceof Error && error.message ? `${message}: ${error.message}` : message
  await showNotification(detail, 'error')
}

// 筛选后的模型列表
const filteredModels = computed(() => {
  if (!filterKeyword.value.trim()) {
    return props.models
  }
  const keyword = filterKeyword.value.toLowerCase().trim()
  return props.models.filter(model =>
    model.id.toLowerCase().includes(keyword) ||
    (model.name && model.name.toLowerCase().includes(keyword)) ||
    (model.description && model.description.toLowerCase().includes(keyword))
  )
})

// 打开选择对话框：先等待父组件准备完成（如 flush 未保存的 url/apiKey 编辑，
// 避免 models.getModels 只凭 configId 读到后端持久化的旧配置）；失败则不打开对话框
async function openDialog() {
  try {
    await props.prepare?.()
    showDialog.value = true
  } catch (error) {
    console.error('Failed to prepare before fetching models:', error)
    await notifyFailure(t('components.settings.modelSelectionDialog.error'), error)
  }
}

// 处理对话框确认
async function handleConfirm(selectedModels: ModelInfo[]) {
  try {
    // 确保数据是可序列化的纯对象
    const serializableModels = selectedModels.map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens
    }))
    
    await sendToExtension(MESSAGE_NAMES['models.addModels'], {
      configId: props.configId,
      models: serializableModels
    })
    // 触发父组件重新加载配置
    const updatedModels = [...props.models, ...serializableModels]
    emit('update:models', updatedModels)
  } catch (error) {
    console.error('Failed to add models:', error)
    await notifyFailure(t('components.settings.modelManager.errors.addFailed'), error)
  }
}

// 处理对话框移除
async function handleDialogRemove(modelId: string) {
  await removeModel(modelId)
}

// 手动添加模型
async function addCustomModel() {
  if (!newModelId.value.trim()) return
  
  const id = newModelId.value.trim()
  
  // 添加前查重：已存在同 ID 模型时提示并阻止，避免重复添加
  if (props.models.some(m => m.id === id)) {
    await notifyFailure(t('components.settings.modelManager.errors.addFailed'))
    return
  }
  
  const model = {
    id,
    name: id
  }
  
  try {
    await sendToExtension(MESSAGE_NAMES['models.addModels'], {
      configId: props.configId,
      models: [model]
    })
    // 触发父组件重新加载配置
    const updatedModels = [...props.models, model]
    emit('update:models', updatedModels)
    newModelId.value = ''
  } catch (error) {
    console.error('Failed to add model:', error)
    await notifyFailure(t('components.settings.modelManager.errors.addFailed'), error)
  }
}

// 移除模型
async function removeModel(modelId: string) {
  try {
    await sendToExtension(MESSAGE_NAMES['models.removeModel'], {
      configId: props.configId,
      modelId
    })
    // 触发父组件重新加载配置
    const updatedModels = props.models.filter(m => m.id !== modelId)
    emit('update:models', updatedModels)
    
    // 如果移除的是当前模型，清空（允许删除正在使用的模型）
    if (props.selectedModel === modelId) {
      emit('update:selectedModel', '')
    }
  } catch (error) {
    console.error('Failed to remove model:', error)
    await notifyFailure(t('components.settings.modelManager.errors.removeFailed'), error)
  }
}

// 显示清除确认对话框
function showClearConfirmDialog() {
  if (props.models.length === 0) return
  showClearConfirm.value = true
}

// 确认清除所有模型
async function confirmClearAllModels() {
  // 失败时局部回滚用：保存删除前的列表与选中项
  const originalModels = [...props.models]
  const originalSelected = props.selectedModel
  
  try {
    // 逐个删除模型
    for (const model of props.models) {
      await sendToExtension(MESSAGE_NAMES['models.removeModel'], {
        configId: props.configId,
        modelId: model.id
      })
    }
    
    // 清空列表和当前选择
    emit('update:models', [])
    emit('update:selectedModel', '')
  } catch (error) {
    console.error('Failed to clear models:', error)
    // 局部回滚：恢复删除前的本地列表（后端部分删除时，下次加载会与后端对齐）
    emit('update:models', originalModels)
    emit('update:selectedModel', originalSelected)
    await notifyFailure(t('components.settings.modelManager.errors.removeFailed'), error)
  }
}

// 选择模型作为启用
async function selectModel(modelId: string) {
  try {
    await sendToExtension(MESSAGE_NAMES['models.setActiveModel'], {
      configId: props.configId,
      modelId
    })
    emit('update:selectedModel', modelId)
  } catch (error) {
    console.error('Failed to set active model:', error)
    await notifyFailure(t('components.settings.modelManager.errors.setActiveFailed'), error)
  }
}
</script>

<template>
  <div class="model-manager">
    <div class="section-header">
      <label>{{ t('components.settings.modelManager.title') }}</label>
      <div class="header-actions">
        <button type="button" class="fetch-btn gc-button gc-button--primary" @click="openDialog">
          <i class="codicon codicon-add" aria-hidden="true"></i>
          <span>{{ t('components.settings.modelManager.fetchModels') }}</span>
        </button>
        <button
          type="button"
          class="clear-btn gc-button"
          :disabled="models.length === 0"
          :title="t('components.settings.modelManager.clearAllTooltip')"
          @click="showClearConfirmDialog"
        >
          <i class="codicon codicon-clear-all" aria-hidden="true"></i>
          <span>{{ t('components.settings.modelManager.clearAll') }}</span>
        </button>
      </div>
    </div>
    
    <!-- 已添加的模型 -->
    <div v-if="models.length > 0" class="model-list-container">
      <!-- 筛选输入框 -->
      <div class="filter-input-container">
        <i class="codicon codicon-search" aria-hidden="true"></i>
        <input
          v-model="filterKeyword"
          type="text"
          :placeholder="t('components.settings.modelManager.filterPlaceholder')"
          :aria-label="t('components.settings.modelManager.filterPlaceholder')"
          class="filter-input"
        />
        <button
          v-if="filterKeyword"
          type="button"
          class="filter-clear-btn gc-icon-button"
          :title="t('components.settings.modelManager.clearFilter')"
          :aria-label="t('components.settings.modelManager.clearFilter')"
          @click="filterKeyword = ''"
        >
          <i class="codicon codicon-close" aria-hidden="true"></i>
        </button>
      </div>
      
      <CustomScrollbar class="model-list-scrollbar">
        <div class="model-list">
          <!-- 筛选无结果提示 -->
          <div v-if="filteredModels.length === 0 && filterKeyword" class="no-results" role="status">
            <i class="codicon codicon-search" aria-hidden="true"></i>
            <span>{{ t('components.settings.modelManager.noResults') }}</span>
          </div>
          
          <div
            v-for="model in filteredModels"
            :key="model.id"
            :class="['model-item', { enabled: selectedModel === model.id }]"
          >
            <button
              type="button"
              class="model-select-button"
              :aria-pressed="selectedModel === model.id"
              @click="selectModel(model.id)"
            >
              <span class="model-status" aria-hidden="true">
                <i
                  :class="[
                    'codicon',
                    selectedModel === model.id ? 'codicon-circle-filled' : 'codicon-circle-outline'
                  ]"
                ></i>
              </span>
              <span class="model-info">
                <span class="model-id">{{ model.id }}</span>
                <span v-if="model.name && model.name !== model.id" class="model-name">{{ model.name }}</span>
                <span v-if="model.description" class="model-desc">{{ model.description }}</span>
              </span>
            </button>
            <button
              type="button"
              class="model-remove-btn gc-icon-button gc-icon-button--danger"
              :title="t('components.settings.modelManager.removeTooltip')"
              :aria-label="`${t('components.settings.modelManager.removeTooltip')}: ${model.id}`"
              @click="removeModel(model.id)"
            >
              <i class="codicon codicon-close" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </CustomScrollbar>
    </div>
    
    <!-- 空状态 -->
    <div v-else class="empty-models" role="status">
      <i class="codicon codicon-info" aria-hidden="true"></i>
      <span>{{ t('components.settings.modelManager.empty') }}</span>
    </div>
    
    <!-- 手动添加 -->
    <div class="add-model">
      <input
        v-model="newModelId"
        type="text"
        class="gc-field"
        :placeholder="t('components.settings.modelManager.addPlaceholder')"
        @keyup.enter="addCustomModel"
      />
      <button
        type="button"
        class="add-btn gc-icon-button"
        :title="t('components.settings.modelManager.addTooltip')"
        :aria-label="t('components.settings.modelManager.addTooltip')"
        :disabled="!newModelId.trim()"
        @click="addCustomModel"
      >
        <i class="codicon codicon-add" aria-hidden="true"></i>
      </button>
    </div>
    
    <!-- 模型选择对话框 -->
    <ModelSelectionDialog
      v-model:visible="showDialog"
      :config-id="configId"
      :added-model-ids="addedModelIds"
      @confirm="handleConfirm"
      @remove="handleDialogRemove"
    />
    
    <!-- 清除确认对话框 -->
    <ConfirmDialog
      v-model="showClearConfirm"
      :title="t('components.settings.modelManager.clearDialog.title')"
      :message="t('components.settings.modelManager.clearDialog.message', { count: models.length })"
      :confirm-text="t('components.settings.modelManager.clearDialog.confirm')"
      :cancel-text="t('components.settings.modelManager.clearDialog.cancel')"
      :is-danger="true"
      @confirm="confirmClearAllModels"
    />
  </div>
</template>

<style scoped>
.model-manager {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 区域标题 */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-header label {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.fetch-btn,
.clear-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: none;
  border-radius: 2px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.fetch-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.fetch-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.clear-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.clear-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.clear-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fetch-btn .codicon,
.clear-btn .codicon {
  font-size: 12px;
}

/* 模型列表容器 - 需要明确高度让 CustomScrollbar 正常工作 */
.model-list-container {
  height: auto;
  max-height: 280px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
}

/* 筛选输入框 */
.filter-input-container {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
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

.model-list-scrollbar {
  flex: 1;
  min-height: 0;
  max-height: 200px;
}

/* 深度选择器覆盖 CustomScrollbar 内部样式 */
.model-list-scrollbar :deep(.custom-scrollbar-wrapper) {
  height: auto !important;
  max-height: 200px;
}

.model-list-scrollbar :deep(.scroll-container) {
  height: auto !important;
  max-height: 200px;
}

/* 模型列表 */
.model-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
}

.model-item {
  display: flex;
  align-items: stretch;
  gap: var(--gc-space-1);
  padding: 0;
  background: var(--vscode-list-hoverBackground);
  border-left: 2px solid transparent;
  border-radius: var(--gc-radius-sm);
  transition:
    background-color var(--gc-duration-fast) var(--gc-ease-standard),
    border-color var(--gc-duration-fast) var(--gc-ease-standard);
}

.model-select-button {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
  padding: var(--gc-space-2) 10px;
  color: var(--gc-text-primary);
  background: transparent;
  border: 0;
  text-align: left;
}

.model-item:hover .model-select-button,
.model-select-button:focus-visible {
  background: var(--vscode-list-activeSelectionBackground);
}

.model-item.enabled {
  background: var(--vscode-list-activeSelectionBackground);
  border-left-color: var(--vscode-focusBorder);
}

.model-status {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.model-item.enabled .model-status {
  color: var(--vscode-charts-blue, #007acc);
}

.model-status .codicon {
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

.model-remove-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* .model-item 是 align-items: stretch，而本按钮有固定高度：
     不显式声明 align-self 时 stretch 会退化成顶端对齐，两行高的条目里叉号就会偏上 */
  align-self: center;
  margin-inline-end: var(--gc-space-1);
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 2px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  opacity: 0;
}

.model-item:hover .model-remove-btn,
.model-item:focus-within .model-remove-btn {
  opacity: 1;
}

.model-remove-btn:hover {
  color: var(--vscode-errorForeground);
}

/* 空状态 */
.empty-models {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background);
  border-radius: var(--gc-radius-sm);
}

.empty-models .codicon {
  font-size: 24px;
  opacity: 0.5;
}

/* 添加模型 */
.add-model {
  display: flex;
  gap: 4px;
}

.add-model input {
  flex: 1;
  padding: 6px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 12px;
}

.add-model input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.add-model input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.15s;
}

.add-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.add-btn .codicon {
  font-size: 14px;
}
</style>