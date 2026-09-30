<script setup lang="ts">
/**
 * find_references 工具内容组件
 * 
 * 显示引用列表（按文件分组，带代码上下文）
 */

import { computed, ref } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: string
  toolId?: string
}>()

interface ReferenceItem {
  line: number
  column: number
  content: string
}

interface GroupedReferences {
  path: string
  count: number
  references: ReferenceItem[]
}

// 解析引用数据
const referencesData = computed(() => {
  if (!props.result?.data) return null
  const data = props.result.data as {
    path?: string
    line?: number
    column?: number
    symbol?: string
    totalCount?: number
    fileCount?: number
    references?: GroupedReferences[]
    message?: string
  }
  return data
})

// 展开的文件
const expandedFiles = ref<Set<string>>(new Set())

function toggleFile(path: string) {
  if (expandedFiles.value.has(path)) {
    expandedFiles.value.delete(path)
  } else {
    expandedFiles.value.add(path)
  }
}

function isFileExpanded(path: string): boolean {
  return expandedFiles.value.has(path)
}
</script>

<template>
  <div class="find-references-content">
    <!-- 错误显示 -->
    <div v-if="error" class="error-section">
      <span class="codicon codicon-error"></span>
      <span>{{ error }}</span>
    </div>
    
    <!-- 引用列表 -->
    <div v-else-if="referencesData" class="references-section">
      <!-- 源位置信息 -->
      <div class="source-info">
        <span class="label">符号:</span>
        <span class="value">{{ referencesData.path }}:{{ referencesData.line }}</span>
        <span v-if="referencesData.symbol" class="symbol">{{ referencesData.symbol }}</span>
      </div>
      
      <!-- 统计信息 -->
      <div v-if="referencesData.totalCount && referencesData.totalCount > 0" class="stats">
        共找到 <strong>{{ referencesData.totalCount }}</strong> 个引用，
        分布在 <strong>{{ referencesData.fileCount }}</strong> 个文件中
      </div>
      
      <!-- 分组列表 -->
      <CustomScrollbar v-if="referencesData.references && referencesData.references.length > 0" :max-height="500" class="references-list">
        <div 
          v-for="group in referencesData.references" 
          :key="group.path" 
          class="file-group"
        >
          <!-- 文件头部 -->
          <button
            type="button"
            class="file-header"
            :aria-expanded="isFileExpanded(group.path)"
            @click="toggleFile(group.path)"
          >
            <span :class="['expand-icon', 'codicon', isFileExpanded(group.path) ? 'codicon-chevron-down' : 'codicon-chevron-right']" aria-hidden="true"></span>
            <span class="codicon codicon-file" aria-hidden="true"></span>
            <span class="file-path">{{ group.path }}</span>
            <span class="ref-count">({{ group.count }})</span>
          </button>
          
          <!-- 引用列表 -->
          <div v-if="isFileExpanded(group.path)" class="ref-list">
            <div 
              v-for="(ref, index) in group.references" 
              :key="index" 
              class="ref-item"
            >
              <div class="ref-header">
                <span class="line-num">行 {{ ref.line }}</span>
              </div>
              <CustomScrollbar v-if="ref.content" :horizontal="true" class="code-content">
                <pre>{{ ref.content }}</pre>
              </CustomScrollbar>
            </div>
          </div>
        </div>
      </CustomScrollbar>
      
      <!-- 未找到引用 -->
      <div v-else class="no-references">
        <span class="codicon codicon-info"></span>
        <span>{{ referencesData.message || '未找到引用' }}</span>
      </div>
    </div>
    
    <!-- 加载中 -->
    <div v-else class="loading">
      正在查找引用...
    </div>
  </div>
</template>

<style scoped>
.find-references-content {
  font-size: 12px;
  font-family: var(--gc-font-code);
}

.error-section {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gc-danger);
  padding: 8px;
  background: var(--gc-danger-bg);
  border-radius: var(--gc-radius-sm);
}

.references-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--gc-surface-base);
  border-radius: var(--gc-radius-xs);
  font-size: 11px;
}

.source-info .label {
  color: var(--gc-text-muted);
}

.source-info .value {
  color: var(--gc-link);
}

.source-info .symbol {
  color: var(--gc-chart-purple);
  font-weight: 600;
}

.stats {
  font-size: 11px;
  color: var(--gc-text-muted);
  padding: 4px 8px;
}

.stats strong {
  color: var(--gc-text-primary);
}

.references-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-group {
  background: var(--gc-surface-base);
  border-radius: var(--gc-radius-xs);
  overflow: hidden;
}

.file-header {
  width: 100%;
  display: flex;
  align-items: center;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  gap: 4px;
  padding: 6px 8px;
  cursor: pointer;
  transition: background 0.1s;
  background: var(--gc-surface-panel);
}

.file-header:hover {
  background: var(--gc-surface-hover);
}

.expand-icon {
  font-size: 12px;
  color: var(--gc-text-muted);
}

.file-path {
  color: var(--gc-link);
  font-weight: 500;
}

.ref-count {
  color: var(--gc-text-muted);
  font-size: 11px;
  margin-left: auto;
}

.ref-list {
  border-top: 1px solid var(--gc-border-subtle);
}

.ref-item {
  border-bottom: 1px solid var(--gc-border-subtle);
}

.ref-item:last-child {
  border-bottom: none;
}

.ref-header {
  padding: 4px 8px 4px 28px;
  background: var(--gc-surface-base);
}

.line-num {
  color: var(--gc-text-disabled);
  font-size: 11px;
}

.code-content {
  padding: 0;
  margin: 0;
}

.code-content pre {
  margin: 0;
  padding: 4px 8px 4px 28px;
  font-family: var(--gc-font-code);
  font-size: 11px;
  line-height: 1.4;
  color: var(--gc-text-primary);
  white-space: pre;
}

.no-references {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--gc-text-muted);
  padding: 8px;
}

.loading {
  color: var(--gc-text-muted);
  padding: 8px;
  text-align: center;
}
</style>
