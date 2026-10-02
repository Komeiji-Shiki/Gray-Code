<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { LanguageDocumentStatus } from '@graycode/contracts';
import * as monaco from '../monaco';
import { appearance, report } from "../state";
import { ensureEditorLanguage } from '../editorLanguages';
import { appearancePalette, resolvedTheme } from '../appearance';
import { applyWorkbenchTheme, WORKBENCH_THEME } from "../editorAppearance";
import { bindLanguageDocument, editorUri } from "../languages";
import { bindEditorUndo, workspaceEditorServices } from '../editorWorkspaceEdits';
import { bindEditorDebugging } from '../editorDebugging';
import { documentLanguageId, editorLanguageId } from '../../../../shared/documentLanguages';
import { documentChangeRegion, type DocumentChangeRegion } from '../../../../shared/documentPatch';
const props = defineProps<{ workspaceId: string; path: string; value: string; version: number;
  flush: () => Promise<unknown>; open: (path: string, range?: monaco.IRange, focus?: boolean) => Promise<void>;
  selection?: monaco.IRange }>();
const emit = defineEmits<{ change: [value: string, edit?: { previous: string; region: DocumentChangeRegion }]; save: []; problems: []; outline: []; ready: [model: monaco.editor.ITextModel] }>();
const root = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let applying = false;
// 模型当前全文（含 BOM）的已知副本：父组件回传本组件刚发出的同一字符串时无需再取全文比较，
// 也是变更范围所基于的文本；挂载前为 undefined。
let synced: string | undefined;
let language: ReturnType<typeof bindLanguageDocument> | undefined;
const languageState = ref<LanguageDocumentStatus>({ languageId: '' });
const diagnosticCounts = ref({ errors: 0, warnings: 0 });
const cursor = ref({ lineNumber: 1, column: 1 });
let markerListener: monaco.IDisposable | undefined;
let undoBinding: monaco.IDisposable | undefined;
let debugBinding: monaco.IDisposable | undefined;
const languageLabel = computed(() => {
  const state = languageState.value;
  if (state.error || state.session?.status === 'failed') return '语言服务异常';
  if (state.session === undefined || state.session?.status === 'starting') return '语言服务正在启动';
  if (state.session?.status === 'stopped') return '语言服务已停止';
  if (state.session) return state.session.name;
  if (state.reason === 'disabled') return `${state.languageId} · 语言服务已停用`;
  if (state.reason === 'unavailable') return `${state.languageId} · 需要安装语言服务`;
  return `${state.languageId} · 语法着色`;
});
function suggest() { editor?.focus(); editor?.trigger('graycode', 'editor.action.triggerSuggest', {}); }
function quickFix() { editor?.focus(); editor?.trigger('graycode', 'editor.action.codeAction', { kind: 'quickfix', apply: 'never' }); }
function options() {
  return {
    fontFamily: appearance.value?.codeFont,
    fontSize: appearance.value?.codeFontSize,
    lineHeight: Math.round(
      (appearance.value?.codeFontSize ?? 14) *
        (appearance.value?.lineHeight ?? 1.6),
    ),
    theme: WORKBENCH_THEME,
  };
}
onMounted(() => {
  void ensureEditorLanguage(editorLanguageId(documentLanguageId(props.path))).catch(report);
  editor = monaco.editor.create(root.value!, {
    value: props.value,
    model: undefined,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    minimap: { enabled: false },
    glyphMargin: true,
    scrollBeyondLastLine: false,
    padding: { top: 14 },
    ...options(),
    theme: resolvedTheme.value === 'light' ? 'vs' : 'vs-dark',
  }, workspaceEditorServices);
  applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light');
  const initial = editor.getModel();
  const uri = editorUri(props.workspaceId, props.path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.value, editorLanguageId(documentLanguageId(props.path)), uri);
  editor.setModel(model);
  initial?.dispose();
  undoBinding = bindEditorUndo(editor);
  debugBinding = bindEditorDebugging(editor, props.workspaceId, props.path);
  language = bindLanguageDocument({ model, workspaceId: props.workspaceId, path: props.path, version: () => props.version, flush: props.flush, open: props.open,
    status: value => { languageState.value = value; } });
  const updateCounts = () => {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    diagnosticCounts.value = { errors: markers.filter(item => item.severity === monaco.MarkerSeverity.Error).length,
      warnings: markers.filter(item => item.severity === monaco.MarkerSeverity.Warning).length };
  };
  markerListener = monaco.editor.onDidChangeMarkers(uris => { if (uris.some(uri => uri.toString() === model.uri.toString())) updateCounts(); });
  updateCounts();
  if (props.selection) { editor.setSelection(props.selection); editor.revealRangeInCenter(props.selection); }
  synced = model.getValue(undefined, true);
  editor.onDidChangeModelContent(event => {
    language?.clearMarkers();
    if (applying) return;
    const previous = synced, value = model.getValue(undefined, true);
    synced = value;
    // 重置与换行符切换没有可靠的局部范围（EOL 切换可能不带 changes），BOM 也可能随重置变化。
    // Monaco 偏移不含 BOM；同一模型的普通编辑不改变 BOM，按当前全文与无 BOM 长度之差补偿。
    const region = previous === undefined || event.isFlush || event.isEolChange ? undefined
      : documentChangeRegion(event.changes, value.length - model.getValueLength());
    emit("change", value, region && previous !== undefined ? { previous, region } : undefined);
  });
  editor.onDidChangeCursorPosition(event => { cursor.value = event.position; });
  editor.addAction({ id: 'graycode.showCompletions', label: '显示代码补全', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ], run: suggest });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
    emit("save"),
  );
  emit('ready', model);
});
watch(
  () => props.value,
  (value) => {
    // 输入回传的是刚发出的同一字符串，引用相同即可跳过全文比较。
    if (!editor || value === synced) return;
    const model = editor.getModel();
    synced = model?.getValue(undefined, true);
    if (synced !== value) {
      applying = true;
      try { editor.setValue(value); } finally { applying = false; }
      // 以模型实际内容为准：setValue 可能统一换行符，之后的变更范围都基于规范化后的文本。
      synced = model?.getValue(undefined, true);
    }
  },
);
watch(() => props.version, () => language?.updateMarkers());
watch(() => props.selection, selection => { if (selection && editor) { editor.setSelection(selection); editor.revealRangeInCenter(selection); editor.focus(); } });
watch(appearance, () => editor?.updateOptions(options()), { deep: true });
watch([appearancePalette, resolvedTheme], () => { if (editor) applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light'); });
onUnmounted(() => {
  debugBinding?.dispose();
  undoBinding?.dispose();
  markerListener?.dispose();
  language?.dispose();
  const model = editor?.getModel();
  editor?.dispose();
  model?.dispose();
});
</script>
<template>
  <div class="code-editor code-editor-shell">
    <div ref="root" class="code-editor-canvas"></div>
    <footer class="editor-status">
      <button class="editor-diagnostics" :class="{ errors: diagnosticCounts.errors }" title="打开问题面板" @click="emit('problems')">错误 {{ diagnosticCounts.errors }} · 警告 {{ diagnosticCounts.warnings }}</button>
      <button title="显示代码补全（Ctrl+空格 / Ctrl+J）" @click="suggest">补全</button>
      <button title="格式化当前文件（Shift+Alt+F）" @click="editor?.getAction('editor.action.formatDocument')?.run()">格式化</button>
      <button title="查看当前文件大纲" @click="emit('outline')">大纲</button>
      <button v-if="diagnosticCounts.errors || diagnosticCounts.warnings" title="显示当前位置的快速修复（Ctrl+.）" @click="quickFix">修复</button>
      <span class="editor-language" :class="{ errors: languageState.error || languageState.session?.status === 'failed' }" :title="languageState.error ?? languageState.session?.error ?? languageState.service?.requirement ?? languageLabel">{{ languageLabel }}</span>
      <button v-if="languageState.error || ['failed', 'stopped'].includes(languageState.session?.status ?? '')" @click="language?.refresh()">重试</button>
      <span class="editor-cursor">行 {{ cursor.lineNumber }}，列 {{ cursor.column }}</span>
    </footer>
  </div>
</template>
<style scoped>
.code-editor-shell{height:100%;min-height:0;display:flex;flex-direction:column}.code-editor-canvas{flex:1;min-height:0}
:deep(.debug-breakpoint),:deep(.debug-breakpoint-disabled),:deep(.debug-breakpoint-pending),:deep(.debug-logpoint){width:10px!important;height:10px!important;margin:6px 0 0 6px;background:#e56b6b;clip-path:circle(50%)}:deep(.debug-breakpoint-disabled){background:#777}:deep(.debug-breakpoint-pending){background:transparent;border:2px solid #e56b6b}:deep(.debug-logpoint){clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);background:#e7b864}:deep(.debug-execution-line){background:#dbc34f20}:deep(.debug-execution-arrow){background:#e1c250;clip-path:polygon(15% 15%,85% 50%,15% 85%);width:12px!important}
.editor-status{display:flex;align-items:center;gap:10px;min-height:28px;padding:2px 9px;background:var(--gc-surface-raised);color:var(--gc-text-muted);font-size:11px;flex-shrink:0}
.editor-status button{border:0;border-radius:var(--gc-radius-sm);background:transparent;color:inherit;padding:3px 0;font:inherit;cursor:pointer;white-space:nowrap}.editor-status button:hover{color:var(--gc-text-primary)}.editor-language{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.editor-cursor{white-space:nowrap}.editor-status .errors{color:var(--gc-danger)}
@media(max-width:850px){.editor-status{flex-wrap:wrap;gap:3px 10px}.editor-language{min-width:100px}.editor-cursor{margin-left:auto}}
</style>
