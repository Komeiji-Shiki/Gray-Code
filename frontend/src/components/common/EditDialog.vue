<script setup lang="ts">
/**
 * 编辑对话框组件
 * 提供编辑、回档并编辑选项
 * 支持附件管理和提示词上下文管理（内联徽章）
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, watch, nextTick } from 'vue'
import type { CheckpointRecord, Attachment, ChannelConfig } from '../../types'
import type { PromptContextItem } from '../../types/promptContext'
import type { EditorNode } from '../../types/editorNode'
import { getContexts, getPlainText, serializeNodes } from '../../types/editorNode'
import { parseMessageToNodes } from '../../types/contextParser'
import { useAttachments } from '../../composables/useAttachments'
import { MessageAttachments } from '../message'
import InputBox from '../input/InputBox.vue'
import FilePickerPanel from '../input/FilePickerPanel.vue'
import { sendToExtension, showNotification } from '../../utils/vscode'
import { languageFromPath } from '../../utils/languageFromPath'
import { resolveWorkspaceItems } from '../../utils/resolveWorkspaceItems'
import { t } from '../../i18n'
import { getFileType } from '../../utils/file'
import { generateId } from '../../utils/format'
import { isDeepSeekVisionModelName } from '../../utils/deepSeekVision'
import { useChatStore } from '../../stores/chatStore'
import * as configService from '../../services/config'
import Modal from './Modal.vue'

interface Props {
  modelValue?: boolean
  /** 消息前关联的检查点（before 阶段） */
  checkpoints?: CheckpointRecord[]
  /** 原始消息内容 */
  originalContent?: string
  /** 原始消息附件 */
  originalAttachments?: Attachment[]
  /** 原消息持久化的 DeepSeek Vision 处理模式；打开编辑时优先继承。 */
  originalDeepSeekVisionTileSplit?: boolean
  /** 是否为会话首条消息（根节点）：无父节点可挂编辑候选，保存仅原地改写、不会重新生成 */
  isRootMessage?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  checkpoints: () => [],
  originalContent: '',
  originalAttachments: () => [],
  originalDeepSeekVisionTileSplit: undefined,
  isRootMessage: false
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 普通编辑（mode：'branch' 新建分支（默认）；'keep' 原地改写原消息，保持当前分支） */
  edit: [newContent: string, attachments: Attachment[], mode?: 'branch' | 'keep', deepSeekVisionTileSplit?: boolean]
  /** 回档并编辑 */
  restoreAndEdit: [newContent: string, attachments: Attachment[], checkpointId: string, deepSeekVisionTileSplit?: boolean]
  cancel: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const chatStore = useChatStore()

/**
 * 当前编辑时的渠道配置（打开对话框时按 chatStore.configId 拉取，用于判断
 * DeepSeek Vision 复选框可见性——与 InputArea 的 currentConfig 同来源）。
 */
const visionConfig = ref<ChannelConfig | null>(null)

/** 编辑中的本地选择；打开时优先继承原消息，修改时同步为输入区后续默认偏好。 */
const visionSplitChecked = ref(true)
watch(visionSplitChecked, value => {
  if (visible.value) chatStore.setVisionSplitChecked?.(value)
})

/** 附件中是否包含图片。 */
const hasImageAttachments = computed(() =>
  allAttachments.value.some(att =>
    (att.mimeType || '').toLowerCase().startsWith('image/') || att.type === 'image'
  )
)

/** 复选框可见条件：有图片附件 + 渠道开启预处理 + 模型是 DeepSeek Vision（与 InputArea 同口径）。 */
const visionSplitToggleVisible = computed(() => {
  const model = chatStore.selectedModelId || visionConfig.value?.model || ''
  return hasImageAttachments.value
    && visionConfig.value?.deepSeekVisionEnabled === true
    && isDeepSeekVisionModelName(model)
})

let visionConfigLoadGeneration = 0

