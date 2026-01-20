<script setup lang="ts">
/**
 * generate_image 工具的内容面板
 *
 * 显示：
 * - 生成任务信息（提示词、输出路径等）
 * - 生成的图片预览
 * - 保存按钮（覆盖保存到指定路径）
 * - 终止按钮（正在生成时可以取消）
 */

import { computed, ref } from 'vue'
import { sendToExtension } from '../../../utils/vscode'
import { useChatStore } from '../../../stores/chatStore'
import { useI18n } from '../../../composables/useI18n'

const { t } = useI18n()

interface MultimodalData {
  mimeType: string
  data: string
  name?: string
}

interface ImageTask {
  prompt: string
  reference_images?: string[]
  aspect_ratio?: string
  image_size?: string
  output_path: string
}

interface ResultData {
  message?: string
  toolId?: string
  totalTasks?: number
  successCount?: number
  failedCount?: number
  totalImages?: number
  paths?: string[]
  model?: string
  details?: string[]
  success?: boolean
  cancelled?: boolean
  error?: string
}

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: 'streaming' | 'queued' | 'awaiting_approval' | 'executing' | 'awaiting_apply' | 'success' | 'error' | 'warning'
  toolId?: string
}>()

// 保存状态
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref('')

// 终止状态
const cancelling = ref(false)

// Chat store（用于取消操作）
const chatStore = useChatStore()

// 获取任务信息
const images = computed(() => props.args.images as ImageTask[] | undefined)
const singlePrompt = computed(() => props.args.prompt as string | undefined)
const singleOutputPath = computed(() => props.args.output_path as string | undefined)
const aspectRatio = computed(() => props.args.aspect_ratio as string | undefined)
const imageSize = computed(() => props.args.image_size as string | undefined)
const referenceImages = computed(() => props.args.reference_images as string[] | undefined)

// 判断模式
const isBatchMode = computed(() => images.value && Array.isArray(images.value) && images.value.length > 0)

// 获取任务列表
const taskList = computed<ImageTask[]>(() => {
  if (isBatchMode.value) {
    return images.value || []
  }
  if (singlePrompt.value && singleOutputPath.value) {
    return [{
      prompt: singlePrompt.value,
      reference_images: referenceImages.value,
      aspect_ratio: aspectRatio.value,
      image_size: imageSize.value,
      output_path: singleOutputPath.value
    }]
  }
  return []
})

// 获取结果数据
const resultData = computed<ResultData>(() => {
  if (!props.result) return {}
  const data = props.result.data as ResultData | undefined
  return data || props.result as ResultData
})

// 获取多模态数据（生成的图片）
const multimodalData = computed<MultimodalData[]>(() => {
  const result = props.result as { multimodal?: MultimodalData[] } | undefined
  return result?.multimodal || []
})

// 是否被取消
const isCancelled = computed(() => {
  // 检查结果中的 cancelled 字段
  if (resultData.value.cancelled) return true
  // 检查结果中的 success 为 false 且有 error 包含"终止"
  if (resultData.value.success === false && resultData.value.error?.includes('终止')) return true
  return false
})

// 是否正在运行
const isRunning = computed(() => {
  if (props.error) return false
  if (isCancelled.value) return false
  if (
    props.status === 'streaming' ||
    props.status === 'queued' ||
    props.status === 'awaiting_approval' ||
    props.status === 'executing'
  ) return true
  return false
})

// 状态标签
const statusLabel = computed(() => {
  if (isCancelled.value) return t('components.tools.media.generateImagePanel.status.cancelled')
  if (props.error) return t('components.tools.media.generateImagePanel.status.failed')
  if (props.status === 'success') return t('components.tools.media.generateImagePanel.status.success')
  if (props.status === 'error') return t('components.tools.media.generateImagePanel.status.error')
  if (isRunning.value) return t('components.tools.media.generateImagePanel.status.generating')
  return t('components.tools.media.generateImagePanel.status.waiting')
})

