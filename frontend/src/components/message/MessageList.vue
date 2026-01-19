<script setup lang="ts">
/**
 * MessageList - 消息列表容器
 * 扁平化设计，简洁加载动画
 */

import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { CustomScrollbar, DeleteDialog, Tooltip, ConfirmDialog } from '../common'
import MessageItem from './MessageItem.vue'
import SummaryMessage from './SummaryMessage.vue'
import { useChatStore } from '../../stores'
import { formatTime } from '../../utils/format'
import { useI18n } from '../../i18n'
import type { Message, CheckpointRecord, Attachment } from '../../types'

const { t } = useI18n()

const props = defineProps<{
  messages: Message[]
}>()

// 消息分页显示逻辑：解决消息过多导致的输入卡顿
const VISIBLE_INCREMENT = 40
const visibleCount = ref(VISIBLE_INCREMENT)

// 是否还有更多历史消息
const hasMore = computed(() => props.messages.length > visibleCount.value)

// 增强的消息对象接口
interface EnhancedMessage {
  message: Message
  actualIndex: number
  beforeCheckpoints: CheckpointRecord[]
  afterCheckpoints: CheckpointRecord[]
}

// 预计算可见消息的增强信息，避免在模板中进行昂贵的计算
const enhancedVisibleMessages = computed<EnhancedMessage[]>(() => {
  const count = visibleCount.value
  const total = props.messages.length
  const startIndex = Math.max(0, total - count)
  
  // 仅对可见的消息进行切片
  const visibleSlice = props.messages.slice(startIndex)
  
  // 预先建立 ID 到 allMessages 索引的映射，提高 getActualIndex 效率
  const idToActualIndex = new Map<string, number>()
  chatStore.allMessages.forEach((m, idx) => {
    idToActualIndex.set(m.id, idx)
  })

  // 预先按消息索引对检查点进行分组
  const checkpointsByMsgIndex = new Map<number, { before: CheckpointRecord[], after: CheckpointRecord[] }>()
  chatStore.checkpoints.forEach(cp => {
    if (!checkpointsByMsgIndex.has(cp.messageIndex)) {
      checkpointsByMsgIndex.set(cp.messageIndex, { before: [], after: [] })
    }
    const group = checkpointsByMsgIndex.get(cp.messageIndex)!
    if (cp.phase === 'before') group.before.push(cp)
    else group.after.push(cp)
  })

  return visibleSlice.map(message => {
    const actualIndex = idToActualIndex.get(message.id) ?? -1
    const cpGroup = actualIndex !== -1 ? checkpointsByMsgIndex.get(actualIndex) : null
    
    return {
      message,
      actualIndex,
      beforeCheckpoints: cpGroup?.before || [],
      afterCheckpoints: cpGroup?.after || []
    }
  })
})

// 是否正在加载更多（用于节流）
const isLoadingMore = ref(false)

// 加载更多历史消息
function loadMore() {
  if (isLoadingMore.value || !hasMore.value) return
  if (!scrollbarRef.value) return
  const container = scrollbarRef.value.getContainer()
  if (!container) return

  isLoadingMore.value = true
  const oldScrollHeight = container.scrollHeight
  const oldScrollTop = container.scrollTop

  visibleCount.value += VISIBLE_INCREMENT

  // 保持滚动位置：加载更多后，滚动条位置会因为顶部插入内容而跳动，这里手动修正
  nextTick(() => {
    const newScrollHeight = container.scrollHeight
    container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)
    // 恢复加载状态
    isLoadingMore.value = false
  })
}

// 滚动事件处理：实现自动加载
function handleScroll(e: Event) {
  const container = e.target as HTMLElement
  if (!container) return
  
  // 当滚动到距离顶部 100px 以内时自动加载
  if (hasMore.value && !isLoadingMore.value && container.scrollTop < 100) {
    loadMore()
  }
}

// 从 store 读取等待状态
const chatStore = useChatStore()

// CustomScrollbar 引用
const scrollbarRef = ref<InstanceType<typeof CustomScrollbar> | null>(null)

// 标记是否需要滚动到底部（切换对话时设置）
const needsScrollToBottom = ref(false)

// ResizeObserver 引用
let resizeObserver: ResizeObserver | null = null

// 监听对话切换，标记需要滚动，并重置可见数量
watch(() => chatStore.currentConversationId, (newId, oldId) => {
  if (newId !== oldId) {
    needsScrollToBottom.value = true
    visibleCount.value = VISIBLE_INCREMENT // 切换对话时重置
  }
})

