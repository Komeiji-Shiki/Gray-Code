<script setup lang="ts">
/**
 * resize_image 工具的内容面板
 *
 * 基于 MediaToolPanel 骨架，仅提供缩放工具特有的任务解析与展示配置。
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'
import MediaToolPanel from './MediaToolPanel.vue'
import type {
  MediaInfoSegment,
  MediaMetaItem,
  MediaToolResultData,
  MediaToolStatus,
  MultimodalData
} from './mediaToolTypes'

interface ResizeTask {
  image_path: string
  output_path: string
  width: number
  height: number
}

interface Dimensions {
  width: number
  height: number
}

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: MediaToolStatus
  toolId?: string
}>()

const { t } = useI18n()
const NS = 'components.tools.media.resizeImagePanel'

// 任务解析
const images = computed(() => props.args.images as ResizeTask[] | undefined)
const isBatchMode = computed(() => !!(images.value && Array.isArray(images.value) && images.value.length > 0))

const taskList = computed<ResizeTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  const imagePath = props.args.image_path as string | undefined
  const outputPath = props.args.output_path as string | undefined
  const width = props.args.width as number | undefined
  const height = props.args.height as number | undefined
  if (imagePath && outputPath && width !== undefined && height !== undefined) {
    return [{
      image_path: imagePath,
      output_path: outputPath,
      width,
      height
    }]
  }
  return []
})

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 格式化尺寸
function formatSize(width: number, height: number): string {
  return `${width}×${height}`
}

const taskTitle = (task: ResizeTask) => truncateText(task.image_path, 25)

const metaItems = (task: ResizeTask): MediaMetaItem[] => [
  { icon: 'codicon-arrow-both', text: formatSize(task.width, task.height), accentColor: 'var(--vscode-charts-purple)' },
  { icon: 'codicon-arrow-right', text: truncateText(task.output_path, 20) }
]

const resultInfo = (result: MediaToolResultData): MediaInfoSegment[] | null => {
  const original = result.originalDimensions as Dimensions | undefined
  const resized = result.resizedDimensions as Dimensions | undefined
  if (!original || !resized) return null
  return [
    { label: t(`${NS}.dimensions.original`) },
    { value: `${original.width}×${original.height}` },
    { arrow: true },
    { label: t(`${NS}.dimensions.resized`) },
    { value: `${resized.width}×${resized.height}` }
  ]
}

const imageLabel = (img: MultimodalData, index: number) =>
  img.name || t(`${NS}.resizeResultN`, { n: index + 1 })
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
    icon="codicon-arrow-both"
    running-badge-color="var(--vscode-charts-green)"
    :dependencies="['sharp']"
    batch-title-key="batchResize"
    single-title-key="resizeTask"
    cancel-title-key="cancelResize"
    running-text-key="resizingImages"
    hint-text-key="sizeHint"
    :task-title="taskTitle"
    :meta-items="metaItems"
    :result-info="resultInfo"
    :image-label="imageLabel"
  />
</template>
