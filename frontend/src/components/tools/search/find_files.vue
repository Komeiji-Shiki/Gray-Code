<script setup lang="ts">
/**
 * find_files 工具的内容面板
 * 
 * 显示：
 * - 每个模式的查找结果
 * - 找到的文件列表
 * - 统计信息
 */

import { computed, ref } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import { useI18n } from '../../../composables/useI18n'

const { t } = useI18n()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

// 每个模式的展开状态
const expandedPatterns = ref<Set<string>>(new Set())

// 获取模式列表
const patternList = computed(() => {
  if (props.args.patterns && Array.isArray(props.args.patterns)) {
    return props.args.patterns as string[]
  }
  if (props.args.pattern && typeof props.args.pattern === 'string') {
    return [props.args.pattern]
  }
  return []
})

interface FoundFileDetail {
  path: string
  lineCount?: number
}

// 单个模式的查找结果
interface FindResult {
  pattern: string
  success?: boolean
  files?: string[]
  fileDetails?: FoundFileDetail[]
  count?: number
  truncated?: boolean
  offset?: number
  nextOffset?: number
  partial?: boolean
  workspaceErrors?: { workspace: string; error: string }[]
  continuationHint?: string
  error?: string
}

interface FindFilesData extends Partial<FindResult> {
  results?: FindResult[]
  totalFiles?: number
  effectiveExclude?: string
  excludeSource?: string
}

const resultData = computed(() => props.result?.data as FindFilesData | undefined)
const resultError = computed(() => props.error || (typeof props.result?.error === 'string' ? props.result.error : ''))
const effectiveExclude = computed(() => resultData.value?.effectiveExclude)
const excludeSource = computed(() => {
  const source = resultData.value?.excludeSource
  return ['argument', 'settings', 'fallback', 'includeIgnored'].includes(source || '') ? source : 'unknown'
})

// 批量结果逐项保留状态；旧单项结果也必须带回行数和失败信息，不能仅因存在 files 就判为成功。
const findResults = computed((): FindResult[] => {
  const data = resultData.value
  if (Array.isArray(data?.results)) return data.results
  if (Array.isArray(data?.files) || Array.isArray(data?.fileDetails)) {
    return [{
      ...data,
      pattern: data.pattern || patternList.value[0] || '',
      success: data.success ?? props.result?.success !== false,
      error: data.error || resultError.value
    }]
  }
  // 执行前只有参数不是「搜索成功且无匹配」；仅在收到失败回执时显示失败占位。
  return patternList.value.map(pattern => ({
    pattern,
    success: resultError.value || props.result?.success === false ? false : undefined,
    error: resultError.value
  }))
})

function isIncomplete(result: FindResult): boolean {
  return result.success === false || result.partial === true || !!result.error || !!result.workspaceErrors?.length
}

function isPartial(result: FindResult): boolean {
  return result.partial === true || (isIncomplete(result) && getFileDetails(result).length > 0)
}

function fileCount(result: FindResult): number {
  return result.count ?? getFileDetails(result).length
}

function hasOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// 不能让旧汇总或显式 partial 把失败模式涂成成功；其他成功模式仍独立计数。
const successCount = computed(() => findResults.value.filter(result => result.success === true && !isIncomplete(result)).length)
const failCount = computed(() => findResults.value.filter(isIncomplete).length)
const totalFiles = computed(() => resultData.value?.totalFiles ?? findResults.value.reduce((sum, result) => sum + fileCount(result), 0))
const globalError = computed(() => resultError.value || (props.result?.success === false ? t('components.tools.failed') : ''))

// 预览文件数
const previewFileCount = 10

// 切换模式展开状态
function togglePattern(pattern: string) {
  if (expandedPatterns.value.has(pattern)) {
    expandedPatterns.value.delete(pattern)
  } else {
    expandedPatterns.value.add(pattern)
  }
}

// 检查模式是否展开
function isPatternExpanded(pattern: string): boolean {
  return expandedPatterns.value.has(pattern)
}

function getFileDetails(result: FindResult): FoundFileDetail[] {
  if (Array.isArray(result.fileDetails) && result.fileDetails.length > 0) {
    return result.fileDetails
  }
  return (result.files || []).map(path => ({ path }))
}

// 获取显示的文件列表
function getDisplayFiles(result: FindResult): FoundFileDetail[] {
  const files = getFileDetails(result)
  if (isPatternExpanded(result.pattern) || files.length <= previewFileCount) {
    return files
  }
  return files.slice(0, previewFileCount)
}

// 检查是否需要展开按钮
function needsExpand(result: FindResult): boolean {
  return getFileDetails(result).length > previewFileCount
}

// 获取文件名
function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

// 获取文件夹路径
function getDirPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  parts.pop()
  return parts.join('/')
}

function formatLineCount(file: FoundFileDetail): string {
  return typeof file.lineCount === 'number'
    ? t('components.tools.search.findFilesPanel.lines', { count: file.lineCount })
    : ''
}
</script>

