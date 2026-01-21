<script setup lang="ts">
/**
 * PromptContextPanel - 提示词上下文面板
 * 用于管理附加到用户消息前的特殊提示词内容（如文件内容等）
 */

import { ref, computed } from 'vue'
import { IconButton, CustomScrollbar } from '../common'
import { sendToExtension, showNotification } from '../../utils/vscode'
import { useI18n } from '../../i18n'
import { getFileIcon } from '../../utils/fileIcons'
import type { PromptContextItem } from '../../types/promptContext'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  /** 是否显示（InputArea 场景使用） */
  visible?: boolean
  /** 上下文项 */
  items: PromptContextItem[]
  /** 是否以内联方式显示（用于 EditDialog） */
  inline?: boolean
  /** 是否显示关闭按钮 */
  closable?: boolean
}>(), {
  visible: true,
  inline: false,
  closable: true
})

const emit = defineEmits<{
  close: []
  'add-file': []
  'add-text': []
  'remove-item': [id: string]
  'toggle-item': [id: string, enabled: boolean]
  'update-items': [items: PromptContextItem[]]
  'update:items': [items: PromptContextItem[]]
}>()

// 编辑状态
const editingItemId = ref<string | null>(null)
const editingContent = ref('')

// 拖拽状态
const isDraggingOver = ref(false)

// 是否正在添加文本
const isAddingText = ref(false)
const newTextTitle = ref('')
const newTextContent = ref('')

// 获取类型图标
function getTypeIcon(item: PromptContextItem): string {
  // 文件类型：根据文件路径获取对应图标
  if (item.type === 'file' && item.filePath) {
    return getFileIcon(item.filePath)
  }
  // 其他类型使用 codicon
  switch (item.type) {
    case 'text': return 'codicon codicon-note'
    case 'snippet': return 'codicon codicon-code'
    default: return 'codicon codicon-file'
  }
}

// 获取类型标签
function getTypeLabel(type: string): string {
  switch (type) {
    case 'file': return t('components.input.promptContext.typeFile')
    case 'text': return t('components.input.promptContext.typeText')
    case 'snippet': return t('components.input.promptContext.typeSnippet')
    default: return type
  }
}

// 处理切换启用状态
function handleToggle(id: string, enabled: boolean) {
  // 支持 v-model:items
  const updatedItems = props.items.map(item => 
    item.id === id ? { ...item, enabled } : item
  )
  emit('update:items', updatedItems)
  emit('toggle-item', id, enabled)
}

// 处理移除项
function handleRemove(id: string) {
  // 支持 v-model:items
  const updatedItems = props.items.filter(item => item.id !== id)
  emit('update:items', updatedItems)
  emit('remove-item', id)
}

// 开始编辑
function startEdit(item: PromptContextItem) {
  editingItemId.value = item.id
  editingContent.value = item.content
}

// 保存编辑
function saveEdit(item: PromptContextItem) {
  const updatedItems = props.items.map(i => 
    i.id === item.id ? { ...i, content: editingContent.value } : i
  )
  emit('update:items', updatedItems)
  emit('update-items', updatedItems)
  cancelEdit()
}

// 取消编辑
function cancelEdit() {
  editingItemId.value = null
  editingContent.value = ''
}

// 开始添加文本
function startAddText() {
  isAddingText.value = true
  newTextTitle.value = ''
  newTextContent.value = ''
}

// 确认添加文本
function confirmAddText() {
  if (!newTextTitle.value.trim() || !newTextContent.value.trim()) {
    return
  }
  
  const newItem: PromptContextItem = {
    id: `text-${Date.now()}`,
    type: 'text',
    title: newTextTitle.value.trim(),
    content: newTextContent.value.trim(),
    enabled: true,
    addedAt: Date.now()
  }
  
  const updatedItems = [...props.items, newItem]
  emit('update:items', updatedItems)
  emit('update-items', updatedItems)
  cancelAddText()
}

// 取消添加文本
function cancelAddText() {
  isAddingText.value = false
  newTextTitle.value = ''
  newTextContent.value = ''
}

// 处理拖拽进入
function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = true
}

// 处理拖拽悬停
function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = true
}

// 处理拖拽离开
function handleDragLeave(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  
  const target = e.currentTarget as HTMLElement
  const related = e.relatedTarget as HTMLElement
  if (target && related && target.contains(related)) {
    return
  }
  
  isDraggingOver.value = false
}

