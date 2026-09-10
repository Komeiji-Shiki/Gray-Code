<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import { appearance } from "../state";
import { workbenchEditorTheme } from "../editorAppearance";
import { bindLanguageDocument, editorUri } from "../languages";
const props = defineProps<{ workspaceId: string; path: string; value: string; version: number;
  flush: () => Promise<unknown>; open: (path: string, range?: monaco.IRange, focus?: boolean) => Promise<void>;
  selection?: monaco.IRange }>();
const emit = defineEmits<{ change: [value: string]; save: [] }>();
const root = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let applying = false;
let language: ReturnType<typeof bindLanguageDocument> | undefined;
function options() {
  return {
    fontFamily: appearance.value?.codeFont,
    fontSize: appearance.value?.codeFontSize,
    lineHeight: Math.round(
      (appearance.value?.codeFontSize ?? 14) *
        (appearance.value?.lineHeight ?? 1.6),
    ),
    theme: workbenchEditorTheme(appearance.value?.theme),
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
  language = bindLanguageDocument({ model, workspaceId: props.workspaceId, path: props.path, version: () => props.version, flush: props.flush, open: props.open });
  if (props.selection) { editor.setSelection(props.selection); editor.revealRangeInCenter(props.selection); }
  editor.onDidChangeModelContent(() => {
    if (!applying) emit("change", editor!.getValue());
  });
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
onUnmounted(() => {
  language?.dispose();
  const model = editor?.getModel();
  editor?.dispose();
  model?.dispose();
});
</script>
<template><div ref="root" class="code-editor"></div></template>
