<script setup lang="ts">
/**
 * MessageItem - 单条消息组件
 * 扁平化设计，所有消息统一靠左布局
 * 按 parts 原始顺序显示内容
 *
 * F-07 拆分后职责：编排头部（角色 + 操作）、重试/编辑/响应查看对话框，
 * 以及按消息类型分发到 SummaryBlock / BackgroundTaskCard / MessageContent。
 */

import { ref, computed, watch } from 'vue'
import MessageActions from './MessageActions.vue'
import ResponseViewerDialog from './ResponseViewerDialog.vue'
import { RetryDialog, EditDialog } from '../common'
import SummaryBlock from './messageItem/SummaryBlock.vue'
import BackgroundTaskCard from './messageItem/BackgroundTaskCard.vue'
import MessageContent from './messageItem/MessageContent.vue'
import { buildResponseViewerData } from './responseViewer/buildResponseViewerData'
import type { ResponseViewerData } from './responseViewer/buildResponseViewerData'
import type { Message, CheckpointRecord, Attachment } from '../../types'
import { useChatStore } from '../../stores/chatStore'
import { useI18n } from '../../i18n'

const { t } = useI18n()

const props = defineProps<{
  message: Message
  messageIndex: number  // 后端消息索引
}>()

const emit = defineEmits<{
  edit: [messageId: string, newContent: string, attachments: Attachment[], mode?: 'branch' | 'keep']
  restoreAndEdit: [messageId: string, newContent: string, attachments: Attachment[], checkpointId: string]
  delete: [messageId: string]
  retry: [messageId: string]
  restoreAndRetry: [messageId: string, checkpointId: string]
  copy: [content: string]
  branch: [messageId: string]
}>()

const chatStore = useChatStore()

const showActions = ref(false)
const showRetryDialog = ref(false)
const showEditDialog = ref(false)
const showResponseDialog = ref(false)

// 消息角色判断
const isUser = computed(() => props.message.role === 'user')
const isTool = computed(() => props.message.role === 'tool')

// 是否为总结消息
const isSummary = computed(() => props.message.isSummary === true)

// 是否为代理消息回流
const isAgentMessage = computed(() => props.message.source === 'agent_message')
// 内部回流消息共用紧凑卡片；代理消息使用独立标题。
const isBackgroundTask = computed(() => props.message.source === 'background_task' || isAgentMessage.value)

// 是否为流式消息
const isStreaming = computed(() => props.message.streaming === true)

// 获取当前消息及之前所有消息的检查点
// 之前消息的存档点：包含所有阶段（before/after），因为这些代表已完成的操作状态
// 当前消息的存档点：只包含 before 阶段，因为用户要撤销的是这条消息的效果
const availableCheckpoints = computed<CheckpointRecord[]>(() => {
  return chatStore.checkpoints
    .filter(cp => {
      if (cp.messageIndex < props.messageIndex) return true          // 之前的消息：包含所有阶段
      if (cp.messageIndex === props.messageIndex && cp.phase === 'before') return true  // 当前消息：只包含 before
      return false
    })
})

// 获取用于编辑用户消息的最新检查点
// 优先显示该用户消息的"消息前存档"（如果存在）
// 如果不存在，则显示之前最近的一个存档点
const checkpointsBeforeMessage = computed<CheckpointRecord[]>(() => {
  // 首先查找该消息的"用户消息前"存档点
  const userMessageBefore = chatStore.checkpoints.find(cp =>
    cp.messageIndex === props.messageIndex &&
    cp.toolName === 'user_message' &&
    cp.phase === 'before'
  )

  if (userMessageBefore) {
    // 如果有该消息的"消息前存档"，只返回这一个
    return [userMessageBefore]
  }

  // 否则，找之前最近的一个存档点（按 messageIndex 降序排列取第一个）
  const previousCheckpoints = chatStore.checkpoints
    .filter(cp => cp.messageIndex < props.messageIndex)
    .sort((a, b) => b.messageIndex - a.messageIndex)

  if (previousCheckpoints.length > 0) {
    return [previousCheckpoints[0]]
  }

  return []
})

// 模型版本
const modelVersion = computed(() => props.message.metadata?.modelVersion)

// 角色显示名称
const roleDisplayName = computed(() => {
  if (isAgentMessage.value) return t('components.message.roles.agent')
  if (isBackgroundTask.value) return t('components.backgroundTasks.completed')
  if (isUser.value) return t('components.message.roles.user')
  if (isTool.value) return t('components.message.roles.tool')
  // 助手消息显示模型版本
  return modelVersion.value || t('components.message.roles.assistant')
})

