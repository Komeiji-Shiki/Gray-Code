<script setup lang="ts">
import { parseUnifiedPatchToDiffBlocks, type DiffBlock } from './diffBlocks'
/**
 * apply_diff 工具的内容面板
 *
 * 显示差异对比：
 * - 被删除的代码（红色背景）
 * - 新增的代码（绿色背景）
 * - 每个 diff 块独立显示
 */

import { computed, ref, watch, onBeforeUnmount } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import VirtualDiffLines from '../../common/VirtualDiffLines.vue'
import { useI18n, useOpenWorkspaceFile } from '@/composables'
import { computeLineDiffCached, type LineDiffEntry, type LineDiffResult } from '@/utils/lineDiff'
import { copyToClipboard } from '@/utils/format'
import { showNotification } from '@/utils/vscode'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  toolId?: string
}>()

const { t } = useI18n()
const { openFile } = useOpenWorkspaceFile()

// 展开状态
const expanded = ref<Set<number>>(new Set())

// 复制状态
const copiedDiffs = ref<Set<number>>(new Set())
const copyTimeouts = new Map<number, ReturnType<typeof setTimeout>>()

// 单个 diff 块
// 获取文件路径
const filePath = computed(() => {
  return (props.args.path as string) || ''
})

// 获取 diff 列表
// - 新格式：优先读取 args.patch（unified diff）并按 hunk 转换为可展示的 DiffBlock
// - 旧格式：兼容 args.diffs
const diffList = computed((): DiffBlock[] => {
  const rawRejectedIndices = resultData.value?.rejectedBlockIndices
  const rejectedIndices = new Set<number>(
    Array.isArray(rawRejectedIndices)
      ? rawRejectedIndices.filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
      : []
  )

  // 结构化 hunks（推荐新格式）
  const hunks = props.args.hunks as Array<{ oldContent: string; newContent: string; startLine?: number }> | undefined
  if (hunks && Array.isArray(hunks) && hunks.length > 0) {
    const data = props.result?.data as Record<string, any> | undefined
    const results = (data?.results as Array<{ index: number; success?: boolean; error?: string; startLine?: number; matchKind?: string }> | undefined) || []

    return hunks.map((h, i) => {
      const r = results.find(x => x.index === i)
      return {
        search: h.oldContent,
        replace: h.newContent,
        start_line: h.startLine,
        success: r?.success,
        error: r?.error,
        rejected: rejectedIndices.has(i)
      }
    })
  }


  const patch = props.args.patch as string | undefined
  if (patch && typeof patch === 'string' && patch.trim()) {
    const blocks = parseUnifiedPatchToDiffBlocks(patch)
    const data = props.result?.data as Record<string, any> | undefined
    const results = (data?.results as Array<{ index: number; success?: boolean; error?: string; startLine?: number }> | undefined) || []

    // 将后端 best-effort 的逐 hunk 结果叠加到展示块上
    return blocks.map((b, i) => {
      const r = results.find(x => x.index === i)
      if (!r) {
        return { ...b, rejected: rejectedIndices.has(i) }
      }
      return {
        ...b,
        success: r.success,
        error: r.error,
        // 统一使用后端返回的 startLine（更接近真实应用位置）；没有则退回参数
        start_line: (r.startLine as any) ?? b.start_line,
        rejected: rejectedIndices.has(i)
      }
    })
  }

  const argsDiffs = (props.args.diffs as DiffBlock[] | undefined) || []
  const failedDiffs = (props.result?.data as Record<string, any>)?.failedDiffs as any[] | undefined

  // 向后兼容旧格式（带有 results 或 diffs 的情况）
  const data = props.result?.data as Record<string, any> | undefined
  if (data?.results || data?.diffs) {
    const results = data.results || data.diffs
    return argsDiffs.map((diff, i) => {
      const res = results.find((r: any) => r.index === i) || {}
      return {
        ...diff,
        success: res.success,
        error: res.error,
        // 不要默认填充为 1：start_line 仅在“参数中提供/后端返回匹配行号”时才展示
        start_line: res.matchedLine ?? res.start_line ?? diff.start_line,
        rejected: rejectedIndices.has(i)
      }
    })
  }

  // 新格式：仅使用 failedDiffs 判断
  return argsDiffs.map((diff, i) => {
    const failure = failedDiffs?.find(f => f.index === i)
    return {
      ...diff,
      success: !failure,
      error: failure?.error,
      // start_line 允许为空；为空时前端不显示“line xx”标记，但内部行号仍会从 1 开始计算
      start_line: diff.start_line,
      rejected: rejectedIndices.has(i)
    }
  })
})

