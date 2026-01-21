<script setup lang="ts">
/**
 * 编辑对话框组件
 * 提供编辑、回档并编辑选项
 * 支持附件管理和提示词上下文管理（内联徽章）
 */

import { ref, computed, watch, nextTick } from 'vue'
import type { CheckpointRecord, Attachment } from '../../types'
import type { PromptContextItem } from '../../types/promptContext'
import { parseMessageContexts } from '../../types/contextParser'
import { useAttachments } from '../../composables/useAttachments'
import { MessageAttachments } from '../message'
import { sendToExtension } from '../../utils/vscode'
import { getFileIcon } from '../../utils/fileIcons'
import { t } from '../../i18n'

interface Props {
  modelValue?: boolean
  /** 消息前关联的检查点（before 阶段） */
  checkpoints?: CheckpointRecord[]
  /** 原始消息内容 */
  originalContent?: string
  /** 原始消息附件 */
  originalAttachments?: Attachment[]
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  checkpoints: () => [],
  originalContent: '',
  originalAttachments: () => []
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 普通编辑 */
  edit: [newContent: string, attachments: Attachment[]]
  /** 回档并编辑 */
  restoreAndEdit: [newContent: string, attachments: Attachment[], checkpointId: string]
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const editContent = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

// 缓存高度状态以减少重排
const cachedLineHeight = ref(0)
const lastScrollHeight = ref(0)

// 拖拽状态
const isDragOver = ref(false)

// 使用附件 composable
const {
  attachments: newAttachments,
  addAttachments,
  removeAttachment: removeNewAttachment,
  clearAttachments
} = useAttachments()

// 被删除的原有附件 ID 集合
const removedOriginalAttachmentIds = ref<Set<string>>(new Set())

// 合并原有附件和新上传的附件（过滤掉被删除的原有附件）
const allAttachments = computed(() => [
  ...props.originalAttachments.filter(att => !removedOriginalAttachmentIds.value.has(att.id)),
  ...newAttachments.value
])

// 提示词上下文项
const promptContextItems = ref<PromptContextItem[]>([])

// 当对话框打开时，初始化编辑内容、附件和上下文
watch(visible, (newValue) => {
  if (newValue) {
    // 解析原始内容中的上下文块
    const parsed = parseMessageContexts(props.originalContent)
    promptContextItems.value = parsed.contexts
    editContent.value = parsed.userContent
    
    clearAttachments() // 清除之前的新附件
    removedOriginalAttachmentIds.value = new Set() // 重置已删除的原有附件
    nextTick(() => {
      adjustTextareaHeight()
      textareaRef.value?.focus()
    })
  }
})

/** 是否有可用的检查点 */
const hasCheckpoints = computed(() => props.checkpoints.length > 0)

/** 最近的检查点（用于回档） */
const latestCheckpoint = computed(() => {
  if (props.checkpoints.length === 0) return null
  
  // 按时间戳降序排序，取最新的
  return [...props.checkpoints].sort((a, b) => b.timestamp - a.timestamp)[0]
})

/** 格式化检查点描述 */
function formatCheckpointDesc(checkpoint: CheckpointRecord): string {
  const toolName = checkpoint.toolName || 'tool'
  // 对于消息类型，显示更友好的描述
  if (toolName === 'user_message') {
    return t('components.common.editDialog.restoreToUserMessage')
  } else if (toolName === 'model_message') {
    return t('components.common.editDialog.restoreToAssistantMessage')
  } else if (toolName === 'tool_batch') {
    return t('components.common.editDialog.restoreToToolBatch')
  }
  return t('components.common.editDialog.restoreToTool').replace('{toolName}', toolName)
}

function adjustTextareaHeight() {
  if (textareaRef.value) {
    const textarea = textareaRef.value
    
    // 获取并缓存行高
    if (!cachedLineHeight.value) {
      cachedLineHeight.value = parseInt(getComputedStyle(textarea).lineHeight) || 20
    }
    
    // 增加高度变化检测：如果当前 scrollHeight 没变，说明不需要重设 height='auto'
    if (textarea.scrollHeight === lastScrollHeight.value && lastScrollHeight.value !== 0) {
      return
    }

    const oldHeight = textarea.style.height
    textarea.style.height = 'auto'
    const newScrollHeight = textarea.scrollHeight
    
    const finalHeight = newScrollHeight + 'px'
    if (oldHeight !== finalHeight) {
      textarea.style.height = finalHeight
    } else {
      textarea.style.height = oldHeight
    }
    
    lastScrollHeight.value = newScrollHeight
  }
}

function handleCancel() {
  visible.value = false
  clearAttachments()
  promptContextItems.value = []
  emit('cancel')
}

// 聚焦 textarea
function focusTextarea() {
  textareaRef.value?.focus()
}

// 获取上下文徽章图标配置
function getContextIcon(ctx: PromptContextItem): { class: string; isFileIcon: boolean } {
  // 文件类型：根据文件路径获取对应图标
  if (ctx.type === 'file' && ctx.filePath) {
    return { class: getFileIcon(ctx.filePath), isFileIcon: true }
  }
  // 其他类型使用 codicon
  switch (ctx.type) {
    case 'snippet':
      return { class: 'codicon codicon-code', isFileIcon: false }
    case 'text':
    default:
      return { class: 'codicon codicon-note', isFileIcon: false }
  }
}

// 移除上下文徽章
function handleRemoveContext(id: string) {
  promptContextItems.value = promptContextItems.value.filter(i => i.id !== id)

  // If the removed chip is being previewed/hovered, close the preview immediately.
  if (previewContext.value?.id === id) {
    previewContext.value = null
  }
  if (hoveredContextId.value === id) {
    hoveredContextId.value = null
  }
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

// 悬浮预览状态
const hoveredContextId = ref<string | null>(null)
const previewContext = ref<PromptContextItem | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function handleContextMouseEnter(ctx: PromptContextItem) {
  hoveredContextId.value = ctx.id
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    previewContext.value = ctx
  }, 300)
}

