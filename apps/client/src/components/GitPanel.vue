<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type { GitEntry, GitStatus, GitWorktree, GitWorktreeCreate } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { loadSettings, state } from '../state';
import { useWorkspaceRoots } from '../workspaceRoots';
import GitWorktrees from './GitWorktrees.vue';
const props = defineProps<{ visible: boolean; saveAll: () => Promise<void>; flush: () => Promise<unknown> }>();
const emit = defineEmits<{ open: [path: string, workspaceId: string] }>();
const { roots, directory } = useWorkspaceRoots();
const status = ref<GitStatus>(); const busy = ref(false); const loading = ref(false); const error = ref(''); const notice = ref('');
const diff = ref(''); const selection = ref<{ path: string; staged: boolean }>();
interface GitDraft { message: string; branch: string; newBranch: string; startPoint: string; initialBranch: string; worktree: GitWorktreeCreate }
const drafts = reactive<Record<string, GitDraft>>({});
const context = () => ({ workspaceId: state.workspaceId, directory: directory.value });
const contextKey = () => JSON.stringify(context());
const draft = computed(() => drafts[contextKey()] ??= { message: '', branch: '', newBranch: '', startPoint: '', initialBranch: '',
  worktree: { path: '', branch: '', createBranch: true, startPoint: '' } });
const groups = computed(() => [
  { id: 'conflicts', label: '需要解决的冲突', staged: false, entries: status.value?.entries.filter(entry => entry.conflict) ?? [] },
  { id: 'staged', label: '已暂存', staged: true, entries: status.value?.entries.filter(entry => !entry.conflict && ![' ', '?'].includes(entry.index)) ?? [] },
  { id: 'working', label: '工作区修改', staged: false, entries: status.value?.entries.filter(entry => !entry.conflict && (entry.index === '?' || ![' ', '?'].includes(entry.worktree))) ?? [] },
]);
const hasConflicts = computed(() => status.value?.entries.some(entry => entry.conflict));
const stagedCount = computed(() => groups.value.find(group => group.id === 'staged')?.entries.length ?? 0);
let refreshEpoch = 0, diffEpoch = 0; let refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  const params = context(), key = contextKey(), epoch = ++refreshEpoch;
  if (!params.workspaceId || !params.directory) { status.value = undefined; loading.value = false; return; }
  loading.value = true;
  try {
    const value = await call<GitStatus>('git.status', params);
    if (epoch !== refreshEpoch || key !== contextKey()) return;
    status.value = value; error.value = '';
    if (selection.value && !value.entries.some(entry => entry.path === selection.value?.path)) { selection.value = undefined; diff.value = ''; }
  } catch (cause) { if (epoch === refreshEpoch && key === contextKey()) { status.value = undefined; error.value = String(cause); } }
  finally { if (epoch === refreshEpoch) loading.value = false; }
}
async function invoke(method: string, input: Record<string, unknown>, success: string): Promise<boolean> {
  if (busy.value) return false;
  const params = context(), key = contextKey(); busy.value = true; error.value = ''; notice.value = '';
  try {
    await props.flush();
    await call(method, { ...params, ...input });
    if (key === contextKey()) { await refresh(); notice.value = success; }
    return true;
  } catch (cause) { if (key === contextKey()) error.value = String(cause); return false; }
  finally { busy.value = false; }
}
async function stage(file: string, staged: boolean) {
  if (await invoke('git.stage', { path: file, staged }, staged ? '已暂存磁盘中的修改。' : '已取消暂存，工作区文件保留。')) {
    if (selection.value?.path === file) await showDiff(file, selection.value.staged);
  }
}
async function showDiff(file: string, staged: boolean) {
  const key = contextKey(), epoch = ++diffEpoch;
  selection.value = { path: file, staged }; diff.value = '正在读取差异…';
  try {
    const value = await call<string>('git.diff', { ...context(), path: file, staged });
    if (epoch === diffEpoch && key === contextKey()) diff.value = value || '此处没有可显示的文本差异。';
  } catch (cause) { if (epoch === diffEpoch && key === contextKey()) diff.value = String(cause); }
}
async function commit() {
  const current = draft.value, message = current.message;
  if (await invoke('git.commit', { message }, '已提交暂存区中的修改。') && current.message === message) current.message = '';
}
async function switchBranch(create: boolean) {
  const current = draft.value;
  if (await invoke('git.switch', { branch: create ? current.newBranch : current.branch, create, startPoint: current.startPoint }, '已切换分支，打开的文件已刷新。')) {
    current.branch = ''; if (create) current.newBranch = '';
  }
}
async function save() {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await props.saveAll(); await refresh(); notice.value = '已保存打开文件的修改。'; }
  catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
