<script setup lang="ts">
/**
 * search_in_files 工具的内容面板
 * 
 * 显示：
 * - 搜索结果列表（仅搜索模式）
 * - 替换结果和 diff 视图（替换模式）
 * - 匹配的文件、行号、上下文
 * - 统计信息
 */

import { computed, ref, watch } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import VirtualDiffLines from '../../common/VirtualDiffLines.vue'
import { useI18n } from '../../../composables/useI18n'
import { computeLineDiffCached, type LineDiffEntry, type LineDiffResult } from '@/utils/lineDiff'
import { useToolDiffPreviews, type ToolDiffContent as DiffContent } from '../common/useToolDiffPreviews'
import { escapeHtml } from '../../common/markdownUtils'
import { useOpenWorkspaceFile } from '../../../composables/useOpenWorkspaceFile'
import ToolResultValue from '../common/ToolResultValue.vue'

const { t } = useI18n()
const { openFileAt } = useOpenWorkspaceFile()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

// 展开状态
const expanded = ref(false)
const skippedOpen = ref(false)
const hasResult = computed(() => props.result !== undefined && props.result !== null)

// 获取搜索参数
const searchQuery = computed(() => props.args.query as string || '')
const searchPath = computed(() => props.args.path as string || '.')
const filePattern = computed(() => props.args.pattern as string || '**/*')
const isRegex = computed(() => props.args.isRegex as boolean || false)
const replacement = computed(() => props.args.replace as string | undefined)

// 是否是替换模式（严格根据 mode 字段判断，支持 replace="" 这类情况）
const isReplaceMode = computed(() => (props.args.mode as string) === 'replace')

// 搜索结果
interface SearchMatch {
  file: string
  workspace?: string
  line: number
  column: number
  match: string
  context: string
}

interface ReplaceResult {
  file: string
  workspace?: string
  replacements: number
  diffContentId?: string
  status?: 'accepted' | 'rejected' | 'pending'
  autoSaveError?: string
}

interface QueryFallbackInfo {
  applied: boolean
  originalQuery: string
  keywords: string[]
  reason?: 'whitespace_keyword_or' | 'suspected_regex'
  suggestion?: string
  signals?: string[]
}

interface PathWarningInfo {
  type: 'possible_multiple_paths'
  path: string
  candidates: string[]
  message: string
}

const resultData = computed(() => {
  const result = props.result as Record<string, any> | undefined
  return result?.data as Record<string, any> | undefined
})

// 获取搜索匹配结果
const searchResults = computed((): SearchMatch[] => {
  const result = props.result as Record<string, any> | undefined
  if (isReplaceMode.value) {
    // 替换模式下，matches 包含匹配信息
    return result?.data?.matches as SearchMatch[] || []
  } else {
    // 仅搜索模式
    return result?.data?.results as SearchMatch[] || []
  }
})

// 获取替换结果
const replaceResults = computed((): ReplaceResult[] => {
  const result = props.result as Record<string, any> | undefined
  if (isReplaceMode.value) {
    return result?.data?.results as ReplaceResult[] || []
  }
  return []
})

// 旧回执的总计可能包含已拒绝项；有逐文件审阅状态时以实际结果为准。
const hasReviewStatuses = computed(() => replaceResults.value.length > 0
  && replaceResults.value.every(result => ['accepted', 'rejected', 'pending'].includes(result.status ?? '')))
const acceptedResults = computed(() => replaceResults.value.filter(result => result.status === 'accepted'))
const filesRejected = computed(() => hasReviewStatuses.value
  ? replaceResults.value.filter(result => result.status === 'rejected').length : Number(resultData.value?.filesRejected ?? 0))
const proposedReplacements = computed(() => Number(resultData.value?.proposedReplacements
  ?? replaceResults.value.reduce((total, result) => total + result.replacements, 0)))
const skippedFiles = computed(() => Array.isArray(resultData.value?.skippedFiles) ? resultData.value.skippedFiles : [])

