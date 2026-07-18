<script setup lang="ts" generic="T">
/**
 * 媒体工具面板骨架组件
 *
 * 承载五个媒体工具（crop/resize/rotate/remove_background/generate_image）
 * 完全一致的面板结构、状态机与样式：
 * - 头部（图标、标题、状态徽章、取消按钮）
 * - 依赖检查与缺失警告（可选）
 * - 任务列表（标题 + meta 行 + 提示行）
 * - 取消 / 错误状态块
 * - 结果图片网格（保存 / 在编辑器中打开）
 * - 结果摘要与运行中指示器
 *
 * 各工具的差异通过配置 props（taskTitle/metaItems/resultInfo/imageLabel 等）
 * 与 pre-status 插槽表达，i18n 文案统一从 ns 命名空间读取。
 */

import { computed, ref } from 'vue'
import { sendToExtension } from '../../../utils/vscode'
import { useChatStore } from '../../../stores/chatStore'
import { useDependency } from '../../../composables/useDependency'
import { useI18n } from '../../../composables/useI18n'
import { DependencyWarning } from '../../common'
import type {
  MultimodalData,
  MediaToolStatus,
  MediaToolResultData,
  MediaMetaItem,
  MediaInfoSegment,
  MediaStatusOverride
} from './mediaToolTypes'

const props = defineProps<{
  // ===== 工具运行时数据 =====
  result?: Record<string, unknown>
  error?: string
  status?: MediaToolStatus
  toolId?: string
  /** 已解析的任务列表（由薄壳组件从 args 构造） */
  tasks: T[]
  /** 是否批量模式（影响任务序号与标题文案） */
  isBatch: boolean

  // ===== 面板配置 =====
  /** i18n 命名空间前缀，例如 'components.tools.media.rotateImagePanel' */
  ns: string
  /** 工具图标 codicon 类名 */
  icon: string
  /** 主题强调色（图标/序号/加载圈/路径图标），默认绿色 */
  accentColor?: string
  /** running 状态徽章底色，默认蓝色 */
  runningBadgeColor?: string
  /** 需要检查的依赖列表；不传则跳过依赖检查区块 */
  dependencies?: string[]

  // ===== i18n 子键（相对 ns） =====
  batchTitleKey: string
  singleTitleKey: string
  cancelTitleKey: string
  runningTextKey: string
  /** running 状态徽章文案键，默认 'status.processing' */
  processingStatusKey?: string
  /** 任务区底部提示行文案键；不传则不渲染提示行 */
  hintTextKey?: string

  // ===== 取消行为 =====
  /** 取消请求通道，默认 'task.cancel' */
  cancelChannel?: string
  /** 取消请求载荷中工具 id 的字段名，默认 'taskId' */
  cancelIdField?: string

  // ===== 差异化渲染 =====
  /** 状态徽章覆盖（如 needsSharp 的 warning 态） */
  statusOverride?: MediaStatusOverride | null
  /** 为 true 时隐藏取消/错误状态块（如 needsSharp 警告显示时） */
  suppressStatusBlocks?: boolean
  /** 任务标题文本 */
  taskTitle: (task: T) => string
  /** 任务标题使用普通字体（默认等宽字体，适合路径） */
  plainTaskTitle?: boolean
  /** 任务 meta 行条目 */
  metaItems?: (task: T) => MediaMetaItem[]
  /** 结果信息行（如尺寸变化）；返回 null 时不渲染 */
  resultInfo?: (result: MediaToolResultData) => MediaInfoSegment[] | null
  /** 结果图片标签；默认 img.name */
  imageLabel?: (img: MultimodalData, index: number) => string
  /** 结果图片容器附加类名（如透明棋盘格背景） */
  imageWrapperClass?: (img: MultimodalData) => string | undefined
  /** 头部附加文本（如生成所用模型名） */
  headerExtra?: (result: MediaToolResultData) => string | undefined
}>()

const { t } = useI18n()

/** 从工具命名空间读取文案 */
function tk(key: string, params?: Record<string, unknown>): string {
  return t(`${props.ns}.${key}`, params)
}

// 保存状态
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref('')

// 终止状态
const cancelling = ref(false)

// Chat store（取消回退用）
const chatStore = useChatStore()

// 依赖检查（无依赖的工具跳过自动检查）
const depsEnabled = computed(() => (props.dependencies?.length ?? 0) > 0)
const {
  allInstalled,
  loading: checkingDependency,
  missingDependencies
} = useDependency({
  dependencies: props.dependencies ?? [],
  autoCheck: (props.dependencies?.length ?? 0) > 0
})

