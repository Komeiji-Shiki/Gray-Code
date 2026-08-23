<script setup lang="ts">
/**
 * AttachmentItem - 单个附件
 * 展示附件信息，支持预览和下载
 */

import { computed } from 'vue'
import { IconButton, Tooltip } from '../common'
import type { Attachment } from '../../types'
import { formatFileSize } from '../../utils/file'
import { t } from '../../i18n'

const props = defineProps<{
  attachment: Attachment
  compact?: boolean
}>()

const emit = defineEmits<{
  preview: [attachment: Attachment]
  download: [attachment: Attachment]
}>()

// 获取文件类型图标类名 (codicon)
const typeIconClass = computed(() => {
  const type = props.attachment.type
  switch (type) {
    case 'image': return 'codicon-file-media'
    case 'video': return 'codicon-device-camera-video'
    case 'audio': return 'codicon-unmute'
    case 'document': return 'codicon-file-code'
    default: return 'codicon-file'
  }
})

// 是否可预览（图片和视频）
const canPreview = computed(() => {
  return props.attachment.type === 'image' || props.attachment.type === 'video'
})

// 缩略图URL（如果有）
const thumbnailUrl = computed(() => {
  if (props.attachment.thumbnail) {
    return props.attachment.thumbnail
  }
  if (props.attachment.type === 'image' && props.attachment.data) {
    return `data:${props.attachment.mimeType};base64,${props.attachment.data}`
  }
  return null
})

// 处理预览
function handlePreview() {
  if (canPreview.value) {
    emit('preview', props.attachment)
  }
}

// 处理下载
function handleDownload() {
  emit('download', props.attachment)
}
</script>

<template>
  <div
    :class="['attachment-item', { compact, clickable: canPreview }]"
    :role="canPreview ? 'button' : undefined"
    :tabindex="canPreview ? 0 : undefined"
    :aria-label="canPreview ? `${t('components.attachment.preview')}: ${attachment.name}` : undefined"
    @click="handlePreview"
    @keydown.enter.prevent="handlePreview"
    @keydown.space.prevent="handlePreview"
  >
    <!-- 缩略图或图标 -->
    <div class="attachment-thumbnail">
      <img v-if="thumbnailUrl" :src="thumbnailUrl" :alt="attachment.name" class="thumbnail-image" />
      <i v-else :class="['codicon', typeIconClass, 'thumbnail-icon']" aria-hidden="true"></i>
    </div>

    <!-- 文件信息 -->
    <div class="attachment-info">
      <div class="attachment-name" :title="attachment.name">
        {{ attachment.name }}
      </div>
      <div class="attachment-meta">
        <span class="attachment-size">{{ formatFileSize(attachment.size) }}</span>
        <span v-if="attachment.mimeType" class="attachment-type">
          {{ attachment.mimeType.split('/')[1]?.toUpperCase() }}
        </span>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="attachment-actions" @click.stop>
      <!-- 预览按钮 -->
      <Tooltip v-if="canPreview" :content="t('components.attachment.preview')" placement="top">
        <IconButton
          icon="codicon-eye"
          size="small"
          variant="default"
          @click="handlePreview"
        />
      </Tooltip>

      <!-- 下载按钮 -->
      <Tooltip :content="t('components.attachment.download')" placement="top">
        <IconButton
          icon="codicon-desktop-download"
          size="small"
          variant="default"
          @click="handleDownload"
        />
      </Tooltip>
    </div>
  </div>
</template>

<style scoped>
.attachment-item {
  display: flex;
  align-items: center;
  gap: var(--gc-space-3);
  padding: var(--gc-space-2) var(--gc-space-3);
  background: var(--gc-surface-muted);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--gc-radius-lg);
  transition:
    background-color var(--gc-duration-fast) var(--gc-ease-standard),
    border-color var(--gc-duration-fast) var(--gc-ease-standard);
  min-width: 200px;
  max-width: 400px;
}

.attachment-item.compact {
  padding: 6px 8px;
  gap: 8px;
  min-width: 150px;
}

.attachment-item.clickable {
  cursor: pointer;
}

.attachment-item.clickable:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.attachment-thumbnail {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editor-background);
  border-radius: 6px;
  overflow: hidden;
}

.compact .attachment-thumbnail {
  width: 36px;
  height: 36px;
}

.thumbnail-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-icon {
  font-size: 24px;
  color: var(--vscode-descriptionForeground);
}

.compact .thumbnail-icon {
  font-size: 20px;
}

.attachment-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attachment-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact .attachment-name {
  font-size: 12px;
}

.attachment-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.attachment-size,
.attachment-type {
  line-height: 1;
}

.attachment-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.attachment-item:hover .attachment-actions {
  opacity: 1;
}
</style>