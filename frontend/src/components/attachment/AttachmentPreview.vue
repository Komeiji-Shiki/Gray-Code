<script setup lang="ts">
/**
 * AttachmentPreview - 附件预览弹窗
 * 支持图片和视频的全屏预览
 */

import { computed } from 'vue'
import { Modal, IconButton } from '../common'
import type { Attachment } from '../../types'
import { formatFileSize } from '../../utils/file'
import { t } from '../../i18n'

const props = defineProps<{
  attachment: Attachment
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
  download: [attachment: Attachment]
}>()

// 预览URL
const previewUrl = computed(() => {
  if (!props.attachment.data) return null
  return `data:${props.attachment.mimeType};base64,${props.attachment.data}`
})

// 是否为图片
const isImage = computed(() => props.attachment.type === 'image')

// 是否为视频
const isVideo = computed(() => props.attachment.type === 'video')

// 处理关闭
function handleClose() {
  emit('close')
}

// 处理下载
function handleDownload() {
  emit('download', props.attachment)
}

// ESC 键关闭由 Modal 组件统一处理（Modal 已在 document 上注册 keydown 并 emit close），
// 此处不再重复监听，避免同一 Esc 按键触发两次关闭（双重监听修复）。
</script>

<template>
  <Modal :model-value="visible" @close="handleClose">
    <template #header>
      <div class="preview-header">
        <div class="preview-info">
          <span class="preview-name">{{ attachment.name }}</span>
          <span class="preview-meta">
            {{ formatFileSize(attachment.size) }}
            <template v-if="attachment.mimeType">
              · {{ attachment.mimeType }}
            </template>
          </span>
        </div>
        
        <div class="preview-actions">
          <IconButton
            icon="codicon-desktop-download"
            @click="handleDownload"
            :title="t('components.attachment.download')"
          />
          <IconButton
            icon="codicon-close"
            @click="handleClose"
            :title="t('components.attachment.close')"
          />
        </div>
      </div>
    </template>

    <template #default>
      <div class="preview-content">
        <!-- 图片预览 -->
        <img
          v-if="isImage && previewUrl"
          :src="previewUrl"
          :alt="attachment.name"
          class="preview-image"
        />

        <!-- 视频预览 -->
        <video
          v-else-if="isVideo && previewUrl"
          :src="previewUrl"
          class="preview-video"
          controls
          autoplay
        />

        <!-- 不支持预览 -->
        <div v-else class="preview-unsupported">
          <i class="codicon codicon-file unsupported-icon"></i>
          <div class="unsupported-text">{{ t('components.attachment.unsupportedPreview') }}</div>
          <button class="download-button" @click="handleDownload">
            {{ t('components.attachment.downloadFile') }}
          </button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}

.preview-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.preview-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-meta {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-content {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  max-height: 70vh;
  background: var(--vscode-editor-background);
  border-radius: 8px;
  overflow: hidden;
}

.preview-image {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  border-radius: 4px;
}

.preview-video {
  max-width: 100%;
  max-height: 70vh;
  border-radius: 4px;
}

.preview-unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 48px;
  text-align: center;
}

.unsupported-icon {
  font-size: 64px;
  opacity: 0.5;
  color: var(--vscode-descriptionForeground);
}

.unsupported-text {
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}

.download-button {
  padding: 8px 16px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.download-button:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>