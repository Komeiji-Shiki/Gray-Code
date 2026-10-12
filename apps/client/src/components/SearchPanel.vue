<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type { ProjectReplacement, ProjectSearchQuery, ProjectSearchResult, SourceRange } from '@graycode/contracts';
import type { EditBatchHandle } from '../../../../shared/editorBatchHistory';
import { call } from '../api';
const props = defineProps<{
  workspaceId: string;
  flush: () => Promise<unknown>;
  apply: (workspaceId: string, edits: ProjectReplacement[]) => Promise<EditBatchHandle>;
  saveAll: () => Promise<void>;
}>();
const emit = defineEmits<{ open: [path: string, range: SourceRange, workspaceId: string] }>();
const options = reactive<ProjectSearchQuery>({ query: '', regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '' });
const replacement = ref('');
const replacing = ref(false);
const busy = ref(false);
const notice = ref('');
const error = ref('');
const result = ref<ProjectSearchResult>();
const selected = ref<string[]>([]);
const searched = ref('');
let requestId: string | undefined;
let generation = 0;
let lastBatch: EditBatchHandle | undefined;
const batchAvailable = ref(false);
const stale = computed(() => searched.value !== JSON.stringify(options));
function cancel() {
  generation++;
  busy.value = false;
  if (requestId) void call('files.searchCancel', { requestId }).catch(() => {});
  requestId = undefined;
}
async function search() {
  cancel();
  const current = generation;
  const workspaceId = props.workspaceId;
  if (!workspaceId) {
    error.value = t('uiSearchPanelProjectRequired');
    return;
  }
  const query = structuredClone({ ...options });
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = undefined;
  requestId = crypto.randomUUID();
  try {
    await props.flush();
    if (current !== generation) return;
    const value = await call<ProjectSearchResult>('files.search', { workspaceId, requestId, options: query });
    if (current !== generation) return;
    result.value = value;
    selected.value = value.files.map((file) => file.path);
    searched.value = JSON.stringify(query);
  } catch (cause) {
    if (current === generation) error.value = String(cause);
  } finally {
    if (current === generation) {
      busy.value = false;
      requestId = undefined;
    }
  }
}
async function replace() {
  if (!result.value || result.value.truncated || stale.value || busy.value) return;
  const workspaceId = props.workspaceId,
    current = generation;
  // 点击时固定这一批操作，等待编辑器同步期间的新输入只用于后续查询。
  const input = {
    workspaceId,
    options: structuredClone({ ...options }),
    replacement: replacement.value,
    files: result.value.files.filter((file) => selected.value.includes(file.path)).map(({ path, hash }) => ({ path, hash })),
  };
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await props.flush();
    if (current !== generation) return;
    const edits = await call<ProjectReplacement[]>('files.replacePreview', input);
    if (current !== generation) return;
    const applied = await props.apply(workspaceId, edits);
    if (current !== generation) return;
    lastBatch = applied;
    batchAvailable.value = edits.length > 0;
    notice.value = edits.length ? t('uiSearchPanelBatchReplacementApplied', { value1: edits.length }) : t('uiSearchPanelReplacementUnchanged');
    result.value = undefined;
  } catch (cause) {
    if (current === generation) error.value = String(cause);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function batch(undo: boolean) {
  if (!lastBatch || busy.value) return;
  const current = generation,
    batch = lastBatch;
  busy.value = true;
  error.value = '';
  try {
    await (undo ? batch.undo() : batch.redo());
    await props.flush();
    if (current === generation) notice.value = undo ? t('uiSearchPanelBatchReplacementUndone') : t('uiSearchPanelBatchReplacementRedone');
  } catch (cause) {
    if (current === generation) error.value = String(cause);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  const current = generation;
  busy.value = true;
  error.value = '';
  try {
    await props.saveAll();
    if (current === generation) notice.value = t('uiGitPanelOpenFilesSaved');
  } catch (cause) {
    if (current === generation) error.value = String(cause);
  } finally {
    if (current === generation) busy.value = false;
  }
}
watch(
  () => props.workspaceId,
  () => {
    cancel();
    result.value = undefined;
    lastBatch = undefined;
    batchAvailable.value = false;
    notice.value = '';
    error.value = '';
  },
);
onUnmounted(cancel);
</script>
<template>
  <section class="search-panel">
    <header>
      <strong>{{ t('uiSearchPanelProjectSearch') }}</strong>
      <button :aria-pressed="replacing" @click="replacing = !replacing">
        {{ replacing ? t('uiSearchPanelCollapseReplacement') : t('uiSearchPanelShowReplacement') }}
      </button>
    </header>
    <form class="search-form" @submit.prevent="search">
      <div class="search-row">
        <input v-model="options.query" :aria-label="t('uiSearchPanelProjectSearchText')" :placeholder="t('uiSearchPanelSearchTextPlaceholder')" />
        <button v-if="requestId" type="button" @click="cancel">{{ t('uiDebugControlsStop') }}</button>
        <button v-else :disabled="busy || !options.query">{{ t('uiMemoryLibrarySearch') }}</button>
      </div>
      <div class="search-options">
        <label>
          <input v-model="options.caseSensitive" type="checkbox" />
          {{ t('uiSearchPanelMatchCase') }}
        </label>
        <label>
          <input v-model="options.wholeWord" type="checkbox" />
          {{ t('uiSearchPanelWholeWord') }}
        </label>
        <label>
          <input v-model="options.regex" type="checkbox" />
          {{ t('uiSearchPanelRegularExpression') }}
        </label>
      </div>
      <div class="search-paths">
        <input v-model="options.include" :aria-label="t('uiSearchPanelSearchIncludedFiles')" :placeholder="t('uiSearchPanelIncludeFilesPlaceholder')" />
        <input v-model="options.exclude" :aria-label="t('uiSearchPanelSearchExcludedFiles')" :placeholder="t('uiSearchPanelExcludeFilesPlaceholder')" />
      </div>
      <div v-if="replacing" class="search-row">
        <input
          v-model="replacement"
          :aria-label="t('uiSearchPanelReplacementText')"
          :placeholder="options.regex ? t('uiSearchPanelReplacementCaptureHelp') : t('uiSearchPanelReplacementPlaceholder')"
        />
        <button type="button" :disabled="busy || stale || !selected.length || !result || result.truncated" @click="replace">
          {{ t('uiSearchPanelReplaceSelectedFiles') }}
        </button>
      </div>
    </form>
    <p v-if="busy" class="search-notice" role="status">{{ t('reviewProcessing') }}</p>
    <p v-if="error" class="search-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="search-notice" role="status">{{ notice }}</p>
    <div v-if="batchAvailable" class="search-batch">
      <button :disabled="busy" @click="batch(true)">{{ t('uiSearchPanelUndoReplacement') }}</button>
      <button :disabled="busy" @click="batch(false)">{{ t('uiSearchPanelRedoReplacement') }}</button>
      <button :disabled="busy" @click="save">{{ t('uiGitPanelSaveAll') }}</button>
    </div>
    <div class="search-results">
      <template v-if="result">
        <p class="search-notice">
          {{ result.count }} {{ t('uiSearchPanelMatchCountSuffix') }}{{ result.files.length }} {{ t('uiSearchPanelFileCountSuffix') }}
          <span v-if="stale">{{ t('uiSearchPanelSearchConditionsChanged') }}</span>
        </p>
        <p v-if="result.truncated" class="search-notice">{{ t('uiSearchPanelSearchLimitReached') }}</p>
        <details v-for="file in result.files" :key="file.path" open class="search-file">
          <summary>
            <input
              v-if="replacing"
              v-model="selected"
              type="checkbox"
              :value="file.path"
              :aria-label="t('uiSearchPanelSelectReplacementPrefix') + file.path"
              @click.stop
            />
            <span>{{ file.path }}</span>
            <small>
              {{ file.matches.length }}
              <span v-if="file.draft">{{ t('uiSearchPanelUnsavedSuffix') }}</span>
            </small>
          </summary>
          <button
            v-for="(match, index) in file.matches"
            :key="index"
            class="search-match"
            :title="`${file.path}:${match.range.start.line + 1}:${match.range.start.character + 1}`"
            @click="emit('open', file.path, match.range, workspaceId)"
          >
            <span>{{ match.range.start.line + 1 }}</span>
            <code>{{ match.preview }}</code>
          </button>
        </details>
        <details v-if="result.skipped.length" class="search-skipped">
          <summary>{{ result.skipped.length }} {{ t('uiSearchPanelUnsearchableFilesCount') }}</summary>
          <p v-for="file in result.skipped" :key="file.path">{{ file.path }} · {{ file.reason }}</p>
        </details>
      </template>
      <p v-else-if="!busy && !notice" class="search-notice">{{ t('uiSearchPanelSearchHelp') }}</p>
    </div>
  </section>
</template>
<style scoped>
.search-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-raised);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 15px;
}
button,
input {
  font: inherit;
  font-size: 12px;
  border-radius: var(--gc-radius-sm);
}
button {
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--gc-border-control);
  padding: 5px 8px;
  color: var(--gc-text-primary);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:hover:not(:disabled) {
  background: var(--gc-surface-hover);
}
input:not([type='checkbox']) {
  min-width: 0;
  width: 100%;
  background: var(--gc-surface-sunken);
  border: 1px solid var(--gc-border-control);
  color: var(--gc-text-primary);
  padding: 8px;
}
.search-form {
  display: grid;
  gap: 9px;
  padding: 12px 14px;
}
.search-row {
  display: flex;
  gap: 6px;
}
.search-row button {
  white-space: nowrap;
}
.search-options {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--gc-text-muted);
}
.search-options label {
  display: flex;
  align-items: center;
  gap: 3px;
}
.search-paths {
  display: grid;
  gap: 6px;
}
.search-notice,
.search-error {
  margin: 10px 14px;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.search-notice {
  color: var(--gc-text-muted);
}
.search-error {
  color: var(--gc-danger);
}
.search-batch {
  display: flex;
  gap: 6px;
  padding: 0 14px 10px;
  flex-wrap: wrap;
}
.search-results {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.search-file {
  border-bottom: 1px solid var(--gc-border-subtle);
}
.search-file summary {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 9px 14px;
  cursor: pointer;
  font-size: 12px;
}
.search-file summary > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-file small {
  color: var(--gc-text-muted);
  white-space: nowrap;
  margin-left: auto;
}
.search-match {
  display: flex;
  width: 100%;
  text-align: left;
  border: 0;
  padding: 6px 14px;
  gap: 10px;
  overflow: hidden;
}
.search-match > span {
  min-width: 30px;
  color: var(--gc-text-muted);
  text-align: right;
}
.search-match code {
  font: inherit;
  font-family: var(--gc-font-code);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-skipped {
  padding: 12px 14px;
  color: var(--gc-text-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: 1px solid var(--gc-accent);
  outline-offset: -1px;
}
</style>