// 获取结果信息
const resultData = computed(() => {
  const result = props.result as Record<string, any> | undefined
  return result?.data || null
})

// 变更数量
// 优先使用可渲染的 diffList（用于展示），否则回退到后端统计字段（避免 patch 过大未透传导致显示 0）
const changesCount = computed(() => {
  if (diffList.value.length > 0) return diffList.value.length

  const data: any = resultData.value || {}
  const fromDiffCount = Number(data?.diffCount)
  if (Number.isFinite(fromDiffCount) && fromDiffCount > 0) return fromDiffCount

  const fromTotalCount = Number(data?.totalCount)
  if (Number.isFinite(fromTotalCount) && fromTotalCount > 0) return fromTotalCount

  const fromApplied = Number(data?.appliedCount)
  if (Number.isFinite(fromApplied) && fromApplied > 0) return fromApplied

  return 0
})

// 获取用户编辑摘要（如果用户在保存前修改了 AI 建议）
// 每行格式：`op | line | content`，多行用 `\n` 分隔
// - 插入：`+ | newLine | content`
// - 替换：`~ | newLine | content`
// - 删除：`- | baseLine | content`
// 空行内容为空字符串
const userEditedContent = computed(() => {
  return resultData.value?.userEditedContent as string | undefined
})

// 是否为全失败（含全部拒绝：rejected 路径 appliedCount 仍为初始成功数，需显式判定）
const isFailed = computed(() => {
  return !!props.error || (resultData.value && (resultData.value.appliedCount === 0 || resultData.value.status === 'rejected'))
})

// 是否为部分成功（有成功也有失败，或后端显式标记 partial）
const isPartial = computed(() => {
  const data = resultData.value
  return !props.error && data && data.status !== 'rejected' && (
    data.partial === true ||
    data.status === 'partial' ||
    (data.appliedCount > 0 && data.failedCount > 0)
  )
})

// 获取文件名
function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

// 获取文件扩展名
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

interface RenderedDiffBlock extends DiffBlock {
  lineDiff: LineDiffResult
}

const renderedDiffList = computed((): RenderedDiffBlock[] => {
  return diffList.value.map(diff => {
    const oldStartLine = diff.start_line || 1
    const newStartLine = diff.new_start_line ?? oldStartLine
    return {
      ...diff,
      lineDiff: computeLineDiffCached(diff.search, diff.replace, { oldStartLine, newStartLine })
    }
  })
})

// 预览行数
const previewLineCount = 20

// 模板兜底用共享空数组（避免 key 缺失时每次渲染创建新数组引用）
const EMPTY_DISPLAY_LINES: LineDiffEntry[] = []

// 展开/折叠展示行的稳定引用缓存：
// 同一 index 的结果对象在 expanded 状态或行差分源（lineDiff 引用）变化前保持不变，
// 避免模板内 slice 每次渲染生成新数组、让 VirtualDiffLines 反复整体重渲染；
// 展开/折叠任一 hunk 时只有该 index 重建，其余未展开 hunk 的折叠 slice 复用缓存对象。
interface DisplayLinesEntry {
  expanded: boolean
  source: LineDiffResult
  lines: LineDiffEntry[]
}
const displayLinesCache = new Map<number, DisplayLinesEntry>()
const displayLinesByIndex = computed(() => {
  const map = new Map<number, LineDiffEntry[]>()
  renderedDiffList.value.forEach((diff, index) => {
    const source = diff.lineDiff
    if (!source) return
    const isExpandedFlag = expanded.value.has(index)
    const cached = displayLinesCache.get(index)
    if (cached && cached.expanded === isExpandedFlag && cached.source === source) {
      map.set(index, cached.lines)
      return
    }
    const lines = isExpandedFlag ? source.lines : source.lines.slice(0, previewLineCount)
    displayLinesCache.set(index, { expanded: isExpandedFlag, source, lines })
    map.set(index, lines)
  })
  return map
})