async function openWorktree(entry: GitWorktree) {
  if (busy.value) return; busy.value = true; error.value = '';
  try {
    const opened = await call<{ id: string }>('workspaces.add', { directory: entry.directory, name: entry.branch || entry.directory.split(/[\\/]/).at(-1) });
    await loadSettings(); state.workspaceId = opened.id;
  } catch (cause) { error.value = String(cause); }
  finally { busy.value = false; }
}
function openFile(file: string) { emit('open', directory.value.replace(/[\\/]$/, '') + '/' + file, state.workspaceId); }
function entryLabel(entry: GitEntry, staged: boolean) { return entry.conflict ? '冲突' : ({ M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', '?': '未跟踪' } as Record<string, string>)[staged ? entry.index : entry.index === '?' ? '?' : entry.worktree] || '修改'; }
watch([() => state.workspaceId, directory], () => { refreshEpoch++; diffEpoch++; status.value = undefined; selection.value = undefined; diff.value = ''; error.value = ''; notice.value = ''; if (props.visible) void refresh(); }, { immediate: true });
watch(() => props.visible, visible => { if (visible) void refresh(); });
const unsubscribe = subscribe(event => {
  if (['file.changed', 'workspace.git.changed'].includes(event.type) && event.workspaceId === state.workspaceId && props.visible && !busy.value) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 250);
  }
});
onUnmounted(() => { unsubscribe(); clearTimeout(refreshTimer); refreshEpoch++; diffEpoch++; });
</script>
<template>
  <section class="git-panel">
    <header class="git-heading"><strong>源代码管理</strong><span>{{ status?.branch || (status?.commit ? '分离 HEAD · ' + status.commit.slice(0, 8) : '') }}</span><button :disabled="busy || loading" @click="refresh">刷新</button></header>
    <p v-if="!state.workspaceId || !directory" class="git-notice">请先从顶部选择项目，再查看 Git 状态。</p>
    <select v-if="roots.length > 1" v-model="directory" :disabled="busy" class="git-root" aria-label="Git 目录"><option v-for="root in roots" :key="root.directory" :value="root.directory">{{ root.name }}</option></select>
    <p v-if="error" class="git-error" role="alert">{{ error }}</p><p v-if="notice" class="git-notice" role="status">{{ notice }}</p><p v-if="loading && !status" class="git-notice">正在读取仓库…</p>
    <div v-if="status && !status.repository" class="git-initialize"><p>当前目录还没有 Git 仓库。初始化后，可以查看差异并提交文件。</p><input v-model="draft.initialBranch" aria-label="Git 初始分支" placeholder="初始分支，留空沿用 Git 设置" /><button :disabled="busy" @click="invoke('git.init', { branch: draft.initialBranch }, '仓库已初始化，可以暂存并提交文件。')">初始化 Git 仓库</button></div>
    <template v-if="status?.repository">
      <p v-if="status.dirtyFiles.length" class="git-drafts">{{ status.dirtyFiles.length }} 个文件有未保存编辑，Git 比较和提交以磁盘文件为准。<button :disabled="busy" @click="save">保存全部</button></p>
      <div class="git-body">
        <div class="git-sidebar">
          <details class="git-branches"><summary>分支 · {{ status.branches.length }}</summary><fieldset :disabled="busy"><label>切换分支<select v-model="draft.branch" aria-label="切换 Git 分支"><option value="" disabled>选择本地分支</option><option v-for="branch in status.branches" :key="branch.name" :value="branch.name">{{ branch.name }}{{ branch.worktree ? ' · 已检出' : '' }}</option></select></label><button :disabled="!draft.branch || draft.branch === status.branch" @click="switchBranch(false)">切换到所选分支</button><label>新分支<input v-model="draft.newBranch" aria-label="Git 新分支" placeholder="例如 feature/new-page" /></label><label>起点<select v-model="draft.startPoint" aria-label="Git 分支起点"><option value="">当前提交</option><option v-for="branch in status.branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option></select></label><button :disabled="!draft.newBranch.trim()" @click="switchBranch(true)">创建并切换分支</button></fieldset></details>
          <GitWorktrees :directory="directory" :worktrees="status.worktrees" :branches="status.branches" :disabled="busy" :draft="draft.worktree" :invoke="invoke" :open="openWorktree" />
          <section v-for="group in groups.filter(group => group.entries.length)" :key="group.id" class="git-group" :data-git-group="group.id"><h3>{{ group.label }}<small>{{ group.entries.length }}</small></h3>
            <div v-for="entry in group.entries" :key="entry.path" class="git-file"><button class="git-pick" :class="{ selected: selection?.path === entry.path && selection?.staged === group.staged }" :title="entry.originalPath ? entry.originalPath + ' → ' + entry.path : entry.path" @click="showDiff(entry.path, group.staged)"><span class="git-code" :class="{ conflict: entry.conflict }">{{ entryLabel(entry, group.staged) }}</span><span>{{ entry.path }}</span></button><button :disabled="busy" :aria-label="(group.staged ? '取消暂存 ' : '暂存 ') + entry.path" :title="group.staged ? '取消暂存' : '暂存磁盘修改'" @click="stage(entry.path, !group.staged)">{{ group.staged ? '−' : '＋' }}</button></div>
          </section>
          <p v-if="!status.entries.length" class="git-notice">工作区没有未提交的修改。</p>
          <div class="git-commit"><textarea v-model="draft.message" aria-label="Git 提交说明" placeholder="提交说明" rows="3" :disabled="busy"></textarea><p v-if="hasConflicts" class="git-error">先打开冲突文件完成修改，再暂存并提交。</p><button :disabled="busy || !draft.message.trim() || !stagedCount || hasConflicts" @click="commit">提交已暂存的修改</button></div>
        </div>
        <div class="git-review"><header v-if="selection"><span>{{ selection.staged ? '暂存区' : '工作区' }} · {{ selection.path }}</span><button @click="openFile(selection.path)">打开文件</button></header><pre>{{ diff || '选择文件，查看暂存区或工作区中的差异。' }}</pre></div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.git-panel{height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--panel);overflow:hidden}.git-heading{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border);flex-shrink:0}.git-heading strong{font-size:13px}.git-heading>span{flex:1;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button,input,select,textarea{font:inherit;font-size:12px;border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);padding:6px 8px}button{cursor:pointer;white-space:nowrap}button:disabled{opacity:.45;cursor:default}.git-root{margin:8px 14px;min-width:0}.git-error,.git-notice,.git-drafts{font-size:12px;line-height:1.6;margin:8px 14px;overflow-wrap:anywhere}.git-error{color:var(--danger,#f08080)}.git-notice,.git-drafts{color:var(--muted)}.git-drafts button{margin-left:8px}.git-body{flex:1;min-width:0;min-height:0;display:grid;grid-template-columns:minmax(220px,40%) minmax(0,1fr);overflow:hidden}.git-sidebar{overflow:auto;min-width:0;min-height:0;border-right:1px solid var(--border)}.git-branches{font-size:12px;border-bottom:1px solid var(--border)}summary{cursor:pointer;padding:11px 14px}fieldset{padding:0 14px 12px;border:0;min-width:0;margin:0;display:grid;gap:9px}label{display:grid;gap:5px;color:var(--muted);font-size:11px}input,select,textarea{min-width:0;width:100%}.git-group h3{display:flex;justify-content:space-between;margin:0;padding:10px 14px;font-size:12px;font-weight:500;color:var(--muted)}.git-group{border-bottom:1px solid var(--border)}.git-file{display:flex;gap:3px;padding-right:7px}.git-file button{border:0;background:transparent}.git-pick{flex:1;min-width:0;display:flex;gap:8px;align-items:center;text-align:left;padding:7px 14px}.git-pick>span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.git-file button:hover,.git-pick.selected{background:var(--hover)}.git-code{font-size:10px;color:var(--accent);flex-shrink:0}.git-code.conflict{color:var(--danger,#f08080)}.git-commit{display:grid;gap:8px;padding:12px 14px}.git-commit textarea{resize:vertical;min-height:68px;max-height:200px}.git-commit .git-error{margin:0}.git-review{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--surface)}.git-review header{display:flex;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);font-size:11px}.git-review header>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.git-review pre{margin:0;padding:14px;flex:1;overflow:auto;font-size:12px;line-height:1.6}.git-initialize{padding:8px 14px;display:grid;gap:10px;font-size:12px;line-height:1.6}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}@media(max-width:1050px){.git-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(120px,50%) minmax(120px,1fr)}.git-sidebar{border-right:0;border-bottom:1px solid var(--border)}}
</style>