// 统计信息
const matchCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (isReplaceMode.value) {
    if (hasReviewStatuses.value) return acceptedResults.value.reduce((total, item) => total + item.replacements, 0)
    return result?.data?.totalReplacements as number || 0
  }
  if (result?.data?.count !== undefined) {
    return result.data.count as number
  }
  return searchResults.value.length
})

const filesModified = computed(() => {
  if (hasReviewStatuses.value) return acceptedResults.value.length
  const result = props.result as Record<string, any> | undefined
  return result?.data?.filesModified as number || 0
})

const truncated = computed(() => {
  const result = props.result as Record<string, any> | undefined
  return result?.data?.truncated as boolean || false
})

const queryFallback = computed(() => {
  return resultData.value?.queryFallback as QueryFallbackInfo | undefined
})

const pathWarning = computed(() => {
  return resultData.value?.pathWarning as PathWarningInfo | undefined
})

// 文件数量
const fileCount = computed(() => matchesByFile.value.size)

// 按文件预分组的匹配列表：模板内不再每次渲染对全量结果做 filter
const matchesByFile = computed(() => {
  const byFile = new Map<string, SearchMatch[]>()
  for (const match of searchResults.value) {
    const list = byFile.get(match.file)
    if (list) list.push(match)
    else byFile.set(match.file, [match])
  }
  return byFile
})

// 预览匹配数
const previewMatchCount = 10

// 获取显示的结果
const displayResults = computed(() => {
  if (expanded.value || searchResults.value.length <= previewMatchCount) {
    return searchResults.value
  }
  return searchResults.value.slice(0, previewMatchCount)
})

// 检查是否需要展开按钮
const needsExpand = computed(() => searchResults.value.length > previewMatchCount)

// 切换展开状态
function toggleExpand() {
  expanded.value = !expanded.value
}

// 高亮匹配文本
function highlightMatch(context: string | undefined, match: string | undefined): string {
  if (!context) return ''
  if (!match) return escapeHtml(context)
  // 在原文中划分命中片段后分别转义，保留大小写和 HTML 字符的原貌。
  const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return context.split(new RegExp(`(${escaped})`, 'gi'))
    .map((part, index) => index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join('')
}

// ============ Diff 相关 ============

const { diffContents, diffLoadErrors, viewModes, loadDiffContent, getViewMode, hasDiffContent, isLoadingDiff } = useToolDiffPreviews(
  computed(() => replaceResults.value.map(result => ({ key: result.file, diffContentId: result.diffContentId }))), 'matches')

type DisplayDiffLine = LineDiffEntry | {
  type: 'omitted'
  content: string
}

interface RenderedSearchDiff {
  content: DiffContent
  lineDiff: LineDiffResult
  contextualLines: DisplayDiffLine[]
}

// 预览 diff 行数
const previewDiffLineCount = 20
const diffContextLineCount = 1

function buildContextualDiffLines(diffLines: LineDiffEntry[]): DisplayDiffLine[] {
  const changedIndexes = diffLines
    .map((line, index) => line.type === 'added' || line.type === 'deleted' ? index : -1)
    .filter(index => index >= 0)

  if (changedIndexes.length === 0) return diffLines

  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changedIndexes) {
    const start = Math.max(0, index - diffContextLineCount)
    const end = Math.min(diffLines.length - 1, index + diffContextLineCount)
    const previous = ranges[ranges.length - 1]
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }

  const contextualLines: DisplayDiffLine[] = []
  let previousEnd = -1
  for (const range of ranges) {
    const omittedBefore = range.start - previousEnd - 1
    if (omittedBefore > 0) {
      contextualLines.push({
        type: 'omitted',
        content: t('components.tools.search.searchInFilesPanel.omittedUnchangedLines', { count: omittedBefore })
      })
    }
    contextualLines.push(...diffLines.slice(range.start, range.end + 1))
    previousEnd = range.end
  }

  const omittedAfter = diffLines.length - previousEnd - 1
  if (omittedAfter > 0) {
    contextualLines.push({
      type: 'omitted',
      content: t('components.tools.search.searchInFilesPanel.omittedUnchangedLines', { count: omittedAfter })
    })
  }
  return contextualLines
}