// 处理拖拽放置 - 添加文件
async function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = false
  
  // 获取拖拽的文件 URI
  const vscodeUriList = e.dataTransfer?.getData('application/vnd.code.uri-list')
  const textUriList = e.dataTransfer?.getData('text/uri-list')
  
  const isValidFileUri = (uri: string): boolean => {
    if (!uri || typeof uri !== 'string') return false
    return uri.startsWith('file://') || uri.startsWith('vscode-remote://')
  }
  
  let urisToProcess: string[] = []
  
  if (vscodeUriList) {
    urisToProcess = vscodeUriList.split('\n').filter(uri => uri.trim() && isValidFileUri(uri.trim()))
  } else if (textUriList) {
    urisToProcess = textUriList.split('\n').filter(uri => uri.trim() && !uri.startsWith('#'))
  }
  
  if (urisToProcess.length > 0) {
    for (const uri of urisToProcess) {
      try {
        // 请求后端读取文件内容
        const result = await sendToExtension<{
          success: boolean
          path: string
          content: string
          error?: string
        }>('readFileForContext', { uri: uri.trim() })
        
        if (result?.success) {
          const newItem: PromptContextItem = {
            id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'file',
            title: result.path,
            content: result.content,
            filePath: result.path,
            enabled: true,
            addedAt: Date.now()
          }
          
          const updatedItems = [...props.items, newItem]
          emit('update:items', updatedItems)
          emit('update-items', updatedItems)
          await showNotification(
            t('components.input.promptContext.fileAdded', { path: result.path }),
            'info'
          )
        } else {
          await showNotification(
            result?.error || t('components.input.promptContext.readFailed'),
            'error'
          )
        }
      } catch (error: any) {
        console.error('Failed to add file to context:', error)
        await showNotification(
          t('components.input.promptContext.addFailed', { error: error.message }),
          'error'
        )
      }
    }
  }
}

// 预览内容（截断）
function getPreviewContent(content: string, maxLength: number = 100): string {
  if (content.length <= maxLength) return content
  return content.slice(0, maxLength) + '...'
}

// 获取启用的项数量
const enabledCount = computed(() => props.items.filter(i => i.enabled).length)
</script>