// 打开时初始化编辑状态；渠道配置响应仅允许写回同一次打开、同一个 configId。
watch(visible, (newValue) => {
  const generation = ++visionConfigLoadGeneration
  if (!newValue) {
    visionConfig.value = null
    return
  }

  visionSplitChecked.value = props.originalDeepSeekVisionTileSplit
    ?? chatStore.visionSplitChecked
    ?? true

  const parsed = parseMessageToNodes(props.originalContent)
  editorNodes.value = parsed.nodes

  showFilePicker.value = false
  filePickerQuery.value = ''

  clearAttachments() // 清除之前的新附件
  removedOriginalAttachmentIds.value = new Set() // 重置已删除的原有附件

  // 在异步请求发出前清空旧配置，避免快速切换渠道后短暂显示上一渠道的复选框。
  visionConfig.value = null
  const configId = chatStore.configId
  if (configId) {
    configService.getConfig(configId).then((config) => {
      if (generation !== visionConfigLoadGeneration || !visible.value || chatStore.configId !== configId) return
      visionConfig.value = config
    }).catch(() => {
      if (generation !== visionConfigLoadGeneration || !visible.value || chatStore.configId !== configId) return
      visionConfig.value = null
    })
  }

  nextTick(() => {
    inputBoxRef.value?.focus()
  })
})

// Editor nodes (text + inline context chips)
const editorNodes = ref<EditorNode[]>([])
const inputBoxRef = ref<InstanceType<typeof InputBox> | null>(null)

const fileInputRef = ref<HTMLInputElement | null>(null)

// @ 文件选择器状态
const showFilePicker = ref(false)
const filePickerQuery = ref('')
const filePickerRef = ref<InstanceType<typeof FilePickerPanel> | null>(null)

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

/** 是否有可用的检查点 */
const hasCheckpoints = computed(() => props.checkpoints.length > 0)

/** 最近的检查点（用于回档） */
const latestCheckpoint = computed(() => {
  if (props.checkpoints.length === 0) return null
  return [...props.checkpoints].sort((a, b) => b.timestamp - a.timestamp)[0]
})

/** 格式化检查点描述 */
function formatCheckpointDesc(checkpoint: CheckpointRecord): string {
  const toolName = checkpoint.toolName || 'tool'
  const isAfter = checkpoint.phase === 'after'
  if (toolName === 'user_message') {
    return isAfter
      ? t('components.common.editDialog.restoreToAfterUserMessage')
      : t('components.common.editDialog.restoreToUserMessage')
  } else if (toolName === 'model_message') {
    return isAfter
      ? t('components.common.editDialog.restoreToAfterAssistantMessage')
      : t('components.common.editDialog.restoreToAssistantMessage')
  } else if (toolName === 'tool_batch') {
    return isAfter
      ? t('components.common.editDialog.restoreToAfterToolBatch')
      : t('components.common.editDialog.restoreToToolBatch')
  }
  return isAfter
    ? t('components.common.editDialog.restoreToAfterTool').replace('{toolName}', toolName)
    : t('components.common.editDialog.restoreToTool').replace('{toolName}', toolName)
}

function handleCancel() {
  visible.value = false
  clearAttachments()
  editorNodes.value = []
  showFilePicker.value = false
  filePickerQuery.value = ''
  emit('cancel')
}

function handleNodesUpdate(nodes: EditorNode[]) {
  editorNodes.value = nodes
}

function handleRemoveContext(id: string) {
  editorNodes.value = editorNodes.value.filter(n => !(n.type === 'context' && n.context.id === id))
}

function handlePasteFiles(files: File[]) {
  // 粘贴文件按附件处理
  addAttachments(files)
}

// 处理 @ 触发
function handleTriggerAtPicker(query: string, _triggerPosition: number) {
  filePickerQuery.value = query
  showFilePicker.value = true
}

function handleAtQueryChange(query: string) {
  filePickerQuery.value = query
}

function handleCloseAtPicker() {
  showFilePicker.value = false
  filePickerQuery.value = ''
  inputBoxRef.value?.closeAtPicker()
}

function handleAtPickerKeydown(key: string) {
  if (!showFilePicker.value || !filePickerRef.value) return

  // 直接调用面板暴露的语义化 API（moveHighlight/confirmSelection），不再构造假 KeyboardEvent
  if (key === 'ArrowUp') {
    filePickerRef.value.moveHighlight(-1)
  } else if (key === 'ArrowDown') {
    filePickerRef.value.moveHighlight(1)
  } else if (key === 'Enter') {
    filePickerRef.value.confirmSelection()
  }
}

function normalizeDirectoryPath(path: string): string {
  const normalized = (path || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '')
  if (!normalized) return ''
  return `${normalized}/`
}

function hasContextWithPath(path: string): boolean {
  const key = (path || '').replace(/\/+$/g, '')
  if (!key) return false
  return getContexts(editorNodes.value).some(item => ((item.filePath || '').replace(/\/+$/g, '') === key))
}