// 增量式 diff 结果缓存：只有新加载/变更的文件才重新计算行级差分与上下文行，
// 已计算的文件保持原结果对象引用，避免单个文件加载完成触发全部文件重复计算。
const renderedSearchDiffs = ref<Map<string, RenderedSearchDiff>>(new Map())

watch(() => new Map(diffContents.value), (contents) => {
  const next = new Map(renderedSearchDiffs.value)
  for (const [path, content] of contents) {
    const existing = next.get(path)
    if (!existing || existing.content !== content) {
      const lineDiff = computeLineDiffCached(content.originalContent, content.newContent)
      next.set(path, {
        content,
        lineDiff,
        contextualLines: buildContextualDiffLines(lineDiff.lines)
      })
    }
  }
  for (const path of Array.from(next.keys())) {
    if (!contents.has(path)) next.delete(path)
  }
  renderedSearchDiffs.value = next
}, { immediate: true })

function getRenderedSearchDiff(path: string): RenderedSearchDiff | undefined {
  return renderedSearchDiffs.value.get(path)
}

// Diff 展开状态
const expandedDiffs = ref<Set<string>>(new Set())

// 模板兜底用共享空数组（避免 key 缺失时每次渲染创建新数组引用）
const EMPTY_DISPLAY_LINES: DisplayDiffLine[] = []
const EMPTY_MATCHES: SearchMatch[] = []

// 展开/折叠展示行的稳定引用缓存：同一 path 的结果对象在展开状态或上下文行源
// （contextualLines 引用）变化前保持不变，避免模板内 slice 每次渲染生成新数组、
// 让 VirtualDiffLines 反复整体重渲染；展开/折叠任一文件时只有该 path 重建。
interface DisplayLinesEntry {
  expanded: boolean
  source: DisplayDiffLine[]
  lines: DisplayDiffLine[]
}
const displayLinesCache = new Map<string, DisplayLinesEntry>()
const displayDiffLinesByPath = computed(() => {
  const map = new Map<string, DisplayDiffLine[]>()
  for (const [path, diff] of renderedSearchDiffs.value) {
    const source = diff.contextualLines
    const isExpandedFlag = expandedDiffs.value.has(path)
    const cached = displayLinesCache.get(path)
    if (cached && cached.expanded === isExpandedFlag && cached.source === source) {
      map.set(path, cached.lines)
      continue
    }
    const lines = isExpandedFlag ? source : source.slice(0, previewDiffLineCount)
    displayLinesCache.set(path, { expanded: isExpandedFlag, source, lines })
    map.set(path, lines)
  }
  // 清理已消失的 path（renderedSearchDiffs 缩短时）；同步修剪展开集合，
  // 避免文件消失后残留的展开标记在新列表中被误用（A-L4）
  for (const key of Array.from(displayLinesCache.keys())) {
    if (!renderedSearchDiffs.value.has(key)) {
      displayLinesCache.delete(key)
      expandedDiffs.value.delete(key)
    }
  }
  return map
})

function needsDiffExpand(diff: RenderedSearchDiff): boolean {
  return diff.contextualLines.length > previewDiffLineCount
}

function getHiddenDiffLineCount(diff: RenderedSearchDiff, path: string): number {
  if (expandedDiffs.value.has(path)) return 0
  return Math.max(0, diff.contextualLines.length - previewDiffLineCount)
}

// 切换 diff 展开状态
function toggleDiffExpand(path: string) {
  if (expandedDiffs.value.has(path)) {
    expandedDiffs.value.delete(path)
  } else {
    expandedDiffs.value.add(path)
  }
}

// 检查 diff 是否已展开
function isDiffExpanded(path: string): boolean {
  return expandedDiffs.value.has(path)
}
</script>