// 清理已消失的 index（renderedDiffList 缩短时）；同步修剪展开集合，
// 避免按 index 残留的展开标记在列表重新变长时让“新块默认展开”（A-L4）。
// 注意：这会修改 expanded（另一个 ref），属于副作用，必须放在 watch 中而不是 computed getter 内。
watch(renderedDiffList, (list) => {
  for (const key of Array.from(displayLinesCache.keys())) {
    if (key >= list.length) {
      displayLinesCache.delete(key)
      expanded.value.delete(key)
    }
  }
})

function needsExpand(diff: RenderedDiffBlock): boolean {
  return diff.lineDiff.lines.length > previewLineCount
}

// 切换展开状态
function toggleExpand(index: number) {
  if (expanded.value.has(index)) {
    expanded.value.delete(index)
  } else {
    expanded.value.add(index)
  }
}

// 检查是否已展开
function isExpanded(index: number): boolean {
  return expanded.value.has(index)
}

// 检查是否已复制
function isCopied(index: number): boolean {
  return copiedDiffs.value.has(index)
}

// 复制替换后的内容
async function copyReplace(diff: DiffBlock, index: number) {
  const ok = await copyToClipboard(diff.replace)
  if (!ok) {
    await showNotification(t('common.copyFailed'), 'error')
    return
  }

  copiedDiffs.value.add(index)

  const existingTimeout = copyTimeouts.get(index)
  if (existingTimeout) {
    clearTimeout(existingTimeout)
  }

  const timeout = setTimeout(() => {
    copiedDiffs.value.delete(index)
    copyTimeouts.delete(index)
  }, 1000)
  copyTimeouts.set(index, timeout)
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
  <div class="apply-diff-panel">
    <!-- 头部信息 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-diff diff-icon"></span>
        <span class="title">{{ t('components.tools.file.applyDiffPanel.title') }}</span>
      </div>
      <div class="header-stats">
        <button type="button" class="stat clickable gc-link-button" :title="filePath" @click.stop="openFile(filePath)">
          <span class="codicon codicon-file" aria-hidden="true"></span>
          {{ getFileNameWithoutExt(filePath) }}<span v-if="getFileExtension(filePath)" class="file-ext">.{{ getFileExtension(filePath) }}</span>
        </button>
        <span class="stat">{{ changesCount }} {{ t('components.tools.file.applyDiffPanel.changes') }}</span>
      </div>
    </div>

    <!-- 文件路径 -->
    <button type="button" class="file-path-bar clickable gc-link-button" :title="filePath" @click.stop="openFile(filePath)">
      <span class="codicon codicon-file-code" aria-hidden="true"></span>
      <span class="path">{{ filePath }}</span>
    </button>

    <!-- 结果状态 -->
    <div v-if="resultData" class="result-status" :class="{ 'is-error': isFailed && !isPartial, 'is-partial': isPartial }">
      <span v-if="!isFailed && !isPartial" class="codicon codicon-check status-icon success"></span>
      <span v-else-if="isPartial" class="codicon codicon-warning status-icon partial"></span>
      <span v-else class="codicon codicon-error status-icon error"></span>
      <span class="status-text">
        <template v-if="error">{{ error }}</template>
        <template v-else-if="resultData.message">{{ resultData.message }}</template>
        <template v-else-if="isPartial">{{ t('components.tools.file.applyDiffPanel.diffApplied') }} ({{ resultData.appliedCount }}/{{ resultData.totalCount }})</template>
        <template v-else-if="isFailed">{{ t('common.failed') }}</template>
        <template v-else>{{ t('components.tools.file.applyDiffPanel.diffApplied') }}</template>
      </span>
      <span v-if="resultData.status === 'pending'" class="status-badge pending">{{ t('components.tools.file.applyDiffPanel.pending') }}</span>
      <span v-else-if="resultData.status === 'partial'" class="status-badge partial">{{ t('components.tools.file.applyDiffPanel.partial') }}</span>
      <span v-else-if="resultData.status === 'accepted'" class="status-badge accepted">{{ t('components.tools.file.applyDiffPanel.accepted') }}</span>
      <span v-else-if="resultData.status === 'rejected'" class="status-badge rejected">{{ t('components.tools.file.applyDiffPanel.rejected') }}</span>
    </div>

    <!-- 用户编辑提示（仅展示摘要，避免完整文件内容） -->
    <div v-if="userEditedContent" class="user-edit-section">
      <div class="user-edit-header">
        <span class="codicon codicon-edit user-edit-icon"></span>
        <span class="user-edit-title" :title="t('components.tools.file.applyDiffPanel.userEditedContent')">{{
          t('components.tools.file.applyDiffPanel.userEdited')
        }}</span>
      </div>
      <div class="user-edit-content">
        <CustomScrollbar :horizontal="true" :max-height="240">
          <pre class="user-edit-code">{{ userEditedContent }}</pre>
        </CustomScrollbar>
      </div>
    </div>

    <!-- 全局错误 -->
    <div v-if="error && !resultData" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ error }}</span>
    </div>

        <!-- Diff 列表 -->
    <div class="diff-list">
      <div
        v-for="(diff, index) in renderedDiffList"
        :key="index"
        class="diff-block"
        :class="{ 'is-failed': diff.success === false, 'is-rejected': diff.rejected }"
      >
        <!-- Diff 头部 -->
        <div class="diff-header" :class="{ 'is-failed': diff.success === false, 'is-rejected': diff.rejected }">
          <div class="diff-info">
            <span class="diff-number">{{ t('components.tools.file.applyDiffPanel.diffNumber') }}{{ index + 1 }}</span>

            <!-- 状态图标 -->
            <span v-if="diff.rejected" class="status-icon rejected" :title="t('components.tools.file.applyDiffPanel.rejectedBlock')">
              <span class="codicon codicon-close"></span>
            </span>
            <span v-else-if="diff.success === true" class="status-icon success" :title="t('common.success')">
              <span class="codicon codicon-check"></span>
            </span>
            <span v-else-if="diff.success === false" class="status-icon error" :title="diff.error || t('common.failed')">
              <span class="codicon codicon-error"></span>
              <span class="error-msg">{{ diff.error || t('common.failed') }}</span>
            </span>

            <span v-if="diff.start_line" class="start-line">
              <span class="codicon codicon-location"></span>
              {{ t('components.tools.file.applyDiffPanel.line') }} {{ diff.start_line }}
            </span>
            <!-- 统计信息 -->
            <span v-if="diff.success !== false && !diff.rejected" class="diff-stats">
              <span class="stat deleted">
                <span class="codicon codicon-remove"></span>
                {{ diff.lineDiff.deleted }}
              </span>
              <span class="stat added">
                <span class="codicon codicon-add"></span>
                {{ diff.lineDiff.added }}
              </span>
            </span>
          </div>
          <div class="diff-actions">
            <button
              type="button"
              class="action-btn"
              :class="{ 'copied': isCopied(index) }"
              :title="isCopied(index) ? t('components.tools.file.applyDiffPanel.copied') : t('components.tools.file.applyDiffPanel.copyNew')"
              :aria-label="isCopied(index) ? t('components.tools.file.applyDiffPanel.copied') : t('components.tools.file.applyDiffPanel.copyNew')"
              @click.stop="copyReplace(diff, index)"
            >
              <span :class="['codicon', isCopied(index) ? 'codicon-check' : 'codicon-copy']"></span>
            </button>
          </div>
        </div>

        <!-- Diff 内容 -->
        <div class="diff-content" v-if="diff.success !== false">
            <VirtualDiffLines
              :lines="displayLinesByIndex.get(index) || EMPTY_DISPLAY_LINES"
              :line-number-width="diff.lineDiff.lineNumberWidth"
              :max-height="300"
            />

          <!-- 展开/收起按钮 -->
          <div v-if="needsExpand(diff)" class="expand-section">
            <button class="expand-btn" @click="toggleExpand(index)">
              <span :class="['codicon', isExpanded(index) ? 'codicon-chevron-up' : 'codicon-chevron-down']"></span>
              {{ isExpanded(index) ? t('components.tools.file.applyDiffPanel.collapse') : t('components.tools.file.applyDiffPanel.expandRemaining', { count: diff.lineDiff.lines.length - previewLineCount }) }}
            </button>
          </div>
        </div>

        <!-- 失败时的内容预览 -->
        <div v-if="diff.success === false" class="diff-content-failed">
          <div class="failed-section">
            <div class="failed-error" v-if="diff.error">
              <span class="codicon codicon-error"></span>
              {{ diff.error }}
            </div>
            <div class="failed-label">{{ t('components.message.tool.parameters') }} (search):</div>
            <CustomScrollbar :horizontal="true" :max-height="150">
              <pre class="failed-code search">{{ diff.search }}</pre>
            </CustomScrollbar>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./apply_diff.css"></style>