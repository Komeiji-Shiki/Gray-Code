<script setup lang="ts">
/**
 * MessageQueue - 消息候选区
 * 显示排队等待发送的消息列表，渲染在输入框上方
 * 每条消息支持"立即发送"、"编辑"、"删除"和"拖拽排序"操作
 */

import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { MESSAGE_NAMES, PUSH_MESSAGE_NAMES } from '@shared/protocol'
import type { PendingUserInput } from '../../../../packages/contracts/src/runtime'
import { useChatStore } from '../../stores'
import { EditDialog } from '../common'
import { useI18n } from '../../i18n'
import type { Attachment, Content } from '../../types'
import { contentToMessageEnhanced } from '../../stores/chat/parsers'
import { onExtensionCommand, sendToExtension, showNotification } from '../../utils/vscode'

const { t } = useI18n()
const chatStore = useChatStore()

const pendingInputs = shallowRef<PendingUserInput[]>([])
const busyInputs = ref(new Set<string>())
let refreshRevision = 0

// 服务端待处理输入与本地显式队列共用候选区；前者的修改必须等服务端确认。
const queueItems = computed(() => [
  ...pendingInputs.value.map(input => {
    const message = contentToMessageEnhanced(input.message as unknown as Content, input.id)
    return { id: input.id, content: message.content, attachments: message.attachments ?? [],
      pendingInput: input as PendingUserInput | undefined, queueIndex: undefined as number | undefined,
      deepSeekVisionTileSplit: input.message.deepSeekVisionTileSplit as boolean | undefined }
  }),
  ...chatStore.messageQueue.map((item, index) => ({ ...item, pendingInput: undefined as PendingUserInput | undefined,
    queueIndex: index as number | undefined, deepSeekVisionTileSplit: item.sendOptions?.deepSeekVisionTileSplit }))
])

async function refreshPendingInputs() {
  const conversationId = chatStore.currentConversationId
  const revision = ++refreshRevision
  if (!window.__GRAYCODE_HOST || !conversationId) { pendingInputs.value = []; return }
  try {
    const result = await sendToExtension<PendingUserInput[]>(MESSAGE_NAMES['chat.pendingUserInputs'], { conversationId })
    if (revision === refreshRevision && conversationId === chatStore.currentConversationId) pendingInputs.value = result
  } catch (error) {
    console.warn('[MessageQueue] Failed to load pending user inputs:', error)
  }
}

watch(() => chatStore.currentConversationId, () => {
  pendingInputs.value = []
  showEditDialog.value = false
  void refreshPendingInputs()
})
const unsubscribe = onExtensionCommand<{ conversationId: string }>(PUSH_MESSAGE_NAMES['chat.pendingUserInputsChanged'], value => {
  if (value.conversationId === chatStore.currentConversationId) void refreshPendingInputs()
})
onBeforeUnmount(() => { refreshRevision++; unsubscribe() })
void refreshPendingInputs()

// ========== 拖拽排序 ==========

/** 当前正在拖拽的项索引 */
const dragFromIndex = ref<number | null>(null)
/** 当前拖拽悬停的目标索引 */
const dragOverIndex = ref<number | null>(null)

function handleDragStart(index: number | undefined, e: DragEvent) {
  if (index === undefined) return
  dragFromIndex.value = index
  dragOverIndex.value = null

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // 需要设置 data 否则 Firefox 不触发 drag
    e.dataTransfer.setData('text/plain', String(index))
  }
}

function handleDragOver(index: number | undefined, e: DragEvent) {
  if (index === undefined) return
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
  if (dragFromIndex.value !== null && dragFromIndex.value !== index) {
    dragOverIndex.value = index
  }
}

function handleDragLeave(_index: number | undefined, _e: DragEvent) {
  // 不立即清除 dragOverIndex，避免子元素进出时闪烁
}

function handleDrop(index: number | undefined, e: DragEvent) {
  if (index === undefined) return
  e.preventDefault()
  if (dragFromIndex.value !== null && dragFromIndex.value !== index) {
    chatStore.moveQueuedMessage(dragFromIndex.value, index)
  }
  dragFromIndex.value = null
  dragOverIndex.value = null
}

function handleDragEnd() {
  dragFromIndex.value = null
  dragOverIndex.value = null
}

// ========== 编辑 ==========

/** 编辑弹窗显隐 */
const showEditDialog = ref(false)
/** 当前正在编辑的消息 ID */
const editingId = ref<string | null>(null)
/** 当前正在编辑的消息原始内容 */
const editingContent = ref('')
/** 当前正在编辑的消息原始附件 */
const editingAttachments = ref<Attachment[]>([])
const editingPendingInput = shallowRef<PendingUserInput | null>(null)
const editingDeepSeekVisionTileSplit = ref<boolean | undefined>()