// 用户消息预览文本（供滚动条 marker tooltip 使用）
const previewText = computed(() => {
  if (!isUser.value) return ''
  const raw = props.message.content || ''
  // 去除 context 标签、多余空白，截断到 80 字符
  const cleaned = raw
    .replace(/<lim-context[\s\S]*?<\/lim-context>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned
})

const messageClass = computed(() => ({
  'message-item': true,
  'user-message': isUser.value,
  'assistant-message': !isUser.value,
  'streaming': isStreaming.value,
  'summary-message': isSummary.value,
  'background-task-message': isBackgroundTask.value
}))

// 开始编辑（显示编辑对话框）
function startEdit() {
  showEditDialog.value = true
}

// 处理编辑保存
function handleEdit(newContent: string, attachments: Attachment[], mode: 'branch' | 'keep' = 'branch') {
  emit('edit', props.message.id, newContent, attachments, mode)
}

// 处理回档并编辑
function handleRestoreAndEdit(newContent: string, attachments: Attachment[], checkpointId: string) {
  emit('restoreAndEdit', props.message.id, newContent, attachments, checkpointId)
}

// 处理操作
function handleCopy() {
  emit('copy', props.message.content)
}

function handleDelete() {
  emit('delete', props.message.id)
}

function handleRetryClick() {
  // 始终显示重试对话框
  showRetryDialog.value = true
}

function handleViewResponse() {
  showResponseDialog.value = true
}

// R3-#6: 响应查看数据仅在对话框打开时构建一次（此前为无条件 computed，
// 流式期间每收到新消息都会重算整包数据）。关闭状态下保持 null，避免无谓重算。
const responseViewerData = ref<ResponseViewerData | null>(null)
watch(showResponseDialog, (open) => {
  if (!open) return
  responseViewerData.value = buildResponseViewerData(props.message, {
    allMessages: chatStore.allMessages
  })
})

function handleRetry() {
  emit('retry', props.message.id)
}

function handleRestoreAndRetry(checkpointId: string) {
  emit('restoreAndRetry', props.message.id, checkpointId)
}
</script>

<template>
  <div
    :class="messageClass"
    :data-preview="isUser ? previewText : undefined"
    @mouseenter="showActions = true"
    @mouseleave="showActions = false"
  >
    <div class="message-header">
      <div class="message-role-indicator">
        <span class="role-label">
          {{ roleDisplayName }}
        </span>
      </div>

      <!-- 操作按钮 -->
      <MessageActions
        :class="{ 'actions-visible': showActions }"
        :message="message"
        :can-edit="isUser"
        :can-retry="!isUser"
        :can-branch="typeof message.backendIndex === 'number' && !isStreaming"
        :can-view-response="!isUser"
        @edit="startEdit"
        @copy="handleCopy"
        @delete="handleDelete"
        @retry="handleRetryClick"
        @branch="emit('branch', message.id)"
        @view-response="handleViewResponse"
      />
    </div>

    <!-- 重试对话框 -->
    <RetryDialog
      v-model="showRetryDialog"
      :checkpoints="availableCheckpoints"
      @retry="handleRetry"
      @restore-and-retry="handleRestoreAndRetry"
    />

    <!-- 编辑对话框 -->
    <EditDialog
      v-model="showEditDialog"
      :checkpoints="checkpointsBeforeMessage"
      :original-content="message.content"
      :original-attachments="message.attachments || []"
      :is-root-message="message.parentId == null"
      @edit="handleEdit"
      @restore-and-edit="handleRestoreAndEdit"
    />

    <!-- 回复查看（仅在打开时渲染：关闭状态下 responseViewerData 为 null，
         传值会触发 ResponseViewerDialog 的 computed 求值 TypeError） -->
    <ResponseViewerDialog
      v-if="showResponseDialog && responseViewerData"
      v-model="showResponseDialog"
      :value="responseViewerData"
      :title="t('components.message.actions.viewResponse')"
      width="960px"
    />

    <div class="message-body">
      <!-- 总结消息特殊显示 -->
      <SummaryBlock
        v-if="isSummary"
        :content="message.content"
        :summarized-message-count="message.summarizedMessageCount"
      />

      <!-- 后台任务回流消息：紧凑卡片，与用户消息明确区分 -->
      <BackgroundTaskCard
        v-else-if="isBackgroundTask"
        :message-id="message.id"
        :content="message.content"
        :is-agent="isAgentMessage"
      />

      <!-- 普通消息显示 -->
      <MessageContent v-else :message="message" />
    </div>
  </div>
</template>

<style scoped>
/* 消息项 - 扁平化设计，统一靠左 */
.message-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px) var(--spacing-md, 16px);
  border-bottom: 1px solid var(--vscode-panel-border);
  transition: background-color var(--transition-fast, 0.1s);
  /* 性能优化：布局隔离 */
  contain: layout;
}

.message-item:last-child {
  border-bottom: none;
}

/* 所有消息统一靠左 */
.user-message,
.assistant-message {
  align-self: stretch;
  max-width: 100%;
}

/* 用户消息淡蓝色背景 — 滚动时快速定位 */
.user-message {
  background-color: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, transparent);
}

/* 消息头部 */
.message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm, 8px);
}

.message-role-indicator {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.role-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.user-message .role-label {
  color: var(--vscode-foreground);
}

.assistant-message .role-label {
  color: var(--vscode-descriptionForeground);
}

/* 工具消息标签 */
.message-item[class*="tool"] .role-label {
  color: var(--vscode-charts-blue);
}

.message-body {
  padding-left: 0;
}

/* 总结消息样式 */
.summary-message {
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
}

/* 后台任务回流卡片 */
.background-task-message .message-header {
  opacity: 0.6;
}

/* 操作按钮淡入淡出效果 */
.message-header :deep(.message-actions) {
  opacity: 0;
  transition: opacity var(--transition-fast, 0.15s);
}

.message-header :deep(.message-actions.actions-visible) {
  opacity: 1;
}

/* 键盘聚焦（Tab 导航到消息内任意可聚焦元素）时同样显示操作按钮，保证纯键盘可用 */
.message-item:focus-within .message-header :deep(.message-actions) {
  opacity: 1;
}
</style>
