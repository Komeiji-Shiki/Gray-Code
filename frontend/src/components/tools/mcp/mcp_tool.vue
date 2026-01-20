<script setup lang="ts">
/**
 * MCP 工具调用显示组件
 *
 * 用于显示 MCP 工具的请求参数和响应结果
 */

import { computed } from 'vue'
import { useI18n } from '../../../composables/useI18n'

const { t } = useI18n()

const props = defineProps<{
  args: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  status?: string
  toolId?: string
}>()

// 格式化 JSON
function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

// 是否有结果
const hasResult = computed(() => {
  return props.result !== undefined && props.result !== null
})

// 是否有错误
const hasError = computed(() => {
  return !!props.error
})

// 请求 JSON
const requestJson = computed(() => formatJson(props.args))

// 响应 JSON
const responseJson = computed(() => {
  if (hasError.value) {
    return props.error
  }
  return formatJson(props.result)
})
</script>

<template>
  <div class="mcp-tool-content">
    <!-- 请求参数 -->
    <div class="content-section">
      <div class="section-header">
        <span class="section-icon codicon codicon-arrow-up"></span>
        <span class="section-label">{{ t('components.tools.mcp.mcpToolPanel.requestParams') }}</span>
      </div>
      <pre class="json-content request">{{ requestJson }}</pre>
    </div>

    <!-- 响应结果 -->
    <div v-if="hasResult || hasError" class="content-section">
      <div class="section-header">
        <span class="section-icon codicon" :class="hasError ? 'codicon-error' : 'codicon-arrow-down'"></span>
        <span class="section-label">{{ hasError ? t('components.tools.mcp.mcpToolPanel.errorInfo') : t('components.tools.mcp.mcpToolPanel.responseResult') }}</span>
      </div>
      <pre class="json-content" :class="{ error: hasError, response: !hasError }">{{ responseJson }}</pre>
    </div>

    <!-- 等待响应状态 -->
    <div
      v-else-if="status === 'executing' || status === 'queued' || status === 'streaming' || status === 'awaiting_approval'"
      class="loading-section"
    >
      <span class="loading-icon codicon codicon-loading"></span>
      <span class="loading-text">{{ t('components.tools.mcp.mcpToolPanel.waitingResponse') }}</span>
    </div>
  </div>
</template>

<style scoped>
.mcp-tool-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.content-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-icon {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.json-content {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), 'Consolas', 'Monaco', monospace;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 4px;
  overflow-x: auto;
}

.json-content.request {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  color: var(--vscode-foreground);
}

.json-content.response {
  background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, var(--vscode-editor-background));
  border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 30%, var(--vscode-panel-border));
  color: var(--vscode-foreground);
}

.json-content.error {
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
}

.loading-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.loading-icon {
  font-size: 14px;
  color: var(--vscode-testing-runAction);
  animation: spin 1s linear infinite;
}

.loading-text {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>