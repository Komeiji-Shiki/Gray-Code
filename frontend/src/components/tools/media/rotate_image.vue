<script setup lang="ts">
/**
 * rotate_image 工具的内容面板
 *
 * 基于 MediaToolPanel 骨架，仅提供旋转工具特有的任务解析与展示配置。
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

interface RotateTask {
  image_path: string
  output_path: string
  angle: number
  format?: string
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
const NS = 'components.tools.media.rotateImagePanel'

// 任务解析
const images = computed(() => props.args.images as RotateTask[] | undefined)
const isBatchMode = computed(() => !!(images.value && Array.isArray(images.value) && images.value.length > 0))

const taskList = computed<RotateTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  const imagePath = props.args.image_path as string | undefined
  const outputPath = props.args.output_path as string | undefined
  const angle = props.args.angle as number | undefined
  if (imagePath && outputPath && angle !== undefined) {
    return [{
      image_path: imagePath,
      output_path: outputPath,
      angle,
      format: props.args.format as string | undefined
    }]
  }
  return []
})

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 格式化角度
function formatAngle(angle: number): string {
  const direction = angle >= 0
    ? t(`${NS}.angleFormat.counterclockwise`)
    : t(`${NS}.angleFormat.clockwise`)
  return `${Math.abs(angle)}° ${direction}`
}

const taskTitle = (task: RotateTask) => truncateText(task.image_path, 25)

const metaItems = (task: RotateTask): MediaMetaItem[] => {
  const items: MediaMetaItem[] = [
    { icon: 'codicon-sync', text: formatAngle(task.angle), accentColor: 'var(--vscode-charts-green)' }
  ]
  if (task.format) {
    items.push({ icon: 'codicon-file-media', text: task.format.toUpperCase() })
  }
  items.push({ icon: 'codicon-arrow-right', text: truncateText(task.output_path, 20) })
  return items
}

const resultInfo = (result: MediaToolResultData): MediaInfoSegment[] | null => {
  const original = result.originalDimensions as Dimensions | undefined
  const rotated = result.rotatedDimensions as Dimensions | undefined
  if (!original || !rotated) return null
  return [
    { label: t(`${NS}.dimensions.rotation`) },
    { value: `${result.angle}°` },
    { arrow: true },
    { label: t(`${NS}.dimensions.size`) },
    { value: `${original.width}×${original.height}` },
    { arrow: true },
    { value: `${rotated.width}×${rotated.height}` }
  ]
}

const imageLabel = (img: MultimodalData, index: number) =>
  img.name || t(`${NS}.rotateResultN`, { n: index + 1 })
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
    icon="codicon-sync"
    running-badge-color="var(--vscode-charts-green)"
    :dependencies="['sharp']"
    batch-title-key="batchRotate"
    single-title-key="rotateTask"
    cancel-title-key="cancelRotate"
    running-text-key="rotatingImages"
    hint-text-key="angleHint"
    :task-title="taskTitle"
    :meta-items="metaItems"
    :result-info="resultInfo"
    :image-label="imageLabel"
  />
</template>
