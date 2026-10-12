<script setup lang="ts">
import { shellText as t } from '../i18n';
import { computed, onUnmounted, ref, watch } from 'vue';
import type { DocumentState, SourceRange } from '@graycode/contracts';
import { call } from '../api';
const props = defineProps<{ document?: DocumentState; flush: () => Promise<unknown> }>();
const emit = defineEmits<{ open: [path: string, range: SourceRange, workspaceId: string] }>();
interface OutlineEntry {
  name: string;
  detail?: string;
  kind: number;
  depth: number;
  range: SourceRange;
}
const entries = ref<OutlineEntry[]>([]);
const query = ref('');
const notice = ref('');
const busy = ref(false);
const visible = computed(() => entries.value.filter((entry) => `${entry.name} ${entry.detail ?? ''}`.toLowerCase().includes(query.value.trim().toLowerCase())));
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let requestId: string | undefined;
function cancel() {
  generation++;
  busy.value = false;
  clearTimeout(timer);
  if (requestId) void call('language.cancel', { requestId }).catch(() => {});
  requestId = undefined;
}
async function refresh() {
  cancel();
  const current = generation,
    doc = props.document;
  if (!doc) {
    entries.value = [];
    notice.value = t('uiOutlinePanelOpenCodeFileHelp');
    return;
  }
  busy.value = true;
  notice.value = '';
  try {
    await props.flush();
    // 同步编辑期间可能关闭或切换文件，已取消的请求无需再启动旧文件的语言服务。
    if (current !== generation) return;
    const ready = await call('language.ensure', { workspaceId: doc.workspaceId, path: doc.path });
    if (current !== generation) return;
    if (!ready.capabilities?.documentSymbolProvider) {
      entries.value = [];
      notice.value = t('uiOutlinePanelOutlineUnavailable');
      return;
    }
    requestId = crypto.randomUUID();
    const values = await call<any[]>('language.request', {
      workspaceId: doc.workspaceId,
      path: doc.path,
      version: doc.version,
      requestId,
      method: 'textDocument/documentSymbol',
      params: {},
    });
    if (current !== generation) return;
    const result: OutlineEntry[] = [];
    const walk = (items: any[], depth: number) => {
      for (const item of items ?? []) {
        const range = item.selectionRange ?? item.range ?? item.location?.range;
        if (range) result.push({ name: item.name, detail: item.detail ?? item.containerName, kind: item.kind, depth, range });
        if (item.children) walk(item.children, depth + 1);
      }
    };
    walk(values, 0);
    entries.value = result;
    if (!result.length) notice.value = t('uiOutlinePanelNoSymbols');
  } catch (error) {
    if (current === generation) notice.value = String(error);
  } finally {
    if (current === generation) {
      busy.value = false;
      requestId = undefined;
    }
  }
}
watch(
  () => [props.document?.workspaceId, props.document?.path],
  () => {
    entries.value = [];
    void refresh();
  },
  { immediate: true },
);
watch(
  () => props.document?.version,
  () => {
    cancel();
    timer = setTimeout(() => void refresh(), 300);
  },
);
onUnmounted(cancel);
const symbolKinds = computed<Record<number, string>>(() => ({
  5: t('uiOutlinePanelClass'),
  6: t('uiMemoryGraphMethod'),
  7: t('uiMemoryLibraryAttribute'),
  8: t('uiOutlinePanelField'),
  10: t('uiOutlinePanelEnum'),
  11: t('uiOutlinePanelInterface'),
  12: t('uiOutlinePanelFunction'),
  13: t('uiOutlinePanelVariable'),
  14: t('uiOutlinePanelConstant'),
  23: t('uiOutlinePanelStruct'),
}));
</script>
<template>
  <section class="outline-panel">
    <header>
      <strong>{{ t('uiOutlinePanelFileOutline') }}</strong>
      <button @click="refresh">{{ t('uiBrowserPaneRefresh') }}</button>
    </header>
    <p v-if="document" class="outline-path" :title="document.path">{{ document.path }}</p>
    <input v-model="query" :aria-label="t('uiOutlinePanelFilterSymbols')" :placeholder="t('uiOutlinePanelSymbolFilterPlaceholder')" />
    <p v-if="busy || notice" class="outline-notice" role="status">{{ busy ? t('uiOutlinePanelLoadingSymbols') : notice }}</p>
    <div class="outline-list">
      <button
        v-for="(entry, index) in visible"
        :key="index"
        :style="{ paddingLeft: 14 + entry.depth * 14 + 'px' }"
        :title="entry.detail || entry.name"
        @click="emit('open', document!.path, entry.range, document!.workspaceId)"
      >
        <span class="symbol-kind">{{ symbolKinds[entry.kind] ?? t('uiOutlinePanelSymbol') }}</span>
        <span>{{ entry.name }}</span>
        <small>{{ entry.range.start.line + 1 }}</small>
      </button>
    </div>
  </section>
</template>
<style scoped>
.outline-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--gc-surface-raised);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 15px;
}
button,
input {
  font: inherit;
  font-size: 12px;
  border-radius: var(--gc-radius-sm);
}
button {
  background: transparent;
  border: 1px solid var(--gc-border-control);
  padding: 5px 8px;
  color: var(--gc-text-primary);
  cursor: pointer;
}
input {
  margin: 0 14px 10px;
  min-width: 0;
  background: var(--gc-surface-sunken);
  border: 1px solid var(--gc-border-control);
  color: var(--gc-text-primary);
  padding: 8px;
}
.outline-path,
.outline-notice {
  margin: 10px 14px;
  color: var(--gc-text-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.outline-notice {
  white-space: normal;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.outline-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.outline-list button {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  width: 100%;
  text-align: left;
  padding: 8px 14px;
}
.outline-list button:hover {
  background: var(--gc-surface-hover);
}
.outline-list button > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.symbol-kind {
  font-size: 10px;
  color: var(--gc-accent);
  flex-shrink: 0;
}
small {
  color: var(--gc-text-muted);
  margin-left: auto;
}
button:focus-visible,
input:focus-visible {
  outline: 1px solid var(--gc-accent);
  outline-offset: -1px;
}
</style>