// 监听消息变化，当消息加载完成时尝试滚动
watch(() => props.messages, (newMessages) => {
  // 当消息加载完成时，尝试滚动
  // 如果容器还没有尺寸（display: none），ResizeObserver 会在可见时触发
  if (needsScrollToBottom.value && newMessages.length > 0) {
    tryScrollToBottom()
  }
}, { deep: false })

// 尝试滚动到底部（会检查容器是否准备好）
function tryScrollToBottom() {
  if (!scrollbarRef.value) return
  
  const container = scrollbarRef.value.getContainer()
  if (!container) return
  
  // 检查容器是否有尺寸（可见状态）
  if (container.scrollHeight > 0 && container.clientHeight > 0) {
    if (needsScrollToBottom.value) {
      needsScrollToBottom.value = false
      scrollbarRef.value.scrollToBottom()
    }
  }
  // 如果容器还没有尺寸，ResizeObserver 会在可见时触发
}

// 设置 ResizeObserver 监听容器尺寸变化
onMounted(() => {
  // 使用 nextTick 确保 scrollbarRef 已经绑定
  nextTick(() => {
    if (!scrollbarRef.value) return
    
    const container = scrollbarRef.value.getContainer()
    if (!container) return
    
    // 添加滚动事件监听以支持自动加载
    container.addEventListener('scroll', handleScroll, { passive: true })
    
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height } = entry.contentRect
        
        // 当容器从 0 高度变为有高度时，尝试滚动
        if (height > 0 && needsScrollToBottom.value) {
          // 使用 requestAnimationFrame 确保布局完成
          requestAnimationFrame(() => {
            tryScrollToBottom()
          })
        }
      }
    })
    
    resizeObserver.observe(container)
  })
})

// 清理监听器
onBeforeUnmount(() => {
  if (scrollbarRef.value) {
    const container = scrollbarRef.value.getContainer()
    if (container) {
      container.removeEventListener('scroll', handleScroll)
    }
  }

  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

const emit = defineEmits<{
  edit: [messageId: string, newContent: string, attachments: Attachment[]]
  delete: [messageId: string]
  retry: [messageId: string]
  copy: [content: string]
  restoreCheckpoint: [checkpointId: string]
  restoreAndRetry: [messageId: string, checkpointId: string]
  restoreAndEdit: [messageId: string, newContent: string, attachments: Attachment[], checkpointId: string]
}>()

// 删除确认对话框状态
const showDeleteConfirm = ref(false)
const pendingDeleteMessageId = ref<string | null>(null)

// 恢复检查点确认对话框状态
const showRestoreConfirm = ref(false)
const pendingCheckpoint = ref<CheckpointRecord | null>(null)


// 计算要删除的消息数量（使用 allMessages）
const deleteCount = computed(() => {
  if (!pendingDeleteMessageId.value) return 0
  const index = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
  if (index === -1) return 0
  return chatStore.allMessages.length - index
})


// 处理编辑
function handleEdit(messageId: string, newContent: string, attachments: Attachment[]) {
  emit('edit', messageId, newContent, attachments)
}

// 处理删除 - 显示确认对话框
function handleDelete(messageId: string) {
  pendingDeleteMessageId.value = messageId
  showDeleteConfirm.value = true
}

// 确认删除 - 使用 allMessages 中的真实索引
function confirmDelete() {
  if (pendingDeleteMessageId.value) {
    const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
    if (actualIndex !== -1) {
      chatStore.deleteMessage(actualIndex)
    }
    pendingDeleteMessageId.value = null
  }
}

// 取消删除
function cancelDelete() {
  pendingDeleteMessageId.value = null
}

// 获取用于删除消息的最新检查点
// 返回该消息及之前所有消息的 before 阶段检查点
// 与重试使用相同的策略
const deleteCheckpoints = computed<CheckpointRecord[]>(() => {
  if (!pendingDeleteMessageId.value) return []
  
  const messageIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
  if (messageIndex === -1) return []
  
  // 返回所有 messageIndex <= 当前消息 且 phase === 'before' 的检查点
  return chatStore.checkpoints
    .filter(cp => cp.messageIndex <= messageIndex && cp.phase === 'before')
})

// 处理回档并删除
async function handleRestoreAndDelete(checkpointId: string) {
  if (!pendingDeleteMessageId.value) return
  
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === pendingDeleteMessageId.value)
  if (actualIndex === -1) return
  
  // 调用 restoreAndDelete 方法
  await chatStore.restoreAndDelete(actualIndex, checkpointId)
  pendingDeleteMessageId.value = null
}

// 处理重试 - 直接调用 store 方法（确认已在 MessageItem 的 RetryDialog 中完成）
function handleRetry(messageId: string) {
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex !== -1) {
    chatStore.retryFromMessage(actualIndex)
  }
}

