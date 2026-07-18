<script setup lang="ts">
/**
 * crop_image 工具的内容面板
 *
 * 基于 MediaToolPanel 骨架，仅提供裁切工具特有的任务解析与展示配置。
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

interface CropTask {
  image_path: string
  output_path: string
  x1: number
  y1: number
  x2: number
  y2: number
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
const NS = 'components.tools.media.cropImagePanel'

// 任务解析
const images = computed(() => props.args.images as CropTask[] | undefined)
const isBatchMode = computed(() => !!(images.value && Array.isArray(images.value) && images.value.length > 0))

const taskList = computed<CropTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  const imagePath = props.args.image_path as string | undefined
  const outputPath = props.args.output_path as string | undefined
  const x1 = props.args.x1 as number | undefined
  const y1 = props.args.y1 as number | undefined
  const x2 = props.args.x2 as number | undefined
  const y2 = props.args.y2 as number | undefined
  if (imagePath && outputPath &&
      x1 !== undefined && y1 !== undefined &&
      x2 !== undefined && y2 !== undefined) {
    return [{
      image_path: imagePath,
      output_path: outputPath,
      x1,
      y1,
      x2,
      y2
    }]
  }
  return []
})

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 格式化坐标
function formatCoords(x1: number, y1: number, x2: number, y2: number): string {
  return `(${x1},${y1}) → (${x2},${y2})`
}

const taskTitle = (task: CropTask) => truncateText(task.image_path, 25)

const metaItems = (task: CropTask): MediaMetaItem[] => [
  { icon: 'codicon-symbol-ruler', text: formatCoords(task.x1, task.y1, task.x2, task.y2), accentColor: 'var(--vscode-charts-blue)' },
  { icon: 'codicon-arrow-right', text: truncateText(task.output_path, 20) }
]

const resultInfo = (result: MediaToolResultData): MediaInfoSegment[] | null => {
  const original = result.originalDimensions as Dimensions | undefined
  const cropped = result.croppedDimensions as Dimensions | undefined
  if (!original || !cropped) return null
  return [
    { label: t(`${NS}.original`) },
    { value: `${original.width}×${original.height}` },
    { arrow: true },
    { label: t(`${NS}.cropped`) },
    { value: `${cropped.width}×${cropped.height}` }
  ]
}

const imageLabel = (img: MultimodalData, index: number) =>
  img.name || t(`${NS}.cropResultN`, { n: index + 1 })
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
    icon="codicon-selection"
    running-badge-color="var(--vscode-charts-green)"
    :dependencies="['sharp']"
    batch-title-key="batchCrop"
    single-title-key="cropTask"
    cancel-title-key="cancelCrop"
    running-text-key="croppingImages"
    hint-text-key="coordsHint"
    :task-title="taskTitle"
    :meta-items="metaItems"
    :result-info="resultInfo"
    :image-label="imageLabel"
  />
</template>