<template>
  <div class="find-files-panel">
    <!-- 头部统计 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-search search-icon"></span>
        <span class="title">{{ t('components.tools.search.findFilesPanel.title') }}</span>
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
        <span class="stat total">{{ t('components.tools.presentation.findFiles.returnedFiles', { count: totalFiles }) }}</span>
      </div>
    </div>
    
    <!-- 只展示回执中的实际排除策略，不用调用参数反推设置或默认值。 -->
    <div v-if="effectiveExclude !== undefined || resultData?.excludeSource" class="exclusion-policy">
      <span>{{ t('components.tools.presentation.findFiles.exclusions') }}</span>
      <span class="exclude-source">{{ t(`components.tools.presentation.findFiles.excludeSources.${excludeSource}`) }}</span>
      <code v-if="effectiveExclude !== undefined" class="effective-exclude">{{ effectiveExclude }}</code>
    </div>

    <div v-if="globalError && !findResults.some(isIncomplete)" class="panel-error" role="alert">
      <span class="codicon codicon-error error-icon" aria-hidden="true"></span>
      <span class="error-text">{{ globalError }}</span>
    </div>

    <!-- 结果列表 -->
    <div class="results-list">
      <div
        v-for="result in findResults"
        :key="result.pattern"
        :class="['pattern-panel', { 'is-error': isIncomplete(result) }]"
      >
        <!-- 模式头部 -->
        <div class="pattern-header">
          <div class="pattern-info">
            <span :class="[
              'pattern-icon',
              'codicon',
              isIncomplete(result) ? 'codicon-error' : 'codicon-file-submodule'
            ]"></span>
            <span class="pattern-text">{{ result.pattern }}</span>
            <span v-if="result.count !== undefined || getFileDetails(result).length" class="file-count">{{ t(hasOffset(result.offset) ? 'components.tools.presentation.findFiles.pageFiles' : 'components.tools.search.findFilesPanel.fileCount', { count: fileCount(result) }) }}</span>
            <span v-if="isPartial(result)" class="partial-badge">{{ t('components.tools.platform.partial') }}</span>
            <span v-else-if="result.truncated" class="truncated-badge">{{ t('components.tools.search.findFilesPanel.truncated') }}</span>
          </div>
        </div>
        
        <!-- 错误信息 -->
        <div v-if="isIncomplete(result)" class="pattern-error" role="alert">
          <p>{{ result.error || t('components.tools.failed') }}</p>
          <ul v-if="result.workspaceErrors?.length" class="workspace-errors" :aria-label="t('components.tools.presentation.findFiles.workspaceErrors')">
            <li v-for="(failure, index) in result.workspaceErrors" :key="index">
              <strong>{{ failure.workspace }}</strong>: {{ failure.error }}
            </li>
          </ul>
        </div>

        <!-- offset 是工具续查位置，不是下面预览十项的本地展开；失败页绝不提供下一页承诺。 -->
        <div v-if="hasOffset(result.offset) || hasOffset(result.nextOffset) || result.continuationHint || isIncomplete(result)" class="pagination-info">
          <span v-if="hasOffset(result.offset)" class="page-offset">{{ t('components.tools.presentation.findFiles.pageOffset', { offset: result.offset }) }}</span>
          <span v-if="isIncomplete(result)" class="restart-hint">{{ t('components.tools.presentation.findFiles.restartAfterFailure') }}</span>
          <span v-else-if="hasOffset(result.nextOffset)" class="next-offset">{{ t('components.tools.presentation.findFiles.nextPage', { offset: result.nextOffset }) }}</span>
          <details v-if="result.continuationHint" class="continuation-details">
            <summary>{{ t('components.tools.presentation.findFiles.continuationDetails') }}</summary>
            <p>{{ result.continuationHint }}</p>
          </details>
        </div>

        <!-- 多根搜索可能同时返回错误和可用文件，二者不能再使用互斥分支。 -->
        <div v-if="getFileDetails(result).length > 0" class="file-list">
          <CustomScrollbar :max-height="200">
            <div class="file-items">
              <div
                v-for="file in getDisplayFiles(result)"
                :key="file.path"
                class="file-item"
              >
                <span class="codicon codicon-file file-icon"></span>
                <span class="file-name">{{ getFileName(file.path) }}</span>
                <span class="file-dir">{{ getDirPath(file.path) }}</span>
                <span v-if="formatLineCount(file)" class="line-count-badge">{{ formatLineCount(file) }}</span>
              </div>
            </div>
          </CustomScrollbar>
          
          <!-- 展开/收起按钮 -->
          <div v-if="needsExpand(result)" class="expand-section">
            <button type="button" class="expand-btn" :aria-expanded="isPatternExpanded(result.pattern)" @click="togglePattern(result.pattern)">
              <span :class="['codicon', isPatternExpanded(result.pattern) ? 'codicon-chevron-up' : 'codicon-chevron-down']" aria-hidden="true"></span>
              {{ isPatternExpanded(result.pattern) ? t('components.tools.search.findFilesPanel.collapse') : t('components.tools.presentation.findFiles.expandPage', { count: getFileDetails(result).length - previewFileCount }) }}
            </button>
          </div>
        </div>
        
        <!-- 无结果 -->
        <div v-else-if="result.success === true && !isIncomplete(result)" class="no-files">
          <span class="codicon codicon-info"></span>
          <span>{{ t('components.tools.search.findFilesPanel.noFiles') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.find-files-panel {
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

.search-icon {
  color: var(--gc-chart-blue);
  font-size: 14px;
}

.title {
  font-weight: 600;
  font-size: 12px;
  color: var(--gc-text-primary);
}

.header-stats {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

.stat {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--gc-text-muted);
}

.stat.success {
  color: var(--gc-success);
}

.stat.error {
  color: var(--gc-danger);
}

/* 全局错误 */
.panel-error {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--gc-danger-bg);
  border: 1px solid var(--gc-danger-border);
  border-radius: 0;
}

.error-icon {
  color: var(--gc-danger);
  font-size: 14px;
  flex-shrink: 0;
}

.error-text {
  font-size: 12px;
  color: var(--gc-danger);
  line-height: 1.4;
}

/* 结果列表 */
.results-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

/* 单个模式面板 */
.pattern-panel {
  border: 1px solid var(--gc-border-subtle);
  border-radius: 0;
  overflow: hidden;
}

.pattern-panel.is-error {
  border-color: var(--gc-danger-border);
}

/* 模式头部 */
.pattern-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--gc-surface-muted);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.pattern-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  flex: 1;
  min-width: 0;
}

