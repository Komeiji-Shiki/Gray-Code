<script setup lang="ts">
/**
 * delete_code 工具的内容面板
 *
 * 支持批量删除，每个文件一个小面板显示
 * 显示：
 * - 文件名（标题）+ 删除范围
 * - 文件路径
 * - 操作结果状态
 */

import { computed } from 'vue'
import { useI18n, useOpenWorkspaceFile } from '@/composables'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

const { t } = useI18n()

const { openFileAt } = useOpenWorkspaceFile()

// 单个删除条目
interface DeleteEntry {
  path: string
  start_line: number
  end_line: number
}

// 单个删除结果
interface DeleteResult {
  path: string
  success: boolean
  start_line?: number
  end_line?: number
  deletedLines?: number
  status?: string
  error?: string
}

// 获取文件列表（从参数中）
const fileList = computed((): DeleteEntry[] => {
  const files = props.args.files as DeleteEntry[] | undefined
  return files && Array.isArray(files) ? files : []
})

// 获取删除结果列表（从结果中）
const deleteResults = computed((): DeleteResult[] => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.results) {
    return result.data.results as DeleteResult[]
  }
  return fileList.value.map(f => ({
    path: f.path,
    success: !props.error,
    error: props.error
  }))
})

// 合并文件列表和结果
interface MergedFile {
  path: string
  start_line: number
  end_line: number
  deletedCount: number
  result: DeleteResult | undefined
}

const mergedFiles = computed((): MergedFile[] => {
  return fileList.value.map(entry => {
    const result = deleteResults.value.find(r => r.path === entry.path)
    return {
      path: entry.path,
      start_line: entry.start_line,
      end_line: entry.end_line,
      deletedCount: entry.end_line - entry.start_line + 1,
      result
    }
  })
})

// 统计
const successCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.successCount !== undefined) return result.data.successCount as number
  return deleteResults.value.filter(r => r.success).length
})

const failCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.failCount !== undefined) return result.data.failCount as number
  return deleteResults.value.filter(r => !r.success).length
})

// 获取文件名
function getFileName(fp: string): string {
  const parts = fp.split(/[/\\]/)
  return parts[parts.length - 1] || fp
}

function getFileExtension(fp: string): string {
  const name = getFileName(fp)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.substring(idx + 1) : ''
}

function getFileNameWithoutExt(fp: string): string {
  const name = getFileName(fp)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.substring(0, idx) : name
}
</script>

<template>
  <div class="delete-code-panel">
    <!-- 总体统计头部 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-diff-removed files-icon"></span>
        <span class="title">{{ t('components.settings.toolsSettings.toolDisplayNames.delete_code') }}</span>
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
        <span class="stat total">{{ t('components.message.tool.deleteCode.totalFiles', { count: mergedFiles.length }) }}</span>
      </div>
    </div>

    <!-- 全局错误 -->
    <div v-if="error && mergedFiles.length === 0" class="panel-error">
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
            <span class="codicon codicon-diff-removed file-icon"></span>
            <button type="button" class="file-name clickable gc-link-button" :title="file.path" @click.stop="openFileAt(file.path, file.start_line, file.end_line)">{{ getFileNameWithoutExt(file.path) }}</button>
            <button v-if="getFileExtension(file.path)" type="button" class="file-ext clickable gc-link-button" :title="file.path" @click.stop="openFileAt(file.path, file.start_line, file.end_line)">.{{ getFileExtension(file.path) }}</button>
            <span class="delete-badge">{{ t('components.message.tool.deleteCode.badge', { start: file.start_line, end: file.end_line }) }}</span>
            <span class="line-count">{{ t('components.message.tool.deleteCode.lineCount', { count: file.deletedCount }) }}</span>
          </div>
        </div>

        <!-- 文件路径 -->
        <button type="button" class="file-path clickable gc-link-button" :title="file.path" @click.stop="openFileAt(file.path, file.start_line, file.end_line)">{{ file.path }}</button>

        <!-- 状态显示 -->
        <div v-if="file.result && !file.result.success && file.result.error" class="file-error">
          <span class="codicon codicon-error"></span>
          {{ file.result.error }}
        </div>
        <div v-else-if="file.result?.status === 'accepted'" class="file-success">
          <span class="codicon codicon-check"></span>
          {{ t('components.message.tool.deleteCode.deletedCount', { count: file.deletedCount }) }}
        </div>
        <div v-else-if="!props.result" class="file-info-bar">
          <span class="codicon codicon-info"></span>
          {{ t('components.message.tool.deleteCode.willDelete', { start: file.start_line, end: file.end_line, count: file.deletedCount }) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delete-code-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

/* 总体头部 */
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

.files-icon {
  color: var(--gc-git-deleted);
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

/* 文件列表 */
.file-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
}

/* 单个文件面板 */
.file-panel {
  border: 1px solid var(--gc-border-subtle);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
}

.file-panel.is-error {
  border-color: var(--gc-danger-border);
}

/* 文件头部 */
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
  color: var(--gc-git-deleted);
  flex-shrink: 0;
}

.file-panel.is-error .file-icon {
  color: var(--gc-danger);
}

.file-name.clickable,
.file-ext.clickable,
.file-path.clickable {
  cursor: pointer;
}

.file-name.clickable:hover,
.file-ext.clickable:hover,
.file-path.clickable:hover {
  color: var(--gc-link);
  text-decoration: underline;
}

.file-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--gc-text-primary);
}

.file-ext {
  font-size: 10px;
  color: var(--gc-text-muted);
}

.delete-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: var(--gc-radius-xs);
  margin-left: var(--spacing-xs, 4px);
  font-weight: 500;
  background: var(--gc-git-deleted);
  color: var(--gc-surface-base);
}

.line-count {
  font-size: 10px;
  color: var(--gc-text-muted);
  margin-left: auto;
  flex-shrink: 0;
}

/* 文件路径 */
.file-path {
  padding: 2px var(--spacing-sm, 8px);
  font-size: 10px;
  color: var(--gc-text-muted);
  font-family: var(--gc-font-code);
  background: var(--gc-surface-base);
  border-bottom: 1px solid var(--gc-border-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 错误信息 */
.file-error {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--gc-danger);
  background: var(--gc-danger-bg);
}

/* 成功信息 */
.file-success {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--gc-success);
  background: var(--gc-surface-base);
}

/* 信息栏 */
.file-info-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs, 4px);
  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);
  font-size: 11px;
  color: var(--gc-text-muted);
  background: var(--gc-surface-base);
}
</style>
