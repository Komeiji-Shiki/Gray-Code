<script setup lang="ts">
/**
 * remove_background 工具的内容面板
 *
 * 基于 MediaToolPanel 骨架，提供抠图工具特有的任务解析、
 * needsSharp 警告块、遮罩图标签与透明棋盘格背景。
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'
import MediaToolPanel from './MediaToolPanel.vue'
import type {
  MediaMetaItem,
  MediaStatusOverride,
  MediaToolStatus,
  MultimodalData
} from './mediaToolTypes'

interface RemoveTask {
  image_path: string
  output_path: string
  subject_description?: string
  mask_path?: string
}

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: MediaToolStatus
  toolId?: string
}>()

const { t } = useI18n()
const NS = 'components.tools.media.removeBackgroundPanel'

// 任务解析
const images = computed(() => props.args.images as RemoveTask[] | undefined)
const isBatchMode = computed(() => !!(images.value && Array.isArray(images.value) && images.value.length > 0))

const taskList = computed<RemoveTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  const imagePath = props.args.image_path as string | undefined
  const outputPath = props.args.output_path as string | undefined
  if (imagePath && outputPath) {
    return [{
      image_path: imagePath,
      output_path: outputPath,
      subject_description: props.args.subject_description as string | undefined,
      mask_path: props.args.mask_path as string | undefined
    }]
  }
  return []
})

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 是否需要安装 sharp（结果中的 needsSharp 标记）
const needsSharp = computed(() => {
  if (!props.result) return false
  const nested = props.result.data as { needsSharp?: boolean } | undefined
  if (nested && nested.needsSharp === true) return true
  return (props.result as { needsSharp?: boolean }).needsSharp === true
})

// needsSharp 时状态徽章显示为 warning
const statusOverride = computed<MediaStatusOverride | null>(() => {
  if (!needsSharp.value) return null
  return {
    label: t(`${NS}.status.needDependency`),
    badgeClass: 'warning'
  }
})

const taskTitle = (task: RemoveTask) =>
  `${truncateText(task.image_path, 30)} → ${truncateText(task.output_path, 30)}`

const metaItems = (task: RemoveTask): MediaMetaItem[] => {
  const items: MediaMetaItem[] = []
  if (task.subject_description) {
    items.push({ icon: 'codicon-tag', text: task.subject_description })
  }
  if (task.mask_path) {
    items.push({
      icon: 'codicon-file-media',
      text: t(`${NS}.maskPath`, { path: truncateText(task.mask_path, 20) })
    })
  }
  return items
}

// 遮罩图显示专用标签
const imageLabel = (img: MultimodalData, index: number): string => {
  if (img.name?.includes('mask')) return t(`${NS}.maskImage`)
  return img.name || t(`${NS}.resultImage`, { n: index + 1 })
}

// 非遮罩图使用透明棋盘格背景
const imageWrapperClass = (img: MultimodalData): string | undefined => {
  return img.name?.includes('mask') ? undefined : 'transparent-bg'
}
</script>

<template>
  <MediaToolPanel
    :result="result"
    :error="error"
    :status="status"
    :tool-id="toolId"
    :tasks="taskList"
    :is-batch="isBatchMode"
    :ns="NS"
    icon="codicon-wand"
    :dependencies="['sharp']"
    batch-title-key="batchTasks"
    single-title-key="removeTask"
    cancel-title-key="cancelRemove"
    running-text-key="processingImages"
    :status-override="statusOverride"
    :suppress-status-blocks="needsSharp"
    :task-title="taskTitle"
    :meta-items="metaItems"
    :image-label="imageLabel"
    :image-wrapper-class="imageWrapperClass"
  >
    <template #pre-status>
      <!-- 需要 sharp 警告 -->
      <div v-if="needsSharp" class="panel-warning">
        <span class="codicon codicon-warning warning-icon"></span>
        <div class="warning-content">
          <span class="warning-title">{{ t(`${NS}.needSharp.title`) }}</span>
          <span class="warning-text">{{ t(`${NS}.needSharp.message`) }}</span>
          <code class="install-cmd">{{ t(`${NS}.needSharp.installCmd`) }}</code>
        </div>
      </div>
    </template>
  </MediaToolPanel>
</template>

<style scoped>
/* 需要 sharp 警告块 */
.panel-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: var(--radius-sm, 2px);
}

.warning-icon {
  color: var(--vscode-charts-orange);
  font-size: 14px;
  flex-shrink: 0;
}

.warning-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
}

.warning-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-inputValidation-warningForeground);
}

.warning-text {
  font-size: 11px;
  color: var(--vscode-inputValidation-warningForeground);
}

.install-cmd {
  display: inline-block;
  padding: 2px 6px;
  background: var(--vscode-editor-background);
  border-radius: var(--radius-sm, 2px);
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  margin-top: var(--spacing-xs, 4px);
}
</style>