function handleContextMouseLeave() {
  hoveredContextId.value = null
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  setTimeout(() => {
    if (!hoveredContextId.value) {
      previewContext.value = null
    }
  }, 100)
}

watch(promptContextItems, () => {
  // If the previewed/hovered context no longer exists, close the preview.
  if (previewContext.value) {
    const stillExists = promptContextItems.value.some(i => i.id === previewContext.value!.id)
    if (!stillExists) {
      previewContext.value = null
    }
  }
  if (hoveredContextId.value) {
    const stillHoveredExists = promptContextItems.value.some(i => i.id === hoveredContextId.value)
    if (!stillHoveredExists) {
      hoveredContextId.value = null
    }
  }
}, { deep: true })

function truncatePreview(content: string, maxLines = 10, maxChars = 500): string {
  const lines = content.split('\n').slice(0, maxLines)
  let result = lines.join('\n')
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '...'
  } else if (content.split('\n').length > maxLines) {
    result += '\n...'
  }
  return result
}

// 从文件路径推断语言
function getLanguageFromPath(path?: string): string {
  if (!path) return 'plaintext'
  
  const ext = path.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescriptreact',
    'js': 'javascript',
    'jsx': 'javascriptreact',
    'vue': 'vue',
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'rb': 'ruby',
    'php': 'php',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'md': 'markdown',
    'sql': 'sql',
    'sh': 'shellscript',
    'bash': 'shellscript',
    'zsh': 'shellscript',
    'ps1': 'powershell'
  }
  
  return langMap[ext || ''] || 'plaintext'
}

// 点击徽章打开预览页签
async function handleContextClick(ctx: PromptContextItem) {
  try {
    await sendToExtension('showContextContent', {
      title: ctx.title,
      content: ctx.content,
      language: ctx.language || getLanguageFromPath(ctx.filePath)
    })
  } catch (error) {
    console.error('Failed to show context content:', error)
  }
}

