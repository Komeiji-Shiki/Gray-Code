<script setup lang="ts">
import { ref } from 'vue';
import type { GitBranch, GitWorktree, GitWorktreeCreate } from '@graycode/contracts';
import { call } from '../api';
const props = defineProps<{ directory: string; worktrees: GitWorktree[]; branches: GitBranch[]; disabled: boolean;
  draft: GitWorktreeCreate; invoke: (method: string, params: Record<string, unknown>, notice: string) => Promise<boolean>;
  open: (entry: GitWorktree) => Promise<void> }>();
const removing = ref<GitWorktree>(); const pickerError = ref('');
const sameDirectory = (left: string, right: string) => left.replaceAll('\\', '/').replace(/\/$/, '') === right.replaceAll('\\', '/').replace(/\/$/, '');
async function choose() {
  pickerError.value = '';
  try { const selected = await call<{ directory: string } | null>('desktop.chooseWorkspace'); if (selected) props.draft.path = selected.directory; }
  catch (error) { pickerError.value = String(error); }
}
async function create() {
  if (await props.invoke('git.worktree.create', { input: { ...props.draft } }, '工作树已创建，可以从列表中打开。')) props.draft.path = '';
}
async function remove() {
  if (removing.value && await props.invoke('git.worktree.remove', { path: removing.value.directory }, '已移除工作树目录，提交记录仍保留。')) removing.value = undefined;
}
</script>
<template>
  <details class="git-worktrees"><summary>工作树 · {{ worktrees.length }}</summary>
    <p class="worktree-help">同一仓库的不同分支可以放在各自的文件夹里，分别编辑和运行。</p>
    <div v-for="entry in worktrees" :key="entry.directory" class="worktree-entry">
      <div><strong>{{ entry.branch || (entry.detached ? '分离 HEAD' : '工作树') }}</strong><small>{{ entry.main ? '主工作树' : entry.commit?.slice(0, 8) }}</small><p :title="entry.directory">{{ entry.directory }}</p><p v-if="entry.locked || entry.prunable">{{ entry.locked ? '已锁定：' + entry.locked : '需要修复：' + entry.prunable }}</p></div>
      <button :disabled="disabled || sameDirectory(entry.directory, directory) || !!entry.prunable" @click="open(entry)">{{ sameDirectory(entry.directory, directory) ? '当前' : '打开' }}</button>
      <button v-if="!entry.main && !sameDirectory(entry.directory, directory)" :disabled="disabled || !!entry.locked || !!entry.prunable" @click="removing = entry">移除</button>
    </div>
    <div v-if="removing" class="worktree-confirm" role="alertdialog" aria-label="移除工作树"><p>删除这个工作树目录？</p><code>{{ removing.directory }}</code><p>提交记录会保留；仍登记为项目，或存在修改、未跟踪及忽略文件时，会保留目录并提示处理。</p><button :disabled="disabled" @click="removing = undefined">取消</button><button :disabled="disabled" @click="remove">删除工作树目录</button></div>
    <form @submit.prevent="create"><fieldset :disabled="disabled">
      <legend>新工作树</legend>
      <label>目录<div class="worktree-path"><input v-model="draft.path" aria-label="新工作树目录" placeholder="新目录或空文件夹的绝对路径" /><button type="button" @click="choose">选择空文件夹</button></div></label>
      <p v-if="pickerError" role="alert">{{ pickerError }}</p>
      <label class="worktree-check"><input v-model="draft.createBranch" type="checkbox" />创建新分支</label>
      <label>分支<input v-if="draft.createBranch" v-model="draft.branch" aria-label="工作树新分支" placeholder="例如 feature/new-page" /><select v-else v-model="draft.branch" aria-label="工作树现有分支"><option value="" disabled>选择未使用的本地分支</option><option v-for="branch in branches" :key="branch.name" :value="branch.name" :disabled="!!branch.worktree">{{ branch.name }}{{ branch.worktree ? ' · 已在其他工作树中使用' : '' }}</option></select></label>
      <label v-if="draft.createBranch">起点<select v-model="draft.startPoint" aria-label="工作树分支起点"><option value="">当前提交</option><option v-for="branch in branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option></select></label>
      <button :disabled="!draft.path.trim() || !draft.branch.trim()">创建工作树</button>
    </fieldset></form>
  </details>
</template>
<style scoped>
.git-worktrees{border-bottom:1px solid var(--border);font-size:12px}summary{padding:11px 14px;cursor:pointer}.worktree-help{margin:0 14px 8px;color:var(--muted);line-height:1.6}.worktree-entry{display:flex;align-items:center;gap:7px;padding:9px 14px;border-top:1px solid var(--border)}.worktree-entry>div{flex:1;min-width:0}.worktree-entry strong{font-weight:500}.worktree-entry small{color:var(--muted);margin-left:8px}.worktree-entry p{font-size:11px;color:var(--muted);margin:5px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button,input,select{font:inherit;font-size:12px;border-radius:0;border:1px solid var(--border);color:var(--text);background:var(--surface);padding:6px 8px}button{cursor:pointer;white-space:nowrap}button:disabled{opacity:.4;cursor:default}input:not([type=checkbox]),select{width:100%;min-width:0}form{padding:10px 14px}fieldset{margin:0;padding:0;border:0;display:grid;gap:9px;min-width:0}legend{padding:0;margin-bottom:10px}label{display:grid;gap:5px;color:var(--muted);font-size:11px}.worktree-path{display:flex;gap:5px}.worktree-check{display:flex;align-items:center;gap:5px}.worktree-confirm{padding:10px 14px;border-block:1px solid var(--danger,#f08080);line-height:1.6}.worktree-confirm code{overflow-wrap:anywhere}.worktree-confirm button+button{margin-left:8px}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
</style>