// 主题色 CSS 变量
const cssVars = computed(() => ({
  '--media-accent': props.accentColor ?? 'var(--vscode-charts-green)',
  '--media-running-badge': props.runningBadgeColor ?? 'var(--vscode-charts-blue)'
}))

// 获取结果数据
const resultData = computed<MediaToolResultData>(() => {
  if (!props.result) return {}
  const data = props.result.data as MediaToolResultData | undefined
  return data || (props.result as MediaToolResultData)
})

// 获取多模态数据（处理/生成后的图片）
const multimodalData = computed<MultimodalData[]>(() => {
  const result = props.result as { multimodal?: MultimodalData[] } | undefined
  return result?.multimodal || []
})

// 是否失败
const isFailed = computed(() => {
  if (props.result && 'success' in props.result && props.result.success === false) {
    return true
  }
  return false
})

// 获取错误信息
const errorMessage = computed(() => {
  if (props.error) return props.error
  if (props.result && 'error' in props.result && typeof props.result.error === 'string') {
    return props.result.error
  }
  if (resultData.value.error) return resultData.value.error
  return ''
})

// 是否被取消
const isCancelled = computed(() => {
  if (resultData.value.cancelled) return true
  if (isFailed.value && errorMessage.value?.includes('终止')) return true
  return false
})

// 是否正在运行
const isRunning = computed(() => {
  if (props.error) return false
  if (isFailed.value) return false
  if (isCancelled.value) return false
  if (
    props.status === 'streaming' ||
    props.status === 'queued' ||
    props.status === 'awaiting_approval' ||
    props.status === 'executing'
  ) return true
  return false
})

// 工具是否可用（依赖已安装或无依赖要求）
const isToolAvailable = computed(() => !depsEnabled.value || allInstalled.value)

// 状态标签
const statusLabel = computed(() => {
  if (depsEnabled.value && !isToolAvailable.value && !checkingDependency.value) return tk('status.needDependency')
  if (isCancelled.value) return tk('status.cancelled')
  if (props.statusOverride) return props.statusOverride.label
  if (isFailed.value || props.error) return tk('status.failed')
  if (props.status === 'success') return tk('status.success')
  if (props.status === 'error') return tk('status.error')
  if (isRunning.value) return tk(props.processingStatusKey ?? 'status.processing')
  return tk('status.waiting')
})

// 状态类名
const statusClass = computed(() => {
  if (depsEnabled.value && !isToolAvailable.value && !checkingDependency.value) return 'disabled'
  if (isCancelled.value) return 'cancelled'
  if (props.statusOverride) return props.statusOverride.badgeClass
  if (isFailed.value || props.error || props.status === 'error') return 'error'
  if (props.status === 'success') return 'success'
  if (isRunning.value) return 'running'
  return 'pending'
})

// 错误状态块（部分任务失败时也提示）
const showErrorBlock = computed(() => {
  return isFailed.value || !!props.error || (resultData.value.failedCount ?? 0) > 0
})

const errorBlockText = computed(() => {
  return errorMessage.value || tk('tasksFailed', { count: resultData.value.failedCount })
})

// 结果信息行
const resultInfoSegments = computed<MediaInfoSegment[] | null>(() => {
  if (!props.resultInfo) return null
  return props.resultInfo(resultData.value)
})

// 头部附加文本
const headerExtraText = computed(() => props.headerExtra?.(resultData.value))

// 结果图片标签
function resolvedImageLabel(img: MultimodalData, index: number): string {
  if (props.imageLabel) return props.imageLabel(img, index)
  return img.name || `image ${index + 1}`
}

// 构造图片 data URI
function imageSrc(img: MultimodalData): string {
  return 'data:' + img.mimeType + ';base64,' + img.data
}

// 保存图片到指定路径
async function saveImage(imageData: MultimodalData, path: string) {
  saving.value = true
  saveSuccess.value = false
  saveError.value = ''

  try {
    const payload: Record<string, unknown> = { path }
    payload.data = imageData.data
    payload.mimeType = imageData.mimeType
    const result = await sendToExtension('saveImageToPath', payload) as { success: boolean; error?: string }

    if (result.success) {
      saveSuccess.value = true
      setTimeout(() => {
        saveSuccess.value = false
      }, 2000)
    } else {
      saveError.value = result.error || tk('saveFailed')
    }
  } catch (err: any) {
    saveError.value = err.message || tk('saveFailed')
  } finally {
    saving.value = false
  }
}

