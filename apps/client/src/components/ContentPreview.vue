<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { call, subscribe } from '../api';
import { report, state } from '../state';
interface Preview { id: string; title: string; content?: string; language?: string; data?: string; mimeType?: string }
const value = ref<Preview>();
watch(value, value => { state.contentPreviewOpen = !!value; }); const url = ref(''); let generation = 0;
function release() { if (url.value) URL.revokeObjectURL(url.value); url.value = ''; }
async function close() {
  generation++; const previous = value.value; value.value = undefined; release();
  if (previous) await call('ui.request', { type: 'preview.close', data: { id: previous.id } }).catch(() => {});
}
const unsubscribe = subscribe(event => {
  if (event.type !== 'workspace.preview') return;
  const request = ++generation;
  void call<Preview>('ui.request', { type: 'preview.get', data: { id: event.previewId } }).then(next => {
    if (request !== generation) return;
    const previous = value.value; release();
    if (previous) void call('ui.request', { type: 'preview.close', data: { id: previous.id } }).catch(() => {});
    if (next.data) {
      const bytes = Uint8Array.from(atob(next.data), character => character.charCodeAt(0));
      url.value = URL.createObjectURL(new Blob([bytes], { type: next.mimeType ?? 'application/octet-stream' }));
    }
    value.value = next;
  }).catch(report);
});
onUnmounted(() => { unsubscribe(); void close(); });
</script>
<template>
  <div v-if="value" class="content-preview-backdrop" @keydown.esc="close"><section class="content-preview" role="dialog" aria-modal="true" :aria-label="value.title">
    <header><strong>{{ value.title }}</strong><a v-if="url" :href="url" :download="value.title">保存附件</a><button @click="close">关闭</button></header>
    <div class="content-preview-body">
      <pre v-if="value.content !== undefined"><code>{{ value.content }}</code></pre>
      <img v-else-if="value.mimeType?.startsWith('image/')" :src="url" :alt="value.title" />
      <audio v-else-if="value.mimeType?.startsWith('audio/')" :src="url" controls />
      <video v-else-if="value.mimeType?.startsWith('video/')" :src="url" controls />
      <iframe v-else-if="value.mimeType === 'application/pdf'" :src="url" title="PDF 预览" sandbox=""></iframe>
      <p v-else>此格式可以保存后使用本机应用打开。</p>
    </div>
  </section></div>
</template>
<style scoped>
.content-preview-backdrop{position:fixed;inset:0;z-index:9500;background:#000b;display:grid;place-items:center}.content-preview{width:min(1100px,94vw);height:88vh;background:var(--surface);border:1px solid var(--border);display:flex;flex-direction:column}.content-preview header{display:flex;align-items:center;gap:18px;padding:14px 18px;border-bottom:1px solid var(--border)}header strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a{color:var(--accent)}button{border-radius:0}.content-preview-body{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:center}.content-preview-body pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;width:100%;font:13px/1.6 var(--code-font,monospace)}img,video{max-width:100%;max-height:100%;object-fit:contain}iframe{border:0;width:100%;height:100%;background:white}audio{width:min(700px,100%)}
</style>