<template>
  <div class="search-in-files-panel">
    <!-- 头部统计 -->
    <div class="panel-header">
      <div class="header-info">
        <span :class="['codicon', isReplaceMode ? 'codicon-replace-all' : 'codicon-search', 'search-icon']"></span>
        <span class="title">{{ isReplaceMode ? t('components.tools.search.searchInFilesPanel.replaceTitle') : t('components.tools.search.searchInFilesPanel.title') }}</span>
        <span v-if="isRegex" class="regex-badge">{{ t('components.tools.search.searchInFilesPanel.regex') }}</span>
      </div>
      <div v-if="hasResult" class="header-stats">
        <span v-if="isReplaceMode" class="stat" :class="{ success: matchCount > 0 }">
          <span v-if="matchCount > 0" class="codicon codicon-check"></span>
          {{ t('components.tools.search.searchInFilesPanel.replacements', { count: matchCount }) }}
        </span>
        <span v-if="isReplaceMode" class="stat">{{ t('components.tools.search.searchInFilesPanel.filesModified', { count: filesModified }) }}</span>
        <span v-else class="stat">{{ t('components.tools.search.searchInFilesPanel.matchCount', { count: matchCount }) }}</span>
        <span v-if="isReplaceMode && filesRejected" class="stat rejected-count">{{ t('components.tools.presentation.searchReplace.filesRejected', { count: filesRejected }) }}</span>
        <span v-if="isReplaceMode && proposedReplacements > matchCount" class="stat">{{ t('components.tools.presentation.searchReplace.proposed', { count: proposedReplacements }) }}</span>
        <span v-if="!isReplaceMode" class="stat">{{ t('components.tools.search.searchInFilesPanel.fileCount', { count: fileCount }) }}</span>
        <span v-if="truncated" class="stat truncated">{{ t('components.tools.search.searchInFilesPanel.truncated') }}</span>
        <span v-if="!isReplaceMode && typeof resultData?.nextOffset === 'number'" class="stat search-next-offset">{{ t('components.tools.platform.nextOffset', { offset: resultData.nextOffset }) }}</span>
      </div>
    </div>
    
    <!-- 搜索信息 -->
    <div class="search-info">
      <div class="query-row">
        <span class="label">{{ t('components.tools.search.searchInFilesPanel.keywords') }}</span>
        <code class="query-text">{{ searchQuery }}</code>
      </div>
      <div v-if="isReplaceMode && replacement !== undefined" class="replace-row">
        <span class="label">{{ t('components.tools.search.searchInFilesPanel.replaceWith') }}</span>
        <code class="replace-text">{{ replacement || t('components.tools.search.searchInFilesPanel.emptyString') }}</code>
      </div>
      <div v-if="searchPath !== '.'" class="path-row">
        <span class="label">{{ t('components.tools.search.searchInFilesPanel.path') }}</span>
        <span class="path-text">{{ searchPath }}</span>
      </div>
      <div v-if="filePattern !== '**/*'" class="pattern-row">
        <span class="label">{{ t('components.tools.search.searchInFilesPanel.pattern') }}</span>
        <span class="pattern-text">{{ filePattern }}</span>
      </div>
    </div>

    <div v-if="queryFallback || pathWarning || resultData?.continuationHint" class="diagnostic-box">
      <div v-if="resultData?.continuationHint" class="diagnostic-row info search-continuation">
        <span class="codicon codicon-info"></span><span>{{ resultData.continuationHint }}</span>
      </div>
      <div v-if="queryFallback?.reason === 'suspected_regex'" class="diagnostic-row warning">
        <span class="codicon codicon-warning"></span>
        <span>{{ queryFallback.suggestion }}</span>
      </div>
      <div v-else-if="queryFallback?.reason === 'whitespace_keyword_or'" class="diagnostic-row info">
        <span class="codicon codicon-search"></span>
        <span>
          {{ t('components.tools.presentation.searchReplace.keywordFallback') }}
          <code>{{ queryFallback.keywords.join(', ') }}</code>
        </span>
      </div>
      <div v-if="pathWarning" class="diagnostic-row warning">
        <span class="codicon codicon-warning"></span>
        <span>{{ pathWarning.message }}</span>
      </div>
    </div>
    
    <!-- 全局错误 -->
    <div v-if="error" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ error }}</span>
    </div>
    
    <p v-if="!hasResult && !error" class="search-waiting" role="status">{{ t('components.tools.structured.waiting') }}</p>
    <!-- 完成回执中的空结果 -->
    <div v-else-if="hasResult && (isReplaceMode ? replaceResults.length : searchResults.length) === 0 && !error" class="no-results">
      <span class="codicon codicon-info"></span>
      <span>{{ t('components.tools.search.searchInFilesPanel.noResults') }}</span>
    </div>
    
    <!-- 替换模式：按文件显示结果 -->
    <div v-else-if="isReplaceMode && replaceResults.length" class="replace-results">
      <div
        v-for="replaceResult in replaceResults"
        :key="replaceResult.file"
        class="replace-file-panel"
      >
        <!-- 文件头部 -->
        <div class="file-header">
          <div class="file-info">
            <span class="codicon codicon-file file-icon"></span>
            <button type="button" class="file-path file-link gc-link-button" :title="replaceResult.file" @click="openFileAt(replaceResult.file)">{{ replaceResult.file }}</button>
            <span v-if="replaceResult.status" class="replace-status" :class="replaceResult.status">{{ t(`components.tools.presentation.searchReplace.${replaceResult.status}`) }}</span>
            <span class="replace-count">{{ t('components.tools.search.searchInFilesPanel.replacementsInFile', { count: replaceResult.replacements }) }}</span>
          </div>
        </div>
        
        <p v-if="replaceResult.autoSaveError" class="replacement-save-error" role="alert">{{ replaceResult.autoSaveError }}</p>
        <!-- 视图切换按钮 -->
        <div v-if="hasDiffContent(replaceResult.file)" class="view-toggle">
          <button
            :class="['toggle-btn', { active: getViewMode(replaceResult.file) === 'matches' }]"
            @click="viewModes.set(replaceResult.file, 'matches')"
          >
            <span class="codicon codicon-list-flat"></span>
            {{ t('components.tools.search.searchInFilesPanel.viewMatches') }}
          </button>
          <button
            :class="['toggle-btn', { active: getViewMode(replaceResult.file) === 'diff' }]"
            @click="viewModes.set(replaceResult.file, 'diff')"
          >
            <span class="codicon codicon-diff"></span>
            {{ t('components.tools.search.searchInFilesPanel.viewDiff') }}
          </button>
        </div>
        
        <!-- 加载中 -->
        <div v-if="isLoadingDiff(replaceResult.file)" class="loading-diff">
          <span class="codicon codicon-loading codicon-modifier-spin"></span>
          {{ t('components.tools.search.searchInFilesPanel.loadingDiff') }}
        </div>

        <div v-else-if="diffLoadErrors.has(replaceResult.file)" class="diff-load-error" role="alert">
          <span>{{ diffLoadErrors.get(replaceResult.file) }}</span>
          <button v-if="replaceResult.diffContentId" type="button" class="gc-button gc-button--ghost" @click="loadDiffContent(replaceResult.file, replaceResult.diffContentId)">{{ t('common.retry') }}</button>
        </div>
        
        <!-- Diff 视图 -->
        <div v-else-if="getRenderedSearchDiff(replaceResult.file) && getViewMode(replaceResult.file) === 'diff'" class="diff-view">
          <div class="diff-stats-bar">
            <span class="stat deleted">
              <span class="codicon codicon-remove"></span>
              {{ getRenderedSearchDiff(replaceResult.file)!.lineDiff.deleted }}
            </span>
            <span class="stat added">
              <span class="codicon codicon-add"></span>
              {{ getRenderedSearchDiff(replaceResult.file)!.lineDiff.added }}
            </span>
          </div>
          <VirtualDiffLines
            :lines="displayDiffLinesByPath.get(replaceResult.file) || EMPTY_DISPLAY_LINES"
            :line-number-width="getRenderedSearchDiff(replaceResult.file)!.lineDiff.lineNumberWidth"
            :max-height="300"
          />
          
          <!-- 展开/收起按钮 -->
          <div v-if="needsDiffExpand(getRenderedSearchDiff(replaceResult.file)!)" class="expand-section">
            <button class="expand-btn" @click="toggleDiffExpand(replaceResult.file)">
              <span :class="['codicon', isDiffExpanded(replaceResult.file) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
              {{ isDiffExpanded(replaceResult.file) ? t('components.tools.search.searchInFilesPanel.collapse') : t('components.tools.search.searchInFilesPanel.expandRemaining', { count: getHiddenDiffLineCount(getRenderedSearchDiff(replaceResult.file)!, replaceResult.file) }) }}
            </button>
          </div>
        </div>
        
        <!-- 匹配列表视图 -->
        <div v-else class="matches-view">
          <CustomScrollbar :max-height="200">
            <div class="match-items">
              <div
                v-for="(match, index) in matchesByFile.get(replaceResult.file) || EMPTY_MATCHES"
                :key="`${match.line}-${index}`"
                class="match-item-compact"
              >
                <span class="line-info">:{{ match.line }}:{{ match.column }}</span>
                <code class="match-text">{{ match.match }}</code>
              </div>
            </div>
          </CustomScrollbar>
        </div>
      </div>
    </div>
    
    <!-- 仅搜索模式：结果列表 -->
    <div v-else-if="!isReplaceMode && searchResults.length" class="results-list">
      <CustomScrollbar :max-height="300">
        <div class="match-items">
          <div
            v-for="(match, index) in displayResults"
            :key="`${match?.file || ''}-${match?.line || 0}-${index}`"
            class="match-item"
          >
            <div class="match-header">
              <span class="codicon codicon-file file-icon"></span>
              <button type="button" class="file-path file-link gc-link-button" :title="match.file" @click="openFileAt(match.file, match.line)">{{ match.file }}</button>
              <button type="button" class="line-info file-link gc-link-button" @click="openFileAt(match.file, match.line)">:{{ match.line }}:{{ match.column }}</button>
            </div>
            <div class="match-context">
              <pre><code v-html="highlightMatch(match?.context, match?.match)"></code></pre>
            </div>
          </div>
        </div>
      </CustomScrollbar>
      
      <!-- 展开/收起按钮 -->
      <div v-if="needsExpand" class="expand-section">
        <button class="expand-btn" @click="toggleExpand">
          <span :class="['codicon', expanded ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
          {{ expanded ? t('components.tools.search.searchInFilesPanel.collapse') : t('components.tools.search.searchInFilesPanel.expandRemaining', { count: searchResults.length - previewMatchCount }) }}
        </button>
      </div>
    </div>
    <details v-if="skippedFiles.length" class="skipped-files" @toggle="skippedOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('components.tools.presentation.searchReplace.skipped', { count: skippedFiles.length }) }}</summary>
      <ToolResultValue v-if="skippedOpen" :value="skippedFiles" />
    </details>
  </div>
