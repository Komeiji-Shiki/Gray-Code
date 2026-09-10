<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { LanguageDiagnostic, LanguageSessionInfo, SourceRange } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { guard, state } from '../state';
const emit = defineEmits<{ open: [path: string, range: SourceRange] }>();
const results = ref<Array<{ uri: string; diagnostics: LanguageDiagnostic[] }>>([]);
const sessions = ref<LanguageSessionInfo[]>([]);
const count = computed(() => results.value.reduce((sum, item) => sum + item.diagnostics.length, 0));
let generation = 0;
async function refresh() {
  const workspaceId = state.workspaceId; const current = ++generation;
  if (!workspaceId) { results.value = []; sessions.value = []; return; }
  const [diagnostics, status] = await Promise.all([
    call<typeof results.value>('language.diagnostics', { workspaceId }),
    call<{ sessions: LanguageSessionInfo[] }>('language.list'),
  ]);
  if (current !== generation) return;
  results.value = diagnostics; sessions.value = status.sessions.filter(session => session.workspaceId === workspaceId);
}
async function open(uri: string, selection: SourceRange) {
  const path = await call<string>('language.path', { workspaceId: state.workspaceId, uri });
  emit('open', path, selection);
}
function fileName(uri: string) { try { return decodeURIComponent(new URL(uri).pathname); } catch { return uri; } }
const unsubscribe = subscribe(event => {
  if (event.type === 'language.diagnostics' && event.workspaceId === state.workspaceId) {
    results.value = [...results.value.filter(item => item.uri !== event.uri), { uri: event.uri, diagnostics: event.diagnostics }];
  } else if (event.type === 'language.status' && event.session.workspaceId === state.workspaceId) {
    sessions.value = [...sessions.value.filter(item => item.id !== event.session.id), event.session];
  }
});
watch(() => state.workspaceId, () => void guard(refresh), { immediate: true });
onUnmounted(() => { generation++; unsubscribe(); });
</script>
<template>
  <section class="problems-panel">
    <header><strong>问题 · {{ count }}</strong><button @click="guard(refresh)">刷新</button></header>
    <div v-for="session in sessions" :key="session.id" class="language-status">
      <span>{{ session.name }} · {{ ({ starting: '正在启动', running: '已连接', stopped: '已停止', failed: '失败' })[session.status] }}</span>
      <button @click="guard(async () => { await call('language.restart', { id: session.id }); await refresh(); })">重启</button>
      <p v-if="session.error">{{ session.error }}</p>
    </div>
    <p v-if="!count" class="no-problems">{{ sessions.some(session => session.status === 'running') ? '当前没有诊断信息。' : '打开受支持的代码文件后，语言服务将在这里显示状态和问题。' }}</p>
    <template v-for="item in results" :key="item.uri"><div v-if="item.diagnostics.length" class="file-problems">
      <div class="file-name">{{ fileName(item.uri) }}</div>
      <button v-for="(diagnostic, index) in item.diagnostics" :key="index" class="problem" @click="guard(() => open(item.uri, diagnostic.range))">
        <span :class="diagnostic.severity === 1 ? 'error' : 'warning'">{{ diagnostic.severity === 1 ? '错误' : diagnostic.severity === 2 ? '警告' : '提示' }}</span>
        <span>{{ diagnostic.message }}</span><small>{{ diagnostic.range.start.line + 1 }}:{{ diagnostic.range.start.character + 1 }}</small>
      </button>
    </div></template>
  </section>
</template>
<style scoped>
.problems-panel{padding:12px;overflow:auto;height:100%;box-sizing:border-box;font-size:12px}header,.language-status{display:flex;gap:12px;align-items:center;margin-bottom:10px}.language-status{flex-wrap:wrap;color:var(--muted)}.language-status p{width:100%;white-space:pre-wrap;color:var(--error,#f08080);margin:0}header button{margin-left:auto}button{border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);padding:5px 9px;cursor:pointer}.file-name{padding:8px 0;color:var(--muted);overflow-wrap:anywhere}.problem{display:grid;grid-template-columns:34px 1fr auto;gap:8px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border);padding:7px 0;background:transparent}.error{color:var(--error,#f08080)}.warning{color:#c8ad69}small,.no-problems{color:var(--muted)}
</style>
