<script setup lang="ts">
/**
 * generate_image 工具的内容面板
 *
 * 基于 MediaToolPanel 骨架，提供图像生成工具特有的任务解析与展示配置。
 * 与图片处理类工具的差异：无依赖检查、紫色主题、独立的取消通道。
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'
import MediaToolPanel from './MediaToolPanel.vue'
import type {
  MediaMetaItem,
  MediaToolResultData,
  MediaToolStatus,
  MultimodalData
} from './mediaToolTypes'

interface ImageTask {
  prompt: string
  reference_images?: string[]
  aspect_ratio?: string
  image_size?: string
  output_path: string
}

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: MediaToolStatus
  toolId?: string
}>()

const { t } = useI18n()
const NS = 'components.tools.media.generateImagePanel'

// 任务解析
const images = computed(() => props.args.images as ImageTask[] | undefined)
const isBatchMode = computed(() => !!(images.value && Array.isArray(images.value) && images.value.length > 0))

const taskList = computed<ImageTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  const prompt = props.args.prompt as string | undefined
  const outputPath = props.args.output_path as string | undefined
  if (prompt && outputPath) {
    return [{
      prompt,
      reference_images: props.args.reference_images as string[] | undefined,
      aspect_ratio: props.args.aspect_ratio as string | undefined,
      image_size: props.args.image_size as string | undefined,
      output_path: outputPath
    }]
  }
  return []
})

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

const taskTitle = (task: ImageTask) => truncateText(task.prompt, 80)

const metaItems = (task: ImageTask): MediaMetaItem[] => {
  const items: MediaMetaItem[] = [
    { icon: 'codicon-file', text: task.output_path }
  ]
  if (task.aspect_ratio) {
    items.push({ icon: 'codicon-screen-normal', text: task.aspect_ratio })
  }
  if (task.image_size) {
    items.push({ icon: 'codicon-symbol-ruler', text: task.image_size })
  }
  if (task.reference_images && task.reference_images.length > 0) {
    items.push({
      icon: 'codicon-references',
      text: t(`${NS}.referenceImages`, { count: task.reference_images.length })
    })
  }
  return items
}

const imageLabel = (img: MultimodalData, index: number) =>
  img.name || `image_${index + 1}`

// 头部展示生成所用模型
const headerExtra = (result: MediaToolResultData) =>
  result.model as string | undefined
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
    icon="codicon-file-media"
    accent-color="var(--vscode-charts-purple)"
    batch-title-key="batchTasks"
    single-title-key="generateTask"
    cancel-title-key="cancelGeneration"
    running-text-key="generatingImages"
    processing-status-key="status.generating"
    cancel-channel="imageGeneration.cancel"
    cancel-id-field="toolId"
    plain-task-title
    :task-title="taskTitle"
    :meta-items="metaItems"
    :image-label="imageLabel"
    :header-extra="headerExtra"
  />
</template>