// 在 VSCode 中打开图片
async function openImageInVSCode(path: string) {
  try {
    await sendToExtension('openWorkspaceFile', { path })
  } catch (err) {
    console.error('打开文件失败:', err)
  }
}

// 获取有效的 toolId（优先使用结果中的）
const effectiveToolId = computed(() => {
  return resultData.value.toolId || props.toolId
})

// 终止任务
async function handleCancel() {
  if (cancelling.value) return

  const toolId = effectiveToolId.value
  cancelling.value = true

  try {
    if (toolId) {
      const channel = props.cancelChannel ?? 'task.cancel'
      const idField = props.cancelIdField ?? 'taskId'
      const result = await sendToExtension(channel, { [idField]: toolId }) as {
        success: boolean
        error?: string
      }

      if (!result.success) {
        console.warn('取消任务失败:', result.error)
        await chatStore.cancelStream()
      }
    } else {
      await chatStore.cancelStream()
    }
  } catch (err) {
    console.error('取消任务失败:', err)
    try {
      await chatStore.cancelStream()
    } catch {
      // 忽略
    }
  } finally {
    cancelling.value = false
  }
}

// 获取结果图片对应的输出路径
function getImagePath(index: number): string | undefined {
  if (resultData.value.paths && resultData.value.paths[index]) {
    return resultData.value.paths[index]
  }
  return undefined
}
</script>

<template>
  <div class="media-tool-panel" :style="cssVars">
    <!-- 头部信息 -->
    <div class="panel-header">
      <div class="header-info">
        <span :class="['codicon', icon, 'tool-icon']"></span>
        <span class="title">{{ tk('title') }}</span>
        <span :class="['status-badge', statusClass]">{{ statusLabel }}</span>
      </div>
      <div class="header-actions">
        <span v-if="headerExtraText" class="header-extra">{{ headerExtraText }}</span>
        <button
          v-if="isRunning"
          class="action-btn cancel-btn"
          :disabled="cancelling"
          :title="tk(cancelTitleKey)"
          @click="handleCancel"
        >
          <span class="codicon codicon-debug-stop"></span>
          <span class="btn-text">{{ tk('cancel') }}</span>
        </button>
      </div>
    </div>

    <!-- 依赖检查与缺失警告 -->
    <template v-if="depsEnabled">
      <div v-if="checkingDependency" class="dependency-check">
        <span class="spinner"></span>
        <span>{{ tk('checkingDependency') }}</span>
      </div>

      <DependencyWarning
        v-else-if="!allInstalled"
        :dependencies="missingDependencies"
        :message="tk('dependencyMessage')"
      />
    </template>

    <!-- 任务信息 -->
    <div class="tasks-section">
      <div class="section-header">
        <span class="codicon codicon-list-unordered"></span>
        <span class="section-title">{{ isBatch ? tk(batchTitleKey, { count: tasks.length }) : tk(singleTitleKey) }}</span>
      </div>

      <div class="task-list">
        <div
          v-for="(task, index) in tasks"
          :key="index"
          class="task-item"
        >
          <div class="task-header">
            <span v-if="isBatch" class="task-index">{{ index + 1 }}</span>
            <span :class="['task-paths', { plain: plainTaskTitle }]">{{ taskTitle(task) }}</span>
          </div>
          <div v-if="metaItems" class="task-meta">
            <span
              v-for="(item, mi) in metaItems(task)"
              :key="mi"
              class="meta-item"
              :class="{ accent: !!item.accentColor }"
              :style="item.accentColor ? { color: item.accentColor } : undefined"
            >
              <span :class="['codicon', item.icon]"></span>
              <span class="meta-value">{{ item.text }}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 提示说明 -->
      <div v-if="hintTextKey" class="tasks-hint">
        <span class="codicon codicon-info"></span>
        <span>{{ tk(hintTextKey) }}</span>
      </div>
    </div>

    <!-- 工具特有的前置状态块（如 needsSharp 警告） -->
    <slot name="pre-status" :result-data="resultData"></slot>

    <!-- 取消信息 -->
    <div v-if="!suppressStatusBlocks && isCancelled" class="panel-cancelled">
      <span class="codicon codicon-debug-stop cancelled-icon"></span>
      <span class="cancelled-text">{{ resultData.error || tk('cancelledMessage') }}</span>
    </div>

    <!-- 错误信息 -->
    <div v-else-if="!suppressStatusBlocks && showErrorBlock" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ errorBlockText }}</span>
    </div>

    <!-- 处理/生成结果 -->
    <div v-if="multimodalData.length > 0" class="result-section">
      <div class="section-header">
        <span class="codicon codicon-preview"></span>
        <span class="section-title">{{ tk('resultTitle', { count: multimodalData.length }) }}</span>
      </div>

      <!-- 结果信息行（如尺寸变化） -->
      <div v-if="resultInfoSegments && resultInfoSegments.length > 0" class="dimensions-info">
        <template v-for="(seg, si) in resultInfoSegments" :key="si">
          <span v-if="seg.arrow" class="codicon codicon-arrow-right dim-arrow"></span>
          <span v-else-if="seg.label" class="dim-label">{{ seg.label }}</span>
          <span v-else class="dim-value">{{ seg.value }}</span>
        </template>
      </div>

      <div class="image-grid">
        <div
          v-for="(img, index) in multimodalData"
          :key="index"
          class="image-card"
        >
          <div class="image-wrapper" :class="imageWrapperClass?.(img)">
            <img
              :src="imageSrc(img)"
              :alt="img.name || `image ${index + 1}`"
              class="result-image"
            />
          </div>
          <div class="image-info">
            <span class="image-label">{{ resolvedImageLabel(img, index) }}</span>
            <div class="image-actions">
              <button
                v-if="getImagePath(index)"
                class="action-btn"
                :disabled="saving"
                :title="saveSuccess ? tk('saved') : tk('overwriteSave')"
                @click="saveImage(img, getImagePath(index)!)"
              >
                <span :class="['codicon', saveSuccess ? 'codicon-check' : 'codicon-save']"></span>
                <span class="btn-text">{{ saveSuccess ? tk('saved') : tk('save') }}</span>
              </button>
              <button
                v-if="getImagePath(index)"
                class="action-btn"
                :title="tk('openInEditor')"
                @click="openImageInVSCode(getImagePath(index)!)"
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
        <div class="paths-header">{{ tk('savePaths') }}</div>
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
      <span>{{ tk(runningTextKey) }}</span>
    </div>
  </div>