/** 打开编辑弹窗 */
function handleStartEdit(id: string) {
  const item = queueItems.value.find(m => m.id === id)
  if (!item) return

  editingId.value = id
  editingContent.value = item.content
  editingAttachments.value = item.attachments
  editingPendingInput.value = item.pendingInput ?? null
  editingDeepSeekVisionTileSplit.value = item.deepSeekVisionTileSplit
  showEditDialog.value = true
}

/** 编辑完成（EditDialog 事件携带 mode 参数；排队消息无分支模式，忽略之） */
async function handleEditDone(newContent: string, attachments: Attachment[], _mode?: 'branch' | 'keep', deepSeekVisionTileSplit?: boolean) {
  const pending = editingPendingInput.value
  if (pending) {
    busyInputs.value.add(pending.id)
    try {
      await sendToExtension(MESSAGE_NAMES['chat.updatePendingUserInput'], { conversationId: pending.conversationId,
        id: pending.id, revision: pending.revision, text: newContent, attachments,
        deepSeekVisionTileSplit: deepSeekVisionTileSplit ?? editingDeepSeekVisionTileSplit.value })
    } catch (error) {
      await showNotification(error instanceof Error ? error.message : t('common.error'), 'error')
      // 保存失败保留编辑稿，重新打开后仍可复制或修改，不能把失败显示为已保存。
      if (pending.conversationId === chatStore.currentConversationId && editingPendingInput.value === pending && !showEditDialog.value) {
        editingContent.value = newContent
        editingAttachments.value = attachments
        showEditDialog.value = true
      }
      return
    } finally {
      busyInputs.value.delete(pending.id)
      void refreshPendingInputs()
    }
    // 请求期间可能已经打开另一条消息，旧回执不能清空新弹窗的编辑内容。
    if (editingPendingInput.value !== pending || showEditDialog.value) return
  } else {
    if (editingId.value) {
      chatStore.updateQueuedMessage(editingId.value, newContent, attachments, deepSeekVisionTileSplit)
    }
  }
  editingId.value = null
  editingContent.value = ''
  editingAttachments.value = []
  editingPendingInput.value = null
}

// ========== 操作 ==========

/** 立即发送指定消息 */
async function handleSendNow(id: string) {
  try {
    await chatStore.sendQueuedMessageNow(id)
  } catch (error) {
    console.error('[MessageQueue] Failed to send queued message:', error)
  }
}

/** 移除指定消息 */
async function handleRemove(id: string) {
  const pending = queueItems.value.find(item => item.id === id)?.pendingInput
  if (pending) {
    busyInputs.value.add(id)
    try {
      await sendToExtension(MESSAGE_NAMES['chat.withdrawPendingUserInput'], { conversationId: pending.conversationId, id, revision: pending.revision })
    } catch (error) {
      await showNotification(error instanceof Error ? error.message : t('common.error'), 'error')
    } finally {
      busyInputs.value.delete(id)
      void refreshPendingInputs()
    }
    return
  }
  chatStore.removeQueuedMessage(id)
}

/** 截断显示文本 */
function truncate(text: string, maxLen = 80): string {
  const singleLine = text.replace(/\n/g, ' ')
  if (singleLine.length <= maxLen) return singleLine
  return singleLine.slice(0, maxLen) + '\u2026'
}
</script>

