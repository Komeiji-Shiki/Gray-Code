<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as monaco from '../monaco';
import { call, subscribe } from "../api";
import { appearance } from '../state';
import { appearancePalette, resolvedTheme } from '../appearance';
import { applyWorkbenchTheme } from '../editorAppearance';
import { workspaceEditorServices } from '../editorWorkspaceEdits';
import NavigationIcon from './navigation/NavigationIcon.vue';
import { ensureEditorLanguage } from '../editorLanguages';
import { documentLanguageId, editorLanguageId } from '../../../../shared/documentLanguages';
import { shellText } from '../i18n';

type DiffStatus = "pending" | "accepted" | "rejected" | "cancelled";
interface WorkspaceDiff {
  id: string; conversationId: string; workspaceId: string; path: string;
  originalText: string; proposedText: string; status: DiffStatus; toolCallId: string;
  diffGuardWarning?: string; error?: string;
}
const MAX_DIFFS = 100;
type DiffTarget = { workspaceId: string; id?: string; path?: string; toolCallId?: string };
const props = defineProps<{ workspaceId: string; target?: DiffTarget }>();
const diffs = ref<WorkspaceDiff[]>([]);
const selectedId = ref("");
const loading = ref(false);
const listVisible = ref(true);
const compactListVisible = ref(false);
const panelWidth = ref(0);
const narrow = computed(() => panelWidth.value > 0 && panelWidth.value <= 560);
const showList = computed(() => diffs.value.length > 1 && (narrow.value ? compactListVisible.value : listVisible.value));
const statusLabels = computed<Record<DiffStatus, string>>(() => ({ pending: shellText('reviewPendingStatus'), accepted: shellText('reviewAcceptedStatus'), rejected: shellText('reviewRejectedStatus'), cancelled: shellText('reviewCancelledStatus') }));
const groups = computed(() => [
  { id: 'pending', label: shellText('reviewPendingGroup'), diffs: diffs.value.filter(diff => diff.status === 'pending') },
  { id: 'processed', label: shellText('reviewProcessedGroup'), diffs: diffs.value.filter(diff => diff.status !== 'pending') },
]);
const error = ref("");
const actionError = ref("");
const processingId = ref("");
const loadedWorkspaceId = ref("");
const targetMissing = ref(false);
const panelRoot = ref<HTMLElement>();
const editorRoot = ref<HTMLDivElement>();
let resizeObserver: ResizeObserver | undefined;
let loadSequence = 0;
let resolveSequence = 0;
let disposed = false;
let requestedTarget: DiffTarget | undefined;
let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let originalModel: monaco.editor.ITextModel | undefined;
let proposedModel: monaco.editor.ITextModel | undefined;
const selected = () => loadedWorkspaceId.value === props.workspaceId
  ? diffs.value.find(diff => diff.id === selectedId.value && diff.workspaceId === props.workspaceId) : undefined;
function matchesTarget(diff: WorkspaceDiff, target: DiffTarget) {
  return diff.workspaceId === target.workspaceId && (!target.id || diff.id === target.id)
    && (!target.toolCallId || diff.toolCallId === target.toolCallId)
    && (!target.path || diff.path.replace(/\\/g, '/') === target.path.replace(/\\/g, '/'));
}
function selectTarget(next: WorkspaceDiff[]) {
  if (requestedTarget?.workspaceId === props.workspaceId) {
    const match = next.find(diff => matchesTarget(diff, requestedTarget!));
    selectedId.value = match?.id ?? ''; targetMissing.value = !match;
  } else if (!next.some(diff => diff.id === selectedId.value)) {
    selectedId.value = (next.find(diff => diff.status === 'pending') ?? next[0])?.id ?? '';
  }
}
function hideList() { if (narrow.value) compactListVisible.value = false; else listVisible.value = false; }
function toggleList() { if (narrow.value) compactListVisible.value = !compactListVisible.value; else listVisible.value = !listVisible.value; }
function selectDiff(diff: WorkspaceDiff) {
  if (diff.workspaceId !== props.workspaceId || loadedWorkspaceId.value !== props.workspaceId) return;
  requestedTarget = undefined; targetMissing.value = false; selectedId.value = diff.id;
  if (narrow.value) compactListVisible.value = false;
}

