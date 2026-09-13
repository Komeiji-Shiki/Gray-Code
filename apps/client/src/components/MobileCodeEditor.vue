<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { IRange } from 'monaco-editor';
const props = defineProps<{ value: string; path: string; selection?: IRange }>();
const emit = defineEmits<{ change: [text: string]; save: []; breakpoint: [line: number] }>();
const input = ref<HTMLTextAreaElement>();
const position = ref({ line: 1, column: 1 });
function locate() {
  const before = (input.value?.value ?? '').slice(0, input.value?.selectionStart ?? 0);
  const lines = before.split('\n'); position.value = { line: lines.length, column: lines.at(-1)!.length + 1 };
}
async function reveal() {
  const range = props.selection; if (!range) return;
  await nextTick(); const element = input.value; if (!element) return;
  const lines = props.value.split('\n');
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
  element.setSelectionRange(offset(range.startLineNumber, range.startColumn), offset(range.endLineNumber, range.endColumn));
  element.scrollTop = Math.max(0, (range.startLineNumber - 3) * 24); locate();
}
watch(() => props.selection, reveal); onMounted(reveal);
</script>
<template>
  <div class="mobile-code-editor">
    <textarea ref="input" :aria-label="`编辑 ${path}`" :value="value" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" wrap="off" @input="emit('change', ($event.target as HTMLTextAreaElement).value); locate()" @click="locate" @keyup="locate" @select="locate" @keydown.ctrl.s.prevent="emit('save')" @keydown.meta.s.prevent="emit('save')"></textarea>
    <div class="mobile-editor-position"><span>{{ path }}</span><button @click="emit('breakpoint', position.line)">当前行断点</button><span>行 {{ position.line }} · 列 {{ position.column }}</span></div>
  </div>
</template>
<style scoped>
.mobile-code-editor{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--input)}.mobile-code-editor textarea{flex:1;min-height:0;width:100%;resize:none;border:0;padding:14px 12px;font-family:var(--code-font);font-size:16px;line-height:24px;tab-size:4;white-space:pre;overscroll-behavior:contain;outline-offset:-1px}.mobile-editor-position{display:flex;justify-content:space-between;gap:14px;padding:6px 10px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)}.mobile-editor-position span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-editor-position span:last-child{flex-shrink:0}
.mobile-editor-position button{padding:0;background:transparent;border:0;border-radius:0;color:var(--text);font:inherit;white-space:nowrap}
</style>
