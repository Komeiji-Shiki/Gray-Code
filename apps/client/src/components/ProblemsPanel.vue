<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { LanguageDiagnostic, LanguageSessionInfo, SourceRange } from '@graycode/contracts';
import { call, subscribe } from '../api';
import { guard, state } from '../state';
const props = defineProps<{ workspaceId?: string }>();
const emit = defineEmits<{ open: [path: string, range: SourceRange, workspaceId: string] }>();
interface DiagnosticFile { uri: string; path?: string; diagnostics: LanguageDiagnostic[] }
const workspaceId = computed(() => props.workspaceId ?? state.workspaceId);
const results = ref<DiagnosticFile[]>([]);
const sessions = ref<LanguageSessionInfo[]>([]);
const query = ref('');
const severity = ref('all');
const counts = computed(() => {
  const all = results.value.flatMap(item => item.diagnostics);
  return { all: all.length, error: all.filter(item => (item.severity ?? 1) === 1).length,
    warning: all.filter(item => item.severity === 2).length, info: all.filter(item => (item.severity ?? 1) > 2).length };
});
function diagnosticKind(item: LanguageDiagnostic) { return (item.severity ?? 1) === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info'; }
const visible = computed(() => results.value.map(file => ({ ...file, diagnostics: file.diagnostics.filter(item =>
  (severity.value === 'all' || diagnosticKind(item) === severity.value) &&
  `${file.path ?? fileName(file.uri)} ${item.message} ${item.source ?? ''} ${item.code ?? ''}`.toLowerCase().includes(query.value.trim().toLowerCase())) })).filter(file => file.diagnostics.length));
let generation = 0;
let revision = 0;
const changedFiles = new Map<string, { revision: number; value: DiagnosticFile }>();
const changedSessions = new Map<string, { revision: number; value: LanguageSessionInfo }>();
async function refresh() {
  const workspace = workspaceId.value; const current = ++generation, started = revision;
  if (!workspace) { results.value = []; sessions.value = []; return; }
  const [diagnostics, status] = await Promise.all([
    call<DiagnosticFile[]>('language.diagnostics', { workspaceId: workspace }),
    call<{ sessions: LanguageSessionInfo[] }>('language.list'),
  ]);
  if (current !== generation) return;
  // 保留请求期间收到的更新，避免旧快照覆盖刚修正的错误或新服务状态。
  const files = new Map(diagnostics.map(item => [item.uri, item]));
  const running = new Map(status.sessions.filter(item => item.workspaceId === workspace).map(item => [item.serverId, item]));
  for (const [uri, item] of changedFiles) if (item.revision > started) files.set(uri, item.value);
  for (const [id, item] of changedSessions) if (item.revision > started) running.set(id, item.value);
  results.value = [...files.values()]; sessions.value = [...running.values()];
}
async function open(uri: string, selection: SourceRange) {
  const workspace = workspaceId.value; if (!workspace) return;
  const path = await call<string>('language.path', { workspaceId: workspace, uri });
  if (workspace === workspaceId.value) emit('open', path, selection, workspace);
}
function fileName(uri: string) { try { return decodeURIComponent(new URL(uri).pathname); } catch { return uri; } }
const unsubscribe = subscribe(event => {
  if (event.type === 'language.diagnostics' && event.workspaceId === workspaceId.value) {
    const value = { uri: event.uri, path: event.path, diagnostics: event.diagnostics };
    changedFiles.set(event.uri, { revision: ++revision, value });
    results.value = [...results.value.filter(item => item.uri !== event.uri), value];
  } else if (event.type === 'language.status' && event.session.workspaceId === workspaceId.value) {
    changedSessions.set(event.session.serverId, { revision: ++revision, value: event.session });
    sessions.value = [...sessions.value.filter(item => item.serverId !== event.session.serverId), event.session];
  }
});
watch(workspaceId, () => { changedFiles.clear(); changedSessions.clear(); results.value = []; sessions.value = []; void guard(refresh); }, { immediate: true });
onUnmounted(() => { generation++; unsubscribe(); });
</script>
<template>
  <section class="problems-panel">
    <header><strong>问题 · {{ counts.all }}</strong><button @click="guard(refresh)">刷新</button></header>
    <div class="problem-filters">
      <button v-for="(label, kind) in { all: '全部', error: '错误', warning: '警告', info: '提示' }" :key="kind" :class="{ selected: severity === kind }" :aria-pressed="severity === kind" @click="severity = kind">{{ label }} {{ counts[kind] }}</button>
      <input v-model="query" type="search" aria-label="搜索问题" placeholder="搜索错误、文件或编号" />
    </div>
    <div v-for="session in sessions" :key="session.id" class="language-status">
      <span>{{ session.name }} · {{ ({ starting: '正在启动', running: '已连接', stopped: '已停止', failed: '失败' })[session.status] }}</span>
      <button @click="guard(async () => { await call('language.restart', { id: session.id }); await refresh(); })">重启</button>
      <p v-if="session.error">{{ session.error }}</p>
    </div>
    <p v-if="!counts.all" class="no-problems">{{ sessions.some(session => session.status === 'running') ? '当前没有诊断信息。' : '打开受支持的代码文件后，语言服务将在这里显示状态和问题。' }}</p>
    <p v-else-if="!visible.length" class="no-problems">没有符合筛选条件的问题。</p>
    <div v-for="item in visible" :key="item.uri" class="file-problems">
      <div class="file-name" :title="fileName(item.uri)">{{ item.path ?? fileName(item.uri) }}</div>
      <div v-for="(diagnostic, index) in item.diagnostics" :key="index">
        <button class="problem" @click="guard(() => open(item.uri, diagnostic.range))">
          <span :class="diagnosticKind(diagnostic)">{{ ({ error: '错误', warning: '警告', info: '提示' })[diagnosticKind(diagnostic)] }}</span>
          <span>{{ diagnostic.message }}<small v-if="diagnostic.source || diagnostic.code !== undefined" class="diagnostic-source">{{ diagnostic.source }} {{ diagnostic.code }}</small></span><small>{{ diagnostic.range.start.line + 1 }}:{{ diagnostic.range.start.character + 1 }}</small>
        </button>
        <details v-if="diagnostic.relatedInformation?.length" class="related-locations"><summary>相关位置 · {{ diagnostic.relatedInformation.length }}</summary>
          <button v-for="(related, relatedIndex) in diagnostic.relatedInformation" :key="relatedIndex" @click="guard(() => open(related.location.uri, related.location.range))">{{ related.message }}<small>{{ fileName(related.location.uri) }}:{{ related.location.range.start.line + 1 }}</small></button>
        </details>
      </div>
    </div>
  </section>
</template>
<style scoped>
.problems-panel{padding:12px;overflow:auto;height:100%;box-sizing:border-box;font-size:12px}header,.language-status{display:flex;gap:12px;align-items:center;margin-bottom:10px}.language-status{flex-wrap:wrap;color:var(--muted)}.language-status p{width:100%;white-space:pre-wrap;color:var(--error,#f08080);margin:0}header button{margin-left:auto}button{border:1px solid var(--border);border-radius:0;background:var(--surface);color:var(--text);padding:5px 9px;cursor:pointer}.file-name{padding:8px 0;color:var(--muted);overflow-wrap:anywhere}.problem{display:grid;grid-template-columns:34px 1fr auto;gap:8px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border);padding:7px 0;background:transparent}.error{color:var(--error,#f08080)}.warning{color:#c8ad69}small,.no-problems{color:var(--muted)}
.problem-filters{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.problem-filters button{font:inherit}.problem-filters .selected{border-color:var(--accent);color:var(--accent)}.problem-filters input{flex:1;min-width:160px;border:1px solid var(--border);border-radius:0;padding:6px 8px;background:var(--input);color:var(--text);font:inherit}.diagnostic-source,.related-locations small{display:block;margin-top:4px}.related-locations{margin:5px 0 12px 42px;color:var(--muted)}.related-locations summary{cursor:pointer}.related-locations button{text-align:left;display:block;width:100%;margin-top:5px;overflow-wrap:anywhere}.error,.language-status p{color:var(--danger,#f08080)}.warning{color:var(--warning,#e8bc72)}.info{color:var(--muted)}
</style>