async function load() {
  const workspaceId = props.workspaceId, sequence = ++loadSequence;
  const current = () => !disposed && sequence === loadSequence && workspaceId === props.workspaceId;
  if (!workspaceId) { loading.value = false; diffs.value = []; selectedId.value = ""; return; }
  loading.value = true; error.value = "";
  try {
    const includeId = requestedTarget?.workspaceId === workspaceId ? requestedTarget.id : undefined;
    const result = await call<WorkspaceDiff[]>("workspace.diffs.list", { workspaceId, ...(includeId ? { includeId } : {}) });
    if (!current()) return;
    const next = Array.isArray(result) ? result.filter(diff => diff.workspaceId === workspaceId).slice(0, MAX_DIFFS) : [];
    loadedWorkspaceId.value = workspaceId;
    diffs.value = next;
    selectTarget(next);
  } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (current()) loading.value = false; }
}
function disposeModels() {
  diffEditor?.setModel(null);
  originalModel?.dispose(); proposedModel?.dispose(); originalModel = undefined; proposedModel = undefined;
}
function showSelected() {
  const diff = selected();
  if (!diffEditor || !diff) { disposeModels(); diffEditor?.setModel(null); return; }
  disposeModels();
  void ensureEditorLanguage(editorLanguageId(documentLanguageId(diff.path))).catch(cause => { if (selected() === diff) error.value = String(cause); });
  originalModel = monaco.editor.createModel(diff.originalText, undefined, monaco.Uri.from({ scheme: 'graycode-review', authority: diff.id, path: '/original/' + diff.path }));
  proposedModel = monaco.editor.createModel(diff.proposedText, undefined, monaco.Uri.from({ scheme: 'graycode-review', authority: diff.id, path: '/proposed/' + diff.path }));
  diffEditor.setModel({ original: originalModel, modified: proposedModel });
}
async function resolve(accepted: boolean) {
  const diff = selected();
  if (!diff || diff.workspaceId !== props.workspaceId || loadedWorkspaceId.value !== props.workspaceId
    || diff.status !== "pending" || processingId.value || (requestedTarget && !matchesTarget(diff, requestedTarget))) return;
  const workspaceId = diff.workspaceId, sequence = ++resolveSequence;
  const current = () => !disposed && sequence === resolveSequence && workspaceId === props.workspaceId;
  processingId.value = diff.id; actionError.value = "";
  try { await call("workspace.diffs.resolve", { id: diff.id, accepted }); if (current()) await load(); }
  catch (cause) { if (current() && selected()?.id === diff.id) actionError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (current()) processingId.value = ""; }
}
watch(() => [props.workspaceId, props.target] as const, ([workspaceId, target], previous) => {
  if (workspaceId !== previous?.[0]) {
    loadSequence++; resolveSequence++; loadedWorkspaceId.value = ''; diffs.value = []; selectedId.value = '';
    processingId.value = ''; actionError.value = ''; error.value = ''; compactListVisible.value = false;
    disposeModels();
  }
  requestedTarget = target?.workspaceId === workspaceId ? target : undefined;
  targetMissing.value = false;
  if (requestedTarget) { selectedId.value = ''; selectTarget(diffs.value); }
  void load();
}, { immediate: true, flush: 'sync' });
watch(selectedId, () => { actionError.value = ''; showSelected(); });
watch(diffs, showSelected, { deep: true });
onMounted(() => {
  if (panelRoot.value) {
    panelWidth.value = panelRoot.value.getBoundingClientRect().width;
    resizeObserver = new ResizeObserver(entries => { if (!disposed) panelWidth.value = entries[0]?.contentRect.width ?? 0; });
    resizeObserver.observe(panelRoot.value);
  }
  if (!editorRoot.value) return;
  diffEditor = monaco.editor.createDiffEditor(editorRoot.value, {
    automaticLayout: true, readOnly: true, originalEditable: false,
    renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, theme: resolvedTheme.value === 'light' ? 'vs' : 'vs-dark',
    fontFamily: appearance.value?.codeFont, fontSize: appearance.value?.codeFontSize ?? 14,
    lineHeight: Math.round((appearance.value?.codeFontSize ?? 14) * (appearance.value?.lineHeight ?? 1.6)),
    glyphMargin: false, lineNumbersMinChars: 4, padding: { top: 14, bottom: 16 },
  }, workspaceEditorServices);
  applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light');
  showSelected();
});
watch([appearancePalette, resolvedTheme], () => { if (diffEditor) applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light'); });
const unsubscribe = subscribe((event) => {
  if (event.type === "workspace.diff.changed" && event.workspaceId === props.workspaceId) void load();
  if (event.type === 'transport.resumed' && (event.snapshotRequired || event.authenticatedAgain)) void load();
});
onUnmounted(() => { disposed = true; loadSequence++; resolveSequence++; resizeObserver?.disconnect(); unsubscribe(); disposeModels(); diffEditor?.dispose(); diffEditor = undefined; });
</script>
<template>
  <section ref="panelRoot" class="diff-panel review-panel" :class="{ 'narrow-review': narrow, 'very-narrow-review': panelWidth > 0 && panelWidth <= 320 }">
    <div class="review-layout">
    <div v-if="showList" class="diff-list">
      <header class="panel-heading"><span>{{ shellText('reviewRecords').replace('{count}', String(diffs.length)) }}</span><button class="icon-button" :title="shellText('reviewHideList')" :aria-label="shellText('reviewHideList')" @click="hideList"><NavigationIcon name="panel" /></button></header>
      <template v-for="group in groups" :key="group.id">
        <div v-if="group.diffs.length" class="review-group" :class="`review-group-${group.id}`">
          <h3 class="review-group-heading"><span>{{ group.label }}</span><span>{{ group.diffs.length }}</span></h3>
          <button v-for="diff in group.diffs" :key="diff.id" class="diff-row" :class="{ active: diff.id === selectedId }" :title="diff.path" @click="selectDiff(diff)">
            <NavigationIcon name="file" /><span class="diff-row-path">{{ diff.path }}</span><span class="diff-status" :class="`status-${diff.status}`">{{ statusLabels[diff.status] }}</span>
          </button>
        </div>
      </template>
    </div>
    <button v-if="narrow && showList" class="review-list-backdrop" :aria-label="shellText('reviewHideList')" @click="hideList"></button>
    <div class="diff-view">
      <div class="diff-toolbar">
        <button v-if="diffs.length > 1" class="review-list-toggle" :title="shellText('reviewToggleList')" :aria-label="shellText('reviewToggleList')" :aria-expanded="showList" @click="toggleList"><NavigationIcon name="folder" /><span>{{ diffs.length }}</span></button>
        <div class="review-breadcrumb" :title="selected()?.path"><NavigationIcon name="file" /><template v-for="(part, index) in selected()?.path.split(/[\\/]/) ?? []" :key="index"><NavigationIcon v-if="index" name="chevron" /><span>{{ part }}</span></template><span v-if="!selected()">{{ shellText('reviewTitle') }}</span></div>
        <button class="review-refresh" :title="shellText('reviewRefresh')" :aria-label="shellText('reviewRefresh')" @click="load"><NavigationIcon name="history" /></button>
      </div>
      <div class="diff-body">
      <p v-if="loading && !selected()" class="empty-note">{{ shellText('reviewLoading') }}</p>
      <p v-if="error" class="empty-note diff-error">{{ error }}</p>
      <p v-if="actionError" class="diff-error">{{ actionError }}</p>
      <p v-if="selected()?.diffGuardWarning" class="empty-note" role="status">{{ selected()!.diffGuardWarning }}</p>
      <p v-if="selected()?.error" class="diff-error">{{ selected()!.error }}</p>
      <div ref="editorRoot" class="diff-editor"></div>
      <div v-if="!selected() && !loading && !error" class="review-empty"><NavigationIcon name="review" /><h3>{{ shellText(targetMissing ? 'reviewTargetMissing' : 'reviewEmptyTitle') }}</h3><p>{{ shellText(targetMissing ? 'reviewTargetMissingDetail' : 'reviewEmptyDetail') }}</p></div>
      </div>
      <footer v-if="selected()" class="review-footer"><span class="diff-status" :class="`status-${selected()!.status}`">{{ statusLabels[selected()!.status] }}</span><span class="review-footer-spacer"></span><template v-if="selected()!.status === 'pending'"><button class="reject-change" :disabled="!!processingId" @click="resolve(false)">{{ shellText('reviewReject') }}</button><button class="accept-change" :disabled="!!processingId" @click="resolve(true)">{{ shellText(processingId === selected()!.id ? 'reviewProcessing' : 'reviewAccept') }}</button></template></footer>
    </div>
    </div>
  </section>
</template>
<style scoped>
.review-panel{background:var(--gc-surface-sunken);min-width:0;overflow:hidden}.review-layout{display:flex;flex:1;min-width:0;min-height:0}.review-panel .diff-list{width:220px;flex-shrink:0;min-height:0;background:var(--gc-surface-raised)}.review-panel .panel-heading{height:44px;min-height:44px;font-size:12px;padding-inline:12px;gap:8px}.panel-heading>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel-heading>button{flex-shrink:0}.review-group-heading{display:flex;justify-content:space-between;gap:8px;margin:0;padding:10px 12px 6px;color:var(--gc-text-muted);font-size:11px;font-weight:500}.review-group-pending .review-group-heading,.review-panel .status-pending{color:var(--gc-accent)}.review-panel .diff-row{gap:8px;min-height:44px;font-size:12px;border-bottom:0}.diff-row>svg{width:14px;height:14px;flex-shrink:0;color:var(--gc-text-muted)}.review-panel .diff-row.active{background:var(--gc-surface-hover);box-shadow:inset 2px 0 var(--gc-accent)}.review-panel .diff-status{font-size:11px;text-transform:none;white-space:nowrap}.review-panel .diff-view{position:relative}.review-panel .diff-toolbar{height:44px;min-height:44px;flex-shrink:0;padding:6px 14px;gap:10px}.review-breadcrumb{display:flex;align-items:center;gap:7px;flex:1;min-width:0;overflow:hidden;white-space:nowrap;font-size:12px;color:var(--gc-text-muted)}.review-breadcrumb>span{overflow:hidden;text-overflow:ellipsis}.review-breadcrumb>span:last-child{font-weight:600;color:var(--gc-text-primary);flex-shrink:0;max-width:70%}.review-breadcrumb>svg{width:13px;height:13px;flex-shrink:0}.review-breadcrumb>svg:not(:first-child){width:10px;opacity:.5}.review-panel button{border-radius:var(--gc-radius-sm)}.review-refresh,.review-list-toggle{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--gc-text-muted);padding:6px;cursor:pointer;flex-shrink:0}.review-refresh svg,.review-list-toggle svg{width:15px;height:15px}.diff-body{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;position:relative;overflow:auto}.review-panel .diff-editor{min-height:0}.review-footer{display:flex;align-items:center;gap:9px;min-height:48px;flex-shrink:0;padding:8px 14px;border-top:1px solid var(--gc-border-subtle);background:var(--gc-surface-sunken)}.review-footer-spacer{flex:1}.review-footer button{padding:6px 13px;font:inherit;font-size:12px;background:transparent;border:1px solid var(--gc-border-subtle);cursor:pointer}.review-footer .accept-change{color:var(--gc-success);border-color:var(--gc-success-border);background:var(--gc-success-bg)}.review-footer .reject-change{color:var(--gc-danger);border-color:var(--gc-danger-border)}.review-footer button:hover{filter:brightness(1.2)}.review-footer button:disabled{opacity:.5;cursor:wait}.review-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--gc-surface-sunken);text-align:center;padding:30px;pointer-events:none}.review-empty>svg{width:32px;height:32px;color:var(--gc-text-muted);opacity:.4}.review-empty h3{font-size:15px;font-weight:500;margin:0}.review-empty p{font-size:12px;color:var(--gc-text-muted);margin:0}.review-panel .diff-error{padding-inline:14px;font-size:12px}
.narrow-review .review-layout{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:44px minmax(0,1fr) auto}.narrow-review .diff-view{display:contents}.narrow-review .diff-toolbar{grid-column:1;grid-row:1;padding-inline:8px;gap:6px}.narrow-review .diff-body{grid-column:1;grid-row:2}.narrow-review .review-footer{grid-column:1;grid-row:3}.narrow-review .diff-list{grid-column:1;grid-row:2;z-index:2;width:min(220px,100%);max-width:100%;border-right:1px solid var(--gc-border-subtle)}.review-list-backdrop{grid-column:1;grid-row:2;z-index:1;padding:0;border:0;background:#0005}.very-narrow-review .review-footer{flex-wrap:wrap;gap:6px;padding:8px}.very-narrow-review .review-footer>.diff-status{flex-basis:100%}.very-narrow-review .review-footer-spacer{display:none}.very-narrow-review .review-footer button{flex:1;min-width:0;padding:6px 8px;overflow-wrap:anywhere}.narrow-review .review-empty{padding:18px}
</style>