// 状态类名
const statusClass = computed(() => {
  if (isCancelled.value) return 'cancelled'
  if (props.error || props.status === 'error') return 'error'
  if (props.status === 'success') return 'success'
  if (isRunning.value) return 'running'
  return 'pending'
})

// 保存图片到指定路径
async function saveImage(imageData: MultimodalData, outputPath: string) {
  saving.value = true
  saveSuccess.value = false
  saveError.value = ''
  
  try {
    const result = await sendToExtension('saveImageToPath', {
      data: imageData.data,
      mimeType: imageData.mimeType,
      path: outputPath
    }) as { success: boolean; error?: string }
    
    if (result.success) {
      saveSuccess.value = true
      setTimeout(() => {
        saveSuccess.value = false
      }, 2000)
    } else {
      saveError.value = result.error || t('components.tools.media.generateImagePanel.saveFailed')
    }
  } catch (err: any) {
    saveError.value = err.message || t('components.tools.media.generateImagePanel.saveFailed')
  } finally {
    saving.value = false
  }
}

// 在 VSCode 中打开图片
async function openImageInVSCode(path: string) {
  try {
    await sendToExtension('openWorkspaceFile', { path })
  } catch (err) {
    console.error(t('components.tools.media.generateImagePanel.openFileFailed'), err)
  }
}

// 截断文本
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 获取有效的 toolId（优先使用结果中的，其次使用 props 中的）
const effectiveToolId = computed(() => {
  return resultData.value.toolId || props.toolId
})

// 终止图像生成
async function handleCancel() {
  if (cancelling.value) return
  
  const toolId = effectiveToolId.value
  
  cancelling.value = true
  
  try {
    if (toolId) {
      // 使用更精确的取消方式：取消特定的图像生成任务
      const result = await sendToExtension('imageGeneration.cancel', { toolId }) as {
        success: boolean
        error?: string
      }
      
      if (!result.success) {
        console.warn('取消图像生成失败:', result.error)
        // 如果特定任务取消失败，回退到取消整个对话流
        await chatStore.cancelStream()
      }
    } else {
      // 没有 toolId，回退到取消整个对话流
      await chatStore.cancelStream()
    }
  } catch (err) {
    console.error('取消图像生成失败:', err)
    // 作为最后的回退，尝试取消整个对话流
    try {
      await chatStore.cancelStream()
    } catch {
      // 忽略错误
    }
  } finally {
    cancelling.value = false
  }
}
</script>

