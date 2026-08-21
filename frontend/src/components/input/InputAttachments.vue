<script setup lang="ts">
import type { Attachment } from '../../types'
import { IconButton } from '../common'
import { formatFileSize } from '../../utils/file'
import { useI18n } from '../../i18n'

const { t } = useI18n()

const props = defineProps<{
  attachments: Attachment[]
  uploading?: boolean
}>()

const emit = defineEmits<{
  (e: 'remove', id: string): void
  (e: 'preview', attachment: Attachment): void
}>()

function getAttachmentIconClass(type: string): string {
  if (type === 'image') return 'codicon-file-media'
  if (type === 'video') return 'codicon-device-camera-video'
  if (type === 'audio') return 'codicon-unmute'
  if (type === 'code') return 'codicon-file-code'
  return 'codicon-file'
}

/**
 * 输入区附件展示策略：
 * - 媒体类（图片/音频/有缩略图的视频）→ 64px 缩略图块，悬停显示删除，点击预览；
 * - 其余（文档/代码等）→ 紧凑 chip（图标 + 名称 + 大小 + 删除）。
 * 整体横向 flex-wrap 排列，多附件时不再逐行堆叠挤占输入框。
 */
function isMediaTile(attachment: Attachment): boolean {
  if (attachment.type === 'image') return true
  if (attachment.type === 'audio') return true
  if (attachment.type === 'video') return !!attachment.thumbnail
  return false
}
</script>

<template>
  <div class="attachments-list">
    <div
      v-for="attachment in props.attachments"
      :key="attachment.id"
      class="attachment-tile"
      :class="{ 'is-media': isMediaTile(attachment) }"
    >
      <!-- 媒体：缩略图块 -->
      <template v-if="isMediaTile(attachment)">
        <div
          class="tile-media clickable"
          :title="t('components.message.attachment.clickToPreview')"
          @click="emit('preview', attachment)"
        >
          <img
            v-if="attachment.thumbnail"
            :src="attachment.thumbnail"
            :alt="attachment.name"
            class="tile-img"
          />
          <div v-else class="tile-img media-placeholder">
            <i :class="['codicon', getAttachmentIconClass(attachment.type), 'tile-icon']"></i>
          </div>
          <i
            v-if="attachment.type === 'video'"
            class="codicon codicon-play tile-overlay"
          ></i>
        </div>
        <IconButton
          class="tile-remove"
          icon="codicon-close"
          size="small"
          :disabled="props.uploading"
          :tooltip="t('components.message.attachment.removeAttachment')"
          @click.stop="emit('remove', attachment.id)"
        />
      </template>

      <!-- 非媒体：紧凑 chip -->
      <template v-else>
        <i :class="['codicon', getAttachmentIconClass(attachment.type), 'chip-icon']"></i>
        <span class="chip-name" :title="attachment.name">{{ attachment.name }}</span>
        <span class="chip-size">{{ formatFileSize(attachment.size) }}</span>
        <IconButton
          class="chip-remove"
          icon="codicon-close"
          size="small"
          :disabled="props.uploading"
          :tooltip="t('components.message.attachment.removeAttachment')"
          @click.stop="emit('remove', attachment.id)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.attachments-list {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  padding: 8px;
  max-height: 148px; /* 约两行 64px 缩略图块，超出滚动，避免挤占输入框 */
  overflow-y: auto;
  background: var(--vscode-list-hoverBackground);
  border-radius: var(--radius-sm, 2px);
}

/* ---------- 媒体缩略图块 ---------- */

.attachment-tile.is-media {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}

.tile-media {
  width: 100%;
  height: 100%;
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.tile-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.media-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #3a3d41, #2d2d30);
}

.tile-icon {
  font-size: 20px;
  color: var(--vscode-foreground);
  opacity: 0.8;
}

.tile-overlay {
  position: absolute;
  bottom: 4px;
  right: 4px;
  font-size: 12px;
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.tile-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  background: var(--vscode-editor-background);
  border-radius: 50%;
}

.attachment-tile.is-media:hover .tile-remove,
.attachment-tile.is-media:focus-within .tile-remove {
  opacity: 1;
}

/* ---------- 非媒体 chip ---------- */

.attachment-tile {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  max-width: 240px;
  padding: 0 4px 0 8px;
  border-radius: 16px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-input-border, transparent);
}

.chip-icon {
  font-size: 14px;
  opacity: 0.7;
  flex-shrink: 0;
}

.chip-name {
  font-size: 12px;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.chip-size {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}
</style>
