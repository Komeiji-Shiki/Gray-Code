<script setup lang="ts">
import { shellText as t, shellLocale } from '../i18n';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type {
  LongMemoryArchive,
  LongMemoryJob,
  LongMemoryPolicy,
  LongMemoryRecall,
  LongMemoryRecord,
  LongMemoryScope,
  LongMemorySource,
  LongMemoryTopic,
} from '@graycode/contracts';
import { call, subscribe } from '../api';
import { state } from '../state';
import type { LongMemoryGraph, LongMemoryGraphNode } from '@graycode/contracts';
import type { LongMemoryTopicPage, LongMemoryBrowseResult, LongMemoryPreview } from '@graycode/contracts';
import MemoryGraph from './MemoryGraph.vue';
import MemoryImports from './MemoryImports.vue';
import MemorySourceFiles from './MemorySourceFiles.vue';
import './memoryShared.css';

interface ScopeRow extends LongMemoryScope {
  label: string;
}
interface Options {
  scopes: ScopeRow[];
  policy: { value: LongMemoryPolicy; revision: number | null };
  providers: Array<{ id: string; name: string; model: string; models: string[] }>;
}
interface Detail {
  revisions: LongMemoryRecord[];
  sources: LongMemorySource[];
  parents: LongMemoryRecord[];
  relations?: LongMemoryRecord[];
  activeVersion?: number;
}
const emit = defineEmits<{ close: [] }>();
const options = ref<Options>(),
  scopeId = ref(''),
  section = ref<'records' | 'organize' | 'jobs' | 'imports'>('records');
const searchText = ref(''),
  appliedQuery = ref(''),
  topicPath = ref<string[]>([]),
  kind = ref('');
const result = ref<LongMemoryRecall>(),
  topics = ref<LongMemoryTopic[]>([]),
  detail = ref<Detail>(),
  jobs = ref<LongMemoryJob[]>([]);
const topicCursor = ref<string>();
const browseResult = ref<LongMemoryBrowseResult>(),
  recordCursor = ref<string>(),
  recordTrail = ref<Array<string | undefined>>([]);
const searchMode = ref<'related' | 'list'>('related'),
  filterConfidence = ref(''),
  filterStatus = ref<'current' | 'inactive' | 'all'>('current');
const relatedSearch = computed(() => searchMode.value === 'related' && !!appliedQuery.value.trim());
const visibleRecords = computed<Array<LongMemoryPreview & { reasons: string[]; conflicts: string[] }>>(() =>
  result.value
    ? result.value.hits.map((hit) => ({
        ...hit.record,
        preview: hit.record.text,
        moreText: false,
        active: true,
        reasons: hit.reasons,
        conflicts: hit.conflicts,
      }))
    : (browseResult.value?.items ?? []).map((item) => ({ ...item, reasons: [], conflicts: [] })),
);
const error = ref(''),
  notice = ref(''),
  busy = ref(false),
  loading = ref(false),
  changedElsewhere = ref(false);
const editing = ref(false),
  editingScopeId = ref(''),
  editingId = ref(''),
  editingVersion = ref(0),
  editorBaseline = ref('');
const pendingNavigation = ref<(() => Promise<void> | void) | null>(null),
  pendingClose = ref(false);
const selectedIds = ref<string[]>([]),
  summaryTopic = ref(''),
  deleteImpact = ref<{ recordCount: number; sourceCount: number; items: Array<{ id: string; kind: string; text: string }>; truncated: boolean } | null>(null);
const importPreview = ref<LongMemoryArchive | null>(null),
  embeddingCredential = ref(''),
  policyBaseline = ref('');
const policy = reactive<LongMemoryPolicy>({
  enabled: true,
  automaticExtraction: false,
  automaticScopes: [],
  recallTokens: 1200,
  recallLimit: 5,
  extractionOutputTokens: 12288,
});
const embeddingEnabled = ref(false);
const editorView = ref<'edit' | 'graph'>('edit'),
  editor = ref<HTMLElement>();
const graph = ref<LongMemoryGraph>(),
  graphLoading = ref(false),
  graphError = ref(''),
  graphLimit = ref(40);
const graphSource = ref<LongMemorySource>();
let graphEpoch = 0;
const embedding = reactive({
  url: '',
  model: '',
  credentialRef: undefined as string | undefined,
  dimensions: '' as string,
  queryPrefix: '',
  documentPrefix: '',
});
const form = reactive({
  text: '',
  kind: 'fact' as LongMemoryRecord['kind'],
  subject: '',
  topic: '',
  attribute: '',
  value: '',
  validFrom: '',
  validTo: '',
  eventAt: '',
  confidence: 'confirmed' as LongMemoryRecord['confidence'],
});
let epoch = 0,
  editorEpoch = 0,
  refreshTimer: ReturnType<typeof setTimeout> | undefined,
  refreshRecords = false;
const kinds = computed<Record<string, string>>(() => ({
  fact: t('uiMemoryGraphFact'),
  preference: t('uiMemoryGraphPreference'),
  experience: t('uiMemoryLibraryExperiencesAndLessons'),
  project: t('uiMemoryLibraryProjectKnowledge'),
  procedure: t('uiMemoryLibraryProcedures'),
  event: t('uiMemoryGraphEvent'),
  summary: t('uiMemoryLibraryHierarchicalSummaries'),
}));
const origins = computed<Record<string, string>>(() => ({
  user: t('uiMemoryLibraryUserStatements'),
  model: t('uiMemoryLibraryModelSynthesis'),
  tool: t('uiMemoryLibraryToolResult'),
  fiction: t('uiMemoryLibraryFiction'),
  import: t('uiMemoryLibraryImportedMaterial'),
}));
const statuses = computed<Record<string, string>>(() => ({
  pending: t('uiMemoryLibraryPending'),
  running: t('uiMemoryLibraryOrganizing'),
  completed: t('uiMemoryLibraryDone'),
  failed: t('uiComputerPaneFailure'),
  cancelled: t('reviewCancelledStatus'),
  interrupted: t('uiMemoryLibraryInterrupted'),
}));
const provider = computed(() => options.value?.providers.find((item) => item.id === policy.providerId));
const draftPolicy = () => ({
  ...policy,
  automaticScopes: [...(policy.automaticScopes ?? [])],
  embedding: embeddingEnabled.value
    ? {
        url: embedding.url,
        model: embedding.model,
        credentialRef: embedding.credentialRef,
        dimensions: embedding.dimensions ? Number(embedding.dimensions) : undefined,
        queryPrefix: embedding.queryPrefix,
        documentPrefix: embedding.documentPrefix,
      }
    : undefined,
});
const editorDirty = computed(() => editing.value && JSON.stringify(form) !== editorBaseline.value);
const policyDirty = computed(() => !!options.value && (JSON.stringify(draftPolicy()) !== policyBaseline.value || !!embeddingCredential.value));
const dirty = computed(() => editorDirty.value || policyDirty.value);
const historicalRevision = computed(() => !!editingId.value && editingVersion.value !== detail.value?.revisions[0]?.version);
const scopeLabel = (id: string) => options.value?.scopes.find((scope) => scope.id === id)?.label ?? id;
const rpc = <T,>(method: string, params: Record<string, unknown> = {}) =>
  call<T>(method, { conversationId: state.conversationId ?? undefined, workspaceId: state.workspaceId || undefined, ...params });