// 处理键盘事件：支持 Backspace 删除徽章
function handleKeydown(e: KeyboardEvent) {
  // Backspace 删除徽章：当光标在最前面且有徽章时，删除最后一个徽章
  if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
    const textarea = textareaRef.value
    if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      if (promptContextItems.value.length > 0) {
        e.preventDefault()
        // 删除最后一个徽章
        promptContextItems.value = promptContextItems.value.slice(0, -1)
        return
      }
    }
  }
}

// 编辑框占位符
const editPlaceholder = computed(() => {
  const hasContexts = promptContextItems.value.length > 0
  const hasText = editContent.value.length > 0
  if (hasContexts || hasText) return ''
  return t('components.common.editDialog.placeholder')
})

// 将附件转换为纯对象（移除 Vue 响应式代理，确保可以通过 postMessage 序列化）
function serializeAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.map(att => ({
    id: att.id,
    name: att.name,
    type: att.type,
    size: att.size,
    mimeType: att.mimeType,
    data: att.data,
    thumbnail: att.thumbnail,
    metadata: att.metadata ? { ...att.metadata } : undefined
  }))
}

// 格式化提示词上下文为 XML 格式
function formatPromptContexts(): string {
  const enabledItems = promptContextItems.value.filter(item => item.enabled)
  if (enabledItems.length === 0) return ''
  
  return enabledItems.map(item => {
    const attrs: string[] = [`type="${item.type}"`]
    if (item.filePath) attrs.push(`path="${item.filePath}"`)
    if (item.title) attrs.push(`title="${item.title}"`)
    if (item.language) attrs.push(`language="${item.language}"`)
    
    // 使用 lim-context 标签避免和用户内容冲突
    return `<lim-context ${attrs.join(' ')}>${item.content}</lim-context>`
  }).join('\n\n')
}

// 获取最终内容（包含上下文块）
function getFinalContent(): string {
  const contextPart = formatPromptContexts()
  const userContent = editContent.value.trim()
  
  if (contextPart) {
    return `${contextPart}\n\n${userContent}`
  }
  return userContent
}

function handleEdit() {
  const finalContent = getFinalContent()
  if (finalContent || allAttachments.value.length > 0) {
    visible.value = false
    // 将附件转换为纯对象以确保可序列化
    emit('edit', finalContent, serializeAttachments(allAttachments.value))
    clearAttachments()
    promptContextItems.value = []
  }
}

function handleRestoreAndEdit() {
  const finalContent = getFinalContent()
  if (latestCheckpoint.value && (finalContent || allAttachments.value.length > 0)) {
    visible.value = false
    // 将附件转换为纯对象以确保可序列化
    emit('restoreAndEdit', finalContent, serializeAttachments(allAttachments.value), latestCheckpoint.value.id)
    clearAttachments()
    promptContextItems.value = []
  }
}

// 附件上传
function triggerFileInput() {
  fileInputRef.value?.click()
}

async function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  
  await addAttachments(Array.from(input.files))
  
  // 重置 input 以允许选择相同文件
  input.value = ''
}

// 移除附件
function handleRemoveAttachment(id: string) {
  // 检查是否是原有附件
  const isOriginal = props.originalAttachments.some(att => att.id === id)
  
  if (isOriginal) {
    // 标记原有附件为已删除
    removedOriginalAttachmentIds.value.add(id)
  } else {
    // 移除新添加的附件
    removeNewAttachment(id)
  }
}

// 处理粘贴事件（支持粘贴图片等文件）
async function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  
  const files: File[] = []
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    // 处理文件类型（图片、文件等）
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) {
        files.push(file)
      }
    }
  }
  
  // 如果有文件，添加为附件
  if (files.length > 0) {
    e.preventDefault()  // 阻止默认粘贴行为
    await addAttachments(files)
  }
  // 如果是纯文本，让浏览器默认处理
}

// 处理拖拽进入
function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = true
}

// 处理拖拽离开
function handleDragLeave(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  // 检查是否真的离开了元素
  const rect = textareaRef.value?.getBoundingClientRect()
  if (rect) {
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      isDragOver.value = false
    }
  }
}

