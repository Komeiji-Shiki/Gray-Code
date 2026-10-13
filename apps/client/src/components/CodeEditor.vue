<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { DocumentState, LanguageDocumentStatus } from '@graycode/contracts';
import * as monaco from '../monaco';
import { appearance } from '../state';
import { appearancePalette, resolvedTheme } from '../appearance';
import { applyWorkbenchTheme, WORKBENCH_THEME } from '../editorAppearance';
import { bindEditorUndo, workspaceEditorServices } from '../editorWorkspaceEdits';
import { bindEditorDebugging } from '../editorDebugging';
import type { WorkbenchDocumentModel, WorkbenchDocumentModels } from '../workbenchModels';
const props = defineProps<{ document: DocumentState; models: WorkbenchDocumentModels; selection?: monaco.IRange }>();
const emit = defineEmits<{ save: []; problems: []; outline: [] }>();
const root = ref<HTMLDivElement>();
const binding = shallowRef<WorkbenchDocumentModel>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let markerListener: monaco.IDisposable | undefined;
let undoBinding: monaco.IDisposable | undefined;
let debugBinding: monaco.IDisposable | undefined;
const language = computed(() => binding.value?.language);
const languageState = computed<LanguageDocumentStatus>(() => binding.value?.languageState.value ?? { languageId: '' });
const diagnosticCounts = ref({ errors: 0, warnings: 0 });
const cursor = ref({ lineNumber: 1, column: 1 });
const languageLabel = computed(() => {
  const state = languageState.value;
  if (state.error || state.session?.status === 'failed') return t('uiCodeEditorLanguageServiceError');
  if (state.session === undefined || state.session?.status === 'starting') return t('uiCodeEditorLanguageServiceStarting');
  if (state.session?.status === 'stopped') return t('uiCodeEditorLanguageServiceStopped');
  if (state.session) return state.session.name;
  if (state.reason === 'disabled') return t('uiCodeEditorLanguageServiceDisabled', { value1: state.languageId });
  if (state.reason === 'unavailable') return t('uiCodeEditorLanguageServiceMissing', { value1: state.languageId });
  return t('uiCodeEditorSyntaxHighlighting', { value1: state.languageId });
});
function suggest() { editor?.focus(); editor?.trigger('graycode', 'editor.action.triggerSuggest', {}); }
function quickFix() { editor?.focus(); editor?.trigger('graycode', 'editor.action.codeAction', { kind: 'quickfix', apply: 'never' }); }
function options() {
  return { fontFamily: appearance.value?.codeFont, fontSize: appearance.value?.codeFontSize,
    lineHeight: Math.round((appearance.value?.codeFontSize ?? 14) * (appearance.value?.lineHeight ?? 1.6)), theme: WORKBENCH_THEME };
}
function updateCounts() {
  const model = editor?.getModel();
  const markers = model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
  diagnosticCounts.value = { errors: markers.filter(item => item.severity === monaco.MarkerSeverity.Error).length,
    warnings: markers.filter(item => item.severity === monaco.MarkerSeverity.Warning).length };
}
function applySelection() {
  const entry = binding.value, selection = props.selection;
  if (!entry || !selection || selection === entry.selection || !editor) return;
  entry.selection = selection;
  editor.setSelection(selection); editor.revealRangeInCenter(selection); editor.focus();
}
function switchDocument() {
  if (!editor) return;
  if (binding.value) binding.value.viewState = editor.saveViewState();
  debugBinding?.dispose();
  const entry = props.models.prepare(props.document);
  binding.value = entry;
  editor.setModel(entry.model);
  if (entry.viewState) editor.restoreViewState(entry.viewState);
  debugBinding = bindEditorDebugging(editor, props.document.workspaceId, props.document.path);
  applySelection(); updateCounts();
  cursor.value = editor.getPosition() ?? { lineNumber: 1, column: 1 };
}
onMounted(() => {
  editor = monaco.editor.create(root.value!, { model: null, automaticLayout: true, fixedOverflowWidgets: true,
    minimap: { enabled: false }, glyphMargin: true, scrollBeyondLastLine: false, padding: { top: 14 }, ...options(),
    theme: resolvedTheme.value === 'light' ? 'vs' : 'vs-dark' }, workspaceEditorServices);
  applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light');
  undoBinding = bindEditorUndo(editor);
  markerListener = monaco.editor.onDidChangeMarkers(uris => {
    const model = editor?.getModel();
    if (model && uris.some(uri => uri.toString() === model.uri.toString())) updateCounts();
  });
  editor.onDidChangeCursorPosition(event => { cursor.value = event.position; });
  editor.addAction({ id: 'graycode.showCompletions', label: t('uiCodeEditorShowCompletion'),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ], run: suggest });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'));
  switchDocument();
});
watch(() => [props.document, props.document.workspaceId, props.document.path], switchDocument);
watch(() => props.selection, applySelection);
watch(appearance, () => editor?.updateOptions(options()), { deep: true });
watch([appearancePalette, resolvedTheme], () => {
  if (editor) applyWorkbenchTheme(appearancePalette.value, resolvedTheme.value === 'light');
});
onUnmounted(() => {
  if (binding.value) binding.value.viewState = editor?.saveViewState() ?? null;
  debugBinding?.dispose(); undoBinding?.dispose(); markerListener?.dispose(); editor?.dispose();
});
</script>
<template>
  <div class="code-editor code-editor-shell">
    <div ref="root" class="code-editor-canvas"></div>
    <footer class="editor-status">
      <button class="editor-diagnostics" :class="{ errors: diagnosticCounts.errors }" :title="t('uiCodeEditorOpenProblems')" @click="emit('problems')">
        {{ t('uiCodeEditorError') }} {{ diagnosticCounts.errors }} {{ t('uiCodeEditorWarnings') }} {{ diagnosticCounts.warnings }}
      </button>
      <button :title="t('uiCodeEditorCompletionShortcut')" @click="suggest">{{ t('uiCodeEditorComplete') }}</button>
      <button :title="t('uiCodeEditorFormatFileShortcut')" @click="editor?.getAction('editor.action.formatDocument')?.run()">
        {{ t('uiCodeEditorFormat') }}
      </button>
      <button :title="t('uiCodeEditorViewOutline')" @click="emit('outline')">{{ t('uiCodeEditorOutline') }}</button>
      <button v-if="diagnosticCounts.errors || diagnosticCounts.warnings" :title="t('uiCodeEditorQuickFixShortcut')" @click="quickFix">
        {{ t('uiCodeEditorFix') }}
      </button>
      <span
        class="editor-language"
        :class="{ errors: languageState.error || languageState.session?.status === 'failed' }"
        :title="languageState.error ?? languageState.session?.error ?? languageState.service?.requirement ?? languageLabel"
      >
        {{ languageLabel }}
      </span>
      <button v-if="languageState.error || ['failed', 'stopped'].includes(languageState.session?.status ?? '')" @click="language?.refresh()">
        {{ t('retry') }}
      </button>
      <span class="editor-cursor">{{ t('uiCodeEditorLines') }} {{ cursor.lineNumber }}{{ t('uiCodeEditorColumnSeparator') }} {{ cursor.column }}</span>
    </footer>
  </div>