const date = (value?: number) => (value === undefined ? '' : new Date(value).toISOString().slice(0, 16));
const fromDate = (value: string) => (value ? Date.parse(value + 'Z') : undefined);
// 控件只显示到分钟，未编辑的时间保留原秒和毫秒，避免普通文字修改改变时效。
const savedDate = (value: string, original?: number) => (value === date(original) ? original : fromDate(value));
const stamp = (value?: number) => (value === undefined ? t('uiMemoryImportFileNotRecorded') : new Date(value).toLocaleString(shellLocale.value));
const topicParts = (value: string) =>
  value
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
function setPolicy(value: LongMemoryPolicy) {
  Object.assign(policy, { ...value, automaticScopes: [...(value.automaticScopes ?? [])] });
  embeddingEnabled.value = !!value.embedding;
  Object.assign(embedding, {
    url: value.embedding?.url ?? '',
    model: value.embedding?.model ?? '',
    credentialRef: value.embedding?.credentialRef,
    dimensions: value.embedding?.dimensions ? String(value.embedding.dimensions) : '',
    queryPrefix: value.embedding?.queryPrefix ?? '',
    documentPrefix: value.embedding?.documentPrefix ?? '',
  });
  embeddingCredential.value = '';
  policyBaseline.value = JSON.stringify(draftPolicy());
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function requestRecords(cursor?: string) {
  const common = { scopeId: scopeId.value, text: appliedQuery.value || undefined, topic: topicPath.value };
  if (relatedSearch.value)
    return { mode: 'related' as const, value: await rpc<LongMemoryRecall>('memory.search', { ...common, kinds: kind.value ? [kind.value] : undefined }) };
  return {
    mode: 'list' as const,
    value: await rpc<LongMemoryBrowseResult>('memory.browse', {
      ...common,
      kind: kind.value || undefined,
      confidence: filterConfidence.value || undefined,
      status: filterStatus.value,
      limit: 40,
      cursor,
    }),
  };
}
function applyRecords(found: Awaited<ReturnType<typeof requestRecords>>) {
  if (found.mode === 'related') {
    result.value = found.value;
    browseResult.value = undefined;
  } else {
    browseResult.value = found.value;
    result.value = undefined;
  }
  selectedIds.value = selectedIds.value.filter((id) => visibleRecords.value.some((record) => record.id === id && record.active));
}
async function loadRecordPage(direction: 'next' | 'previous') {
  const cursor = direction === 'next' ? browseResult.value?.nextCursor : recordTrail.value.at(-1);
  const current = ++epoch;
  loading.value = true;
  try {
    const found = await requestRecords(cursor);
    if (current !== epoch) return;
    if (direction === 'next') recordTrail.value.push(recordCursor.value);
    else recordTrail.value.pop();
    recordCursor.value = cursor;
    applyRecords(found);
  } finally {
    if (current === epoch) loading.value = false;
  }
}
async function refreshJobs() {
  const scope = scopeId.value;
  if (!scope) return;
  const list = await rpc<LongMemoryJob[]>('memory.jobs', { scopeId: scope });
  if (scope === scopeId.value) jobs.value = list.sort((a, b) => b.updatedAt - a.updatedAt);
}
async function reload() {
  if (!scopeId.value) return;
  const current = ++epoch,
    scope = scopeId.value;
  loading.value = true;
  topicCursor.value = undefined;
  try {
    const [found, directory, list] = await Promise.all([
      requestRecords(),
      rpc<LongMemoryTopicPage>('memory.topics', { scopeId: scope, topic: topicPath.value }),
      rpc<LongMemoryJob[]>('memory.jobs', { scopeId: scope }),
    ]);
    if (current !== epoch) return;
    applyRecords(found);
    recordCursor.value = undefined;
    recordTrail.value = [];
    topics.value = directory.topics;
    topicCursor.value = directory.nextCursor;
    jobs.value = list.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    if (current === epoch) loading.value = false;
  }
}
async function loadOptions() {
  const next = await rpc<Options>('memory.options');
  options.value = next;
  if (!policyDirty.value || !policyBaseline.value) setPolicy(next.policy.value);
  if (!scopeId.value || !next.scopes.some((scope) => scope.id === scopeId.value)) scopeId.value = next.scopes[0]?.id ?? '';
  await reload();
}
function resetEditor() {
  editorEpoch++;
  editing.value = false;
  detail.value = undefined;
  editingId.value = '';
  deleteImpact.value = null;
  changedElsewhere.value = false;
  graphSource.value = undefined;
}
async function navigate(action: () => Promise<void> | void) {
  if (busy.value) return;
  if (editorDirty.value) {
    pendingNavigation.value = action;
    return;
  }
  await perform(async () => {
    await action();
  });
}
async function choose(id: string, version?: number) {
  const current = ++editorEpoch,
    scope = scopeId.value,
    data = await rpc<Detail>('memory.get', { scopeId: scope, id, version });
  if (current !== editorEpoch) return;
  if (!data.revisions.length) {
    resetEditor();
    return;
  }
  const record = version === undefined ? data.revisions[0] : data.revisions.find((item) => item.version === version);
  if (!record) throw new Error(t('uiMemoryLibraryRevisionUnavailable'));
  detail.value = data;
  editingScopeId.value = scope;
  editingId.value = id;
  editingVersion.value = record.version;
  editing.value = true;
  changedElsewhere.value = false;
  deleteImpact.value = null;
  Object.assign(form, {
    text: record.text,
    kind: record.kind,
    subject: record.subject,
    topic: record.topic.join(' / '),
    attribute: record.attribute ?? '',
    value: record.value ?? '',
    validFrom: date(record.validFrom),
    validTo: date(record.validTo),
    eventAt: date(record.eventAt),
    confidence: record.confidence,
  });
  editorBaseline.value = JSON.stringify(form);
  graphSource.value = undefined;
  graphLimit.value = 40;
  await nextTick();
  editor.value?.scrollIntoView({ block: 'nearest' });
}
async function loadMoreTopics() {
  if (!topicCursor.value) return;
  const current = epoch;
  const page = await rpc<LongMemoryTopicPage>('memory.topics', { scopeId: scopeId.value, topic: topicPath.value, cursor: topicCursor.value });
  if (current !== epoch) return;
  topics.value.push(...page.topics);
  topicCursor.value = page.nextCursor;
  if (!page.topics.length && page.requiredTokenBudget) throw new Error(t('uiMemoryLibraryTopicBudgetExceeded'));
}
async function latestRevision() {
  const scope = editingScopeId.value,
    id = editingId.value;
  await navigate(async () => {
    scopeId.value = scope;
    await choose(id);
  });
}
async function browseImport(id: string) {
  await navigate(async () => {
    resetEditor();
    scopeId.value = id;
    section.value = 'records';
    topicPath.value = [];
    searchText.value = '';
    appliedQuery.value = '';
    kind.value = '';
    filterConfidence.value = '';
    filterStatus.value = 'all';
    searchMode.value = 'list';
    await loadOptions();
  });
}
function create() {
  resetEditor();
  editing.value = true;
  editingScopeId.value = scopeId.value;
  editorView.value = 'edit';
  Object.assign(form, {
    text: '',
    kind: 'fact',
    subject: '',
    topic: topicPath.value.join(' / '),
    attribute: '',
    value: '',
    validFrom: '',
    validTo: '',
    eventAt: '',
    confidence: 'confirmed',
  });
  editorBaseline.value = JSON.stringify(form);
}
async function save() {
  if (historicalRevision.value) throw new Error(t('uiMemoryLibraryEditLatestRevisionRequired'));
  const original = detail.value?.revisions.find((record) => record.version === editingVersion.value);
  const params = {
    scopeId: editingScopeId.value,
    text: form.text,
    kind: form.kind,
    subject: form.subject || undefined,
    topic: topicParts(form.topic),
    attribute: form.attribute || (editingId.value ? null : undefined),
    value: form.value || (editingId.value ? null : undefined),
    validFrom: savedDate(form.validFrom, original?.validFrom),
    validTo: savedDate(form.validTo, original?.validTo) ?? (editingId.value ? null : undefined),
    eventAt: savedDate(form.eventAt, original?.eventAt) ?? (editingId.value ? null : undefined),
    confidence: form.confidence,
  };
  const saved = await rpc<{ records: LongMemoryRecord[] }>(editingId.value ? 'memory.revise' : 'memory.remember', {
    ...params,
    ...(editingId.value ? { id: editingId.value, expectedVersion: editingVersion.value } : {}),
  });
  notice.value = t('uiMemoryLibraryMemorySaved');
  scopeId.value = editingScopeId.value;
  await reload();
  await choose(saved.records[0].id);
}
async function showImpact() {
  deleteImpact.value = await rpc('memory.impact', { scopeId: editingScopeId.value, id: editingId.value, action: 'delete' });
}
async function remove() {
  await rpc('memory.remove', { scopeId: editingScopeId.value, id: editingId.value, expectedVersion: editingVersion.value, action: 'delete' });
  resetEditor();
  notice.value = t('uiMemoryLibraryMemoryRemoved');
  await reload();
}
async function savePolicy() {
  const saved = await rpc<Options['policy']>('memory.policy.save', {
    value: draftPolicy(),
    expectedRevision: options.value!.policy.revision,
    embeddingCredential: embeddingCredential.value || undefined,
  });
  options.value!.policy = saved;
  setPolicy(saved.value);
  notice.value = t('uiMemoryLibraryOrganizationSaved');
}
async function exportScope() {
  const archive = await rpc<LongMemoryArchive>('memory.export', { scopeId: scopeId.value });
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = t('uiMemoryLibraryArchiveFilenamePrefix') + new Date().toISOString().slice(0, 10) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readImport(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await perform(async () => {
    if (file.size > 32 * 1024 * 1024) throw new Error(t('uiMemoryLibraryArchiveTooLarge'));
    const value = JSON.parse(await file.text()) as LongMemoryArchive;
    if (
      value.format !== 'graycode-long-memory' ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      !Array.isArray(value.sources) ||
      !Array.isArray(value.scopes) ||
      !Array.isArray(value.tombstones)
    )
      throw new Error(t('uiMemoryLibraryInvalidArchive'));
    importPreview.value = value;
  });
}
async function restore() {
  const restored = await rpc<{ records: number; sources: number; skipped: number }>('memory.restore', { archive: importPreview.value });
  importPreview.value = null;
  notice.value = t('uiMemoryLibraryArchiveMerged', { value1: restored.records, value2: restored.sources, value3: restored.skipped });
  await loadOptions();
}
async function queueSummary() {
  await rpc('memory.summary.queue', {
    scopeId: scopeId.value,
    recordIds: selectedIds.value,
    topic: topicParts(summaryTopic.value || topicPath.value.join('/')),
  });
  notice.value = t('uiMemoryLibrarySummaryTaskQueued');
  selectedIds.value = [];
  await reload();
}
async function regenerateSummary() {
  const refs = detail.value?.revisions[0].dependencies.filter((ref) => ref.kind === 'record').map((ref) => ref.id) ?? [];
  await rpc('memory.summary.queue', {
    scopeId: editingScopeId.value,
    recordIds: refs,
    topic: topicParts(form.topic),
    id: editingId.value,
    expectedVersion: editingVersion.value,
  });
  notice.value = t('uiMemoryLibrarySummariesReorganized');
  section.value = 'jobs';
  await reload();
}
async function testEmbedding() {
  const value = await rpc<{ dimensions: number }>('memory.embedding.test', { scopeId: scopeId.value });
  notice.value = t('uiMemoryLibraryConnectedDimensionsPrefix') + value.dimensions + '。';
}
async function rebuildIndex() {
  const value = await rpc<{ queued: number }>('memory.index.rebuild', { scopeId: scopeId.value });
  notice.value = t('uiMemoryLibraryRebuildScheduledPrefix') + value.queued + t('uiMemoryLibraryRebuildScheduledSuffix');
  section.value = 'jobs';
  await reload();
}
function requestClose(): boolean {
  if (busy.value) {
    notice.value = t('uiMemoryLibrarySavingPleaseWait');
    return false;
  }
  if (dirty.value) {
    pendingClose.value = true;
    return false;
  }
  return true;
}
async function discard() {
  if (pendingClose.value) {
    emit('close');
    return;
  }
  const action = pendingNavigation.value;
  pendingNavigation.value = null;
  resetEditor();
  await action?.();
}
function discardChanges() {
  pendingClose.value = false;
  pendingNavigation.value = null;
  resetEditor();
  if (options.value) setPolicy(options.value.policy.value);
}
defineExpose({ requestClose, dirty, busy, discardChanges });
async function loadGraph() {
  const request = ++graphEpoch;
  graph.value = undefined;
  graphError.value = '';
  if (editorView.value !== 'graph' || !editingId.value) {
    graphLoading.value = false;
    return;
  }
  graphLoading.value = true;
  try {
    const value = await rpc<LongMemoryGraph>('memory.graph', {
      scopeId: editingScopeId.value,
      id: editingId.value,
      version: editingVersion.value,
      limit: graphLimit.value,
    });
    if (request === graphEpoch) graph.value = value;
  } catch (cause) {
    if (request === graphEpoch) graphError.value = (cause as Error).message;
  } finally {
    if (request === graphEpoch) graphLoading.value = false;
  }
}
async function selectGraphNode(node: LongMemoryGraphNode) {
  if (node.type === 'source') {
    graphSource.value = detail.value?.sources.find((source) => source.id === node.id && source.version === node.version);
    return;
  }
  if (node.id === editingId.value && node.version === editingVersion.value) {
    editorView.value = 'edit';
    return;
  }
  await navigate(async () => {
    scopeId.value = node.scopeId;
    await choose(node.id, node.version);
  });
}
watch([editorView, editingId, editingVersion, graphLimit], () => {
  void loadGraph();
});
let unsubscribe = () => {};
onMounted(() => {
  void perform(loadOptions);
  unsubscribe = subscribe((event) => {
    if (['memory.changed', 'memory.indexed', 'memory.job.changed'].includes(event.type) && (!event.scopeId || event.scopeId === scopeId.value)) {
      if (editingId.value && event.type === 'memory.changed') changedElsewhere.value = true;
      refreshRecords ||= event.type === 'memory.changed' || (event.type === 'memory.indexed' && relatedSearch.value);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const reloadRecords = refreshRecords;
        refreshRecords = false;
        void (reloadRecords ? reload() : refreshJobs()).catch((cause) => (error.value = (cause as Error).message));
      }, 180);
    }
  });
});
onUnmounted(() => {
  epoch++;
  editorEpoch++;
  graphEpoch++;
  unsubscribe();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>
<template>
  <section class="memory-library" :aria-label="t('uiMemoryLibraryLongTermMemory')">
    <div class="memory-toolbar">
      <label v-if="section !== 'imports'">
        {{ t('uiMemoryLibraryRange') }}
        <select
          v-model="scopeId"
          :disabled="busy"
          :aria-label="t('uiMemoryLibraryMemoryScope')"
          @change="
            topicPath = [];
            selectedIds = [];
            perform(reload);
          "
        >
          <option v-for="scope in options?.scopes" :key="scope.id" :value="scope.id">{{ scope.label }}</option>
        </select>
      </label>
      <nav :aria-label="t('uiMemoryLibraryMemoryManagement')">
        <button :aria-pressed="section === 'records'" @click="section = 'records'">{{ t('uiMemoryLibraryBrowseAndEdit') }}</button>
        <button :aria-pressed="section === 'imports'" @click="section = 'imports'">{{ t('uiMemoryLibraryImportedLibrary') }}</button>
        <button :aria-pressed="section === 'organize'" @click="section = 'organize'">{{ t('uiMemoryLibraryOrganizationSettings') }}</button>
        <button
          :aria-pressed="section === 'jobs'"
          @click="
            section = 'jobs';
            perform(refreshJobs);
          "
        >
          {{ t('uiMemoryLibraryBackgroundTasks') }}
        </button>
      </nav>
      <span v-if="loading" class="memory-muted" role="status">{{ t('uiComputerPaneLoading') }}</span>
    </div>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="memory-notice" role="status">{{ notice }}</p>
    <div v-if="pendingClose || pendingNavigation" class="memory-confirm">
      <span>{{ t('uiMemoryLibraryUnsavedChangesHelp') }}</span>
      <button
        @click="
          pendingClose = false;
          pendingNavigation = null;
        "
      >
        {{ t('uiMemoryLibraryKeepCurrentEdits') }}
      </button>
      <button @click="perform(discard)">{{ t('uiMemoryLibraryDiscardAndContinue') }}</button>
    </div>
    <div v-if="importPreview" class="memory-confirm">
      <span>
        {{ t('uiMemoryLibraryMergeArchivePrefix') }} {{ importPreview.scopes.length }} {{ t('uiMemoryLibraryScopeCountSuffix')
        }}{{ importPreview.records.length }} {{ t('uiMemoryLibraryMemoryVersionCountSuffix') }} {{ importPreview.sources.length }}
        {{ t('uiMemoryLibrarySourceVersionMergeSuffix') }}
      </span>
      <button :disabled="busy" @click="perform(restore)">{{ t('uiMemoryLibraryConfirmArchiveMerge') }}</button>
      <button @click="importPreview = null">{{ t('uiBrowserPaneCancel') }}</button>
    </div>
    <div v-show="section === 'records'" class="memory-columns">
      <aside>
        <form
          class="memory-search"
          @submit.prevent="
            appliedQuery = searchText;
            perform(reload);
          "
        >
          <input
            v-model="searchText"
            :disabled="busy"
            :aria-label="t('uiMemoryLibrarySearchLongTermMemory')"
            :placeholder="t('uiMemoryLibraryMemorySearchPlaceholder')"
          />
          <button :disabled="busy" type="submit">{{ t('uiMemoryLibrarySearch') }}</button>
        </form>
        <label class="memory-filter">
          {{ t('uiMemoryLibrarySearchMethod') }}
          <select
            v-model="searchMode"
            :disabled="busy"
            :aria-label="t('uiMemoryLibraryMemorySearchMethod')"
            @change="
              filterConfidence = '';
              filterStatus = 'current';
              perform(reload);
            "
          >
            <option value="related">{{ t('uiMemoryLibraryRelevanceSearch') }}</option>
            <option value="list">{{ t('uiMemoryLibraryBrowseKeywordSearch') }}</option>
          </select>
        </label>
        <label class="memory-filter">
          {{ t('uiMemoryLibraryCategory') }}
          <select v-model="kind" :disabled="busy" @change="perform(reload)">
            <option value="">{{ t('uiMemoryLibraryAllCategories') }}</option>
            <option v-for="(label, key) in kinds" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <label class="memory-filter">
          {{ t('uiMemoryLibraryVerificationStatus') }}
          <select
            v-model="filterConfidence"
            :disabled="busy"
            :aria-label="t('uiMemoryLibraryFilterVerificationStatus')"
            @change="
              searchMode = 'list';
              perform(reload);
            "
          >
            <option value="">{{ t('uiMemoryLibraryAllStatuses') }}</option>
            <option value="confirmed">{{ t('uiMemoryLibraryConfirmed') }}</option>
            <option value="inferred">{{ t('uiMemoryLibraryAwaitingVerification') }}</option>
            <option value="disputed">{{ t('uiMemoryLibraryDisputed') }}</option>
          </select>
        </label>
        <label class="memory-filter">
          {{ t('uiMemoryLibraryValidity') }}
          <select
            v-model="filterStatus"
            :disabled="busy"
            :aria-label="t('uiMemoryLibraryFilterValidity')"
            @change="
              searchMode = 'list';
              perform(reload);
            "
          >
            <option value="current">{{ t('uiMemoryLibraryValidVersions') }}</option>
            <option value="all">{{ t('uiMemoryLibraryLatestRevisions') }}</option>
            <option value="inactive">{{ t('uiMemoryLibraryInactiveVersions') }}</option>
          </select>
        </label>
        <p class="memory-muted">{{ t('uiMemoryLibrarySearchMethodHelp') }}</p>
        <div class="memory-path">
          <button
            @click="
              topicPath = [];
              perform(reload);
            "
          >
            {{ t('uiMemoryLibraryAllTopics') }}
          </button>
          <button
            v-for="(part, index) in topicPath"
            :key="index"
            @click="
              topicPath = topicPath.slice(0, index + 1);
              perform(reload);
            "
          >
            {{ part }}
          </button>
        </div>
        <button
          v-for="topic in topics"
          :key="topic.scopeId + topic.path.join('/')"
          class="memory-topic"
          @click="
            topicPath = topic.path;
            perform(reload);
          "
        >
          <span>{{ topic.path.at(-1) }}</span>
          <small>
            {{ topic.records }} {{ t('uiMemoryLibraryEntryCountSuffix') }}
            <span v-if="topic.summaries.length">{{ t('uiMemoryLibraryHasSummarySuffix') }}</span>
          </small>
        </button>
        <button v-if="topicCursor" class="memory-topic" :disabled="busy || loading" @click="perform(loadMoreTopics)">
          {{ t('uiMemoryLibraryLoadMoreTopics') }}
        </button>
        <div class="memory-side-actions">
          <button :disabled="busy || !scopeId" @click="navigate(create)">{{ t('uiMemoryLibraryAddMemory') }}</button>
          <button :disabled="busy || !scopeId" @click="perform(exportScope)">{{ t('uiMemoryLibraryExportCurrentScope') }}</button>
          <label class="memory-import">
            {{ t('uiMemoryLibraryMergeArchive') }}
            <input type="file" accept=".json" :disabled="busy" @change="readImport" />
          </label>
        </div>
        <p class="memory-muted">{{ t('uiMemoryLibraryScopeBrowsingHelp') }}</p>
      </aside>
      <main :class="{ 'has-selection': editing }">
        <div v-if="result" class="memory-result-meta">
          <span>
            {{ result.method === 'hybrid' ? t('uiMemoryLibraryKeywordAndSemantic') : t('uiMemoryLibraryKeyword') }} · {{ result.hits.length }}
            {{ t('uiMemoryLibraryRelevantResultsCount') }}
          </span>
          <span v-if="result.truncated">{{ t('uiMemoryLibraryRelevantResultsHelp') }}</span>
        </div>
        <div v-if="browseResult" class="memory-pagination">
          <span v-if="loading">{{ t('uiMemoryLibraryLoadingMemories') }}</span>
          <span v-else>
            {{
              browseResult.total
                ? `${browseResult.offset + 1}–${browseResult.offset + browseResult.items.length} / ${browseResult.total}`
                : t('uiMemoryLibraryNoEntriesCount')
            }}
            {{ t('uiMemoryLibraryBrowseEntriesSuffix') }}
          </span>
          <button :disabled="busy || loading" @click="perform(reload)">{{ t('uiMemoryLibraryRefreshList') }}</button>
          <button :disabled="busy || loading || !recordTrail.length" @click="perform(() => loadRecordPage('previous'))">
            {{ t('uiMemoryLibraryPreviousMemoryPage') }}
          </button>
          <button :disabled="busy || loading || !browseResult.nextCursor" @click="perform(() => loadRecordPage('next'))">
            {{ t('uiMemoryLibraryNextMemoryPage') }}
          </button>
        </div>
        <div v-if="selectedIds.length" class="memory-summary-actions">
          <span>{{ t('uiMemoryLibrarySelected') }} {{ selectedIds.length }} {{ t('uiMemoryLibraryEntryCountSuffix') }}</span>
          <input v-model="summaryTopic" :aria-label="t('uiMemoryLibrarySummaryTopic')" :placeholder="t('uiMemoryLibrarySummaryTopicPlaceholder')" />
          <button :disabled="busy" @click="perform(queueSummary)">{{ t('uiMemoryLibrarySummarizeSelectedEvidence') }}</button>
        </div>
        <div class="memory-records" :aria-busy="loading">
          <div v-for="record in visibleRecords" :key="record.id" class="memory-record" :class="{ selected: editingId === record.id }">
            <input
              v-model="selectedIds"
              type="checkbox"
              :value="record.id"
              :disabled="busy || loading || !record.active"
              :title="record.active ? t('uiMemoryLibrarySelectSummaryEvidence') : t('uiMemoryLibraryInvalidSummaryEvidence')"
              :aria-label="t('uiMemoryLibrarySelectMemoryPrefix') + record.id"
            />
            <button :disabled="busy || loading" @click="navigate(() => choose(record.id, record.version))">
              <span class="memory-record-meta">
                {{ kinds[record.kind] }} · {{ origins[record.origin] }}
                <span v-if="record.confidence !== 'confirmed'">
                  · {{ record.confidence === 'inferred' ? t('uiMemoryLibraryNeedsVerification') : t('uiMemoryLibraryDisputed') }}
                </span>
                <span v-if="!record.active">{{ t('uiMemoryLibraryInactiveVersionSuffix') }}</span>
                <span v-if="record.conflicts.length">{{ t('uiMemoryLibraryConflictingAccountsSuffix') }}</span>
              </span>
              <strong>{{ record.preview }}</strong>
              <small v-if="record.moreText">{{ t('uiMemoryLibraryViewFullText') }}</small>
              <small>
                {{ record.topic.join(' / ') || t('uiMemoryLibraryUncategorized') }}
                <template v-if="record.reasons.length">· {{ record.reasons.join(' + ') }}</template>
              </small>
            </button>
          </div>
        </div>
        <p v-if="!visibleRecords.length && !loading" class="memory-empty">{{ t('uiMemoryLibraryNoMatchingMemories') }}</p>
        <section v-if="editing" ref="editor" class="memory-editor" :aria-label="t('uiMemoryLibraryMemoryEditor')">
          <header>
            <strong>
              {{ historicalRevision ? t('uiMemoryLibraryViewRevisionHistory') : editingId ? t('uiMemoryLibraryEditMemory') : t('uiMemoryLibraryAddMemory') }}
            </strong>
            <span>{{ scopeLabel(editingScopeId) }}</span>
            <code v-if="editingId">{{ editingId.slice(0, 12) }} · v{{ editingVersion }}</code>
          </header>
          <p v-if="historicalRevision" class="memory-warning">
            {{ t('uiMemoryLibraryHistoricalVersionDisplayed') }}
            <button :disabled="busy" @click="latestRevision">{{ t('uiMemoryLibraryReturnToLatestRevision') }}</button>
          </p>
          <nav v-if="editingId" class="memory-editor-tabs" :aria-label="t('uiMemoryLibraryMemoryViewMode')">
            <button :aria-pressed="editorView === 'edit'" @click="editorView = 'edit'">{{ t('uiMemoryLibraryEditText') }}</button>
            <button :aria-pressed="editorView === 'graph'" @click="editorView = 'graph'">{{ t('uiMemoryLibraryViewRelationships') }}</button>
          </nav>
          <template v-if="editorView === 'graph'">
            <p v-if="editorDirty" class="memory-warning">{{ t('uiMemoryLibrarySavedGraphHelp') }}</p>
            <p v-if="graphLoading" class="memory-muted" role="status">{{ t('uiMemoryLibraryLoadingRelationships') }}</p>
            <p v-if="graphError" class="memory-error" role="alert">{{ graphError }}</p>
            <MemoryGraph
              v-if="graph"
              :graph="graph"
              :busy="busy"
              :can-expand="graphLimit < 100"
              @select="selectGraphNode"
              @more="graphLimit = Math.min(100, graphLimit + 30)"
            />
            <aside v-if="graphSource" class="memory-source-preview">
              <header>
                <strong>{{ t('uiMemoryLibrarySourceTextLabel') }} {{ origins[graphSource.origin] }}</strong>
                <button @click="graphSource = undefined">{{ t('uiMemoryLibraryCollapseOriginalText') }}</button>
              </header>
              <blockquote>{{ graphSource.text }}</blockquote>
              <MemorySourceFiles :key="graphSource.id" :source="graphSource" />
            </aside>
          </template>
          <div v-show="editorView === 'edit'">
            <p v-if="changedElsewhere" class="memory-muted">{{ t('uiMemoryLibraryScopeUpdatedHelp') }}</p>
            <p v-if="detail && detail.activeVersion !== editingVersion" class="memory-warning">{{ t('uiMemoryLibraryInactiveRevisionHelp') }}</p>
            <label>
              {{ t('uiComputerPaneBodyText') }}
              <textarea v-model="form.text" :readonly="historicalRevision" rows="5" :aria-label="t('uiMemoryLibraryMemoryText')"></textarea>
            </label>
            <div class="memory-form-grid">
              <label>
                {{ t('uiMemoryLibraryCategory') }}
                <select v-model="form.kind" :disabled="form.kind === 'summary' || historicalRevision">
                  <option v-for="(label, key) in kinds" :key="key" :value="key" :disabled="key === 'summary' && form.kind !== 'summary'">{{ label }}</option>
                </select>
              </label>
              <label>
                {{ t('uiMemoryLibraryVerificationStatus') }}
                <select v-model="form.confidence" :disabled="historicalRevision">
                  <option value="confirmed">{{ t('uiMemoryLibraryConfirmed') }}</option>
                  <option value="inferred">{{ t('uiMemoryLibraryAwaitingVerification') }}</option>
                  <option value="disputed">{{ t('uiMemoryLibraryDisputed') }}</option>
                </select>
              </label>
              <label>
                {{ t('uiMemoryLibrarySubject') }}
                <input v-model="form.subject" :readonly="historicalRevision" :placeholder="t('uiMemoryLibrarySubjectPlaceholder')" />
              </label>
              <label>
                {{ t('uiMemoryLibraryTopicHierarchy') }}
                <input v-model="form.topic" :readonly="historicalRevision" :placeholder="t('uiMemoryLibraryTopicHierarchyPlaceholder')" />
              </label>
              <label>
                {{ t('uiMemoryLibraryAttribute') }}
                <input v-model="form.attribute" :readonly="historicalRevision" :placeholder="t('uiMemoryLibraryAttributePlaceholder')" />
              </label>
              <label>
                {{ t('uiMemoryLibraryAttributeValue') }}
                <input v-model="form.value" :readonly="historicalRevision" :placeholder="t('uiMemoryLibraryAttributeValuePlaceholder')" />
              </label>
              <label>
                {{ t('uiMemoryLibraryValidFrom') }}
                <input v-model="form.validFrom" :readonly="historicalRevision" type="datetime-local" />
              </label>
              <label>
                {{ t('uiMemoryLibraryValidUntil') }}
                <input v-model="form.validTo" :readonly="historicalRevision" type="datetime-local" />
              </label>
              <label>
                {{ t('uiMemoryLibraryEventTime') }}
                <input v-model="form.eventAt" :readonly="historicalRevision" type="datetime-local" />
              </label>
            </div>
            <div class="memory-editor-actions">
              <button :disabled="busy || historicalRevision || !form.text.trim()" @click="perform(save)">{{ t('uiMemoryLibrarySaveMemory') }}</button>
              <button v-if="editingId" :disabled="busy || historicalRevision" @click="perform(showImpact)">{{ t('uiMemoryLibraryViewDeletionImpact') }}</button>
              <button v-if="form.kind === 'summary' && editingId" :disabled="busy || historicalRevision" @click="perform(regenerateSummary)">
                {{ t('uiMemoryLibraryReorganizeCurrentEvidence') }}
              </button>
              <button :disabled="busy" @click="navigate(resetEditor)">{{ t('uiMemoryLibraryCollapseEditor') }}</button>
            </div>
          </div>
          <div v-if="deleteImpact" class="memory-confirm">
            <p>{{ t('uiMemoryLibraryRemoveMemoryPrefix') }} {{ deleteImpact.recordCount }} {{ t('uiMemoryLibraryRemoveMemorySuffix') }}</p>
            <ul>
              <li v-for="item in deleteImpact.items" :key="item.id">{{ kinds[item.kind] }}：{{ item.text }}</li>
            </ul>
            <p v-if="deleteImpact.truncated">
              {{ t('uiMemoryLibraryDeletionListPrefix') }} {{ deleteImpact.items.length }} {{ t('uiMemoryLibraryDeletionListSuffix') }}
            </p>
            <button :disabled="busy" class="memory-delete" @click="perform(remove)">{{ t('uiMemoryLibraryConfirmDeleteContent') }}</button>
            <button @click="deleteImpact = null">{{ t('uiBrowserPaneCancel') }}</button>
          </div>
          <details v-if="detail" open class="memory-evidence">
            <summary>{{ t('uiMemoryLibrarySourcesAndDependencies') }}</summary>
            <article v-for="source in detail.sources" :key="source.id + '@' + source.version">
              <div>
                {{ origins[source.origin] }} · {{ source.reference?.label || source.reference?.messageId || t('uiMemoryLibrarySourceExcerpts') }} ·
                {{ stamp(source.recordedAt) }}
              </div>
              <blockquote>{{ source.text }}</blockquote>
              <MemorySourceFiles :source="source" />
            </article>
            <article v-for="parent in detail.parents" :key="parent.id + '@' + parent.version">
              <button
                @click="
                  scopeId = editingScopeId;
                  navigate(() => choose(parent.id, parent.version));
                "
              >
                {{ t('uiComputerPaneExpand') }} {{ kinds[parent.kind] }} · {{ parent.id.slice(0, 12) }}@{{ parent.version }}
              </button>
              <p>{{ parent.text }}</p>
            </article>
            <p v-if="!detail.sources.length && !detail.parents.length" class="memory-muted">{{ t('uiMemoryLibrarySourceRemovedHelp') }}</p>
          </details>
          <details v-if="detail && detail.revisions.length > 1" class="memory-revisions">
            <summary>{{ t('uiMemoryLibraryRevisionHistoryPrefix') }}{{ detail.revisions.length }}）</summary>
            <article v-for="revision in detail.revisions" :key="revision.version">
              <small>
                v{{ revision.version }} · {{ stamp(revision.recordedAt) }} {{ t('uiMemoryLibraryValidFromPrefix') }} {{ stamp(revision.validFrom) }}
                {{ t('uiMemoryLibraryValidLabel') }}
              </small>
              <button
                :disabled="busy || revision.version === editingVersion"
                @click="
                  scopeId = editingScopeId;
                  navigate(() => choose(revision.id, revision.version));
                "
              >
                {{ t('uiMemoryLibraryViewRevision') }}
              </button>
              <p>{{ revision.text }}</p>
            </article>
          </details>
          <details v-if="detail?.relations?.length" class="memory-evidence">
            <summary>{{ t('uiMemoryLibraryRelatedMemoriesPrefix') }}{{ detail.relations.length }}）</summary>
            <article v-for="related in detail.relations" :key="related.id">
              <button
                @click="
                  scopeId = editingScopeId;
                  navigate(() => choose(related.id, related.version));
                "
              >
                {{ t('uiMemoryLibraryViewRelatedPrefix') }} {{ related.subject }}
              </button>
              <p>{{ related.text }}</p>
            </article>
          </details>
        </section>
      </main>
    </div>
    <MemoryImports v-if="section === 'imports'" @browse="browseImport" />
    <section v-show="section === 'organize'" class="memory-organization" :aria-label="t('uiMemoryLibraryMemoryOrganizationSettings')">
      <div class="memory-form-grid">
        <fieldset>
          <legend>{{ t('uiMemoryLibraryBackgroundOrganization') }}</legend>
          <label>
            {{ t('uiMemoryLibraryOrganizationChannel') }}
            <select v-model="policy.providerId" @change="policy.model = provider?.model || ''">
              <option value="">{{ t('uiMemoryLibrarySelectOrganizationChannel') }}</option>
              <option v-for="item in options?.providers" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <label>
            {{ t('uiMemoryLibraryOrganizationModel') }}
            <input v-model="policy.model" list="memory-model-options" :placeholder="t('uiMemoryLibraryOrganizationModelPlaceholder')" />
            <datalist id="memory-model-options"><option v-for="model in provider?.models" :key="model" :value="model" /></datalist>
          </label>
          <label>
            {{ t('uiMemoryLibraryOutputLimitIncludingReasoning') }}
            <input v-model.number="policy.extractionOutputTokens" type="number" min="1024" max="32768" :aria-label="t('uiMemoryLibraryOutputLimit')" />
            <small class="settings-help">{{ t('uiMemoryLibraryOutputLimitHelp') }}</small>
          </label>
        </fieldset>
      </div>
      <fieldset>
        <legend>{{ t('uiMemoryLibrarySemanticSearch') }}</legend>
        <label class="memory-check">
          <input v-model="embeddingEnabled" type="checkbox" />
          {{ t('uiMemoryLibraryEmbeddingSearch') }}
        </label>
        <div v-if="embeddingEnabled" class="memory-form-grid">
          <label>
            {{ t('uiMemoryLibraryEmbeddingEndpoint') }}
            <input v-model="embedding.url" :placeholder="t('uiMemoryLibraryEmbeddingEndpointPlaceholder')" />
          </label>
          <label>
            {{ t('uiMemoryLibraryEmbeddingModel') }}
            <input v-model="embedding.model" :placeholder="t('uiMemoryLibraryEmbeddingModelPlaceholder')" />
          </label>
          <label>
            {{ t('uiMemoryLibraryCredentials') }}
            <input
              v-model="embeddingCredential"
              type="password"
              autocomplete="new-password"
              :placeholder="embedding.credentialRef ? t('uiMemoryLibrarySavedCredentialsPlaceholder') : t('uiMemoryLibraryLocalCredentialsPlaceholder')"
            />
          </label>
          <label>
            {{ t('uiMemoryLibraryRequestedDimensionsOptional') }}
            <input
              v-model="embedding.dimensions"
              type="number"
              min="1"
              max="16384"
              :placeholder="t('uiMemoryLibraryReturnedDimensionsPlaceholder')"
              :aria-label="t('uiMemoryLibraryRequestedDimensions')"
            />
            <small class="settings-help">{{ t('uiMemoryLibraryRequestedDimensionsHelp') }}</small>
          </label>
          <label>
            {{ t('uiMemoryLibraryQueryPrefixRequired') }}
            <input v-model="embedding.queryPrefix" :aria-label="t('uiMemoryLibraryQueryPrefix')" />
            <small class="settings-help">{{ t('uiMemoryLibraryQueryPrefixHelp') }}</small>
          </label>
          <label>
            {{ t('uiMemoryLibraryTextPrefixOptional') }}
            <input v-model="embedding.documentPrefix" :aria-label="t('uiMemoryLibraryTextPrefix')" />
            <small class="settings-help">{{ t('uiMemoryLibraryTextPrefixHelp') }}</small>
          </label>
        </div>
        <p class="memory-muted">{{ t('uiMemoryLibraryEmbeddingConfigurationHelp') }}</p>
      </fieldset>
      <div class="memory-editor-actions">
        <button :disabled="busy || !policyDirty" @click="perform(savePolicy)">{{ t('uiMemoryLibrarySaveOrganizationSettings') }}</button>
        <button :disabled="busy || policyDirty || !embeddingEnabled" @click="perform(testEmbedding)">{{ t('uiMemoryLibraryTestEmbeddingConnection') }}</button>
        <button :disabled="busy || policyDirty || !embeddingEnabled" @click="perform(rebuildIndex)">{{ t('uiMemoryLibraryRebuildScopeIndex') }}</button>
      </div>
    </section>
    <section v-show="section === 'jobs'" class="memory-jobs" :aria-label="t('uiMemoryLibraryMemoryBackgroundTasks')">
      <p class="memory-muted">{{ t('uiMemoryLibraryBackgroundTaskUsageHelp') }}</p>
      <p v-if="!jobs.length" class="memory-empty">{{ t('uiMemoryLibraryNoBackgroundTasks') }}</p>
      <article v-for="job in jobs" :key="job.id">
        <header>
          <strong>
            {{
              job.kind === 'embed'
                ? t('uiMemoryLibraryVectorIndex')
                : job.kind === 'summarize'
                  ? t('uiMemoryLibraryHierarchicalSummaries')
                  : t('uiMemoryLibrarySourceExtraction')
            }}
          </strong>
          <span>{{ statuses[job.status] }}</span>
          <small>{{ stamp(job.updatedAt) }}</small>
        </header>
        <p>
          {{ job.usage?.servedModel || job.model || job.providerId }} {{ t('uiMemoryLibraryAttemptLabel') }} {{ job.attempts }} {{ t('uiMemoryLibraryCalls') }}
        </p>
        <div class="memory-job-usage">
          <span>{{ t('uiMemoryLibraryType') }} {{ job.usage?.input ?? t('uiMemoryLibraryUnknown') }}</span>
          <span>{{ t('uiMemoryLibraryOutput') }} {{ job.usage?.output ?? t('uiMemoryLibraryUnknown') }}</span>
          <span>{{ t('uiMemoryLibraryIncludedReasoning') }} {{ job.usage?.thoughts ?? t('uiMemoryLibraryUnknown') }}</span>
          <span>{{ t('uiMemoryLibraryCacheReads') }} {{ job.usage?.cacheRead ?? t('uiMemoryLibraryUnknown') }}</span>
        </div>
        <p v-if="job.error" class="memory-error">{{ job.error }}</p>
        <button
          v-if="['failed', 'interrupted'].includes(job.status)"
          :disabled="busy"
          @click="
            perform(async () => {
              await rpc('memory.job.retry', { scopeId: job.scopeId, id: job.id });
              await reload();
            })
          "
        >
          {{ t('uiMemoryLibraryRetryTask') }}
        </button>
        <button
          v-if="['pending', 'running'].includes(job.status)"
          :disabled="busy"
          @click="
            perform(async () => {
              await rpc('memory.job.cancel', { scopeId: job.scopeId, id: job.id });
              await reload();
            })
          "
        >
          {{ t('uiMemoryLibraryStopTask') }}
        </button>
      </article>
    </section>
  </section>
</template>
<style scoped src="./memoryLibrary.css"></style>