function addDirectoryContextByPath(path: string) {
  const dirPath = normalizeDirectoryPath(path)
  if (!dirPath) return
  if (hasContextWithPath(dirPath)) return

  const contextItem: PromptContextItem = {
    id: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'file',
    title: dirPath,
    content: '',
    filePath: dirPath,
    isTextContent: false,
    enabled: true,
    addedAt: Date.now()
  }

  inputBoxRef.value?.insertContextAtCaret(contextItem)
}

const AUTO_UPLOAD_NON_TEXT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf'
])

function shouldAutoUploadBinaryAttachment(payload?: { name: string; size: number; mimeType: string; data: string }): boolean {
  if (!payload?.data) return false
  const mime = (payload.mimeType || '').toLowerCase()
  if (AUTO_UPLOAD_NON_TEXT_MIME_TYPES.has(mime)) return true
  if (mime.startsWith('audio/')) return true
  if (mime.startsWith('video/')) return true
  return false
}

async function addFileContextByPath(path: string, options?: { autoUploadBinaryAttachment?: boolean }) {
  // Skip directories
  if (path.endsWith('/')) return

  const exists = getContexts(editorNodes.value).some(item => item.filePath === path)
  if (exists) return

  const addWorkspaceAttachment = (relativePath: string, payload?: { name: string; size: number; mimeType: string; data: string }) => {
    if (!payload?.data) return

    const existsAttachment = allAttachments.value.some(att => att.metadata?.sourcePath === relativePath)
    if (existsAttachment) return

    const attachment: Attachment = {
      id: generateId(),
      name: payload.name || relativePath.split('/').pop() || relativePath,
      type: getFileType(payload.mimeType || 'application/octet-stream'),
      size: payload.size || 0,
      mimeType: payload.mimeType || 'application/octet-stream',
      data: payload.data,
      metadata: {
        sourcePath: relativePath
      }
    }

    newAttachments.value = [...newAttachments.value, attachment]
  }

  try {
    const result = await sendToExtension<{
      success: boolean
      path: string
      isText: boolean
      content?: string
      attachment?: { name: string; size: number; mimeType: string; data: string }
      error?: string
    }>(
      MESSAGE_NAMES.readWorkspaceFileForInput,
      { path }
    )

    if (!result?.success) {
      await showNotification(result?.error || t('components.input.promptContext.readFailed'), 'error')
      return
    }

    const isTextContent = result.isText !== false
    if (!isTextContent) {
      if (options?.autoUploadBinaryAttachment && shouldAutoUploadBinaryAttachment(result.attachment)) {
        addWorkspaceAttachment(result.path || path, result.attachment)
      }
    }

    const contextItem: PromptContextItem = {
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'file',
      title: result.path || path,
      content: isTextContent ? (result.content || '') : '',
      filePath: result.path || path,
      isTextContent,
      enabled: true,
      addedAt: Date.now()
    }

    inputBoxRef.value?.insertContextAtCaret(contextItem)
  } catch (error: any) {
    console.error('Failed to add file context:', error)
    await showNotification(t('components.input.promptContext.addFailed', { error: error.message || t('common.unknownError') }), 'error')
  }
}

// InputBox 拖拽文件路径（徽章模式）
async function handleAddFileContexts(files: { path: string; isDirectory: boolean }[], options?: { allowDirectoryBadge?: boolean }) {
  const inserted = new Set<string>()

  for (const file of files) {
    const key = file.isDirectory ? normalizeDirectoryPath(file.path) : file.path
    if (!key) continue
    if (inserted.has(key)) continue
    inserted.add(key)

    if (file.isDirectory) {
      if (options?.allowDirectoryBadge) {
        addDirectoryContextByPath(file.path)
      }
      continue
    }

    await addFileContextByPath(file.path, { autoUploadBinaryAttachment: true })
  }

  nextTick(() => {
    inputBoxRef.value?.focus()
  })
}

async function handleDropFileItems(items: string[], insertAsTextPath: boolean, dragMeta?: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
  const resolved = await resolveWorkspaceItems(items)
  if (resolved.length === 0) return

  if (insertAsTextPath) {
    inputBoxRef.value?.insertPathsAsAtText(resolved)
    nextTick(() => inputBoxRef.value?.focus())
    return
  }

  const allowDirectoryBadge = !!dragMeta?.shiftKey && !insertAsTextPath
  await handleAddFileContexts(resolved, { allowDirectoryBadge })
}