<template>
  <div class="generate-image-panel">
    <!-- 头部信息 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-file-media tool-icon"></span>
        <span class="title">{{ t('components.tools.media.generateImagePanel.title') }}</span>
        <span :class="['status-badge', statusClass]">{{ statusLabel }}</span>
      </div>
      <div class="header-actions">
        <span v-if="resultData.model" class="model-info">
          {{ resultData.model }}
        </span>
        <button
          v-if="isRunning"
          class="action-btn cancel-btn"
          :disabled="cancelling"
          :title="t('components.tools.media.generateImagePanel.cancelGeneration')"
          @click="handleCancel"
        >
          <span class="codicon codicon-debug-stop"></span>
          <span class="btn-text">{{ t('components.tools.media.generateImagePanel.cancel') }}</span>
        </button>
      </div>
    </div>
    
    <!-- 任务信息 -->
    <div class="tasks-section">
      <div class="section-header">
        <span class="codicon codicon-list-unordered"></span>
        <span class="section-title">{{ isBatchMode ? t('components.tools.media.generateImagePanel.batchTasks', { count: taskList.length }) : t('components.tools.media.generateImagePanel.generateTask') }}</span>
      </div>
      
      <div class="task-list">
        <div
          v-for="(task, index) in taskList"
          :key="index"
          class="task-item"
        >
          <div class="task-header">
            <span v-if="isBatchMode" class="task-index">{{ index + 1 }}</span>
            <span class="task-prompt">{{ truncateText(task.prompt, 80) }}</span>
          </div>
          <div class="task-meta">
            <span class="meta-item">
              <span class="codicon codicon-file"></span>
              <span class="meta-value">{{ task.output_path }}</span>
            </span>
            <span v-if="task.aspect_ratio" class="meta-item">
              <span class="codicon codicon-screen-normal"></span>
              <span class="meta-value">{{ task.aspect_ratio }}</span>
            </span>
            <span v-if="task.image_size" class="meta-item">
              <span class="codicon codicon-symbol-ruler"></span>
              <span class="meta-value">{{ task.image_size }}</span>
            </span>
            <span v-if="task.reference_images && task.reference_images.length > 0" class="meta-item">
              <span class="codicon codicon-references"></span>
              <span class="meta-value">{{ t('components.tools.media.generateImagePanel.referenceImages', { count: task.reference_images.length }) }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 取消信息 -->
    <div v-if="isCancelled" class="panel-cancelled">
      <span class="codicon codicon-debug-stop cancelled-icon"></span>
      <span class="cancelled-text">{{ resultData.error || t('components.tools.media.generateImagePanel.cancelledMessage') }}</span>
    </div>
    
    <!-- 错误信息 -->
    <div v-else-if="props.error || resultData.failedCount" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ props.error || t('components.tools.media.generateImagePanel.tasksFailed', { count: resultData.failedCount }) }}</span>
    </div>
    
    <!-- 生成结果 -->
    <div v-if="multimodalData.length > 0" class="result-section">
      <div class="section-header">
        <span class="codicon codicon-preview"></span>
        <span class="section-title">{{ t('components.tools.media.generateImagePanel.resultTitle', { count: multimodalData.length }) }}</span>
      </div>
      
      <div class="image-grid">
        <div
          v-for="(img, index) in multimodalData"
          :key="index"
          class="image-card"
        >
          <div class="image-wrapper">
            <img
              :src="`data:${img.mimeType};base64,${img.data}`"
              :alt="img.name || `Generated image ${index + 1}`"
              class="generated-image"
            />
          </div>
          <div class="image-info">
            <span class="image-name">{{ img.name || `image_${index + 1}` }}</span>
            <div class="image-actions">
              <button
                v-if="resultData.paths && resultData.paths[index]"
                class="action-btn"
                :disabled="saving"
                :title="saveSuccess ? t('components.tools.media.generateImagePanel.saved') : t('components.tools.media.generateImagePanel.overwriteSave')"
                @click="saveImage(img, resultData.paths![index])"
              >
                <span :class="['codicon', saveSuccess ? 'codicon-check' : 'codicon-save']"></span>
                <span class="btn-text">{{ saveSuccess ? t('components.tools.media.generateImagePanel.saved') : t('components.tools.media.generateImagePanel.save') }}</span>
              </button>
              <button
                v-if="resultData.paths && resultData.paths[index]"
                class="action-btn"
                :title="t('components.tools.media.generateImagePanel.openInEditor')"
                @click="openImageInVSCode(resultData.paths![index])"
              >
                <span class="codicon codicon-go-to-file"></span>
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <div v-if="saveError" class="save-error">
        <span class="codicon codicon-error"></span>
        <span>{{ saveError }}</span>
      </div>
    </div>
    
    <!-- 结果摘要（无图片时显示） -->
    <div v-else-if="resultData.message && !isRunning" class="result-summary">
      <div class="summary-message">{{ resultData.message }}</div>
      <div v-if="resultData.paths && resultData.paths.length > 0" class="paths-list">
        <div class="paths-header">{{ t('components.tools.media.generateImagePanel.savePaths') }}</div>
        <div v-for="p in resultData.paths" :key="p" class="path-item">
          <span class="codicon codicon-file-media"></span>
          <span
            class="path-text clickable"
            @click="openImageInVSCode(p)"
          >{{ p }}</span>
        </div>
      </div>
    </div>
    
    <!-- 运行中指示器 -->
    <div v-if="isRunning" class="running-indicator">
      <span class="spinner"></span>
      <span>{{ t('components.tools.media.generateImagePanel.generatingImages') }}</span>
    </div>
  </div>
</template>