<template>
  <div
    v-if="visible"
    class="prompt-context-panel"
    :class="{ 'drag-over': isDraggingOver, inline: props.inline }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 头部 -->
    <div class="panel-header">
      <span class="panel-title">
        <i class="codicon codicon-symbol-parameter"></i>
        {{ t('components.input.promptContext.title') }}
        <span v-if="enabledCount > 0" class="count-badge">{{ enabledCount }}</span>
      </span>
      <div class="header-actions">
        <IconButton
          icon="codicon-add"
          size="small"
          @click="startAddText"
          :title="t('components.input.promptContext.addText')"
        />
        <IconButton
          v-if="props.closable"
          icon="codicon-close"
          size="small"
          @click="emit('close')"
        />
      </div>
    </div>
    
    <!-- 描述 -->
    <div class="panel-description">
      {{ t('components.input.promptContext.description') }}
    </div>
    
    <!-- 内容区域 -->
    <CustomScrollbar class="panel-content" :maxHeight="280">
      <!-- 添加文本表单 -->
      <div v-if="isAddingText" class="add-text-form">
        <input
          v-model="newTextTitle"
          type="text"
          class="text-input title-input"
          :placeholder="t('components.input.promptContext.titlePlaceholder')"
          @keydown.enter="confirmAddText"
          @keydown.escape="cancelAddText"
        />
        <textarea
          v-model="newTextContent"
          class="text-input content-input"
          :placeholder="t('components.input.promptContext.contentPlaceholder')"
          rows="3"
        ></textarea>
        <div class="form-actions">
          <button class="btn btn-primary" @click="confirmAddText" :disabled="!newTextTitle.trim() || !newTextContent.trim()">
            {{ t('common.confirm') }}
          </button>
          <button class="btn btn-secondary" @click="cancelAddText">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
      
      <!-- 空状态 -->
      <div v-if="items.length === 0 && !isAddingText" class="empty-state">
        <i class="codicon codicon-inbox"></i>
        <span>{{ t('components.input.promptContext.empty') }}</span>
        <span class="empty-hint">{{ t('components.input.promptContext.emptyHint') }}</span>
      </div>
      
      <!-- 项列表 -->
      <div v-else class="items-list">
        <div
          v-for="item in items"
          :key="item.id"
          class="context-item"
          :class="{ disabled: !item.enabled }"
        >
          <!-- 项头部 -->
          <div class="item-header">
            <input
              type="checkbox"
              :checked="item.enabled"
              @change="handleToggle(item.id, !item.enabled)"
              class="item-checkbox"
            />
            <i :class="getTypeIcon(item)"></i>
            <span class="item-title" :title="item.title">{{ item.title }}</span>
            <span class="item-type-badge">{{ getTypeLabel(item.type) }}</span>
            <div class="item-actions">
              <IconButton
                v-if="item.type !== 'file'"
                icon="codicon-edit"
                size="small"
                @click="startEdit(item)"
                :title="t('common.edit')"
              />
              <IconButton
                icon="codicon-close"
                size="small"
                @click="handleRemove(item.id)"
                :title="t('common.remove')"
              />
            </div>
          </div>
          
          <!-- 项内容预览 -->
          <div class="item-content">
            <template v-if="editingItemId === item.id">
              <textarea
                v-model="editingContent"
                class="edit-textarea"
                rows="4"
              ></textarea>
              <div class="edit-actions">
                <button class="btn btn-primary btn-sm" @click="saveEdit(item)">
                  {{ t('common.save') }}
                </button>
                <button class="btn btn-secondary btn-sm" @click="cancelEdit">
                  {{ t('common.cancel') }}
                </button>
              </div>
            </template>
            <template v-else>
              <pre class="content-preview">{{ getPreviewContent(item.content, 200) }}</pre>
            </template>
          </div>
        </div>
      </div>
    </CustomScrollbar>
    
    <!-- 底部提示 -->
    <div class="panel-footer">
      <div class="footer-hint">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.input.promptContext.hint') }}</span>
      </div>
    </div>
    
    <!-- 拖拽遮罩 -->
    <div v-if="isDraggingOver" class="drag-overlay">
      <i class="codicon codicon-file-add"></i>
      <span>{{ t('components.input.promptContext.dropHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.prompt-context-panel {
  position: absolute;
  bottom: 100%;
  left: 8px;
  right: 8px;
  margin-bottom: 8px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  max-height: 400px;
  display: flex;
  flex-direction: column;
}

/* 内联模式：用于编辑对话框等场景，放在文档流中 */
.prompt-context-panel.inline {
  position: relative;
  bottom: auto;
  left: auto;
  right: auto;
  margin-bottom: 12px;
  z-index: auto;
  max-height: 260px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.panel-title .codicon {
  font-size: 14px;
  color: var(--vscode-textLink-foreground);
}

.count-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  border-radius: 8px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.panel-description {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

/* 添加文本表单 */
.add-text-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: var(--vscode-list-hoverBackground);
  border-radius: 4px;
  margin-bottom: 8px;
}

.text-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  outline: none;
}

.text-input:focus {
  border-color: var(--vscode-focusBorder);
}

.content-input {
  resize: vertical;
  min-height: 60px;
  font-family: var(--vscode-editor-font-family);
}

.form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.btn {
  padding: 4px 12px;
  font-size: 12px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.btn-secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.btn-sm {
  padding: 2px 8px;
  font-size: 11px;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--vscode-descriptionForeground);
}

.empty-state .codicon {
  font-size: 32px;
  opacity: 0.5;
}

.empty-hint {
  font-size: 11px;
  text-align: center;
}

/* 项列表 */
.items-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.context-item {
  background: var(--vscode-list-hoverBackground);
  border-radius: 4px;
  overflow: hidden;
}

.context-item.disabled {
  opacity: 0.5;
}

.item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-editor-background);
}

.item-checkbox {
  cursor: pointer;
  accent-color: var(--vscode-checkbox-foreground);
}

.item-header .codicon {
  font-size: 14px;
  opacity: 0.7;
  flex-shrink: 0;
}

.item-title {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-type-badge {
  font-size: 10px;
  padding: 1px 6px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background);
  border-radius: 3px;
  flex-shrink: 0;
}

.item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.item-content {
  padding: 8px 10px;
}

.content-preview {
  margin: 0;
  padding: 8px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background);
  border-radius: 3px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 80px;
  overflow-y: auto;
}

/* 编辑区域 */
.edit-textarea {
  width: 100%;
  padding: 8px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  resize: vertical;
  min-height: 80px;
}

.edit-textarea:focus {
  border-color: var(--vscode-focusBorder);
  outline: none;
}

.edit-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  margin-top: 6px;
}

/* 底部 */
.panel-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border);
}

.footer-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.footer-hint .codicon {
  font-size: 12px;
  opacity: 0.7;
}

/* 拖拽状态 */
.prompt-context-panel.drag-over {
  border-color: var(--vscode-focusBorder);
}

.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(var(--vscode-editor-background), 0.95);
  border-radius: 6px;
  z-index: 10;
}

.drag-overlay .codicon {
  font-size: 32px;
  color: var(--vscode-textLink-foreground);
}

.drag-overlay span {
  font-size: 13px;
  color: var(--vscode-foreground);
}
</style>
