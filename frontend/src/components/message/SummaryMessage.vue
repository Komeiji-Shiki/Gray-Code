<script setup lang="ts">
/**
 * SummaryMessage - 总结消息专用组件
 *
 * 用于显示上下文压缩后生成的总结消息
 * 采用特殊样式区别于普通消息
 */

import { ref, computed } from 'vue'
import { MarkdownRenderer } from '../common'
import type { Message } from '../../types'
import { formatTime } from '../../utils/format'
import { useChatStore } from '../../stores'
import { useI18n } from '../../i18n'

const { t } = useI18n()

const props = defineProps<{
  message: Message
  messageIndex: number
}>()

const emit = defineEmits<{
  deleted: []
}>()

const chatStore = useChatStore()

// 删除状态
const isDeleting = ref(false)
// 恢复状态
const isRestoring = ref(false)

// 展开/收起状态
const isExpanded = ref(false)

// 格式化时间
const formattedTime = computed(() =>
  formatTime(props.message.timestamp, 'HH:mm')
)

// 获取总结内容（去除 [对话总结] 前缀）
const summaryContent = computed(() => {
  const content = props.message.content || ''
  // 移除 [对话总结] 标题和换行
  return content.replace(/^\[对话总结\]\s*\n*/, '').trim()
})

// 获取预览文本（前 100 个字符）
const previewText = computed(() => {
  const text = summaryContent.value
  if (text.length <= 100) return text
  return text.slice(0, 100) + '...'
})

// Token 信息
const usageMetadata = computed(() => props.message.metadata?.usageMetadata)
const summaryTokenStats = computed(() => props.message.summaryTokenStats)
const hasTokenInfo = computed(() =>
  summaryTokenStats.value || usageMetadata.value?.promptTokenCount || usageMetadata.value?.candidatesTokenCount
)
const tokenBefore = computed(() =>
  summaryTokenStats.value?.sourceTokenCount ?? usageMetadata.value?.promptTokenCount ?? 0
)
const tokenAfter = computed(() =>
  summaryTokenStats.value?.summaryTokenCount ?? usageMetadata.value?.candidatesTokenCount ?? 0
)
const tokenTitle = computed(() => summaryTokenStats.value
  ? t('components.message.summary.compressionTokens', {
      saved: summaryTokenStats.value.estimatedTokensSaved
    })
  : t('components.message.summary.legacyRequestTokens')
)
const tokenModeLabel = computed(() => summaryTokenStats.value
  ? t('components.message.summary.historyTokenLabel')
  : t('components.message.summary.requestTokenLabel')
)

// 删除总结消息（后端会自动恢复其覆盖的原文，避免上下文真空）
async function handleDelete() {
  if (isDeleting.value || isRestoring.value) return  // 与恢复互斥，防并发双 IPC + 双次历史重载

  isDeleting.value = true
  try {
    await chatStore.deleteSingleMessage(props.messageIndex)
    emit('deleted')
  } catch (error) {
    console.error('Failed to delete summary message:', error)
  } finally {
    isDeleting.value = false
  }
}

// 恢复原文：取消该总结覆盖消息的 isSummarized 标记并删除总结消息，原文重新参与发送
async function handleRestore() {
  if (isRestoring.value || isDeleting.value) return  // 与删除互斥
  if (!props.message.id) return

  isRestoring.value = true
  try {
    await chatStore.restoreSummarizedMessages(props.message.id)
    emit('deleted')
  } catch (error) {
    console.error('Failed to restore summarized messages:', error)
  } finally {
    isRestoring.value = false
  }
}
</script>

<template>
  <div class="summary-message">
    <div class="summary-bar" @click="isExpanded = !isExpanded">
      <!-- 左侧：图标和标题 -->
      <div class="summary-left">
        <i class="codicon" :class="isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"></i>
        <span class="summary-title">{{ t('components.message.summary.title') }}</span>
        <span v-if="message.summarizedMessageCount" class="summary-count">
          {{ t('components.message.summary.compressed', { count: message.summarizedMessageCount }) }}
        </span>
        <span v-if="message.isAutoSummary" class="summary-auto-badge">
          {{ t('components.message.summary.autoTriggered') }}
        </span>
      </div>
      
      <!-- 右侧：删除按钮 + 时间和 Token 信息 -->
      <div class="summary-right">
        <span v-if="hasTokenInfo" class="summary-tokens" :title="tokenTitle">
          <span class="token-mode">{{ tokenModeLabel }}</span>
          <span class="token-before">{{ tokenBefore }}</span>
          <span class="token-arrow">→</span>
          <span class="token-after">{{ tokenAfter }}</span>
          <span v-if="summaryTokenStats" class="token-saved">−{{ summaryTokenStats.estimatedTokensSaved }}</span>
        </span>
        <span class="summary-time">{{ formattedTime }}</span>
        <button
          class="delete-button"
          :disabled="isRestoring"
          @click.stop="handleRestore"
          :title="t('components.message.summary.restoreTitle')"
        >
          <i class="codicon codicon-discard"></i>
        </button>
        <button
          class="delete-button"
          :disabled="isDeleting"
          @click.stop="handleDelete"
          :title="t('components.message.summary.deleteTitle')"
        >
          <i class="codicon codicon-trash"></i>
        </button>
      </div>
    </div>
    
    <!-- 展开时显示内容 -->
    <div v-if="isExpanded" class="summary-content">
      <MarkdownRenderer
        :content="summaryContent"
        :latex-only="false"
        class="summary-text"
      />
    </div>
    
    <!-- 收起时显示预览 -->
    <div v-else class="summary-preview">
      {{ previewText }}
    </div>
  </div>
</template>

<style scoped>
.summary-message {
  margin: 8px 16px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: linear-gradient(
    135deg,
    rgba(128, 128, 128, 0.08),
    rgba(128, 128, 128, 0.03)
  );
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s;
}

.summary-bar:hover {
  background: linear-gradient(
    135deg,
    rgba(128, 128, 128, 0.12),
    rgba(128, 128, 128, 0.06)
  );
}

.summary-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.summary-left .codicon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.summary-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.summary-count {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  padding: 2px 8px;
  border-radius: 10px;
}

.summary-auto-badge {
  font-size: 11px;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--vscode-focusBorder);
}

.summary-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.summary-tokens {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.token-before {
  font-weight: 500;
  color: var(--vscode-foreground);
  opacity: 0.7;
}

.token-mode,
.token-saved {
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}

.token-after {
  font-weight: 500;
  color: var(--vscode-foreground);
}

.token-arrow {
  opacity: 0.5;
  font-size: 10px;
}

.summary-time {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.delete-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background-color 0.15s, color 0.15s;
}

.summary-bar:hover .delete-button {
  opacity: 0.7;
}

.delete-button:hover {
  opacity: 1 !important;
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-errorForeground);
}

.delete-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.delete-button .codicon {
  font-size: 14px;
}

.summary-preview {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-textBlockQuote-background);
}

.summary-content {
  padding: 12px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.summary-text {
  font-size: 13px;
  color: var(--vscode-foreground);
  line-height: 1.6;
}

.summary-text :deep(p) {
  margin: 0.5em 0;
}

.summary-text :deep(p:first-child) {
  margin-top: 0;
}

.summary-text :deep(p:last-child) {
  margin-bottom: 0;
}

.summary-text :deep(ul),
.summary-text :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.summary-text :deep(li) {
  margin: 0.25em 0;
}
</style>
