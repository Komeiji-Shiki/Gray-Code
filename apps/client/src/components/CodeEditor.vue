<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { LanguageSessionInfo } from '@graycode/contracts';
import * as monaco from "monaco-editor";
import { appearance } from "../state";
import { resolvedTheme } from '../appearance';
import { workbenchEditorTheme } from "../editorAppearance";
import { bindLanguageDocument, editorUri } from "../languages";
const props = defineProps<{ workspaceId: string; path: string; value: string; version: number;
  flush: () => Promise<unknown>; open: (path: string, range?: monaco.IRange, focus?: boolean) => Promise<void>;
  selection?: monaco.IRange }>();
const emit = defineEmits<{ change: [value: string]; save: []; problems: [] }>();
const root = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let applying = false;
let language: ReturnType<typeof bindLanguageDocument> | undefined;
const languageState = ref<{ languageId: string; session?: LanguageSessionInfo | null; error?: string }>({ languageId: '' });
const diagnosticCounts = ref({ errors: 0, warnings: 0 });
const cursor = ref({ lineNumber: 1, column: 1 });
let markerListener: monaco.IDisposable | undefined;
const languageLabel = computed(() => {
  const state = languageState.value;
  if (state.error || state.session?.status === 'failed') return '语言服务异常';
  if (state.session === undefined || state.session?.status === 'starting') return '语言服务正在启动';
  if (state.session?.status === 'stopped') return '语言服务已停止';
  if (state.session) return state.session.name;
  return ['json', 'css', 'scss', 'less', 'html'].includes(state.languageId) ? `${state.languageId.toUpperCase()} · 本地语法支持` : `${state.languageId} · 未配置语言服务`;
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
    theme: workbenchEditorTheme(resolvedTheme.value),
  };
}
onMounted(() => {
  editor = monaco.editor.create(root.value!, {
    value: props.value,
    model: undefined,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 14 },
    ...options(),
  });
  const initial = editor.getModel();
  const uri = editorUri(props.workspaceId, props.path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.value, undefined, uri);
  editor.setModel(model);
  initial?.dispose();
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
  editor.onDidChangeModelContent(() => {
    language?.clearMarkers();
    if (!applying) emit("change", editor!.getValue());
  });
  editor.onDidChangeCursorPosition(event => { cursor.value = event.position; });
  editor.addAction({ id: 'graycode.showCompletions', label: '显示代码补全', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ], run: suggest });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
    emit("save"),
  );
});
watch(
  () => props.value,
  (value) => {
    if (editor && editor.getValue() !== value) {
      applying = true;
      editor.setValue(value);
      applying = false;
    }
  },
);
watch(() => props.version, () => language?.updateMarkers());
watch(() => props.selection, selection => { if (selection && editor) { editor.setSelection(selection); editor.revealRangeInCenter(selection); editor.focus(); } });
watch(appearance, () => editor?.updateOptions(options()), { deep: true });
watch(resolvedTheme, value => { if (editor) monaco.editor.setTheme(workbenchEditorTheme(value)); });
onUnmounted(() => {
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
      <button v-if="diagnosticCounts.errors || diagnosticCounts.warnings" title="显示当前位置的快速修复（Ctrl+.）" @click="quickFix">修复</button>
      <span class="editor-language" :class="{ errors: languageState.error || languageState.session?.status === 'failed' }" :title="languageState.error ?? languageState.session?.error ?? languageLabel">{{ languageLabel }}</span>
      <button v-if="languageState.error || ['failed', 'stopped'].includes(languageState.session?.status ?? '')" @click="language?.refresh()">重试</button>
      <span class="editor-cursor">行 {{ cursor.lineNumber }}，列 {{ cursor.column }}</span>
    </footer>
  </div>
</template>
<style scoped>
.code-editor-shell{height:100%;min-height:0;display:flex;flex-direction:column}.code-editor-canvas{flex:1;min-height:0}
.editor-status{display:flex;align-items:center;gap:10px;min-height:28px;padding:2px 9px;border-top:1px solid var(--border);background:var(--panel);color:var(--muted);font-size:11px;flex-shrink:0}
.editor-status button{border:0;border-radius:0;background:transparent;color:inherit;padding:3px 0;font:inherit;cursor:pointer;white-space:nowrap}.editor-status button:hover{color:var(--text)}.editor-language{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.editor-cursor{white-space:nowrap}.editor-status .errors{color:var(--danger,#f08080)}
@media(max-width:850px){.editor-status{flex-wrap:wrap;gap:3px 10px}.editor-language{min-width:100px}.editor-cursor{margin-left:auto}}
</style>
