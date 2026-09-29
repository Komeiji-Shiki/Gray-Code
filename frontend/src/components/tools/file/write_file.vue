<script setup lang="ts">
import { useWriteFilePlans } from './useWriteFilePlans'
/**
 * write_file 工具的内容面板
 *
 * 支持批量写入，每个文件一个小面板显示
 * 显示：
 * - 文件名（标题）
 * - 文件路径（副标题）
 * - 写入的内容（带行号）或 diff 对比视图
 */

import { computed, ref, onBeforeUnmount, watch } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import VirtualDiffLines from '../../common/VirtualDiffLines.vue'
import { MarkdownRenderer } from '../../common'
import ChannelSelector from '../../input/ChannelSelector.vue'
import ModelSelector from '../../input/ModelSelector.vue'
import { useI18n, useOpenWorkspaceFile } from '@/composables'
import { showNotification } from '@/utils/vscode'
import { useToolDiffPreviews, type ToolDiffContent as DiffContent } from '../common/useToolDiffPreviews'
import { extractPreviewText, isPlanDocPath } from '../../../utils/taskCards'
import { copyToClipboard } from '@/utils/format'
import { computeLineDiffCached, type LineDiffEntry, type LineDiffResult } from '@/utils/lineDiff'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

const { t } = useI18n()
const { openFile } = useOpenWorkspaceFile()

const { channelOptions, selectedChannelId, selectedModelId, modelOptions, isLoadingChannels, isLoadingModels, isExecutingPlan, togglePlanExpand, isPlanExpanded, executePlan } = useWriteFilePlans()

// 每个文件的展开状态
const expandedFiles = ref<Set<string>>(new Set())

// 复制状态（按文件路径）
const copiedFiles = ref<Set<string>>(new Set())
const copyTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

// 单个文件写入配置
interface WriteFileEntry {
  path: string
  content: string
}

// 单个文件写入结果
interface WriteResult {
  path: string
  success: boolean
  action?: 'created' | 'modified' | 'unchanged'
  status?: string
  error?: string
  diffContentId?: string
}

// 获取文件列表（从参数中）
// 兼容批量格式 (files 数组) 和单文件格式 (path + content)
const fileList = computed((): WriteFileEntry[] => {
  const files = props.args.files as WriteFileEntry[] | undefined
  if (files && Array.isArray(files) && files.length > 0) {
    return files
  }
  // 回退到单文件参数格式
  const singlePath = props.args.path as string | undefined
  const singleContent = props.args.content as string | undefined
  if (singlePath) {
    return [{ path: singlePath, content: singleContent || '' }]
  }
  return []
})

// 获取写入结果列表（从结果中）
const writeResults = computed((): WriteResult[] => {
  const result = props.result as Record<string, any> | undefined

  // 批量结果
  if (Array.isArray(result?.data?.results)) {
    return result.data.results as WriteResult[]
  }
  return []
})

// 合并文件列表和结果，方便显示
interface MergedFile {
  path: string
  content: string
  result: WriteResult | undefined
}

const mergedFiles = computed((): MergedFile[] => {
  return fileList.value.map(entry => {
    const result = writeResults.value.find(r => r.path === entry.path)
    return {
      path: entry.path,
      content: entry.content,
      result
    }
  })
})

// 计划文档预览（.graycode/plans/**/*.md）
const planFiles = computed((): MergedFile[] => mergedFiles.value.filter(f => isPlanDocPath(f.path)))

function getPlanCardStatus(file: MergedFile): 'pending' | 'running' | 'success' | 'error' {
  if (props.error) return 'error'
  // 还没收到 tool result：视为 running
  if (!props.result) return 'running'
  if (file.result && file.result.success === false) return 'error'
  return 'success'
}

const { diffContents, diffLoadErrors, viewModes, loadDiffContent, getViewMode, hasDiffContent, isLoadingDiff } = useToolDiffPreviews(
  computed(() => writeResults.value.map(result => ({ key: result.path, diffContentId: result.diffContentId }))), 'content')

// 总文件数统计
const successCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.successCount !== undefined) {
    return result.data.successCount as number
  }
  return writeResults.value.filter(r => r.success).length
})

const failCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.failCount !== undefined) {
    return result.data.failCount as number
  }
  return writeResults.value.filter(r => !r.success).length
})

// 预览行数
const previewLineCount = 15

// 获取文件名
function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

// 获取文件扩展名（不含点号）
function getFileExtension(filePath: string): string {
  const fileName = getFileName(filePath)
  const lastDotIndex = fileName.lastIndexOf('.')
  if (lastDotIndex > 0) {
    return fileName.substring(lastDotIndex + 1)
  }
  return ''
}

// 获取不含扩展名的文件名
function getFileNameWithoutExt(filePath: string): string {
  const fileName = getFileName(filePath)
  const lastDotIndex = fileName.lastIndexOf('.')
  if (lastDotIndex > 0) {
    return fileName.substring(0, lastDotIndex)
  }
  return fileName
}

// 获取内容行数组
function getContentLines(content: string | undefined): string[] {
  return content ? content.split('\n') : []
}

// 获取显示的内容（带行号）
function getDisplayContent(file: MergedFile): string {
  if (!file.content) return ''
  const lines = getContentLines(file.content)
  const maxLineNum = lines.length
  const padWidth = String(maxLineNum).length

  const displayLines = isFileExpanded(file.path) || lines.length <= previewLineCount
    ? lines
    : lines.slice(0, previewLineCount)

  return displayLines.map((line, index) =>
    `${String(index + 1).padStart(padWidth)} | ${line}`
  ).join('\n')
}

// 检查是否需要展开按钮
function needsExpand(file: MergedFile): boolean {
  const lines = getContentLines(file.content)
  return lines.length > previewLineCount
}

// 切换文件展开状态
function toggleFile(path: string) {
  if (expandedFiles.value.has(path)) {
    expandedFiles.value.delete(path)
  } else {
    expandedFiles.value.add(path)
  }
}

// 检查文件是否展开
function isFileExpanded(path: string): boolean {
  return expandedFiles.value.has(path)
}

// 检查是否已复制
function isCopied(path: string): boolean {
  return copiedFiles.value.has(path)
}

// 复制单个文件内容
async function copyFileContent(file: MergedFile) {
  if (!file.content) return

  const ok = await copyToClipboard(file.content)
  if (!ok) {
    await showNotification(t('common.copyFailed'), 'error')
    return
  }

  // 显示对钩状态
  copiedFiles.value.add(file.path)

  // 清除之前的定时器
  const existingTimeout = copyTimeouts.get(file.path)
  if (existingTimeout) {
    clearTimeout(existingTimeout)
  }

  // 1秒后恢复
  const timeout = setTimeout(() => {
    copiedFiles.value.delete(file.path)
    copyTimeouts.delete(file.path)
  }, 1000)
  copyTimeouts.set(file.path, timeout)
}

// 获取操作图标
function getActionIcon(action?: string): string {
  switch (action) {
    case 'created':
      return 'codicon-new-file'
    case 'modified':
      return 'codicon-edit'
    case 'unchanged':
      return 'codicon-file'
    default:
      return 'codicon-save'
  }
}

// 获取操作标签
function getActionLabel(action?: string): string {
  switch (action) {
    case 'created':
      return t('components.tools.file.writeFilePanel.actions.created')
    case 'modified':
      return t('components.tools.file.writeFilePanel.actions.modified')
    case 'unchanged':
      return t('components.tools.file.writeFilePanel.actions.unchanged')
    default:
      return t('components.tools.file.writeFilePanel.actions.write')
  }
}

// ============ Diff 对比相关 ============

interface RenderedFileDiff {
  content: DiffContent
  lineDiff: LineDiffResult
}

// 增量式 diff 结果缓存：只有新加载/变更的文件才重新计算行级差分，
// 已计算的文件保持原结果对象引用，避免单个文件加载完成触发全部文件重复计算。
const renderedFileDiffs = ref<Map<string, RenderedFileDiff>>(new Map())

watch(() => new Map(diffContents.value), (contents) => {
  const next = new Map(renderedFileDiffs.value)
  for (const [path, content] of contents) {
    const existing = next.get(path)
    if (!existing || existing.content !== content) {
      next.set(path, {
        content,
        lineDiff: computeLineDiffCached(content.originalContent, content.newContent)
      })
    }
  }
  for (const path of Array.from(next.keys())) {
    if (!contents.has(path)) next.delete(path)
  }
  renderedFileDiffs.value = next
}, { immediate: true })