async function handleOpenContext(ctx: PromptContextItem) {
  if (ctx.isTextContent === false && ctx.filePath) {
    try {
      await sendToExtension(MESSAGE_NAMES.openWorkspaceFile, { path: ctx.filePath })
    } catch (error) {
      console.error('Failed to open workspace file:', error)
    }
    return
  }

  try {
    await sendToExtension(MESSAGE_NAMES.showContextContent, {
      title: ctx.title,
      content: ctx.content,
      language: ctx.language || languageFromPath(ctx.filePath) || 'plaintext'
    })
  } catch (error) {
    console.error('Failed to show context content:', error)
  }
}

// 从 @ 面板选择
async function handleSelectFileFromPicker(path: string, asText: boolean = false) {
  showFilePicker.value = false
  filePickerQuery.value = ''

  // Ctrl+Click or directory: insert as plain @path text
  if (asText || path.endsWith('/')) {
    inputBoxRef.value?.replaceAtTriggerWithText(` @${path} `)
    nextTick(() => inputBoxRef.value?.focus())
    return
  }

  // Remove @query from the editor, then insert the chip at the same caret position.
  inputBoxRef.value?.replaceAtTriggerWithText('')
  await addFileContextByPath(path)

  nextTick(() => inputBoxRef.value?.focus())
}

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

function getFinalContent(): string {
  return serializeNodes(editorNodes.value).trim()
}

const canSubmit = computed(() => {
  const hasText = getPlainText(editorNodes.value).trim().length > 0
  const hasContexts = getContexts(editorNodes.value).length > 0
  const hasAttachments = allAttachments.value.length > 0
  return hasText || hasContexts || hasAttachments
})

function handleEdit(mode: 'branch' | 'keep' = 'branch') {
  const finalContent = getFinalContent()
  if (finalContent || allAttachments.value.length > 0) {
    visible.value = false
    emit('edit', finalContent, serializeAttachments(allAttachments.value), mode, visionSplitToggleVisible.value ? visionSplitChecked.value : undefined)
    clearAttachments()
    editorNodes.value = []
  }
}

function handleRestoreAndEdit() {
  const finalContent = getFinalContent()
  if (latestCheckpoint.value && (finalContent || allAttachments.value.length > 0)) {
    visible.value = false
    emit('restoreAndEdit', finalContent, serializeAttachments(allAttachments.value), latestCheckpoint.value.id, visionSplitToggleVisible.value ? visionSplitChecked.value : undefined)
    clearAttachments()
    editorNodes.value = []
  }
}

function triggerFileInput() {
  fileInputRef.value?.click()
}

async function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return

  await addAttachments(Array.from(input.files))
  input.value = ''
}

function handleRemoveAttachment(id: string) {
  const isOriginal = props.originalAttachments.some(att => att.id === id)

  if (isOriginal) {
    removedOriginalAttachmentIds.value.add(id)
  } else {
    removeNewAttachment(id)
  }
}
</script>