<template>
  <div v-if="queueItems.length > 0 || showEditDialog" class="message-queue">
    <div class="queue-header">
      <i class="codicon codicon-list-ordered queue-icon"></i>
      <span class="queue-title">{{ t('components.input.queue.title') }}</span>
      <span class="queue-count">({{ queueItems.length }})</span>
    </div>
    <div class="queue-list">
      <div
        v-for="(item, index) in queueItems"
        :key="item.id"
        class="queue-item"
        :class="{
          'queue-item--dragging': dragFromIndex === item.queueIndex,
          'queue-item--drag-over': dragOverIndex === item.queueIndex && dragFromIndex !== item.queueIndex
        }"
        :draggable="false"
        @dragover="handleDragOver(item.queueIndex, $event)"
        @dragleave="handleDragLeave(item.queueIndex, $event)"
        @drop="handleDrop(item.queueIndex, $event)"
      >
        <!-- 左侧拖拽手柄 -->
        <span
          v-if="item.queueIndex !== undefined"
          class="queue-drag-handle"
          draggable="true"
          :title="t('components.input.queue.drag')"
          @dragstart="handleDragStart(item.queueIndex, $event)"
          @dragend="handleDragEnd"
        >
          <i class="codicon codicon-gripper"></i>
        </span>
        <span v-else class="queue-drag-handle" :title="t('components.input.queue.waitingForModel')">
          <i class="codicon codicon-clock"></i>
        </span>

        <span class="queue-item-index">{{ index + 1 }}</span>
        <span class="queue-item-content" :title="item.content">
          {{ truncate(item.content) }}
          <span v-if="item.attachments.length > 0" class="queue-item-attachments">
            <i class="codicon codicon-attach"></i>{{ item.attachments.length }}
          </span>
        </span>
        <div class="queue-item-actions">
          <button
            class="queue-action-btn edit-btn"
            :title="t('components.input.queue.edit')"
            :disabled="busyInputs.has(item.id)"
            @click="handleStartEdit(item.id)"
          >
            <i class="codicon codicon-edit"></i>
          </button>
          <button
            v-if="!item.pendingInput"
            class="queue-action-btn send-now-btn"
            :title="t('components.input.queue.sendNow')"
            @click="handleSendNow(item.id)"
          >
            <i class="codicon codicon-play"></i>
          </button>
          <button
            class="queue-action-btn remove-btn"
            :title="t(item.pendingInput ? 'components.input.queue.withdraw' : 'components.input.queue.remove')"
            :disabled="busyInputs.has(item.id)"
            @click="handleRemove(item.id)"
          >
            <i class="codicon codicon-close"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（复用现有 EditDialog） -->
    <EditDialog
      v-model="showEditDialog"
      :original-content="editingContent"
      :original-attachments="editingAttachments"
      :original-deep-seek-vision-tile-split="editingDeepSeekVisionTileSplit"
      @edit="handleEditDone"
    />
  </div>
</template>

<style scoped>
.message-queue {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--gc-quote-bg);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-sm);
  margin-bottom: 6px;
  max-height: 150px;
  overflow-y: auto;
}

.queue-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--gc-border-subtle);
  margin-bottom: 2px;
}

.queue-icon {
  font-size: 12px;
  color: var(--gc-text-muted);
}

.queue-title {
  font-size: 11px;
  color: var(--gc-text-muted);
  font-weight: 500;
}

.queue-count {
  font-size: 10px;
  color: var(--gc-text-muted);
  opacity: 0.7;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: var(--gc-radius-xs);
  transition: background-color 0.1s, box-shadow 0.15s;
  border: 1px solid transparent;
}

.queue-item:hover {
  background: var(--gc-surface-hover);
}

/* 正在被拖拽的项：半透明 */
.queue-item--dragging {
  opacity: 0.35;
}

/* 拖拽悬停目标：顶部指示线 */
.queue-item--drag-over {
  border-top: 2px solid var(--gc-focus-border);
  padding-top: 2px;
}

/* ========== 拖拽手柄 ========== */
.queue-drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
  cursor: grab;
  color: var(--gc-text-muted);
  opacity: 0;
  transition: opacity 0.1s;
  border-radius: var(--gc-radius-xs);
}

.queue-drag-handle:active {
  cursor: grabbing;
}

.queue-item:hover .queue-drag-handle {
  opacity: 0.6;
}

.queue-drag-handle:hover {
  opacity: 1 !important;
  background: var(--gc-surface-hover);
}

.queue-drag-handle .codicon {
  font-size: 14px;
}

.queue-item-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  font-size: 10px;
  font-weight: 600;
  color: var(--gc-badge-fg);
  background: var(--gc-badge-bg);
  border-radius: var(--gc-radius-md);
  flex-shrink: 0;
}

.queue-item-content {
  flex: 1;
  font-size: 12px;
  color: var(--gc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.queue-item-attachments {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  font-size: 10px;
  color: var(--gc-text-muted);
  opacity: 0.8;
}

.queue-item-attachments .codicon {
  font-size: 10px;
}

.queue-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s;
}

.queue-item:hover .queue-item-actions,
.queue-item:focus-within .queue-item-actions {
  opacity: 1;
}

.queue-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--gc-radius-xs);
  color: var(--gc-text-primary);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.1s, background-color 0.1s;
}

.queue-action-btn:hover {
  opacity: 1;
  background: var(--gc-surface-hover);
}

.queue-action-btn:disabled {
  opacity: 0.4;
  cursor: wait;
}

.queue-action-btn .codicon {
  font-size: 12px;
}

.edit-btn:hover {
  color: var(--gc-chart-blue);
}

.send-now-btn:hover {
  color: var(--gc-chart-green);
}

.remove-btn:hover {
  color: var(--gc-chart-red);
}
</style>
