<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import { call, subscribe } from "../api";
import { appearance } from '../state';
import { resolvedTheme } from '../appearance';
import { workbenchEditorTheme } from '../editorAppearance';
import NavigationIcon from './navigation/NavigationIcon.vue';

type DiffStatus = "pending" | "accepted" | "rejected" | "cancelled";
interface WorkspaceDiff {
  id: string; conversationId: string; workspaceId: string; path: string;
  originalText: string; proposedText: string; status: DiffStatus; toolCallId: string;
  diffGuardWarning?: string; error?: string;
}
const MAX_DIFFS = 100;
const props = defineProps<{ workspaceId: string }>();
const diffs = ref<WorkspaceDiff[]>([]);
const selectedId = ref("");
const loading = ref(false);
const listVisible = ref(true);
const statusLabels: Record<DiffStatus, string> = { pending: '等待处理', accepted: '已接受', rejected: '已拒绝', cancelled: '已取消' };
const error = ref("");
const actionError = ref("");
const processingId = ref("");
const editorRoot = ref<HTMLDivElement>();
let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let originalModel: monaco.editor.ITextModel | undefined;
let proposedModel: monaco.editor.ITextModel | undefined;
const selected = () => diffs.value.find((diff) => diff.id === selectedId.value);

async function load() {
  if (!props.workspaceId) { diffs.value = []; selectedId.value = ""; return; }
  loading.value = true; error.value = "";
  try {
    const result = await call<WorkspaceDiff[]>("workspace.diffs.list", { workspaceId: props.workspaceId });
    const next = Array.isArray(result) ? result.slice(0, MAX_DIFFS) : [];
    diffs.value = next;
    if (!next.some((diff) => diff.id === selectedId.value)) selectedId.value = next[0]?.id ?? "";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}
function disposeModels() {
  diffEditor?.setModel(null);
  originalModel?.dispose(); proposedModel?.dispose(); originalModel = undefined; proposedModel = undefined;
}
function showSelected() {
  const diff = selected();
  if (!diffEditor || !diff) { disposeModels(); diffEditor?.setModel(null); return; }
  disposeModels();
  originalModel = monaco.editor.createModel(diff.originalText, undefined, monaco.Uri.from({ scheme: 'graycode-review', authority: diff.id, path: '/original/' + diff.path }));
  proposedModel = monaco.editor.createModel(diff.proposedText, undefined, monaco.Uri.from({ scheme: 'graycode-review', authority: diff.id, path: '/proposed/' + diff.path }));
  diffEditor.setModel({ original: originalModel, modified: proposedModel });
}
async function resolve(accepted: boolean) {
  const diff = selected();
  if (!diff || diff.status !== "pending" || processingId.value) return;
  processingId.value = diff.id; actionError.value = "";
  try { await call("workspace.diffs.resolve", { id: diff.id, accepted }); await load(); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { processingId.value = ""; }
}
watch(() => props.workspaceId, () => void load(), { immediate: true });
watch(selectedId, showSelected);
watch(diffs, showSelected, { deep: true });
onMounted(() => {
  if (!editorRoot.value) return;
  diffEditor = monaco.editor.createDiffEditor(editorRoot.value, {
    automaticLayout: true, readOnly: true, originalEditable: false,
    renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, theme: workbenchEditorTheme(resolvedTheme.value),
    fontFamily: appearance.value?.codeFont, fontSize: appearance.value?.codeFontSize ?? 14,
    lineHeight: Math.round((appearance.value?.codeFontSize ?? 14) * (appearance.value?.lineHeight ?? 1.6)),
    glyphMargin: false, lineNumbersMinChars: 4, padding: { top: 14, bottom: 16 },
  });
  showSelected();
});
watch(resolvedTheme, value => { if (diffEditor) monaco.editor.setTheme(workbenchEditorTheme(value)); });
const unsubscribe = subscribe((event) => {
  if (event.type === "workspace.diff.changed" && event.workspaceId === props.workspaceId) void load();
});
onUnmounted(() => { unsubscribe(); disposeModels(); diffEditor?.dispose(); diffEditor = undefined; });
</script>
<template>
  <section class="diff-panel review-panel">
    <div v-if="diffs.length > 1 && listVisible" class="diff-list">
      <header class="panel-heading"><span>{{ diffs.length }} 个文件</span><button class="icon-button" title="收起修改列表" @click="listVisible = false"><NavigationIcon name="panel" /></button></header>
      <p v-if="loading" class="empty-note">正在加载修改…</p>
      <p v-else-if="error" class="empty-note diff-error">{{ error }}</p>
      <button v-for="diff in diffs" :key="diff.id" class="diff-row" :class="{ active: diff.id === selectedId }" :title="diff.path" @click="selectedId = diff.id">
        <NavigationIcon name="file" /><span class="diff-row-path">{{ diff.path }}</span><span class="diff-status" :class="`status-${diff.status}`">{{ statusLabels[diff.status] }}</span>
      </button>
      <p v-if="!loading && !error && !diffs.length" class="empty-note">当前没有 AI 修改。</p>
    </div>
    <div class="diff-view">
      <div class="diff-toolbar">
        <button v-if="diffs.length > 1" class="review-list-toggle" title="切换修改列表" @click="listVisible = !listVisible"><NavigationIcon name="folder" /><span>{{ diffs.length }}</span></button>
        <div class="review-breadcrumb" :title="selected()?.path"><NavigationIcon name="file" /><template v-for="(part, index) in selected()?.path.split(/[\\/]/) ?? []" :key="index"><NavigationIcon v-if="index" name="chevron" /><span>{{ part }}</span></template><span v-if="!selected()">审查</span></div>
        <button class="review-refresh" title="刷新修改" @click="load"><NavigationIcon name="history" /></button>
      </div>
      <p v-if="loading && !selected()" class="empty-note">正在加载修改…</p>
      <p v-if="error" class="empty-note diff-error">{{ error }}</p>
      <p v-if="actionError" class="diff-error">{{ actionError }}</p>
      <p v-if="selected()?.diffGuardWarning" class="empty-note" role="status">{{ selected()!.diffGuardWarning }}</p>
      <p v-if="selected()?.error" class="diff-error">{{ selected()!.error }}</p>
      <div ref="editorRoot" class="diff-editor"></div>
      <div v-if="!selected() && !loading && !error" class="review-empty"><NavigationIcon name="review" /><h3>当前没有需要审查的修改</h3><p>AI 提出的文件修改会显示在这里。</p></div>
      <footer v-if="selected()" class="review-footer"><span class="diff-status" :class="`status-${selected()!.status}`">{{ statusLabels[selected()!.status] }}</span><span class="review-footer-spacer"></span><template v-if="selected()!.status === 'pending'"><button class="reject-change" :disabled="processingId === selected()!.id" @click="resolve(false)">拒绝</button><button class="accept-change" :disabled="processingId === selected()!.id" @click="resolve(true)">{{ processingId ? '正在处理…' : '接受' }}</button></template></footer>
    </div>
  </section>
</template>
<style scoped>
.review-panel{background:var(--surface,#101217)}.review-panel .diff-list{width:220px;flex-shrink:0;background:var(--panel)}.review-panel .panel-heading{height:44px;font-size:12px;padding-inline:12px}.review-panel .diff-row{gap:8px;min-height:44px;font-size:12px;border-bottom:0}.diff-row>svg{width:14px;height:14px;flex-shrink:0;color:var(--muted)}.review-panel .diff-row.active{background:var(--hover,#ffffff0a);box-shadow:inset 2px 0 var(--accent)}.review-panel .diff-status{font-size:11px;text-transform:none;white-space:nowrap}.review-panel .diff-view{position:relative}.review-panel .diff-toolbar{height:44px;min-height:44px;padding:6px 14px;gap:10px}.review-breadcrumb{display:flex;align-items:center;gap:7px;flex:1;min-width:0;overflow:hidden;white-space:nowrap;font-size:12px;color:var(--muted)}.review-breadcrumb>span{overflow:hidden;text-overflow:ellipsis}.review-breadcrumb>span:last-child{font-weight:600;color:var(--text);flex-shrink:0;max-width:70%}.review-breadcrumb>svg{width:13px;height:13px;flex-shrink:0}.review-breadcrumb>svg:not(:first-child){width:10px;opacity:.5}.review-panel button{border-radius:0}.review-refresh,.review-list-toggle{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--muted);padding:6px;cursor:pointer}.review-refresh svg,.review-list-toggle svg{width:15px;height:15px}.review-footer{display:flex;align-items:center;gap:9px;min-height:48px;padding:8px 14px;border-top:1px solid var(--border);background:var(--surface,#101217)}.review-footer-spacer{flex:1}.review-footer button{padding:6px 13px;font:inherit;font-size:12px;background:transparent;border:1px solid var(--border);cursor:pointer}.review-footer .accept-change{color:#82d69a;border-color:#3fb95055;background:#2ea04310}.review-footer .reject-change{color:#f28b86;border-color:#f8514940}.review-footer button:hover{filter:brightness(1.2)}.review-footer button:disabled{opacity:.5;cursor:wait}.review-empty{position:absolute;inset:44px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--surface,#101217);text-align:center;padding:30px;pointer-events:none}.review-empty>svg{width:32px;height:32px;color:var(--muted);opacity:.4}.review-empty h3{font-size:15px;font-weight:500;margin:0}.review-empty p{font-size:12px;color:var(--muted);margin:0}.review-panel .diff-error{padding-inline:14px;font-size:12px}@media(max-width:700px){.review-panel .diff-list{position:absolute;inset:44px auto 48px 0;z-index:10;width:220px;box-shadow:8px 0 24px #0005}.review-panel{position:relative}}
</style>
