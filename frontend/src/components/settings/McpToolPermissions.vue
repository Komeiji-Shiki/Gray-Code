<script setup lang="ts">
import { computed } from 'vue';
import { decodeMcpToolName } from '../../../../shared/mcpToolNameCodec';
import SearchableMultiSelect from '../common/SearchableMultiSelect.vue';
const props = defineProps<{ modelValue?: string[]; tools: Array<{ name: string; description?: string; serverName?: string }> }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const choices = computed(() => {
  const values = new Map(props.tools.map(tool => [tool.name, tool]));
  for (const name of props.modelValue ?? []) if (!values.has(name)) values.set(name, { name, description: '当前未发现此工具，已保存的授权会保留。' });
  return [...values.values()].map(tool => ({ ...tool, title: decodeMcpToolName(tool.name)?.toolName ?? tool.name }))
    .sort((left, right) => (left.serverName ?? '').localeCompare(right.serverName ?? '') || left.title.localeCompare(right.title));
});
</script>
<template>
  <details class="mcp-permissions" @change.stop>
    <summary>MCP 工具权限 <small>{{ modelValue === undefined ? '沿用原操作权限' : `已允许 ${modelValue.length} 项` }}</small></summary>
    <template v-if="modelValue === undefined"><p>此账号尚未逐项配置 MCP，仍使用原操作权限。改为逐项授权后，只有勾选的工具可以执行。</p><button type="button" @click="emit('update:modelValue', [])">改为逐项授权</button></template>
    <template v-else>
      <p>只有勾选的 MCP 工具可以执行。启用一个工具不会开放同一服务器中的其他工具。</p>
      <SearchableMultiSelect :model-value="modelValue" :options="choices.map(tool => ({ value: tool.name, label: tool.title, group: tool.serverName, description: tool.description }))" label="允许的 MCP 工具" placeholder="选择允许执行的 MCP 工具" @update:model-value="emit('update:modelValue', $event)" />
      <p v-if="!choices.length">连接 MCP 服务器后，可以在这里逐项选择工具。</p>
      <button v-if="modelValue.length" type="button" @click="emit('update:modelValue', [])">取消全部 MCP 授权</button>
    </template>
  </details>
</template>
<style scoped>
.mcp-permissions{margin-top:16px;padding:15px;border:1px solid var(--gc-border-control);background:var(--gc-surface-raised)}summary{cursor:pointer;font-size:14px;font-weight:500}summary small{font-size:12px;font-weight:400;color:var(--gc-text-muted);margin-left:10px}p{font-size:13px;line-height:1.7;color:var(--gc-text-muted);margin:12px 0}button{margin-top:8px;padding:8px 12px;background:var(--vscode-input-background);border:1px solid var(--gc-border-control);color:var(--gc-text-primary);border-radius:0;cursor:pointer}
</style>
