<script setup lang="ts">
import { computed } from 'vue';
import type { AppSettings } from '../../../../packages/contracts/src/settings';
import type { ActorIdentity } from '../../../../packages/contracts/src/runtime';
import SearchableMultiSelect from '../common/SearchableMultiSelect.vue';
import McpToolPermissions from './McpToolPermissions.vue';

const props = defineProps<{
  account: ActorIdentity;
  workspaces: AppSettings['workspaces'];
  mcpTools: Array<{ name: string; description?: string; serverName?: string }>;
  expandMcp?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();
const workspaceOptions = computed(() => [
  { value: '$bot', label: '当前机器人专用工作区', description: '当前 Discord / QQ 聊天的独立目录，不包含其他频道或普通项目。' },
  { value: '*', label: '全部工作区', description: '包含以后添加的工作区。' },
  ...props.workspaces.filter(workspace => !workspace.managedConversationId && !workspace.id.startsWith('workspace-bot_'))
    .map(workspace => ({ value: workspace.id, label: workspace.name, description: workspace.directory })),
]);
const permissions = [
  { value: 'public_read', label: '公开网页读取与搜索' }, { value: 'workspace_read', label: '读取工作区' },
  { value: 'workspace_write', label: '修改工作区' }, { value: 'process_execute', label: '执行命令' },
  { value: 'data_delete', label: '删除数据' }, { value: 'external_send', label: '向外部发送' },
  { value: 'private_browser', label: '私人浏览器' }, { value: 'desktop_control', label: '操作桌面' },
  { value: 'administration', label: '管理类操作' }, { value: 'high_risk', label: '高风险操作' },
];
function updateWorkspaces(selected: string[]) {
  props.account.botWorkspaceAccess = selected.includes('$bot');
  props.account.workspaceIds = selected.includes('*') ? '*' : selected.filter(value => value !== '$bot');
  emit('change');
}
</script>

<template>
  <div class="permission-account-fields" @change.stop="emit('change')">
    <label>身份<select v-model="account.role"><option value="member">授权成员</option><option value="guest">访客</option></select></label>
    <div class="grant-row"><span>允许的工作区</span><div class="grant-options">
      <SearchableMultiSelect :model-value="[...(account.botWorkspaceAccess !== false ? ['$bot'] : []), ...(account.workspaceIds === '*' ? ['*'] : account.workspaceIds)]"
        :options="workspaceOptions" label="允许的工作区" @update:model-value="updateWorkspaces" />
    </div></div>
    <div class="grant-row"><span>操作权限</span><div class="grant-options">
      <SearchableMultiSelect :model-value="account.effects" :options="permissions" label="操作权限"
        @update:model-value="account.effects = $event as ActorIdentity['effects']; emit('change')" />
    </div></div>
    <p v-if="account.role === 'guest'">访客只可使用公开信息能力与单独允许的 MCP 工具。如需授予工作区等权限，请选择“授权成员”。</p>
    <McpToolPermissions :model-value="account.mcpTools" :tools="mcpTools" :expanded="expandMcp"
      @update:model-value="account.mcpTools = $event; emit('change')" />
  </div>
</template>

<style scoped>
label,.grant-row{display:flex;justify-content:space-between;gap:30px;padding:16px 0;border-bottom:1px solid var(--gc-border-subtle)}
label{align-items:center}select{width:58%;color:var(--gc-text-primary);background:var(--vscode-input-background);border:1px solid var(--gc-border-control);padding:8px 10px;font:inherit;border-radius:0}
.grant-row>span{padding-top:9px}.grant-options{width:58%;display:grid;gap:7px}p{color:var(--gc-text-muted);font-size:13px;line-height:1.7;margin:12px 0 20px}
</style>