<style scoped>
.generate-image-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

/* 头部 */
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-xs, 4px) 0;
}

.header-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
}

.tool-icon {
  color: var(--vscode-charts-purple);
  font-size: 14px;
}

.title {
  font-weight: 600;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.status-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.status-badge.success {
  background: var(--vscode-testing-iconPassed);
  color: var(--vscode-editor-background);
}

.status-badge.error {
  background: var(--vscode-testing-iconFailed);
  color: var(--vscode-editor-background);
}

.status-badge.running {
  background: var(--vscode-charts-blue);
  color: var(--vscode-editor-background);
}

.status-badge.pending {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.status-badge.cancelled {
  background: var(--vscode-charts-orange);
  color: var(--vscode-editor-background);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.model-info {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
}

/* 区块样式 */
.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  margin-bottom: var(--spacing-xs, 4px);
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.section-header .codicon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 任务列表 */
.tasks-section {
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
}

.task-item {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
}

.task-header {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-xs, 4px);
}

.task-index {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-charts-purple);
  color: var(--vscode-editor-background);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
}

.task-prompt {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
}

.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm, 8px);
  margin-top: var(--spacing-xs, 4px);
  padding-left: 22px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

.meta-item .codicon {
  font-size: 10px;
}

/* 错误显示 */
.panel-error {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: var(--radius-sm, 2px);
}

.error-icon {
  color: var(--vscode-inputValidation-errorForeground);
  font-size: 14px;
  flex-shrink: 0;
}

.error-text {
  font-size: 12px;
  color: var(--vscode-inputValidation-errorForeground);
  line-height: 1.4;
}

/* 取消显示 */
.panel-cancelled {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: var(--radius-sm, 2px);
}

.cancelled-icon {
  color: var(--vscode-charts-orange);
  font-size: 14px;
  flex-shrink: 0;
}

.cancelled-text {
  font-size: 12px;
  color: var(--vscode-inputValidation-warningForeground);
  line-height: 1.4;
}

/* 结果区域 */
.result-section {
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--spacing-sm, 8px);
  margin-top: var(--spacing-sm, 8px);
}

.image-card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
}

.image-wrapper {
  position: relative;
  width: 100%;
  padding-top: 100%; /* 1:1 aspect ratio */
  background: var(--vscode-editor-inactiveSelectionBackground);
}

.generated-image {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.image-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px);
  border-top: 1px solid var(--vscode-panel-border);
}

.image-name {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.image-actions {
  display: flex;
  gap: var(--spacing-xs, 4px);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: transparent;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: var(--radius-sm, 2px);
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 10px;
  transition: all var(--transition-fast, 0.1s);
}

.action-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel-btn {
  color: var(--vscode-testing-iconFailed);
  border-color: var(--vscode-testing-iconFailed);
}

.cancel-btn:hover:not(:disabled) {
  background: var(--vscode-testing-iconFailed);
  color: var(--vscode-editor-background);
}

.btn-text {
  white-space: nowrap;
}

.save-error {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  margin-top: var(--spacing-sm, 8px);
  padding: var(--spacing-xs, 4px);
  background: var(--vscode-inputValidation-errorBackground);
  border-radius: var(--radius-sm, 2px);
  font-size: 10px;
  color: var(--vscode-inputValidation-errorForeground);
}

/* 结果摘要 */
.result-summary {
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
}

.summary-message {
  font-size: 11px;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  line-height: 1.5;
}

.paths-list {
  margin-top: var(--spacing-sm, 8px);
}

.paths-header {
  font-size: 10px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  margin-bottom: var(--spacing-xs, 4px);
}

.path-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 0;
}

.path-item .codicon {
  font-size: 12px;
  color: var(--vscode-charts-purple);
}

.path-text.clickable {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
}

.path-text.clickable:hover {
  color: var(--vscode-textLink-foreground);
}

/* 运行中指示器 */
.running-indicator {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: var(--radius-sm, 2px);
  color: var(--vscode-foreground);
  font-size: 11px;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--vscode-charts-purple);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>