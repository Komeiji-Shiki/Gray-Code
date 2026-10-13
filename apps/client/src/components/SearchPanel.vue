<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
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
const selected = ref(new Set<string>());
const collapsedFiles = ref(new Set<string>());
const skippedExpanded = ref(false);
const searched = ref('');
let requestId: string | undefined;
let generation = 0;
let lastBatch: EditBatchHandle | undefined;
const batchAvailable = ref(false);
const stale = computed(() => searched.value !== JSON.stringify(options));
type SearchFile = ProjectSearchResult['files'][number];
type SearchRow = { kind: 'file'; key: string; file: SearchFile }
  | { kind: 'match'; key: string; file: SearchFile; match: SearchFile['matches'][number] };
const rowHeight = 32;
const viewport = ref<HTMLElement>();
const resultList = ref<HTMLElement>();
const viewportHeight = ref(0);
const listOffset = ref(0);
const scrollTop = ref(0);
let resizeObserver: ResizeObserver | undefined;
// 路径和命中预览都是单行；折叠与勾选保存完整状态，DOM 只挂载视口附近的行。
const rows = computed<SearchRow[]>(() => {
  const values: SearchRow[] = [];
  for (const file of result.value?.files ?? []) {
    values.push({ kind: 'file', key: `${file.path}:file`, file });
    if (!collapsedFiles.value.has(file.path)) {
      file.matches.forEach((match, index) => values.push({ kind: 'match', key: `${file.path}:match:${index}`, file, match }));
    }
  }
  return values;
});
const startRow = computed(() => Math.max(0, Math.floor(Math.max(0, scrollTop.value - listOffset.value) / rowHeight) - 8));
const rowCount = computed(() => Math.ceil(viewportHeight.value / rowHeight) + 17);
const visibleRows = computed(() => rows.value.slice(startRow.value, startRow.value + rowCount.value));
function measureResults() {
  viewportHeight.value = viewport.value?.clientHeight ?? 0;
  listOffset.value = resultList.value?.offsetTop ?? 0;
}
function toggleFile(path: string) {
  if (collapsedFiles.value.has(path)) collapsedFiles.value.delete(path);
  else collapsedFiles.value.add(path);
}
async function navigateResults(event: KeyboardEvent, index: number) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !viewport.value) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.value.length - 1
    : index + (event.key === 'ArrowUp' ? -1 : 1);
  const row = rows.value[next];
  if (!row) return;
  const top = listOffset.value + next * rowHeight;
  if (top < scrollTop.value) viewport.value.scrollTop = top;
  else if (top + rowHeight > scrollTop.value + viewportHeight.value) {
    viewport.value.scrollTop = top + rowHeight - viewportHeight.value;
  }
  scrollTop.value = viewport.value.scrollTop;
  await nextTick();
  const target = [...(resultList.value?.querySelectorAll<HTMLElement>('[data-search-row]') ?? [])]
    .find(element => element.dataset.searchRow === row.key);
  (target?.matches('button') ? target : target?.querySelector<HTMLElement>('.search-file-toggle'))?.focus();
}
onMounted(() => {
  resizeObserver = new ResizeObserver(measureResults);
  if (viewport.value) resizeObserver.observe(viewport.value);
  measureResults();
});
watch([() => rows.value.length, stale], () => { void nextTick(measureResults); });
watch(result, () => {
  collapsedFiles.value = new Set();
  skippedExpanded.value = false;
  scrollTop.value = 0;
  if (viewport.value) viewport.value.scrollTop = 0;
});
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
    selected.value = new Set(value.files.map((file) => file.path));
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
    files: result.value.files.filter((file) => selected.value.has(file.path)).map(({ path, hash }) => ({ path, hash })),
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
onUnmounted(() => { cancel(); resizeObserver?.disconnect(); });
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
        <button type="button" :disabled="busy || stale || !selected.size || !result || result.truncated" @click="replace">
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
    <div ref="viewport" class="search-results" :style="{ '--gc-search-row-height': rowHeight + 'px' }"
      @scroll="scrollTop = ($event.currentTarget as HTMLElement).scrollTop">
      <template v-if="result">
        <p class="search-notice">
          {{ result.count }} {{ t('uiSearchPanelMatchCountSuffix') }}{{ result.files.length }} {{ t('uiSearchPanelFileCountSuffix') }}
          <span v-if="stale">{{ t('uiSearchPanelSearchConditionsChanged') }}</span>
        </p>
        <p v-if="result.truncated" class="search-notice">{{ t('uiSearchPanelSearchLimitReached') }}</p>
        <div ref="resultList" class="search-result-list" :style="{ height: rows.length * rowHeight + 'px' }">
          <div class="search-visible-rows" :style="{ transform: `translateY(${startRow * rowHeight}px)` }">
            <template v-for="(row, index) in visibleRows" :key="row.key">
              <div v-if="row.kind === 'file'" class="search-file" :data-search-row="row.key"
                @keydown="navigateResults($event, startRow + index)">
                <input v-if="replacing" v-model="selected" type="checkbox" :value="row.file.path"
                  :aria-label="t('uiSearchPanelSelectReplacementPrefix') + row.file.path" />
                <button type="button" class="search-file-toggle" :aria-expanded="!collapsedFiles.has(row.file.path)"
                  @click="toggleFile(row.file.path)">
                  <span aria-hidden="true">{{ collapsedFiles.has(row.file.path) ? '›' : '⌄' }}</span>
                  <span class="search-file-path">{{ row.file.path }}</span>
                  <small>{{ row.file.matches.length }}
                    <span v-if="row.file.draft">{{ t('uiSearchPanelUnsavedSuffix') }}</span>
                  </small>
                </button>
              </div>
              <button v-else type="button" class="search-match" :data-search-row="row.key"
                :title="`${row.file.path}:${row.match.range.start.line + 1}:${row.match.range.start.character + 1}`"
                @keydown="navigateResults($event, startRow + index)"
                @click="emit('open', row.file.path, row.match.range, workspaceId)">
                <span>{{ row.match.range.start.line + 1 }}</span>
                <code>{{ row.match.preview }}</code>
              </button>
            </template>
          </div>
        </div>
        <details v-if="result.skipped.length" class="search-skipped" :open="skippedExpanded"
          @toggle="skippedExpanded = ($event.target as HTMLDetailsElement).open">
          <summary>{{ result.skipped.length }} {{ t('uiSearchPanelUnsearchableFilesCount') }}</summary>
          <template v-if="skippedExpanded">
            <p v-for="file in result.skipped" :key="file.path">{{ file.path }} · {{ file.reason }}</p>
          </template>
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
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.search-file {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--gc-search-row-height);
  padding: 0 14px;
  border-bottom: 1px solid var(--gc-border-subtle);
}
.search-file-toggle {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
  gap: 6px;
  align-items: center;
  padding: 0;
  border: 0;
  cursor: pointer;
  font-size: 12px;
}
.search-file-path {
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
  height: var(--gc-search-row-height);
  display: flex;
  width: 100%;
  text-align: left;
  border: 0;
  padding: 6px 14px;
  gap: 10px;
  overflow: hidden;
}
.search-result-list { position: relative; }
.search-visible-rows { position: absolute; inset: 0 0 auto; }
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
