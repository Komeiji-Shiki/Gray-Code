<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ value?: unknown }>()
interface NextAction { tool: string; args: Record<string, unknown>; when?: string }
// 回执中的建议仅展示工具与参数，执行仍由模型经过原有审批路径发起。
const actions = computed(() => Array.isArray(props.value) ? props.value.filter((value): value is NextAction =>
  !!value && typeof value === 'object' && typeof value.tool === 'string' && !!value.args
  && typeof value.args === 'object' && !Array.isArray(value.args)) : [])
</script>

<template>
  <div v-if="actions.length" class="tool-next-actions">
    <div v-for="(action, index) in actions" :key="index" class="tool-next-action">
      <div class="next-action-call"><span class="codicon codicon-arrow-right" aria-hidden="true" /><code>{{ action.tool }}({{ JSON.stringify(action.args) }})</code></div>
      <p v-if="typeof action.when === 'string'">{{ action.when }}</p>
    </div>
  </div>
</template>

<style scoped>
.tool-next-actions{border-top:1px solid var(--vscode-panel-border);padding-top:8px;display:flex;flex-direction:column;gap:8px}.next-action-call{display:flex;align-items:flex-start;gap:6px;color:var(--vscode-foreground)}.next-action-call>code{font:11px/1.6 var(--vscode-editor-font-family,monospace);white-space:pre-wrap;overflow-wrap:anywhere}.next-action-call>.codicon{margin-top:2px;color:var(--vscode-descriptionForeground)}.tool-next-action>p{margin:2px 0 0 20px;color:var(--vscode-descriptionForeground);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
