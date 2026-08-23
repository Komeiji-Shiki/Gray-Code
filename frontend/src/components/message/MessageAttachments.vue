<script setup lang="ts">
/**
 * MessageAttachments - 消息中的附件显示组件
 *
 * 复用输入框的附件样式，支持点击预览
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { sendToExtension, showNotification } from '../../utils/vscode'
import { formatFileSize } from '../../utils/file'
import { useI18n } from '../../i18n'
import type { Attachment } from '../../types'

const { t } = useI18n()

withDefaults(defineProps<{
  attachments: Attachment[]
  /** 是否为只读模式（不显示删除按钮） */
  readonly?: boolean
}>(), {
  readonly: true
})

const emit = defineEmits<{
  remove: [attachmentId: string]
}>()

// 获取附件图标类名
function getAttachmentIconClass(type: string): string {
  if (type === 'image') return 'codicon-file-media'
  if (type === 'video') return 'codicon-device-camera-video'
  if (type === 'audio') return 'codicon-unmute'
  if (type === 'code') return 'codicon-file-code'
  return 'codicon-file'
}

// 判断附件是否有预览
function hasPreview(attachment: Attachment): boolean {
  if (!attachment.data) return false
  if (attachment.type === 'image' && attachment.thumbnail) return true
  if (attachment.type === 'video' && attachment.thumbnail) return true
  if (attachment.type === 'audio') return true
  return false
}

// 预览附件（在 VSCode 中打开）
async function previewAttachment(attachment: Attachment) {
  if (!attachment.data) return
  
  try {
    await sendToExtension(MESSAGE_NAMES.previewAttachment, {
      name: attachment.name,
      mimeType: attachment.mimeType,
      data: attachment.data
    })
  } catch (error) {
    console.error('Failed to preview attachment:', error)
    await showNotification(error instanceof Error ? error.message : t('common.error'), 'error')
  }
}

// 移除附件
function handleRemove(attachmentId: string) {
  emit('remove', attachmentId)
}
</script>

<template>
  <div v-if="attachments && attachments.length > 0" class="message-attachments">
    <div
      v-for="attachment in attachments"
      :key="attachment.id"
      class="attachment-item"
      :class="{ 'has-preview': hasPreview(attachment) }"
    >
      <button
        v-if="hasPreview(attachment)"
        type="button"
        class="media-preview-wrapper clickable"
        :class="{ 'audio-placeholder': attachment.type === 'audio' }"
        :title="t('components.message.attachment.clickToPreview')"
        :aria-label="`${t('components.message.attachment.clickToPreview')}: ${attachment.name}`"
        @click="previewAttachment(attachment)"
      >
        <img
          v-if="(attachment.type === 'image' || attachment.type === 'video') && attachment.thumbnail"
          :src="attachment.thumbnail"
          :alt="attachment.name"
          class="attachment-preview"
        />
        <i
          v-if="attachment.type === 'video'"
          class="codicon codicon-play media-overlay-icon"
          aria-hidden="true"
        ></i>
        <i
          v-else-if="attachment.type === 'audio'"
          class="codicon codicon-unmute media-center-icon"
          aria-hidden="true"
        ></i>
      </button>
      <img
        v-else-if="attachment.type === 'image' && attachment.thumbnail"
        :src="attachment.thumbnail"
        :alt="attachment.name"
        class="attachment-preview"
      />
      <i
        v-else
        :class="['codicon', getAttachmentIconClass(attachment.type), 'attachment-icon']"
        aria-hidden="true"
      ></i>
      <span class="attachment-name">{{ attachment.name }}</span>
      <span class="attachment-size">{{ formatFileSize(attachment.size) }}</span>
      <!-- 删除按钮（仅在非只读模式显示） -->
      <button
        v-if="!readonly"
        type="button"
        class="remove-btn gc-icon-button gc-icon-button--danger"
        @click.stop="handleRemove(attachment.id)"
        :title="t('components.message.attachment.removeAttachment')"
        :aria-label="`${t('components.message.attachment.removeAttachment')}: ${attachment.name}`"
      >
        <i class="codicon codicon-close" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 附件列表 */
.message-attachments {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-list-hoverBackground);
  border-radius: var(--radius-sm, 2px);
  margin-bottom: var(--spacing-sm, 8px);
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--vscode-editor-background);
  border-radius: var(--radius-sm, 2px);
  transition: background-color var(--transition-fast, 0.1s);
}

.attachment-item:hover {
  background: var(--vscode-list-hoverBackground);
}

.attachment-icon {
  font-size: 14px;
  flex-shrink: 0;
  opacity: 0.7;
}

/* 图片预览 */
.attachment-preview {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

/* 可点击的预览 */
.clickable {
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s;
}

.clickable:hover {
  opacity: 0.8;
  transform: scale(1.05);
}

.attachment-item.has-preview {
  padding: var(--spacing-xs, 4px);
}

/* 媒体预览包装器（视频、音频） */
.media-preview-wrapper {
  position: relative;
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 0;
  flex-shrink: 0;
  border: 0;
  border-radius: var(--gc-radius-sm);
  overflow: hidden;
  background: transparent;
}

.media-preview-wrapper .attachment-preview {
  width: 100%;
  height: 100%;
}

/* 音频占位背景 */
.audio-placeholder {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--gc-text-primary) 18%, var(--gc-surface-base)),
    var(--gc-surface-muted)
  );
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 叠加层图标（右下角小图标，用于视频） */
.media-overlay-icon {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 10px;
  color: var(--vscode-button-foreground, #fff);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

/* 居中图标（用于音频） */
.media-center-icon {
  font-size: 16px;
  color: var(--vscode-foreground);
  opacity: 0.8;
}

.attachment-name {
  flex: 1;
  font-size: 12px;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

/* 删除按钮 */
.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  transition: background-color 0.15s, color 0.15s;
  flex-shrink: 0;
  opacity: 0;
}

.attachment-item:hover .remove-btn,
.attachment-item:focus-within .remove-btn {
  opacity: 1;
}

.remove-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-errorForeground);
}

.remove-btn .codicon {
  font-size: 12px;
}
</style>