</template>

<style scoped>
.search-waiting{color:var(--gc-text-muted)}.file-link{cursor:pointer;text-align:left;color:var(--gc-link)}.replace-status{font-size:11px;white-space:nowrap;color:var(--gc-text-muted)}.replace-status.accepted{color:var(--gc-success)}.replace-status.rejected,.rejected-count{color:var(--gc-warning)}.replacement-save-error{color:var(--gc-danger);white-space:pre-wrap;overflow-wrap:anywhere}.skipped-files{border-top:1px solid var(--gc-border-subtle);padding-top:8px}.skipped-files>summary{cursor:pointer;color:var(--gc-text-muted);font-size:12px;margin-bottom:8px}
.diff-load-error { display: flex; align-items: center; gap: 8px; padding: 10px; color: var(--gc-danger); border-left: 2px solid currentColor; }
.diff-load-error span { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.search-in-files-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

/* 头部 */
.panel-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
  color: var(--gc-chart-orange);
  font-size: 14px;
}

.title {
  font-weight: 600;
  font-size: 12px;
  color: var(--gc-text-primary);
}

.regex-badge {
  font-size: 9px;
  padding: 1px 4px;
  background: var(--gc-badge-bg);
  color: var(--gc-badge-fg);
  border-radius: var(--gc-radius-xs);
}

