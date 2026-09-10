<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import MarkdownIt from 'markdown-it';
import { MarkdownRenderer } from '../common';
import { sanitizeHtml } from '../common/markdownUtils';
const props = defineProps<{ content: string; streaming?: boolean; user?: boolean }>();
const frame = ref<HTMLIFrameElement>();
const raw = ref(false);
const height = ref(140);
const frameId = crypto.randomUUID();
const markdown = new MarkdownIt({ html: true, breaks: true, linkify: true });
const hasHtml = computed(() => /<(?:div|span|style|table|section|article|details|summary|p|img|svg|html|body|h[1-6])(?:\s|>)/i.test(props.content));
let timer: ReturnType<typeof setTimeout> | undefined;
let loaded = false;
const frameUrl = new URL('./character-frame.html', window.location.href).href;
function updateFrame() {
  if (!loaded || !frame.value?.contentWindow) return;
  frame.value.contentWindow.postMessage({ id: frameId, html: sanitizeHtml(markdown.render(props.content), { allowStyles: true }) }, '*');
}
function onLoad() { loaded = true; updateFrame(); }
function onMessage(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.data?.id !== frameId || typeof event.data.height !== 'number') return;
  height.value = Math.max(40, Math.min(6000, event.data.height));
}
watch(() => props.content, () => {
  clearTimeout(timer);
  if (props.streaming) timer = setTimeout(updateFrame, 160); else updateFrame();
});
watch(raw, () => { loaded = false; });
onMounted(() => window.addEventListener('message', onMessage));
onUnmounted(() => { clearTimeout(timer); window.removeEventListener('message', onMessage); });
</script>
<template>
  <div v-if="hasHtml" class="character-fragment"><button class="source-toggle" @click="raw = !raw">{{ raw ? '显示内容' : '查看文本' }}</button>
    <pre v-if="raw">{{ content }}</pre><iframe v-else ref="frame" :src="frameUrl" sandbox="allow-scripts" referrerpolicy="no-referrer" title="角色消息 HTML 与 CSS" :style="{ height: height + 'px' }" @load="onLoad"></iframe>
  </div>
  <MarkdownRenderer v-else :content="content" :latex-only="user" :is-streaming="streaming" />
</template>
<style scoped>
.character-fragment{position:relative;min-width:0}.character-fragment iframe{display:block;width:100%;border:0;background:transparent}.source-toggle{display:block;margin-left:auto;background:transparent;border:0;color:var(--vscode-descriptionForeground);font-size:11px;cursor:pointer;padding:3px 6px}.character-fragment pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--vscode-editor-font-family,monospace)}
</style>
