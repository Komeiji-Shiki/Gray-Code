<script setup lang="ts">
/**
 * delete_file 工具的内容面板
 *
 * 显示：
 * - 删除的文件列表
 * - 每个文件的删除状态（成功/失败）
 * - 统计信息
 */

import { computed } from 'vue'
import { useI18n, useOpenWorkspaceFile } from '@/composables'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}>()

const { t } = useI18n()
const { openFile } = useOpenWorkspaceFile()

// 获取删除的文件路径列表
const pathList = computed(() => {
  if (props.args.paths && Array.isArray(props.args.paths)) {
    return props.args.paths as string[]
  }
  if (props.args.path && typeof props.args.path === 'string') {
    return [props.args.path]
  }
  return []
})

// 文件数量
const fileCount = computed(() => pathList.value.length)

// 删除结果列表
interface DeleteResult {
  path: string
  success: boolean
  error?: string
}

const deleteResults = computed((): DeleteResult[] => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.results) {
    return result.data.results as DeleteResult[]
  }
  // 如果没有详细结果，根据路径列表生成默认结果
  const success = result?.success ?? false
  return pathList.value.map(path => ({
    path,
    success,
    error: success ? undefined : props.error
  }))
})

// 成功/失败统计
const successCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.successCount !== undefined) {
    return result.data.successCount as number
  }
  return deleteResults.value.filter(r => r.success).length
})

const failCount = computed(() => {
  const result = props.result as Record<string, any> | undefined
  if (result?.data?.failCount !== undefined) {
    return result.data.failCount as number
  }
  return deleteResults.value.filter(r => !r.success).length
})

// 获取文件名
function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}
</script>

<template>
  <div class="delete-file-panel">
    <!-- 头部统计 -->
    <div class="panel-header">
      <div class="header-info">
        <span class="codicon codicon-trash delete-icon"></span>
        <span class="title">{{ t('components.tools.file.deleteFilePanel.title') }}</span>
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
        <span class="stat total">{{ t('components.tools.file.deleteFilePanel.total', { count: fileCount }) }}</span>
      </div>
    </div>
    
    <!-- 全局错误 -->
    <div v-if="error && fileCount === 0" class="panel-error">
      <span class="codicon codicon-error error-icon"></span>
      <span class="error-text">{{ error }}</span>
    </div>
    
    <!-- 文件列表 -->
    <div v-else-if="deleteResults.length > 0" class="file-list">
      <div 
        v-for="item in deleteResults" 
        :key="item.path" 
        :class="['file-item', { 'is-error': !item.success }]"
      >
        <span :class="[
          'status-icon', 
          'codicon', 
          item.success ? 'codicon-check' : 'codicon-error'
        ]"></span>
        <div class="file-info">
          <span class="file-name clickable" :title="item.path" @click.stop="openFile(item.path)">{{ getFileName(item.path) }}</span>
          <span class="file-path clickable" :title="item.path" @click.stop="openFile(item.path)">{{ item.path }}</span>
          <span v-if="!item.success && item.error" class="file-error">
            {{ item.error }}
          </span>
        </div>
      </div>
    </div>
    
    <!-- 无文件 -->
    <div v-else class="empty-state">
      <span class="codicon codicon-info"></span>
      <span>{{ t('components.tools.file.deleteFilePanel.noFiles') }}</span>
    </div>
  </div>
</template>

<style scoped>
.delete-file-panel {
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

.delete-icon {
  color: var(--vscode-charts-red);
  font-size: 14px;
}

.title {
  font-weight: 600;
  font-size: 12px;
  color: var(--vscode-foreground);
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
  color: var(--vscode-descriptionForeground);
}

.stat.success {
  color: var(--vscode-testing-iconPassed);
}

.stat.error {
  color: var(--vscode-testing-iconFailed);
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

/* 文件列表 */
.file-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm, 2px);
  overflow: hidden;
  max-height: 300px;
  overflow-y: auto;
}

.file-item {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-sm, 8px);
  background: var(--vscode-editor-background);
  transition: background-color var(--transition-fast, 0.1s);
}

.file-item:not(:last-child) {
  border-bottom: 1px solid var(--vscode-panel-border);
}

.file-item.is-error {
  background: var(--vscode-inputValidation-errorBackground);
}

.status-icon {
  font-size: 12px;
  flex-shrink: 0;
  margin-top: 2px;
}

.file-item:not(.is-error) .status-icon {
  color: var(--vscode-testing-iconPassed);
}

.file-item.is-error .status-icon {
  color: var(--vscode-testing-iconFailed);
}

.file-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.file-name.clickable,
.file-path.clickable {
  cursor: pointer;
}

.file-name.clickable:hover,
.file-path.clickable:hover {
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
}

.file-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.file-path {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
  word-break: break-all;
}

.file-error {
  font-size: 10px;
  color: var(--vscode-inputValidation-errorForeground);
  margin-top: 2px;
}

/* 空状态 */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>