.header-stats {
  display: flex;
  flex-wrap: wrap;
  max-width: 100%;
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

.stat.truncated {
  color: var(--gc-chart-yellow);
}

/* 搜索信息 */
.search-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--gc-surface-muted);
  border-radius: var(--radius-sm, 2px);
}

.query-row,
.replace-row,
.path-row,
.pattern-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  font-size: 11px;
}

.label {
  color: var(--gc-text-muted);
  flex-shrink: 0;
}

.query-text {
  font-family: var(--gc-font-code);
  font-weight: 600;
  color: var(--gc-text-primary);
  background: rgba(230, 149, 0, 0.18);
  border: 1px solid rgba(230, 149, 0, 0.35);
  padding: 0 6px;
  border-radius: var(--gc-radius-xs);
  opacity: 1;
}

.replace-text {
  font-family: var(--gc-font-code);
  font-weight: 600;
  color: var(--gc-text-primary);
  background: rgba(0, 200, 83, 0.16);
  border: 1px solid rgba(0, 200, 83, 0.35);
  padding: 0 6px;
  border-radius: var(--gc-radius-xs);
  opacity: 1;
  background: var(--gc-code-bg);
  padding: 0 4px;
  border-radius: var(--gc-radius-xs);
}

.path-text,
.pattern-text {
  font-family: var(--gc-font-code);
  color: var(--gc-text-primary);
}