// 处理复制
function handleCopy(content: string) {
  emit('copy', content)
}

// 处理错误后重试
function handleErrorRetry() {
  chatStore.retryAfterError()
}

// 处理继续对话（工具执行后中断时）
function handleContinue() {
  chatStore.retryAfterError()
}

// 处理恢复检查点
function handleRestoreCheckpoint(checkpointId: string) {
  const checkpoint = chatStore.checkpoints.find(cp => cp.id === checkpointId)
  if (checkpoint) {
    restoreCheckpoint(checkpoint)
  }
}

// 处理回档并重试
async function handleRestoreAndRetry(messageId: string, checkpointId: string) {
  // 找到消息在 allMessages 中的索引
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex === -1) return
  
  // 调用 restoreAndRetry 方法
  await chatStore.restoreAndRetry(actualIndex, checkpointId)
}

// 处理回档并编辑
async function handleRestoreAndEdit(messageId: string, newContent: string, attachments: Attachment[], checkpointId: string) {
  // 找到消息在 allMessages 中的索引
  const actualIndex = chatStore.allMessages.findIndex(m => m.id === messageId)
  if (actualIndex === -1) return
  
  // 调用 restoreAndEdit 方法
  await chatStore.restoreAndEdit(actualIndex, newContent, attachments, checkpointId)
}

// 检查特定工具的检查点是否需要合并显示（前后内容一致时合并）
function shouldMergeForTool(messageIndex: number, toolName: string): boolean {
  // 如果设置为不合并，直接返回 false（从 chatStore 读取配置）
  if (!chatStore.mergeUnchangedCheckpoints) {
    return false
  }
  
  // 查找该工具名称的 before 和 after 检查点
  const beforeCp = chatStore.checkpoints.find(cp =>
    cp.messageIndex === messageIndex && cp.phase === 'before' && cp.toolName === toolName
  )
  const afterCp = chatStore.checkpoints.find(cp =>
    cp.messageIndex === messageIndex && cp.phase === 'after' && cp.toolName === toolName
  )
  
  // 必须同时存在 before 和 after 才能合并
  if (!beforeCp || !afterCp) return false
  
  return Boolean(beforeCp.contentHash && afterCp.contentHash && beforeCp.contentHash === afterCp.contentHash)
}

// 恢复检查点 - 显示确认对话框
async function restoreCheckpoint(checkpoint: CheckpointRecord) {
  pendingCheckpoint.value = checkpoint
  showRestoreConfirm.value = true
}

// 确认恢复检查点
async function confirmRestore() {
  if (pendingCheckpoint.value) {
    await chatStore.restoreCheckpoint(pendingCheckpoint.value.id)
    pendingCheckpoint.value = null
  }
}

// 获取检查点标签
function getCheckpointLabel(cp: CheckpointRecord, phase: 'before' | 'after'): string {
  if (cp.toolName === 'user_message') {
    return phase === 'before' ? t('components.message.checkpoint.userMessageBefore') : t('components.message.checkpoint.userMessageAfter')
  }
  if (cp.toolName === 'model_message') {
    return phase === 'before' ? t('components.message.checkpoint.assistantMessageBefore') : t('components.message.checkpoint.assistantMessageAfter')
  }
  if (cp.toolName === 'tool_batch') {
    return phase === 'before' ? t('components.message.checkpoint.toolBatchBefore') : t('components.message.checkpoint.toolBatchAfter')
  }
  return phase === 'before' ? t('components.message.checkpoint.toolBatchBefore') : t('components.message.checkpoint.toolBatchAfter')
}

// 获取合并后的标签文案
function getMergedLabel(cp: CheckpointRecord): string {
  if (cp.toolName === 'user_message') {
    return t('components.message.checkpoint.userMessageUnchanged')
  }
  if (cp.toolName === 'model_message') {
    return t('components.message.checkpoint.assistantMessageUnchanged')
  }
  if (cp.toolName === 'tool_batch') {
    return t('components.message.checkpoint.toolBatchUnchanged')
  }
  return t('components.message.checkpoint.toolExecutionUnchanged')
}