function getRenderedFileDiff(path: string): RenderedFileDiff | undefined {
  return renderedFileDiffs.value.get(path)
}

// 预览 diff 行数
const previewDiffLineCount = 20

// 模板兜底用共享空数组（避免 key 缺失时每次渲染创建新数组引用）
const EMPTY_DISPLAY_LINES: LineDiffEntry[] = []

// 展开/折叠展示行的稳定引用缓存（同 apply_diff 面板）：
// 同一 path 的结果对象在展开状态或行差分源（lineDiff 引用）变化前保持不变，
// 展开/折叠任一文件时只有该 path 重建，其余文件的折叠 slice 复用缓存对象。
interface DisplayLinesEntry {
  expanded: boolean
  source: LineDiffResult
  lines: LineDiffEntry[]
}
const displayLinesCache = new Map<string, DisplayLinesEntry>()
const displayDiffLinesByPath = computed(() => {
  const map = new Map<string, LineDiffEntry[]>()
  for (const [path, diff] of renderedFileDiffs.value) {
    const source = diff.lineDiff
    const isExpandedFlag = isDiffExpanded(path)
    const cached = displayLinesCache.get(path)
    if (cached && cached.expanded === isExpandedFlag && cached.source === source) {
      map.set(path, cached.lines)
      continue
    }
    const lines = isExpandedFlag ? source.lines : source.lines.slice(0, previewDiffLineCount)
    displayLinesCache.set(path, { expanded: isExpandedFlag, source, lines })
    map.set(path, lines)
  }
  // 清理已消失的 path（renderedFileDiffs 缩短时）；同步修剪 diff 展开集合，
  // 避免文件消失后残留的展开标记在新列表中被误用（A-L4）
  for (const key of Array.from(displayLinesCache.keys())) {
    if (!renderedFileDiffs.value.has(key)) {
      displayLinesCache.delete(key)
      expandedFiles.value.delete(key + '_diff')
    }
  }
  return map
})

function needsDiffExpand(diff: RenderedFileDiff): boolean {
  return diff.lineDiff.lines.length > previewDiffLineCount
}

// 切换 diff 展开状态
function toggleDiffExpand(path: string) {
  const key = path + '_diff'
  if (expandedFiles.value.has(key)) {
    expandedFiles.value.delete(key)
  } else {
    expandedFiles.value.add(key)
  }
}

// 检查 diff 是否已展开
function isDiffExpanded(path: string): boolean {
  return expandedFiles.value.has(path + '_diff')
}

// 清理定时器
onBeforeUnmount(() => {
  for (const timeout of copyTimeouts.values()) {
    clearTimeout(timeout)
  }
  copyTimeouts.clear()
})
</script>