.diagnostic-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--radius-sm, 2px);
  background: var(--gc-surface-muted);
}

.diagnostic-row {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-xs, 4px);
  font-size: 11px;
  line-height: 1.4;
  color: var(--gc-text-muted);
}

.diagnostic-row.warning {
  color: var(--gc-chart-yellow);
}

.diagnostic-row.info {
  color: var(--gc-text-muted);
}

.diagnostic-row code {
  color: var(--gc-text-primary);
}

/* 错误显示 */
.panel-error {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--gc-danger-bg);
  border: 1px solid var(--gc-danger-border);
  border-radius: var(--radius-sm, 2px);
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

/* 无结果 */
.no-results {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  color: var(--gc-text-muted);
  font-size: 12px;
}

/* 替换结果 */
.replace-results {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

.replace-file-panel {
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--gc-surface-muted);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.file-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  flex: 1;
  min-width: 0;
}

.file-icon {
  font-size: 12px;
  color: var(--gc-chart-blue);
  flex-shrink: 0;
}

.file-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--gc-text-primary);
  flex-shrink: 0;
}

.file-path {
  font-size: 10px;
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replace-count {
  font-size: 10px;
  color: var(--gc-success);
  margin-left: auto;
  flex-shrink: 0;
}

/* 视图切换 */
.view-toggle {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--gc-surface-muted);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.toggle-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: 2px var(--spacing-sm, 8px);
  background: transparent;
  border: none;
  font-size: 10px;
  color: var(--gc-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm, 2px);
  transition: all var(--transition-fast, 0.1s);
}

.toggle-btn:hover {
  background: var(--gc-surface-hover);
  color: var(--gc-text-primary);
}

.toggle-btn.active {
  background: var(--gc-button-primary);
  color: var(--gc-text-on-primary);
}

/* 加载中 */
.loading-diff {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  color: var(--gc-text-muted);
  font-size: 11px;
}

/* Diff 视图 */
.diff-view {
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-base);
}