</template>
<style scoped>
.code-editor-shell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.code-editor-canvas {
  flex: 1;
  min-height: 0;
}
:deep(.debug-breakpoint),
:deep(.debug-breakpoint-disabled),
:deep(.debug-breakpoint-pending),
:deep(.debug-logpoint) {
  width: 10px !important;
  height: 10px !important;
  margin: 6px 0 0 6px;
  background: var(--gc-danger);
  clip-path: circle(50%);
}
:deep(.debug-breakpoint-disabled) {
  background: var(--gc-text-disabled);
}
:deep(.debug-breakpoint-pending) {
  background: transparent;
  border: 2px solid var(--gc-danger);
}
:deep(.debug-logpoint) {
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  background: var(--gc-warning);
}
:deep(.debug-execution-line) {
  background: color-mix(in srgb, var(--gc-warning) 13%, transparent);
}
:deep(.debug-execution-arrow) {
  background: var(--gc-warning);
  clip-path: polygon(15% 15%, 85% 50%, 15% 85%);
  width: 12px !important;
}
.editor-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 2px 9px;
  background: var(--gc-surface-raised);
  color: var(--gc-text-muted);
  font-size: 11px;
  flex-shrink: 0;
}
.editor-status button {
  border: 0;
  border-radius: var(--gc-radius-sm);
  background: transparent;
  color: inherit;
  padding: 3px 0;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.editor-status button:hover {
  color: var(--gc-text-primary);
}
.editor-language {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.editor-cursor {
  white-space: nowrap;
}
.editor-status .errors {
  color: var(--gc-danger);
}
@media (max-width: 850px) {
  .editor-status {
    flex-wrap: wrap;
    gap: 3px 10px;
  }
  .editor-language {
    min-width: 100px;
  }
  .editor-cursor {
    margin-left: auto;
  }
}
</style>
