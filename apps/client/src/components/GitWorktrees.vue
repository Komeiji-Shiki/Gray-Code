<script setup lang="ts">
import { shellText as t } from '../i18n';
import { ref } from 'vue';
import type { GitBranch, GitWorktree, GitWorktreeCreate } from '@graycode/contracts';
import { call } from '../api';
const props = defineProps<{
  directory: string;
  worktrees: GitWorktree[];
  branches: GitBranch[];
  disabled: boolean;
  draft: GitWorktreeCreate;
  invoke: (method: string, params: Record<string, unknown>, notice: string) => Promise<boolean>;
  open: (entry: GitWorktree, startTask?: boolean) => Promise<void>;
}>();
const removing = ref<GitWorktree>();
const pickerError = ref('');
const sameDirectory = (left: string, right: string) => left.replaceAll('\\', '/').replace(/\/$/, '') === right.replaceAll('\\', '/').replace(/\/$/, '');
async function choose() {
  pickerError.value = '';
  try {
    const selected = await call<{ directory: string } | null>('desktop.chooseWorkspace');
    if (selected) props.draft.path = selected.directory;
  } catch (error) {
    pickerError.value = String(error);
  }
}
async function create() {
  if (await props.invoke('git.worktree.create', { input: { ...props.draft } }, t('uiGitWorktreesWorktreeCreated'))) props.draft.path = '';
}
async function remove() {
  if (removing.value && (await props.invoke('git.worktree.remove', { path: removing.value.directory }, t('uiGitWorktreesWorktreeRemoved'))))
    removing.value = undefined;
}
</script>
<template>
  <details class="git-worktrees">
    <summary>{{ t('uiGitWorktreesWorktreesLabel') }} {{ worktrees.length }}</summary>
    <p class="worktree-help">{{ t('uiGitWorktreesWorktreesHelp') }}</p>
    <div v-for="entry in worktrees" :key="entry.directory" class="worktree-entry">
      <div>
        <strong>{{ entry.branch || (entry.detached ? t('uiGitWorktreesDetachedHead') : t('uiGitWorktreesWorktree')) }}</strong>
        <small>{{ entry.main ? t('uiGitWorktreesMainWorktree') : entry.commit?.slice(0, 8) }}</small>
        <p :title="entry.directory">{{ entry.directory }}</p>
        <p v-if="entry.locked || entry.prunable">
          {{ entry.locked ? t('uiGitWorktreesLockedPrefix') + entry.locked : t('uiGitWorktreesNeedsRepairPrefix') + entry.prunable }}
        </p>
      </div>
      <button :disabled="disabled || sameDirectory(entry.directory, directory) || !!entry.prunable" @click="open(entry)">
        {{ sameDirectory(entry.directory, directory) ? t('uiGitWorktreesActive') : t('uiBrowserPaneOpen') }}
      </button>
      <button :disabled="disabled || !!entry.prunable" @click="open(entry, true)">{{ t('uiGitWorktreesNewTask') }}</button>
      <button
        v-if="!entry.main && !sameDirectory(entry.directory, directory)"
        :disabled="disabled || !!entry.locked || !!entry.prunable"
        @click="removing = entry"
      >
        {{ t('uiGitWorktreesRemove') }}
      </button>
    </div>
    <div v-if="removing" class="worktree-confirm" role="alertdialog" :aria-label="t('uiGitWorktreesRemoveWorktree')">
      <p>{{ t('uiGitWorktreesDeleteWorktreeQuestion') }}</p>
      <code>{{ removing.directory }}</code>
      <p>{{ t('uiGitWorktreesDeleteWorktreeHelp') }}</p>
      <button :disabled="disabled" @click="removing = undefined">{{ t('uiBrowserPaneCancel') }}</button>
      <button :disabled="disabled" @click="remove">{{ t('uiGitWorktreesDeleteWorktreeDirectory') }}</button>
    </div>
    <form @submit.prevent="create">
      <fieldset :disabled="disabled">
        <legend>{{ t('uiGitWorktreesNewWorktree') }}</legend>
        <label>
          {{ t('uiGitWorktreesDirectory') }}
          <div class="worktree-path">
            <input v-model="draft.path" :aria-label="t('uiGitWorktreesNewWorktreeDirectory')" :placeholder="t('uiGitWorktreesWorktreeDirectoryPlaceholder')" />
            <button type="button" @click="choose">{{ t('uiGitWorktreesChooseEmptyFolder') }}</button>
          </div>
        </label>
        <p v-if="pickerError" role="alert">{{ pickerError }}</p>
        <label class="worktree-check">
          <input v-model="draft.createBranch" type="checkbox" />
          {{ t('uiGitWorktreesCreateNewBranch') }}
        </label>
        <label>
          {{ t('uiGitWorktreesBranch') }}
          <input
            v-if="draft.createBranch"
            v-model="draft.branch"
            :aria-label="t('uiGitWorktreesWorktreeNewBranch')"
            :placeholder="t('uiGitPanelBranchNamePlaceholder')"
          />
          <select v-else v-model="draft.branch" :aria-label="t('uiGitWorktreesWorktreeExistingBranch')">
            <option value="" disabled>{{ t('uiGitWorktreesSelectUnusedBranch') }}</option>
            <option v-for="branch in branches" :key="branch.name" :value="branch.name" :disabled="!!branch.worktree">
              {{ branch.name }}{{ branch.worktree ? t('uiGitWorktreesBranchInUseSuffix') : '' }}
            </option>
          </select>
        </label>
        <label v-if="draft.createBranch">
          {{ t('uiGitPanelStartingPoint') }}
          <select v-model="draft.startPoint" :aria-label="t('uiGitWorktreesWorktreeBranchStartingPoint')">
            <option value="">{{ t('uiGitPanelCurrentCommit') }}</option>
            <option v-for="branch in branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option>
          </select>
        </label>
        <button :disabled="!draft.path.trim() || !draft.branch.trim()">{{ t('uiGitWorktreesCreateWorktree') }}</button>
      </fieldset>
    </form>
  </details>