<template>
  <Modal
    v-model="visible"
    :aria-label="t('components.common.editDialog.title')"
    width="500px"
    :closable="false"
    :mask-closable="false"
    initial-focus-selector=".input-editor"
    body-padding="compact"
    @close="handleCancel"
  >
    <template #header>
      <div class="dialog-heading">
        <i class="codicon codicon-edit dialog-icon" aria-hidden="true"></i>
        <h3>{{ t('components.common.editDialog.title') }}</h3>
      </div>
    </template>

    <div class="dialog-body">
      <div class="edit-input-wrapper">
        <FilePickerPanel
          ref="filePickerRef"
          :visible="showFilePicker"
          :query="filePickerQuery"
          @select="handleSelectFileFromPicker"
          @close="handleCloseAtPicker"
        />

        <InputBox
          ref="inputBoxRef"
          :nodes="editorNodes"
          :placeholder="t('components.common.editDialog.placeholder')"
          :submit-on-enter="false"
          :min-rows="4"
          :max-rows="14"
          @update:nodes="handleNodesUpdate"
          @remove-context="handleRemoveContext"
          @paste="handlePasteFiles"
          @drop-files="handlePasteFiles"
          @drop-file-items="handleDropFileItems"
          @open-context="handleOpenContext"
          @trigger-at-picker="handleTriggerAtPicker"
          @close-at-picker="handleCloseAtPicker"
          @at-query-change="handleAtQueryChange"
          @at-picker-keydown="handleAtPickerKeydown"
        />
      </div>

      <div class="attachment-section">
        <button
          type="button"
          class="attachment-btn gc-button"
          :title="t('components.common.editDialog.addAttachment')"
          @click="triggerFileInput"
        >
          <i class="codicon codicon-add" aria-hidden="true"></i>
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

        <div v-if="allAttachments.length > 0" class="attachment-list">
          <MessageAttachments
            :attachments="allAttachments"
            :readonly="false"
            @remove="handleRemoveAttachment"
          />
        </div>
      </div>

      <p v-if="hasCheckpoints" class="checkpoint-hint gc-feedback">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.common.editDialog.checkpointHint') }}</span>
      </p>

      <p v-if="isRootMessage" class="root-message-hint gc-feedback gc-feedback--warning">
        <i class="codicon codicon-info" aria-hidden="true"></i>
        <span>{{ t('components.common.editDialog.rootMessageHint') }}</span>
      </p>

      <label
        v-if="visionSplitToggleVisible"
        class="vision-split-toggle"
        :title="t('components.input.visionSplitPreventionHint')"
      >
        <input v-model="visionSplitChecked" type="checkbox" />
        <span>{{ t('components.input.visionSplitPrevention') }}</span>
      </label>
    </div>

    <template #footer>
      <button type="button" class="dialog-btn cancel gc-button" @click="handleCancel">
        <span class="btn-label">{{ t('components.common.editDialog.cancel') }}</span>
      </button>

      <button
        v-if="latestCheckpoint"
        type="button"
        class="dialog-btn restore gc-button"
        :disabled="!canSubmit"
        @click="handleRestoreAndEdit"
      >
        <i class="codicon codicon-discard" aria-hidden="true"></i>
        <span class="btn-label">{{ formatCheckpointDesc(latestCheckpoint) }}</span>
      </button>

      <button
        type="button"
        class="dialog-btn keep-branch gc-button"
        :disabled="!canSubmit"
        @click="handleEdit('keep')"
      >
        <i class="codicon codicon-source-control" aria-hidden="true"></i>
        <span class="btn-label">{{ t('components.common.editDialog.saveInPlace') }}</span>
      </button>

      <button
        type="button"
        class="dialog-btn confirm gc-button gc-button--primary"
        :disabled="!canSubmit"
        :title="isRootMessage ? t('components.common.editDialog.rootSaveHint') : undefined"
        @click="handleEdit('branch')"
      >
        <span class="btn-label">{{ t('components.common.editDialog.save') }}</span>
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.dialog-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--gc-space-2);
}

.dialog-heading h3 {
  margin: 0;
  font-size: var(--gc-font-size-title);
  font-weight: var(--gc-font-weight-medium);
}

.dialog-icon {
  flex-shrink: 0;
  color: var(--gc-link);
  font-size: var(--gc-icon-size-lg);
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--gc-space-3);
}

.edit-input-wrapper {
  position: relative;
}

.edit-input-wrapper :deep(.input-editor) {
  min-height: 96px !important;
  max-height: 280px !important;
  border-radius: var(--gc-radius-sm);
}

.attachment-section {
  margin-top: var(--gc-space-1);
}

.attachment-btn {
  color: var(--gc-text-muted);
}

.attachment-list {
  margin-top: var(--gc-space-2);
}

.checkpoint-hint,
.root-message-hint {
  margin: 0;
}

.checkpoint-hint .codicon {
  color: var(--gc-info);
}

.root-message-hint .codicon {
  color: var(--gc-warning);
}

.vision-split-toggle {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--gc-space-1);
  padding: 2px var(--gc-space-2);
  color: var(--gc-text-muted);
  background: var(--gc-surface-muted);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  font-size: var(--gc-font-size-caption);
  cursor: pointer;
  user-select: none;
}

.vision-split-toggle:hover {
  border-color: var(--gc-focus-border);
}

.vision-split-toggle input {
  margin: 0;
}

.dialog-btn {
  min-width: 0;
  flex: 0 1 auto;
}

.dialog-btn .btn-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-btn.restore {
  max-width: 220px;
  color: var(--gc-warning);
  background: color-mix(in srgb, var(--gc-warning) 12%, transparent);
}

.dialog-btn.keep-branch {
  color: var(--gc-info);
}

@media (max-width: 420px) {
  .dialog-btn.restore .btn-label,
  .dialog-btn.keep-branch .btn-label {
    display: none;
  }
}
</style>
