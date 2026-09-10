<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkspaceDefinition } from '../../../../packages/contracts/src';
import { sendToExtension } from '../../utils/vscode';
const props = defineProps<{ conversationId: string; workspaces: WorkspaceDefinition[] }>();
const emit = defineEmits<{ error: [message: string] }>();
const workspaceId = ref(''); const busy = ref(false); const loaded = ref(false); const bound = ref('');
const sources = ref<{ id: string; name: string; uri: string }[]>([]);
const mapping = ref<Record<string, string>>({});
const target = computed(() => props.workspaces.find(item => item.id === workspaceId.value));
const roots = computed(() => target.value?.roots ?? (target.value ? [{ name: target.value.name, directory: target.value.directory }] : []));
const needsMapping = computed(() => sources.value.length > 1 || roots.value.length > 1);
const ready = computed(() => loaded.value && !!workspaceId.value && (!needsMapping.value || sources.value.every(root => !!mapping.value[root.id])));
async function select() {
  loaded.value = false; mapping.value = {}; if (!workspaceId.value) return;
  busy.value = true;
  try {
    const value = await sendToExtension<{ roots: typeof sources.value }>('migration.workspaceRoots', { conversationId: props.conversationId });
    sources.value = value.roots; loaded.value = true;
  } catch (error) { emit('error', (error as Error).message); }
  finally { busy.value = false; }
}
async function bind() {
  if (!ready.value || busy.value) return;
  busy.value = true;
  try {
    await sendToExtension('migration.bindWorkspace', { conversationId: props.conversationId, workspaceId: workspaceId.value, ...(needsMapping.value ? { mapping: mapping.value } : {}) });
    bound.value = workspaceId.value;
  } catch (error) { emit('error', (error as Error).message); }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="binding">
    <code>{{ conversationId }}</code>
    <select v-model="workspaceId" aria-label="目标工作区" :disabled="busy" @change="select"><option value="">选择目标工作区</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select>
    <template v-if="needsMapping && loaded && bound !== workspaceId">
      <label v-for="source in sources" :key="source.id" class="root-binding"><span>{{ source.name }}<small>{{ source.uri }}</small></span><select v-model="mapping[source.id]" :aria-label="`旧目录 ${source.name} 对应的新目录`"><option value="">选择对应目录</option><option v-for="root in roots" :key="root.directory" :value="root.directory">{{ root.name }} · {{ root.directory }}</option></select></label>
    </template>
    <button :disabled="!ready || busy || !!bound && bound === workspaceId" @click="bind">{{ busy ? '正在处理…' : !!bound && bound === workspaceId ? '已绑定' : '绑定工作区' }}</button>
  </div>
</template>
<style scoped>
.binding{display:grid;gap:10px;border-top:1px solid var(--gc-border-subtle);padding:16px 0}.binding>code{overflow-wrap:anywhere}.root-binding{display:grid;gap:8px}.root-binding span{font-weight:500}.root-binding small{display:block;color:var(--gc-text-muted);overflow-wrap:anywhere;font-weight:400;margin-top:5px}select,button{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--gc-border-control);border-radius:0;background:var(--gc-surface-base);color:var(--gc-text-primary);font:inherit}button{justify-self:start;width:auto;cursor:pointer}button:disabled{opacity:.45;cursor:default}
</style>
