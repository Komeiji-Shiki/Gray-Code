<script setup lang="ts">
import type { WorkspaceDefinition } from '../../../../packages/contracts/src';
import { sendToExtension } from '../../utils/vscode';
import { onMounted, ref } from 'vue';
const props = defineProps<{ workspaces: WorkspaceDefinition[] }>();
const emit = defineEmits<{ change: []; error: [message: string] }>();
const automaticRoot = ref('Documents/graycode');
onMounted(async () => { try { automaticRoot.value = (await sendToExtension<{ directory: string }>('platform.workspaces.automaticRoot', {})).directory; } catch (error) { emit('error', (error as Error).message); } });
const directories = (workspace: WorkspaceDefinition) => workspace.roots ?? [{ name: workspace.name, directory: workspace.directory }];
async function choose(workspace?: WorkspaceDefinition) {
  try {
    const folder = await sendToExtension<{ name: string; directory: string } | null>('desktop.chooseWorkspace', {});
    if (!folder) return;
    if (workspace) workspace.roots = [...directories(workspace), folder];
    else props.workspaces.push({ id: 'workspace_' + crypto.randomUUID(), ...folder, deviceId: 'local' });
    emit('change');
  } catch (error) { emit('error', (error as Error).message); }
}
function renameRoot(workspace: WorkspaceDefinition, index: number, name: string) {
  workspace.roots = directories(workspace).map((root, position) => position === index ? { ...root, name } : root);
}
function removeRoot(workspace: WorkspaceDefinition, index: number) {
  if (directories(workspace).length < 2) return;
  workspace.roots = directories(workspace).filter((_, position) => position !== index);
  workspace.directory = workspace.roots[0].directory; emit('change');
}
function makeDefault(workspace: WorkspaceDefinition, index: number) {
  const roots = [...directories(workspace)]; const [first] = roots.splice(index, 1);
  workspace.roots = [first, ...roots]; workspace.directory = first.directory; emit('change');
}
function remove(workspace: WorkspaceDefinition) {
  props.workspaces.splice(props.workspaces.indexOf(workspace), 1); emit('change');
}
</script>
<template>
  <section class="workspace-settings" @change.stop="emit('change')">
    <h4>本地工作区</h4>
    <p>未选择项目时，新对话会在 <code>{{ automaticRoot }}</code> 下按日期建立独立文件夹。自动目录随对话保留，不需要预先配置默认工作区。</p>
    <p>一个工作区可以包含多个目录。多目录的文件路径使用 <code>@目录名/文件</code>，每个目录的名称需要不同。默认目录用于新建终端、没有指定目录的新命令，以及任务的项目记忆。</p>
    <article v-for="workspace in workspaces.filter(item => !item.managedConversationId)" :key="workspace.id" class="workspace-entry">
      <label class="workspace-name">工作区名称<input v-model="workspace.name" aria-label="工作区名称" /></label>
      <div v-for="(root, index) in directories(workspace)" :key="root.directory + ':' + index" class="workspace-root">
        <label>目录名称<input :value="root.name" aria-label="目录名称" @change="renameRoot(workspace, index, ($event.target as HTMLInputElement).value)" /></label>
        <p class="root-directory">{{ root.directory }}</p>
        <div class="root-actions"><span v-if="index === 0" class="default-root">默认目录</span><button v-else @click="makeDefault(workspace, index)">设为默认目录</button><button v-if="directories(workspace).length > 1" @click="removeRoot(workspace, index)">移除此目录</button></div>
      </div>
      <div class="workspace-actions"><button @click="choose(workspace)">添加目录</button><button @click="remove(workspace)">从列表移除工作区</button></div>
    </article>
    <button @click="choose()">打开本地文件夹</button>
    <p>修改通过设置页统一保存。移除目录只改变工作区配置，磁盘文件和已有编辑草稿仍保留；已经开始的任务继续使用启动时的目录。</p>
  </section>
</template>
<style scoped>
h4{font-size:24px;margin:0 0 12px}p{color:var(--gc-text-muted);line-height:1.7}code{color:var(--gc-text-primary)}.workspace-entry{border-top:1px solid var(--gc-border-control);padding:18px 0 24px;margin-top:20px}label{display:flex;align-items:center;justify-content:space-between;gap:18px}.workspace-name{margin-bottom:14px}.workspace-root{padding:14px 16px;margin:10px 0;border:1px solid var(--gc-border-subtle);background:var(--gc-surface-base)}input{width:58%;min-width:0;background:var(--vscode-input-background);border:1px solid var(--gc-border-control);color:var(--gc-text-primary);padding:8px 10px;font:inherit;border-radius:0}.root-directory{font:12px/1.6 var(--gc-font-code,monospace);overflow-wrap:anywhere;margin:12px 0}.root-actions,.workspace-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.default-root{color:var(--vscode-focusBorder);font-size:12px;margin-right:auto}.workspace-actions{margin-top:14px}button{padding:8px 12px;border:1px solid var(--gc-border-control);background:var(--gc-surface-raised);color:var(--gc-text-primary);font:inherit;border-radius:0;cursor:pointer}@media(max-width:500px){.workspace-root{padding:12px}label{align-items:flex-start;flex-direction:column;gap:8px}input{width:100%}}
</style>