</template>
<style scoped>
.git-worktrees {
  border-bottom: 1px solid var(--gc-border-subtle);
  font-size: 12px;
}
summary {
  padding: 11px 14px;
  cursor: pointer;
}
.worktree-help {
  margin: 0 14px 8px;
  color: var(--gc-text-muted);
  line-height: 1.6;
}
.worktree-entry {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-top: 1px solid var(--gc-border-subtle);
}
.worktree-entry > div {
  flex: 1;
  min-width: 0;
}
.worktree-entry strong {
  font-weight: 500;
}
.worktree-entry small {
  color: var(--gc-text-muted);
  margin-left: 8px;
}
.worktree-entry p {
  font-size: 11px;
  color: var(--gc-text-muted);
  margin: 5px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button,
input,
select {
  font: inherit;
  font-size: 12px;
  border-radius: var(--gc-radius-sm);
  border: 1px solid var(--gc-border-control);
  color: var(--gc-text-primary);
  background: var(--gc-surface-sunken);
  padding: 6px 8px;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
input:not([type='checkbox']),
select {
  width: 100%;
  min-width: 0;
}
form {
  padding: 10px 14px;
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  gap: 9px;
  min-width: 0;
}
legend {
  padding: 0;
  margin-bottom: 10px;
}
label {
  display: grid;
  gap: 5px;
  color: var(--gc-text-muted);
  font-size: 11px;
}
.worktree-path {
  display: flex;
  gap: 5px;
}
.worktree-check {
  display: flex;
  align-items: center;
  gap: 5px;
}
.worktree-confirm {
  padding: 10px 14px;
  border-block: 1px solid var(--gc-danger);
  line-height: 1.6;
}
.worktree-confirm code {
  overflow-wrap: anywhere;
}
.worktree-confirm button + button {
  margin-left: 8px;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 1px solid var(--gc-accent);
  outline-offset: -1px;
}
</style>
