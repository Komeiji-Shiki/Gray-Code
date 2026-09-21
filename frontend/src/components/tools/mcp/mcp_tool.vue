<script setup lang="ts">
import ToolResultPanel from '../common/ToolResultPanel.vue'

// MCP 与内置工具共用字段、文本、图片和列表展示，外部工具无需逐个添加组件。
defineProps<{ args: Record<string, unknown>; result?: Record<string, unknown>; error?: string; status?: string; toolId?: string; toolName?: string }>()
</script>

<template>
  <ToolResultPanel :args="args" :result="result" :error="error" :status="status" :tool-name="toolName" />
</template>