// 格式化检查点时间（精确到秒，支持友好显示）
function formatCheckpointTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  
  // 判断是否是今天
  const isToday = date.toDateString() === now.toDateString()
  
  // 时间部分 HH:mm:ss
  const timeStr = formatTime(timestamp, 'HH:mm:ss')
  
  if (isToday) {
    // 今天：只显示时间
    return timeStr
  }
  
  // 计算天数差
  const daysDiff = Math.floor(diff / (1000 * 60 * 60 * 24))
  
  if (daysDiff === 1) {
    // 昨天
    return `${t('components.message.checkpoint.yesterday')} ${timeStr}`
  }
  
  if (daysDiff < 7) {
    // 一周内
    return `${t('components.message.checkpoint.daysAgo', { days: daysDiff })} ${timeStr}`
  }
  
  // 超过一周：显示完整日期
  return formatTime(timestamp, 'YYYY-MM-DD HH:mm:ss')
}
</script>

<template>
  <div class="message-list">
    <CustomScrollbar ref="scrollbarRef" sticky-bottom show-jump-buttons>
      <div class="messages-container">
        <!-- 自动加载更多指示器 -->
        <div v-if="hasMore" class="load-more-container">
          <i class="codicon codicon-loading codicon-modifier-spin"></i>
        </div>

        <template v-for="item in enhancedVisibleMessages" :key="item.message.id">
          <!-- 消息前的检查点（或合并显示） -->
          <template v-if="item.beforeCheckpoints.length > 0">
            <div
              v-for="cp in item.beforeCheckpoints"
              :key="cp.id"
              class="checkpoint-bar"
              :class="shouldMergeForTool(item.actualIndex, cp.toolName) ? 'checkpoint-merged' : 'checkpoint-before'"
            >
              <div class="checkpoint-icon">
                <i class="codicon" :class="shouldMergeForTool(item.actualIndex, cp.toolName) ? 'codicon-check' : 'codicon-archive'"></i>
              </div>
              <div class="checkpoint-info">
                <span class="checkpoint-label">
                  {{ shouldMergeForTool(item.actualIndex, cp.toolName) ? getMergedLabel(cp) : getCheckpointLabel(cp, 'before') }}
                </span>
                <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
              </div>
              <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
              <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                <button class="checkpoint-action" @click="restoreCheckpoint(cp)">
                  <i class="codicon codicon-discard"></i>
                </button>
              </Tooltip>
            </div>
          </template>
          
          <!-- 总结消息使用专用组件 -->
          <SummaryMessage
            v-if="item.message.isSummary"
            :message="item.message"
            :message-index="item.actualIndex"
          />
          
          <!-- 普通消息使用 MessageItem -->
          <MessageItem
            v-else
            :message="item.message"
            :message-index="item.actualIndex"
            @edit="handleEdit"
            @delete="handleDelete"
            @retry="handleRetry"
            @copy="handleCopy"
            @restore-checkpoint="handleRestoreCheckpoint"
            @restore-and-retry="handleRestoreAndRetry"
            @restore-and-edit="handleRestoreAndEdit"
          />
          
          <!-- 消息后的检查点（仅当该工具的内容有变化时显示） -->
          <template v-if="item.afterCheckpoints.length > 0">
            <template v-for="cp in item.afterCheckpoints" :key="cp.id">
              <!-- 只有当该工具没有被合并时才显示 after 检查点 -->
              <div
                v-if="!shouldMergeForTool(item.actualIndex, cp.toolName)"
                class="checkpoint-bar checkpoint-after"
              >
                <div class="checkpoint-icon">
                  <i class="codicon codicon-archive"></i>
                </div>
                <div class="checkpoint-info">
                  <span class="checkpoint-label">{{ getCheckpointLabel(cp, 'after') }}</span>
                  <span class="checkpoint-meta">{{ t('components.message.checkpoint.fileCount', { count: cp.fileCount }) }}</span>
                </div>
                <span class="checkpoint-time">{{ formatCheckpointTime(cp.timestamp) }}</span>
                <Tooltip :text="t('components.message.checkpoint.restoreTooltip')">
                  <button class="checkpoint-action" @click="restoreCheckpoint(cp)">
                    <i class="codicon codicon-discard"></i>
                  </button>
                </Tooltip>
              </div>
            </template>
          </template>
        </template>
        
        <!-- 继续对话提示 - 当最后一条是工具响应时显示 -->
        <div v-if="chatStore.needsContinueButton" class="continue-message">
          <div class="continue-icon">
            <i class="codicon codicon-debug-pause"></i>
          </div>
          <div class="continue-content">
            <div class="continue-title">{{ t('components.message.continue.title') }}</div>
            <div class="continue-text">{{ t('components.message.continue.description') }}</div>
          </div>
          <div class="continue-actions">
            <button class="continue-btn" @click="handleContinue">
              <span class="codicon codicon-play"></span>
              <span class="btn-text">{{ t('components.message.continue.button') }}</span>
            </button>
          </div>
        </div>
        
        <!-- 错误提示 - 显示在消息末尾 -->
        <div v-if="chatStore.error" class="error-message">
          <div class="error-header">
            <div class="error-icon">⚠</div>
            <div class="error-title">{{ t('components.message.error.title') }}</div>
            <div class="error-actions">
              <button class="error-retry" @click="handleErrorRetry" :title="t('components.message.error.retry')">
                <span class="codicon codicon-refresh"></span>
              </button>
              <button class="error-dismiss" @click="chatStore.error = null" :title="t('components.message.error.dismiss')">
                ✕
              </button>
            </div>
          </div>
          <div class="error-body">
            <CustomScrollbar :max-height="120" :width="4">
              <pre class="error-text-code">{{ chatStore.error.code }}: {{ chatStore.error.message }}</pre>
            </CustomScrollbar>
          </div>
        </div>
      </div>
    </CustomScrollbar>
    
    <!-- 删除确认对话框 -->
    <DeleteDialog
      v-model="showDeleteConfirm"
      :checkpoints="deleteCheckpoints"
      :delete-count="deleteCount"
      @delete="confirmDelete"
      @restore-and-delete="handleRestoreAndDelete"
      @cancel="cancelDelete"
    />
    
    <!-- 恢复检查点确认对话框 -->
    <ConfirmDialog
      v-model="showRestoreConfirm"
      :title="t('components.message.checkpoint.restoreConfirmTitle')"
      :message="t('components.message.checkpoint.restoreConfirmMessage')"
      :confirm-text="t('components.message.checkpoint.restoreConfirmBtn')"
      is-danger
      @confirm="confirmRestore"
    />
    
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  height: 100%;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.messages-container {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* 加载更多指示器 */
.load-more-container {
  display: flex;
  justify-content: center;
  padding: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.load-more-container .codicon {
  font-size: 16px;
}

/* 错误提示 - 扁平化设计，类似重试面板样式 */
.error-message {
  display: flex;
  flex-direction: column;
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.2));
}

