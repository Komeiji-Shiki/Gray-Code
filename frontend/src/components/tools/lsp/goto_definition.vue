<script setup lang="ts">
/**
 * goto_definition 工具内容组件
 * 
 * 显示定义位置和代码内容
 */

import { computed } from 'vue'
import CustomScrollbar from '../../common/CustomScrollbar.vue'
import { useI18n } from '../../../i18n'
const { t } = useI18n()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: string
  toolId?: string
}>()

interface DefinitionLocation {
  path: string
  line: number
  column: number
  endLine: number
  content: string
  lineCount: number
  contentTruncated?: boolean
}

// 解析定义数据
const definitionData = computed(() => {
  if (!props.result?.data) return null
  const data = props.result.data as {
    path?: string
    line?: number
    column?: number
    symbol?: string
    definitionCount?: number
    totalCount?: number
    nextOffset?: number
    truncated?: boolean
    definitions?: DefinitionLocation[]
    message?: string
  }
  return data
})
</script>

<template>
  <div class="goto-definition-content">
    <!-- 错误显示 -->
    <div v-if="error" class="error-section">
      <span class="codicon codicon-error"></span>
      <span>{{ error }}</span>
    </div>
    
    <!-- 定义列表 -->
    <div v-else-if="definitionData" class="definition-section">
      <!-- 源位置信息 -->
      <div class="source-info">
        <span class="label">源位置:</span>
        <span class="value">{{ definitionData.path }}:{{ definitionData.line }}:{{ definitionData.column }}</span>
        <span v-if="definitionData.symbol" class="symbol">({{ definitionData.symbol }})</span>
      </div>
      
      <!-- 定义列表 -->
      <CustomScrollbar v-if="definitionData.definitions && definitionData.definitions.length > 0" :max-height="400" class="definitions-list">
        <div class="list-header">
          <template v-if="definitionData.totalCount !== undefined">{{ t('components.tools.presentation.gotoDefinition.pageSummary', { returned: definitionData.definitionCount ?? definitionData.definitions.length, total: definitionData.totalCount }) }}</template>
          <template v-else>找到 {{ definitionData.definitionCount }} 个定义</template>
        </div>
        <div 
          v-for="(def, index) in definitionData.definitions" 
          :key="index" 
          class="definition-item"
        >
          <div class="location">
            <span class="codicon codicon-go-to-file"></span>
            <span class="path">{{ def.path }}</span>
            <span class="line">:行 {{ def.line }}</span>
          </div>
          <CustomScrollbar v-if="def.content" :horizontal="true" class="code-content">
            <pre>{{ def.content }}</pre>
          </CustomScrollbar>
          <p v-if="def.contentTruncated" class="pagination-info">{{ t('components.tools.presentation.gotoDefinition.contentTruncated') }}</p>
        </div>
      </CustomScrollbar>
      
      <!-- 未找到定义 -->
      <div v-else class="no-definitions">
        <span class="codicon codicon-info"></span>
        <span>{{ definitionData.message || (definitionData.totalCount ? t('components.tools.presentation.gotoDefinition.emptyPage') : '未找到定义') }}</span>
      </div>
      <p v-if="definitionData.nextOffset !== undefined" class="pagination-info">{{ t('components.tools.presentation.gotoDefinition.nextPage', { offset: definitionData.nextOffset }) }}</p>
    </div>
    
    <!-- 加载中 -->
    <div v-else class="loading">
      正在查找定义...
    </div>
  </div>
</template>

<style scoped>
.pagination-info { margin: 0; padding: 4px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.goto-definition-content {
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
}

.error-section {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-errorForeground);
  padding: 8px;
  background: var(--vscode-inputValidation-errorBackground);
  border-radius: var(--gc-radius-sm);
}

.definition-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--vscode-editor-background);
  border-radius: var(--gc-radius-xs);
  font-size: 11px;
}

.source-info .label {
  color: var(--vscode-descriptionForeground);
}

.source-info .value {
  color: var(--vscode-textLink-foreground);
}

.source-info .symbol {
  color: var(--vscode-symbolIcon-methodForeground, #b180d7);
  font-weight: 500;
}

.definitions-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.list-header {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  padding: 4px 8px;
}

.definition-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--vscode-editor-background);
  border-radius: var(--gc-radius-xs);
  border-left: 2px solid var(--vscode-textLink-foreground);
  overflow: hidden;
}

.location {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--vscode-sideBar-background);
}

.location .codicon {
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
}

.location .path {
  color: var(--vscode-textLink-foreground);
}

.location .line {
  color: var(--vscode-descriptionForeground);
}

.code-content {
  padding: 0;
  margin: 0;
}

.code-content pre {
  margin: 0;
  padding: 8px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-foreground);
  white-space: pre;
}

.no-definitions {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
  padding: 8px;
}

.loading {
  color: var(--vscode-descriptionForeground);
  padding: 8px;
  text-align: center;
}
</style>