<template>
  <div class="write-file-panel">
    <!-- 总体统计头部 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-save files-icon"></span>
        <span class="title">{{ t('components.tools.file.writeFilePanel.title') }}</span>
      </div>
      <div class="header-stats">
        <span v-if="successCount > 0" class="stat success">
          <span class="codicon codicon-check"></span>
          {{ successCount }}
        </span>
        <span v-if="failCount > 0" class="stat error">
          <span class="codicon codicon-error"></span>
          {{ failCount }}
        </span>
        <span class="stat total">{{ t('components.tools.file.writeFilePanel.total', { count: mergedFiles.length }) }}</span>
      </div>
    </div>

    <!-- Plan 预览面板（仅当写入 .graycode/plans/**.md 时展示） -->
    <div v-if="planFiles.length > 0" class="plan-preview-section">
      <div v-for="file in planFiles" :key="file.path" class="plan-panel">
        <!-- Plan 头部 -->
        <div class="plan-header">
          <div class="plan-info">
            <span class="codicon codicon-list-unordered plan-icon"></span>
            <span class="plan-title">Plan</span>
            <span v-if="getPlanCardStatus(file) === 'success'" class="plan-status success">
              <span class="codicon codicon-check"></span>
            </span>
            <span v-else-if="getPlanCardStatus(file) === 'running'" class="plan-status running">
              <span class="codicon codicon-loading codicon-modifier-spin"></span>
            </span>
            <span v-else-if="getPlanCardStatus(file) === 'error'" class="plan-status error">
              <span class="codicon codicon-error"></span>
            </span>
          </div>
          <div class="plan-actions">
            <button
              class="action-btn"
              :title="isPlanExpanded(file.path) ? t('common.collapse') : t('common.expand')"
              @click="togglePlanExpand(file.path)"
            >
              <span :class="['codicon', isPlanExpanded(file.path) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
            </button>
          </div>
        </div>

        <!-- Plan 路径 -->
        <div class="plan-path">{{ file.path }}</div>

        <!-- Plan 预览内容 -->
        <div class="plan-content">
          <CustomScrollbar :max-height="isPlanExpanded(file.path) ? 500 : 200">
            <div class="plan-preview">
              <MarkdownRenderer :content="isPlanExpanded(file.path) ? file.content : extractPreviewText(file.content, { maxLines: 12, maxChars: 1600 })" render-profile="artifactSafe" />
            </div>
          </CustomScrollbar>
        </div>

        <!-- Plan 执行区域 -->
        <div class="plan-execute">
          <div class="execute-selector">
            <span class="execute-label">{{ t('components.message.tool.planCard.executeLabel') }}</span>
            <ChannelSelector
              v-model="selectedChannelId"
              :options="channelOptions"
              :disabled="isLoadingChannels || isExecutingPlan"
              class="channel-select"
            />
            <ModelSelector
              v-model="selectedModelId"
              :models="modelOptions"
              :disabled="isLoadingChannels || isLoadingModels || isExecutingPlan || !selectedChannelId"
              class="model-select"
            />
          </div>
          <button
            class="execute-btn"
            :disabled="isExecutingPlan || !selectedChannelId || !selectedModelId"
            @click="executePlan(file.content, file.path)"
          >
            <span v-if="isExecutingPlan" class="codicon codicon-loading codicon-modifier-spin"></span>
            <span v-else class="codicon codicon-play"></span>
            <span class="btn-text">{{ isExecutingPlan ? t('components.message.tool.planCard.executing') : t('components.message.tool.planCard.executePlan') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 全局错误 -->
    <div v-if="error && writeResults.length === 0" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ error }}</span>
    </div>

    <!-- 文件列表 -->
    <div v-else class="file-list">
      <div
        v-for="file in mergedFiles"
        :key="file.path"
        :class="['file-panel', { 'is-error': file.result && !file.result.success }]"
      >
        <!-- 文件头部 -->
        <div class="file-header">
          <div class="file-info">
            <span :class="[
              'file-icon',
              'codicon',
              file.result?.success === false ? 'codicon-error' : getActionIcon(file.result?.action)
            ]"></span>
            <button type="button" class="file-name clickable gc-link-button" :title="file.path" @click.stop="openFile(file.path)">{{ getFileNameWithoutExt(file.path) }}</button>
            <button v-if="getFileExtension(file.path)" type="button" class="file-ext clickable gc-link-button" :title="file.path" @click.stop="openFile(file.path)">.{{ getFileExtension(file.path) }}</button>
            <span v-if="file.result?.action" :class="['action-badge', file.result.action]">
              {{ getActionLabel(file.result.action) }}
            </span>
            <span v-if="getContentLines(file.content).length" class="line-count">
              {{ t('components.tools.file.writeFilePanel.lines', { count: getContentLines(file.content).length }) }}
            </span>
          </div>
          <div class="file-actions">
            <button
              v-if="file.content"
              type="button"
              class="action-btn"
              :class="{ 'copied': isCopied(file.path) }"
              :title="isCopied(file.path) ? t('components.tools.file.writeFilePanel.copied') : t('components.tools.file.writeFilePanel.copyContent')"
              :aria-label="isCopied(file.path) ? t('components.tools.file.writeFilePanel.copied') : t('components.tools.file.writeFilePanel.copyContent')"
              @click.stop="copyFileContent(file)"
            >
              <span :class="['codicon', isCopied(file.path) ? 'codicon-check' : 'codicon-copy']"></span>
            </button>
          </div>
        </div>

        <!-- 文件路径 -->
        <button type="button" class="file-path clickable gc-link-button" :title="file.path" @click.stop="openFile(file.path)">{{ file.path }}</button>

        <!-- 错误信息 -->
        <div v-if="file.result && !file.result.success && file.result.error" class="file-error">
          {{ file.result.error }}
        </div>

        <!-- 视图切换按钮 -->
        <div v-if="hasDiffContent(file.path)" class="view-toggle">
          <button
            :class="['toggle-btn', { active: getViewMode(file.path) === 'content' }]"
            @click="viewModes.set(file.path, 'content')"
          >
            <span class="codicon codicon-file-code"></span>
            {{ t('components.tools.file.writeFilePanel.viewContent') }}
          </button>
          <button
            :class="['toggle-btn', { active: getViewMode(file.path) === 'diff' }]"
            @click="viewModes.set(file.path, 'diff')"
          >
            <span class="codicon codicon-diff"></span>
            {{ t('components.tools.file.writeFilePanel.viewDiff') }}
          </button>
        </div>

        <!-- 加载中 -->
        <div v-if="isLoadingDiff(file.path)" class="loading-diff">
          <span class="codicon codicon-loading codicon-modifier-spin"></span>
          {{ t('components.tools.file.writeFilePanel.loadingDiff') }}
        </div>

        <div v-else-if="diffLoadErrors.has(file.path)" class="diff-load-error" role="alert">
          <span>{{ diffLoadErrors.get(file.path) }}</span>
          <button v-if="file.result?.diffContentId" type="button" class="gc-button gc-button--ghost" @click="loadDiffContent(file.path, file.result.diffContentId)">{{ t('common.retry') }}</button>
        </div>

        <!-- Diff 视图 -->
        <div v-else-if="getRenderedFileDiff(file.path) && getViewMode(file.path) === 'diff'" class="diff-view">
          <div class="diff-stats-bar">
            <span class="stat deleted">
              <span class="codicon codicon-remove"></span>
              {{ getRenderedFileDiff(file.path)!.lineDiff.deleted }}
            </span>
            <span class="stat added">
              <span class="codicon codicon-add"></span>
              {{ getRenderedFileDiff(file.path)!.lineDiff.added }}
            </span>
          </div>
          <VirtualDiffLines
            :lines="displayDiffLinesByPath.get(file.path) || EMPTY_DISPLAY_LINES"
            :line-number-width="getRenderedFileDiff(file.path)!.lineDiff.lineNumberWidth"
            :max-height="300"
          />

          <!-- 展开/收起按钮 -->
          <div v-if="needsDiffExpand(getRenderedFileDiff(file.path)!)" class="expand-section">
            <button class="expand-btn" @click="toggleDiffExpand(file.path)">
              <span :class="['codicon', isDiffExpanded(file.path) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
              {{ isDiffExpanded(file.path) ? t('components.tools.file.writeFilePanel.collapse') : t('components.tools.file.writeFilePanel.expandRemaining', { count: getRenderedFileDiff(file.path)!.lineDiff.lines.length - previewDiffLineCount }) }}
            </button>
          </div>
        </div>

        <!-- 原内容视图 -->
        <div v-else-if="file.content" class="file-content" :class="{ 'expanded': isFileExpanded(file.path) }">
          <div class="content-wrapper">
            <CustomScrollbar :horizontal="true">
              <pre class="content-code"><code>{{ getDisplayContent(file) }}</code></pre>
            </CustomScrollbar>
          </div>

          <!-- 展开/收起按钮 -->
          <div v-if="needsExpand(file)" class="expand-section">
            <button class="expand-btn" @click="toggleFile(file.path)">
              <span :class="['codicon', isFileExpanded(file.path) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
              {{ isFileExpanded(file.path) ? t('components.tools.file.writeFilePanel.collapse') : t('components.tools.file.writeFilePanel.expandRemaining', { count: getContentLines(file.content).length - previewLineCount }) }}
            </button>
          </div>
        </div>

        <!-- 空文件 -->
        <div v-else class="file-empty">
          <span class="codicon codicon-file"></span>
          <span>{{ t('components.tools.file.writeFilePanel.noContent') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./write_file.css"></style>