.error-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--vscode-errorForeground, #f48771);
}

.error-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.error-body {
  padding: 12px;
}

.error-text-code {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family, monospace);
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 4px;
  margin: 0;
}

.error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.error-retry,
.error-dismiss {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  opacity: 0.6;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  transition: opacity 0.2s, background 0.2s;
}

.error-retry:hover,
.error-dismiss:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.error-retry .codicon {
  font-size: 14px;
}

/* 继续对话提示 */
.continue-message {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  margin: 0 var(--spacing-md, 16px) var(--spacing-md, 16px);
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 2px;
  flex-shrink: 0;
}

.continue-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.continue-icon .codicon {
  font-size: 16px;
}

.continue-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.continue-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.continue-text {
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
}

.continue-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.continue-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--vscode-toolbar-activeBackground, rgba(127, 127, 127, 0.2));
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.continue-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.3));
}

.continue-btn .codicon {
  font-size: 12px;
}

.btn-text {
  font-weight: 500;
}

/* 检查点条 */
.checkpoint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 0;
  background: var(--vscode-editor-background);
  border-left: 2px solid var(--vscode-charts-yellow, #ddb92f);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.checkpoint-bar.checkpoint-before {
  border-left-color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-bar.checkpoint-after {
  border-left-color: var(--vscode-charts-green, #89d185);
}

.checkpoint-bar.checkpoint-merged {
  border-left-color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.checkpoint-before .checkpoint-icon {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-icon {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-icon {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-icon .codicon {
  font-size: 14px;
}

.checkpoint-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.checkpoint-label {
  font-weight: 500;
}

.checkpoint-before .checkpoint-label {
  color: var(--vscode-charts-yellow, #ddb92f);
}

.checkpoint-after .checkpoint-label {
  color: var(--vscode-charts-green, #89d185);
}

.checkpoint-merged .checkpoint-label {
  color: var(--vscode-charts-blue, #75beff);
}

.checkpoint-meta {
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}

.checkpoint-time {
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  font-size: 11px;
  flex-shrink: 0;
  margin-left: auto;
}

.checkpoint-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.checkpoint-action:hover {
  opacity: 1;
  background: var(--vscode-list-hoverBackground);
}

.checkpoint-action .codicon {
  font-size: 14px;
}
</style>