.pattern-icon {
  font-size: 12px;
  color: var(--gc-chart-blue);
  flex-shrink: 0;
}

.pattern-panel.is-error .pattern-icon {
  color: var(--gc-danger);
}

.pattern-text {
  font-size: 11px;
  font-family: var(--gc-font-code);
  color: var(--gc-text-primary);
}

.file-count {
  font-size: 10px;
  color: var(--gc-text-muted);
  margin-left: auto;
  flex-shrink: 0;
}

.truncated-badge,
.partial-badge {
  font-size: 9px;
  padding: 1px 4px;
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
  border-radius: 0;
  margin-left: var(--spacing-xs, 4px);
}

.partial-badge {
  color: var(--gc-danger);
  background: var(--gc-danger-bg);
}

.exclusion-policy,
.pagination-info {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  font-size: 11px;
  line-height: 1.6;
  color: var(--gc-text-muted);
  min-width: 0;
}

.exclusion-policy {
  border-left: 2px solid var(--gc-border-subtle);
}

.exclude-source,
.next-offset {
  color: var(--gc-text-primary);
}

.effective-exclude {
  flex-basis: 100%;
  font-family: var(--gc-font-code);
  overflow-wrap: anywhere;
}

.continuation-details {
  flex-basis: 100%;
  min-width: 0;
}

.continuation-details > summary {
  cursor: pointer;
}

.continuation-details p,
.pattern-error p {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.workspace-errors {
  margin: 4px 0 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}

/* 模式错误 */
.pattern-error {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--gc-danger);
  background: var(--gc-danger-bg);
}

/* 文件列表 */
.file-list {
  background: var(--gc-surface-base);
}

.file-items {
  display: flex;
  flex-direction: column;
}

.file-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: 2px var(--spacing-sm, 8px);
  font-size: 11px;
  border-bottom: 1px solid var(--gc-border-subtle);
  min-width: 0;
}

.file-item:last-child {
  border-bottom: none;
}

.file-icon {
  font-size: 12px;
  color: var(--gc-chart-blue);
  flex-shrink: 0;
}

.file-name {
  font-weight: 500;
  color: var(--gc-text-primary);
  flex-shrink: 0;
}

.file-dir {
  font-size: 10px;
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.line-count-badge {
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 0;
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
}

/* 展开区域 */
.expand-section {
  display: flex;
  justify-content: center;
  padding: 2px;
  background: var(--gc-surface-muted);
  border-top: 1px solid var(--gc-border-subtle);
}

.expand-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: 2px var(--spacing-sm, 8px);
  background: transparent;
  border: none;
  font-size: 10px;
  color: var(--gc-link);
  cursor: pointer;
  transition: opacity var(--transition-fast, 0.1s);
}

.expand-btn:hover {
  opacity: 0.8;
}

.expand-btn:focus-visible,
.continuation-details > summary:focus-visible {
  outline: 1px solid var(--gc-focus-border);
  outline-offset: 2px;
}

/* 无结果 */
.no-files {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  color: var(--gc-text-muted);
  font-size: 11px;
}
</style>