</template>

<style scoped>
.media-tool-panel {
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
  color: var(--media-accent);
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

.status-badge.warning {
  background: var(--vscode-charts-orange);
  color: var(--vscode-editor-background);
}

.status-badge.running {
  background: var(--media-running-badge);
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

.status-badge.disabled {
  background: var(--vscode-disabledForeground);
  color: var(--vscode-editor-background);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.header-extra {
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
  background: var(--media-accent);
  color: var(--vscode-editor-background);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
}

.task-paths {
  font-size: 11px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family);
}

.task-paths.plain {
  font-family: inherit;
}

.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm, 8px);
  margin-top: var(--spacing-xs, 4px);
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

.meta-item.accent {
  font-weight: 500;
}

/* 任务提示行 */
.tasks-hint {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  margin-top: var(--spacing-sm, 8px);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

.tasks-hint .codicon {
  font-size: 10px;
  opacity: 0.8;
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

.dimensions-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  margin-bottom: var(--spacing-sm, 8px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--vscode-editor-background);
  border-radius: var(--radius-sm, 2px);
  font-size: 11px;
  flex-wrap: wrap;
}

.dim-label {
  color: var(--vscode-descriptionForeground);
}

.dim-value {
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
  font-weight: 500;
}

.dim-arrow {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin: 0 var(--spacing-xs, 4px);
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--spacing-sm, 8px);
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
  padding-top: 100%;
  background: var(--vscode-editor-inactiveSelectionBackground);
}

/* 透明背景棋盘格图案（抠图结果用） */
.image-wrapper.transparent-bg {
  background-image:
    linear-gradient(45deg, #808080 25%, transparent 25%),
    linear-gradient(-45deg, #808080 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #808080 75%),
    linear-gradient(-45deg, transparent 75%, #808080 75%);
  background-size: 10px 10px;
  background-position: 0 0, 0 5px, 5px -5px, -5px 0px;
  background-color: #a0a0a0;
}

.result-image {
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

.image-label {
  font-size: 10px;
  font-weight: 500;
  color: var(--vscode-foreground);
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
  color: var(--media-accent);
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
  border: 2px solid var(--media-accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 依赖检查 */
.dependency-check {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: var(--radius-sm, 2px);
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
</style>