// 处理拖拽悬停
function handleDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
  isDragOver.value = true
}

// 处理拖拽放置
async function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false
  
  const dt = e.dataTransfer
  if (!dt) return
  
  // VSCode 使用自定义的数据类型
  // 优先使用 application/vnd.code.uri-list
  const vscodeUriList = dt.getData('application/vnd.code.uri-list')
  
  if (vscodeUriList) {
    const uris = vscodeUriList.split('\n').filter(uri => uri.trim() && !uri.startsWith('#'))
    if (uris.length > 0) {
      await insertFilePathsFromUris(uris)
      return
    }
  }
  
  // 尝试 resourceurls（JSON 数组格式）
  const resourceUrls = dt.getData('resourceurls')
  if (resourceUrls) {
    try {
      const urls = JSON.parse(resourceUrls) as string[]
      if (urls.length > 0) {
        await insertFilePathsFromUris(urls)
        return
      }
    } catch {
      // 忽略解析错误
    }
  }
  
  // 尝试标准的 text/uri-list
  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    const uris = uriList.split('\n').filter(uri => uri.trim() && !uri.startsWith('#'))
    if (uris.length > 0) {
      await insertFilePathsFromUris(uris)
      return
    }
  }
  
  // 如果没有 URI 列表，尝试从 Files 获取
  if (dt.files && dt.files.length > 0) {
    const paths: string[] = []
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files[i]
      const filePath = (file as any).path || file.name
      if (filePath) {
        paths.push(filePath)
      }
    }
    
    if (paths.length > 0) {
      await insertFilePathsFromPaths(paths)
    }
  }
}

// 从 URI 列表添加文件为徽章
async function insertFilePathsFromUris(uris: string[]) {
  for (const uri of uris) {
    try {
      const result = await sendToExtension<{ relativePath: string; isDirectory?: boolean }>('getRelativePath', {
        absolutePath: uri.trim()
      })
      if (result.relativePath && !result.isDirectory) {
        await addFileContextByPath(result.relativePath)
      }
    } catch (err) {
      console.error('获取相对路径失败:', err)
      try {
        const url = new URL(uri)
        const pathName = decodeURIComponent(url.pathname)
        const fileName = pathName.split('/').pop()
        if (fileName) {
          await addFileContextByPath(fileName)
        }
      } catch {
        // 忽略无效 URI
      }
    }
  }
}

// 从本地路径添加文件为徽章
async function insertFilePathsFromPaths(paths: string[]) {
  for (const absolutePath of paths) {
    try {
      const result = await sendToExtension<{ relativePath: string; isDirectory?: boolean }>('getRelativePath', {
        absolutePath
      })
      if (result.relativePath && !result.isDirectory) {
        await addFileContextByPath(result.relativePath)
      }
    } catch (err) {
      console.error('获取相对路径失败:', err)
      const fileName = absolutePath.split(/[/\\]/).pop()
      if (fileName) {
        await addFileContextByPath(fileName)
      }
    }
  }
}