.diff-stats-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: 2px var(--spacing-sm, 8px);
  background: var(--gc-surface-muted);
  border-bottom: 1px solid var(--gc-border-subtle);
}

.diff-stats-bar .stat {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
}

.diff-stats-bar .stat.deleted {
  color: var(--gc-git-deleted);
}

.diff-stats-bar .stat.added {
  color: var(--gc-git-added);
}

.diff-lines {
  display: flex;
  flex-direction: column;
  font-family: var(--gc-font-code);
  font-size: 11px;
  line-height: 1.5;
}

/* Diff 行样式 */
.diff-line {
  display: flex;
  white-space: pre;
  min-height: 1.5em;
}

.diff-line.line-unchanged {
  background: transparent;
}

.diff-line.line-deleted {
  background: rgba(255, 82, 82, 0.15);
}

.diff-line.line-added {
  background: rgba(0, 200, 83, 0.15);
}

.diff-line.line-omitted {
  background: var(--gc-surface-muted);
  color: var(--gc-text-muted);
  font-style: italic;
}

/* 行号 */
.line-nums {
  display: flex;
  flex-shrink: 0;
  padding: 0 var(--spacing-xs, 4px);
  background: rgba(128, 128, 128, 0.1);
  border-right: 1px solid var(--gc-border-subtle);
}

.old-num,
.new-num {
  min-width: 24px;
  text-align: right;
  color: var(--gc-text-disabled);
  padding: 0 2px;
}

.line-deleted .old-num {
  color: var(--gc-git-deleted);
}

.line-added .new-num {
  color: var(--gc-git-added);
}

/* 差异标记 */
.line-marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
}

.marker {
  font-weight: bold;
}

.marker.deleted {
  color: var(--gc-git-deleted);
}

.marker.added {
  color: var(--gc-git-added);
}

.marker.unchanged {
  color: transparent;
}

.marker.omitted {
  color: var(--gc-text-muted);
}

/* 行内容 */
.line-content {
  flex: 1;
  padding: 0 var(--spacing-sm, 8px);
}

/* 匹配列表视图 */
.matches-view {
  background: var(--gc-surface-base);
}

.match-items {
  display: flex;
  flex-direction: column;
}

.match-item-compact {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  border-bottom: 1px solid var(--gc-border-subtle);
  font-size: 11px;
}

.match-item-compact:last-child {
  border-bottom: none;
}

.match-item-compact .line-info {
  color: var(--gc-chart-orange);
  font-family: var(--gc-font-code);
  flex-shrink: 0;
}

.match-item-compact .match-text {
  font-family: var(--gc-font-code);
  color: var(--gc-text-primary);
  background: var(--gc-highlight-bg);
  padding: 0 4px;
  border-radius: var(--gc-radius-xs);
}

/* 结果列表 */
.results-list {
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
  /* 确保容器有最小高度，避免内容为空时高度坍塌 */
  min-height: 0;
}

/* 确保滚动容器能正确显示 */
.results-list :deep(.custom-scrollbar-wrapper) {
  height: auto !important;
  min-height: 0;
}

.results-list :deep(.scroll-container) {
  height: auto !important;
  min-height: 0;
}

.match-item {
  border-bottom: 1px solid var(--gc-border-subtle);
}

.match-item:last-child {
  border-bottom: none;
}

.match-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--gc-surface-muted);
  font-size: 11px;
}

.line-info {
  color: var(--gc-chart-orange);
  font-family: var(--gc-font-code);
  margin-left: auto;
  flex-shrink: 0;
}

.match-context {
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  background: var(--gc-surface-base);
}

.match-context pre {
  margin: 0;
  font-size: 11px;
  font-family: var(--gc-font-code);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}

.match-context code {
  font-family: inherit;
}

.match-context :deep(mark) {
  background: var(--gc-highlight-bg);
  color: inherit;
  padding: 0 2px;
  border-radius: var(--gc-radius-xs);
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
</style>
