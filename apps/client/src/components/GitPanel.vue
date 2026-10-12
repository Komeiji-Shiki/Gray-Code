<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type { GitEntry, GitStatus, GitWorktree, GitWorktreeCreate } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { loadSettings, state } from '../state';
import { useWorkspaceRoots } from '../workspaceRoots';
import GitWorktrees from './GitWorktrees.vue';
const props = defineProps<{ visible: boolean; saveAll: () => Promise<void>; flush: () => Promise<unknown> }>();
const emit = defineEmits<{ open: [path: string, workspaceId: string] }>();
const { roots, directory } = useWorkspaceRoots();
const status = ref<GitStatus>();
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const diff = ref('');
const selection = ref<{ path: string; staged: boolean }>();
interface GitDraft {
  message: string;
  branch: string;
  newBranch: string;
  startPoint: string;
  initialBranch: string;
  worktree: GitWorktreeCreate;
}
const drafts = reactive<Record<string, GitDraft>>({});
const context = () => ({ workspaceId: state.workspaceId, directory: directory.value });
const contextKey = () => JSON.stringify(context());
const draft = computed(
  () =>
    (drafts[contextKey()] ??= {
      message: '',
      branch: '',
      newBranch: '',
      startPoint: '',
      initialBranch: '',
      worktree: { path: '', branch: '', createBranch: true, startPoint: '' },
    }),
);
const groups = computed(() => [
  { id: 'conflicts', label: t('uiGitPanelUnresolvedConflicts'), staged: false, entries: status.value?.entries.filter((entry) => entry.conflict) ?? [] },
  {
    id: 'staged',
    label: t('uiGitPanelStaged'),
    staged: true,
    entries: status.value?.entries.filter((entry) => !entry.conflict && ![' ', '?'].includes(entry.index)) ?? [],
  },
  {
    id: 'working',
    label: t('uiGitPanelWorkspaceChanges'),
    staged: false,
    entries: status.value?.entries.filter((entry) => !entry.conflict && (entry.index === '?' || ![' ', '?'].includes(entry.worktree))) ?? [],
  },
]);
const hasConflicts = computed(() => status.value?.entries.some((entry) => entry.conflict));
const stagedCount = computed(() => groups.value.find((group) => group.id === 'staged')?.entries.length ?? 0);
let refreshEpoch = 0,
  diffEpoch = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  const params = context(),
    key = contextKey(),
    epoch = ++refreshEpoch;
  const selected = selection.value,
    selectedDiffEpoch = diffEpoch;
  if (!params.workspaceId || !params.directory) {
    status.value = undefined;
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const value = await call<GitStatus>('git.status', params);
    if (epoch !== refreshEpoch || key !== contextKey()) return;
    status.value = value;
    error.value = '';
    if (selection.value && !value.entries.some((entry) => entry.path === selection.value?.path)) {
      diffEpoch++;
      selection.value = undefined;
      diff.value = '';
    }
    // 状态变化后重读当前差异；等待状态期间的新选择已经自行读取，不重复覆盖它。
    else if (selected && selection.value === selected && diffEpoch === selectedDiffEpoch) await showDiff(selected.path, selected.staged);
  } catch (cause) {
    if (epoch === refreshEpoch && key === contextKey()) {
      status.value = undefined;
      error.value = String(cause);
    }
  } finally {
    if (epoch === refreshEpoch) loading.value = false;
  }
}
async function invoke(method: string, input: Record<string, unknown>, success: string): Promise<boolean> {
  if (busy.value) return false;
  const params = context(),
    key = contextKey();
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await props.flush();
    await call(method, { ...params, ...input });
    if (key === contextKey()) {
      await refresh();
      if (key === contextKey()) notice.value = success;
    }
    return true;
  } catch (cause) {
    if (key === contextKey()) error.value = String(cause);
    return false;
  } finally {
    busy.value = false;
  }
}
async function stage(file: string, staged: boolean) {
  await invoke('git.stage', { path: file, staged }, staged ? t('uiGitPanelStagedChanges') : t('uiGitPanelUnstagedChanges'));
}
async function showDiff(file: string, staged: boolean) {
  const key = contextKey(),
    epoch = ++diffEpoch;
  selection.value = { path: file, staged };
  diff.value = t('uiGitPanelLoadingDiff');
  try {
    const value = await call<string>('git.diff', { ...context(), path: file, staged });
    if (epoch === diffEpoch && key === contextKey()) diff.value = value || t('uiGitPanelNoTextDiff');
  } catch (cause) {
    if (epoch === diffEpoch && key === contextKey()) diff.value = String(cause);
  }
}
async function commit() {
  const current = draft.value,
    message = current.message;
  if ((await invoke('git.commit', { message }, t('uiGitPanelCommittedChanges'))) && current.message === message) current.message = '';
}
async function switchBranch(create: boolean) {
  const current = draft.value;
  if (
    await invoke('git.switch', { branch: create ? current.newBranch : current.branch, create, startPoint: current.startPoint }, t('uiGitPanelBranchSwitched'))
  ) {
    current.branch = '';
    if (create) current.newBranch = '';
  }
}
async function save() {
  if (busy.value) return;
  const key = contextKey();
  busy.value = true;
  error.value = '';
  try {
    await props.saveAll();
    if (key === contextKey()) {
      await refresh();
      if (key === contextKey()) notice.value = t('uiGitPanelOpenFilesSaved');
    }
  } catch (cause) {
    if (key === contextKey()) error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
async function openWorktree(entry: GitWorktree, startTask = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const opened = await call<{ id: string }>('workspaces.add', { directory: entry.directory, name: entry.branch || entry.directory.split(/[\\/]/).at(-1) });
    await loadSettings();
    state.workspaceId = opened.id;
    if (startTask) {
      const task = await call<{ conversationId: string }>('ui.request', { type: 'ui.mode.new', data: { mode: 'code', workspaceId: opened.id } });
      await call('ui.command', { command: 'platform.openModeConversation', data: { conversationId: task.conversationId } });
    }
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
function openFile(file: string) {
  emit('open', directory.value.replace(/[\\/]$/, '') + '/' + file, state.workspaceId);
}
function entryLabel(entry: GitEntry, staged: boolean) {
  return entry.conflict
    ? t('uiGitPanelConflicts')
    : (
        {
          M: t('uiGitPanelModified'),
          A: t('uiGitPanelAdded'),
          D: t('uiFileTreeDelete'),
          R: t('uiBrowserPaneRename'),
          C: t('uiGitPanelCopy'),
          '?': t('uiGitPanelUntracked'),
        } as Record<string, string>
      )[staged ? entry.index : entry.index === '?' ? '?' : entry.worktree] || t('uiGitPanelModified');
}
watch(
  [() => state.workspaceId, directory],
  () => {
    refreshEpoch++;
    diffEpoch++;
    status.value = undefined;
    selection.value = undefined;
    diff.value = '';
    error.value = '';
    notice.value = '';
    if (props.visible) void refresh();
  },
  { immediate: true },
);
watch(
  () => props.visible,
  (visible) => {
    clearTimeout(refreshTimer);
    if (visible) void refresh();
  },
);
const unsubscribe = subscribe((event) => {
  if (event.type === 'transport.resumed' && (event.snapshotRequired || event.authenticatedAgain)) {
    clearTimeout(refreshTimer);
    if (props.visible) void refresh();
    return;
  }
  if (['file.changed', 'workspace.git.changed'].includes(event.type) && event.workspaceId === state.workspaceId && props.visible && !busy.value) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (props.visible) void refresh();
    }, 250);
  }
});
onUnmounted(() => {
  unsubscribe();
  clearTimeout(refreshTimer);
  refreshEpoch++;
  diffEpoch++;
});
</script>
<template>
  <section class="git-panel">
    <header class="git-heading">
      <strong>{{ t('uiGitPanelSourceControl') }}</strong>
      <span>{{ status?.branch || (status?.commit ? t('uiGitPanelDetachedHead') + status.commit.slice(0, 8) : '') }}</span>
      <button :disabled="busy || loading" @click="refresh">{{ t('uiBrowserPaneRefresh') }}</button>
    </header>
    <p v-if="!state.workspaceId || !directory" class="git-notice">{{ t('uiGitPanelSelectProjectHelp') }}</p>
    <select v-if="roots.length > 1" v-model="directory" :disabled="busy" class="git-root" :aria-label="t('uiGitPanelGitDirectory')">
      <option v-for="root in roots" :key="root.directory" :value="root.directory">{{ root.name }}</option>
    </select>
    <p v-if="error" class="git-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="git-notice" role="status">{{ notice }}</p>
    <p v-if="loading && !status" class="git-notice">{{ t('uiGitPanelLoadingRepository') }}</p>
    <div v-if="status && !status.repository" class="git-initialize">
      <p>{{ t('uiGitPanelInitializeRepositoryHelp') }}</p>
      <input v-model="draft.initialBranch" :aria-label="t('uiGitPanelInitialBranch')" :placeholder="t('uiGitPanelInitialBranchPlaceholder')" />
      <button :disabled="busy" @click="invoke('git.init', { branch: draft.initialBranch }, t('uiGitPanelRepositoryInitialized'))">
        {{ t('uiGitPanelInitializeRepository') }}
      </button>
    </div>
    <template v-if="status?.repository">
      <p v-if="status.dirtyFiles.length" class="git-drafts">
        {{ status.dirtyFiles.length }} {{ t('uiGitPanelUnsavedFilesHelp') }}
        <button :disabled="busy" @click="save">{{ t('uiGitPanelSaveAll') }}</button>
      </p>
      <div class="git-body">
        <div class="git-sidebar">
          <details class="git-branches">
            <summary>{{ t('uiGitPanelBranchesLabel') }} {{ status.branches.length }}</summary>
            <fieldset :disabled="busy">
              <label>
                {{ t('uiGitPanelSwitchBranch') }}
                <select v-model="draft.branch" :aria-label="t('uiGitPanelSwitchGitBranch')">
                  <option value="" disabled>{{ t('uiGitPanelSelectLocalBranch') }}</option>
                  <option v-for="branch in status.branches" :key="branch.name" :value="branch.name">
                    {{ branch.name }}{{ branch.worktree ? t('uiGitPanelCheckedOutSuffix') : '' }}
                  </option>
                </select>
              </label>
              <button :disabled="!draft.branch || draft.branch === status.branch" @click="switchBranch(false)">
                {{ t('uiGitPanelSwitchSelectedBranch') }}
              </button>
              <label>
                {{ t('uiGitPanelNewBranch') }}
                <input v-model="draft.newBranch" :aria-label="t('uiGitPanelNewGitBranch')" :placeholder="t('uiGitPanelBranchNamePlaceholder')" />
              </label>
              <label>
                {{ t('uiGitPanelStartingPoint') }}
                <select v-model="draft.startPoint" :aria-label="t('uiGitPanelBranchStartingPoint')">
                  <option value="">{{ t('uiGitPanelCurrentCommit') }}</option>
                  <option v-for="branch in status.branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option>
                </select>
              </label>
              <button :disabled="!draft.newBranch.trim()" @click="switchBranch(true)">{{ t('uiGitPanelCreateAndSwitchBranch') }}</button>
            </fieldset>
          </details>
          <GitWorktrees
            :directory="directory"
            :worktrees="status.worktrees"
            :branches="status.branches"
            :disabled="busy"
            :draft="draft.worktree"
            :invoke="invoke"
            :open="openWorktree"
          />
          <section v-for="group in groups.filter((group) => group.entries.length)" :key="group.id" class="git-group" :data-git-group="group.id">
            <h3>
              {{ group.label }}
              <small>{{ group.entries.length }}</small>
            </h3>
            <div v-for="entry in group.entries" :key="entry.path" class="git-file">
              <button
                class="git-pick"
                :class="{ selected: selection?.path === entry.path && selection?.staged === group.staged }"
                :title="entry.originalPath ? entry.originalPath + ' → ' + entry.path : entry.path"
                @click="showDiff(entry.path, group.staged)"
              >
                <span class="git-code" :class="{ conflict: entry.conflict }">{{ entryLabel(entry, group.staged) }}</span>
                <span>{{ entry.path }}</span>
              </button>
              <button
                :disabled="busy"
                :aria-label="(group.staged ? t('uiGitPanelUnstagePrefix') : t('uiGitPanelStagePrefix')) + entry.path"
                :title="group.staged ? t('uiGitPanelUnstage') : t('uiGitPanelStageDiskChanges')"
                @click="stage(entry.path, !group.staged)"
              >
                {{ group.staged ? '−' : '＋' }}
              </button>
            </div>
          </section>
          <p v-if="!status.entries.length" class="git-notice">{{ t('uiGitPanelNoUncommittedChanges') }}</p>
          <div class="git-commit">
            <textarea
              v-model="draft.message"
              :aria-label="t('uiGitPanelGitCommitMessage')"
              :placeholder="t('uiGitPanelCommitMessage')"
              rows="3"
              :disabled="busy"
            ></textarea>
            <p v-if="hasConflicts" class="git-error">{{ t('uiGitPanelResolveConflictsHelp') }}</p>
            <button :disabled="busy || !draft.message.trim() || !stagedCount || hasConflicts" @click="commit">{{ t('uiGitPanelCommitStagedChanges') }}</button>
          </div>
        </div>
        <div class="git-review">
          <header v-if="selection">
            <span>{{ selection.staged ? t('uiGitPanelIndex') : t('workspace') }} · {{ selection.path }}</span>
            <button @click="openFile(selection.path)">{{ t('uiGitPanelOpenFile') }}</button>
          </header>
          <pre>{{ diff || t('uiGitPanelSelectFileHelp') }}</pre>
        </div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.git-panel {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-raised);
  overflow: hidden;
}
.git-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  flex-shrink: 0;
}
.git-heading strong {
  font-size: 13px;
}
.git-heading > span {
  flex: 1;
  color: var(--gc-text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button,
input,
select,
textarea {
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--gc-border-control);
  border-radius: var(--gc-radius-sm);
  background: var(--gc-surface-sunken);
  color: var(--gc-text-primary);
  padding: 6px 8px;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.git-root {
  margin: 8px 14px;
  min-width: 0;
}
.git-error,
.git-notice,
.git-drafts {
  font-size: 12px;
  line-height: 1.6;
  margin: 8px 14px;
  overflow-wrap: anywhere;
}
.git-error {
  color: var(--gc-danger);
}
.git-notice,
.git-drafts {
  color: var(--gc-text-muted);
}
.git-drafts button {
  margin-left: 8px;
}
.git-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 40%) minmax(0, 1fr);
  overflow: hidden;
}
.git-sidebar {
  overflow: auto;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--gc-border-subtle);
}
.git-branches {
  font-size: 12px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
summary {
  cursor: pointer;
  padding: 11px 14px;
}
fieldset {
  padding: 0 14px 12px;
  border: 0;
  min-width: 0;
  margin: 0;
  display: grid;
  gap: 9px;
}
label {
  display: grid;
  gap: 5px;
  color: var(--gc-text-muted);
  font-size: 11px;
}
input,
select,
textarea {
  min-width: 0;
  width: 100%;
}
.git-group h3 {
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--gc-text-muted);
}
.git-group {
  border-bottom: 1px solid var(--gc-border-subtle);
}
.git-file {
  display: flex;
  gap: 3px;
  padding-right: 7px;
}
.git-file button {
  border: 0;
  background: transparent;
}
.git-pick {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: center;
  text-align: left;
  padding: 7px 14px;
}
.git-pick > span:last-child {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.git-file button:hover,
.git-pick.selected {
  background: var(--gc-surface-hover);
}
.git-code {
  font-size: 10px;
  color: var(--gc-accent);
  flex-shrink: 0;
}
.git-code.conflict {
  color: var(--gc-danger);
}
.git-commit {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
}
.git-commit textarea {
  resize: vertical;
  min-height: 68px;
  max-height: 200px;
}
.git-commit .git-error {
  margin: 0;
}
.git-review {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-sunken);
}
.git-review header {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--gc-border-subtle);
  font-size: 11px;
}
.git-review header > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-review pre {
  margin: 0;
  padding: 14px;
  flex: 1;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
}
.git-initialize {
  padding: 8px 14px;
  display: grid;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 1px solid var(--gc-accent);
  outline-offset: -1px;
}
@media (max-width: 1050px) {
  .git-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(120px, 50%) minmax(120px, 1fr);
  }
  .git-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--gc-border-subtle);
  }
}
</style>