// 通过路径添加文件上下文
async function addFileContextByPath(path: string) {
  // 检查是否已存在
  const exists = promptContextItems.value.some(item => item.filePath === path)
  if (exists) return
  
  try {
    const result = await sendToExtension<{ success: boolean; path: string; content: string; error?: string }>(
      'readWorkspaceTextFile',
      { path }
    )
    
    if (result?.success) {
      promptContextItems.value.push({
        id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'file',
        title: result.path,
        content: result.content,
        filePath: result.path,
        enabled: true,
        addedAt: Date.now()
      })
    }
  } catch (error) {
    console.error('Failed to add file context:', error)
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="dialog-overlay">
        <div class="dialog edit-dialog">
          <div class="dialog-header">
            <i class="codicon codicon-edit dialog-icon"></i>
            <span class="dialog-title">{{ t('components.common.editDialog.title') }}</span>
          </div>
          <div class="dialog-body">
            <!-- 输入区域（内联徽章 + textarea） -->
            <div class="edit-input-wrapper">
              <div
                class="edit-input-surface"
                :class="{ 'drag-over': isDragOver }"
                @click="focusTextarea"
              >
                <!-- 内联上下文徽章 -->
                <template v-for="ctx in promptContextItems" :key="ctx.id">
                  <span
                    class="context-chip"
                    :class="{ hovered: hoveredContextId === ctx.id }"
                    @click.stop="handleContextClick(ctx)"
                    @mouseenter="handleContextMouseEnter(ctx)"
                    @mouseleave="handleContextMouseLeave"
                  >
                    <i :class="getContextIcon(ctx).class"></i>
                    <span class="context-chip__text">{{ ctx.title }}</span>
                    <button
                      class="context-chip__remove"
                      type="button"
                      @click.stop="handleRemoveContext(ctx.id)"
                      aria-label="Remove"
                    >
                      <i class="codicon codicon-close"></i>
                    </button>
                  </span>
                </template>

                <!-- 文本输入框 -->
                <textarea
                  ref="textareaRef"
                  v-model="editContent"
                  class="edit-textarea"
                  :placeholder="editPlaceholder"
                  @input="adjustTextareaHeight"
                  @keydown="handleKeydown"
                  @keydown.esc="handleCancel"
                  @paste="handlePaste"
                  @dragenter="handleDragEnter"
                  @dragleave="handleDragLeave"
                  @dragover="handleDragOver"
                  @drop="handleDrop"
                />
              </div>

              <!-- 悬浮预览弹窗（不占用布局） -->
              <Transition name="fade">
                <div
                  v-if="previewContext"
                  class="context-preview"
                  @mouseenter="hoveredContextId = previewContext.id"
                  @mouseleave="handleContextMouseLeave"
                >
                  <div class="preview-header">
                    <i :class="getContextIcon(previewContext).class"></i>
                    <span class="preview-title">{{ previewContext.title }}</span>
                  </div>
                  <pre class="preview-content">{{ truncatePreview(previewContext.content) }}</pre>
                </div>
              </Transition>
            </div>
            
            <!-- 附件区域 -->
            <div class="attachment-section">
              <!-- 附件上传按钮 -->
              <button class="attachment-btn" @click="triggerFileInput" :title="t('components.common.editDialog.addAttachment')">
                <i class="codicon codicon-add"></i>
                <span>{{ t('components.common.editDialog.addAttachment') }}</span>
              </button>
              <input
                ref="fileInputRef"
                type="file"
                multiple
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.json,.js,.ts,.py,.java,.c,.cpp,.h,.css,.html,.xml,.md"
                style="display: none"
                @change="handleFileSelect"
              />
              
              <!-- 附件列表 -->
              <div v-if="allAttachments.length > 0" class="attachment-list">
                <MessageAttachments
                  :attachments="allAttachments"
                  :readonly="false"
                  @remove="handleRemoveAttachment"
                />
              </div>
            </div>
            
            <p v-if="hasCheckpoints" class="checkpoint-hint">
              <i class="codicon codicon-info"></i>
              {{ t('components.common.editDialog.checkpointHint') }}
            </p>
          </div>
          <div class="dialog-footer">
            <button class="dialog-btn cancel" @click="handleCancel">
              {{ t('components.common.editDialog.cancel') }}
            </button>
            <!-- 有检查点时显示回档选项 -->
            <button
              v-if="latestCheckpoint"
              class="dialog-btn restore"
              :disabled="!editContent.trim()"
              @click="handleRestoreAndEdit"
            >
              <i class="codicon codicon-discard"></i>
              {{ formatCheckpointDesc(latestCheckpoint) }}
            </button>
            <button
              class="dialog-btn confirm"
              :disabled="!editContent.trim()"
              @click="handleEdit"
            >
              {{ t('components.common.editDialog.save') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  min-width: 320px;
  max-width: 90%;
  width: calc(100% - 32px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.edit-dialog {
  /* 使用最大宽度限制，不再固定宽度 */
  max-width: min(500px, 90%);
}

@media (max-width: 400px) {
  .dialog {
    min-width: unset;
    width: calc(100% - 16px);
    margin: 0 8px;
  }
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.dialog-icon {
  font-size: 18px;
  color: var(--vscode-editorInfo-foreground);
}

.dialog-title {
  font-weight: 500;
  font-size: 14px;
}

.dialog-body {
  padding: 16px;
}

/* 输入外壳：包含徽章和 textarea */
.edit-input-wrapper {
  position: relative;
}

/* 输入外壳：包含徽章和 textarea */
.edit-input-surface {
  width: 100%;
  min-height: 100px;
  max-height: 300px;
  padding: 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  transition: border-color 0.15s;
  overflow-y: auto;
  cursor: text;

  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
}

.edit-input-surface:focus-within {
  border-color: var(--vscode-focusBorder);
}

.edit-input-surface.drag-over {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-hoverBackground);
}

/* 文本输入区（无边框，融入 input-surface） */
.edit-textarea {
  flex: 1;
  min-width: 120px;
  min-height: 60px;
  padding: 0;
  margin: 0;
  background: transparent;
  color: var(--vscode-input-foreground);
  border: none;
  border-radius: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  outline: none;
  overflow-y: auto;
}

.edit-textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

/* 内联徽章样式：浅蓝色背景 */
.context-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 200px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 122, 204, 0.16);
  border: 1px solid rgba(0, 122, 204, 0.28);
  color: var(--vscode-foreground);
  user-select: none;
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.context-chip:hover {
  background: rgba(0, 122, 204, 0.24);
  border-color: rgba(0, 122, 204, 0.4);
}

.context-chip .codicon {
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
  flex-shrink: 0;
}

.context-chip__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.context-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.context-chip:hover .context-chip__remove,
.context-chip.hovered .context-chip__remove {
  opacity: 1;
  pointer-events: auto;
}

.context-chip__remove:hover {
  color: var(--vscode-errorForeground);
}

.context-chip__remove .codicon {
  font-size: 10px;
}

/* 附件区域 */
.attachment-section {
  margin-top: 12px;
}

.attachment-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.attachment-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  border-color: var(--vscode-focusBorder);
}

.attachment-btn .codicon {
  font-size: 14px;
}

.attachment-list {
  margin-top: 8px;
}

.dialog-body .checkpoint-hint {
  margin-top: 12px;
  padding: 8px 10px;
  background: var(--vscode-editorInfo-background, rgba(0, 120, 212, 0.1));
  border-radius: 4px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-editorInfo-foreground, #3794ff);
}

.dialog-body .checkpoint-hint .codicon {
  flex-shrink: 0;
  margin-top: 1px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-panel-border);
  flex-wrap: wrap;
}

.dialog-btn {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: background-color 0.15s, opacity 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dialog-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dialog-btn.cancel {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border);
}

.dialog-btn.cancel:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
}

.dialog-btn.restore {
  background: var(--vscode-editorInfo-foreground);
  color: white;
}

.dialog-btn.restore:hover:not(:disabled) {
  opacity: 0.9;
}

.dialog-btn.restore .codicon {
  font-size: 12px;
}

.dialog-btn.confirm {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dialog-btn.confirm:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

/* 动画 */
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.15s ease;
}

.dialog-fade-enter-active .dialog,
.dialog-fade-leave-active .dialog {
  transition: transform 0.15s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-from .dialog,
.dialog-fade-leave-to .dialog {
  transform: scale(0.95);
}

/* 悬浮预览弹窗 */
.context-preview {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 100;
  max-height: 240px;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.preview-header .codicon {
  font-size: 14px;
  color: var(--vscode-textLink-foreground);
}

.preview-title {
  flex: 1;
  font-weight: 500;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-content {
  margin: 0;
  padding: 10px 12px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  line-height: 1.5;
  overflow-y: auto;
  max-height: 140px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vscode-foreground);
  background: var(--vscode-textBlockQuote-background);
}

/* 淡入淡出动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>