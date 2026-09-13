<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import type { DebugAdapterInfo, DebugBreakpoint, DebugConfiguration, DebugScope, DebugStackFrame, DebugWorkspaceState } from '@graycode/contracts';
import { call } from '../api';
import { state } from '../state';
import { changeBreakpoints, connectDebugging, debugAlive, debugRequest, debugState, loadDebugSessions, loadDebugSettings, selectDebugFrame } from '../debugging';
import DebugConfigurationEditor from './DebugConfigurationEditor.vue';
import DebugVariables from './DebugVariables.vue';
const props = defineProps<{ visible: boolean; saveAll: () => Promise<void>; activeFile?: { workspaceId: string; path: string } }>();
const emit = defineEmits<{ open: [path: string, line: number, column: number, workspaceId: string] }>();
interface Draft { configuration: DebugConfiguration; argsText: string; envText: string; optionsText: string }
interface ProjectDraft { selected: string; configurations: Draft[]; revision: number | null; dirty: boolean; editing: boolean }
const projects = reactive<Record<string, ProjectDraft>>({});
const project = computed(() => projects[state.workspaceId]);
const draft = computed(() => project.value?.configurations.find(value => value.configuration.id === project.value.selected));
const adapters = ref<DebugAdapterInfo[]>([]), busy = ref(false), error = ref('');
const sessions = computed(() => debugState.sessions.filter(value => value.workspaceId === state.workspaceId));
const session = computed(() => debugState.sessions.find(value => value.id === debugState.activeId));
const frames = ref<DebugStackFrame[]>([]), scopes = ref<DebugScope[]>([]), selectedFrame = ref<number>(), selectedThread = ref<number>();
const threads = ref<Array<{ id: number; name: string }>>([]), expandedScopes = ref<number[]>([]);
const variablesRevision = ref(0), expression = ref(''), evaluating = ref(false);
const evaluationsBySession = reactive<Record<string, Array<{ id: number; expression: string; result: string; variablesReference?: number }>>>({});
let evaluationSequence = 0;
const evaluations = computed(() => evaluationsBySession[session.value?.id ?? ''] ?? []);
const consoleElement = ref<HTMLElement>(); const virtualSource = ref('');
const output = computed(() => debugState.output[session.value?.id ?? ''] ?? []);
const breakpoints = computed(() => debugState.settings[state.workspaceId]?.breakpoints ?? []);
let selectionEpoch = 0, frameEpoch = 0, disposed = false;
connectDebugging();
function asDraft(configuration: DebugConfiguration): Draft {
  const value = JSON.parse(JSON.stringify(configuration));
  return { configuration: value, argsText: (value.args ?? []).join('\n'), envText: Object.entries(value.env ?? {}).map(([key, value]) => value === null ? key : key + '=' + value).join('\n'),
    optionsText: value.options ? JSON.stringify(value.options, null, 2) : '' };
}
async function loadProject() {
  const workspaceId = state.workspaceId; if (!workspaceId) return;
  try {
    const [settings] = await Promise.all([loadDebugSettings(workspaceId), loadDebugSessions(workspaceId)]);
    if (disposed) return;
    if (!projects[workspaceId]) projects[workspaceId] = { selected: settings.configurations[0]?.id ?? '', configurations: settings.configurations.map(asDraft), revision: settings.configurationRevision, dirty: false, editing: !settings.configurations.length };
    if (!adapters.value.length) adapters.value = await call<DebugAdapterInfo[]>('debug.adapters');
    if (workspaceId === state.workspaceId && !sessions.value.some(value => value.id === debugState.activeId)) debugState.activeId = sessions.value.find(debugAlive)?.id ?? sessions.value.at(-1)?.id ?? '';
  } catch (failure) { if (workspaceId === state.workspaceId) error.value = String(failure); }
}
watch(() => [props.visible, state.workspaceId], () => { if (props.visible) void loadProject(); }, { immediate: true });
function addConfiguration() {
  if (!project.value) return;
  const file = props.activeFile?.workspaceId === state.workspaceId ? props.activeFile.path : '';
  const configuration: DebugConfiguration = { id: crypto.randomUUID(), name: '新调试配置', adapterId: /\.py$/i.test(file) ? 'python' : 'node', request: 'launch', program: file, console: 'integratedTerminal' };
  project.value.configurations.push(asDraft(configuration)); project.value.selected = configuration.id; project.value.editing = true; project.value.dirty = true;
}
function serialize(value: Draft): DebugConfiguration {
  const env: Record<string, string | null> = {};
  for (const line of value.envText.split('\n').filter(value => value.trim())) {
    const equals = line.indexOf('='); env[equals < 0 ? line.trim() : line.slice(0, equals).trim()] = equals < 0 ? null : line.slice(equals + 1);
  }
  const options = value.optionsText.trim() ? JSON.parse(value.optionsText) : undefined;
  if (options !== undefined && (!options || Array.isArray(options) || typeof options !== 'object')) throw new Error('高级调试选项必须是 JSON 对象。');
  const configuration = { ...value.configuration, args: value.argsText ? value.argsText.split('\n') : [], env, options };
  if ((configuration.port as unknown) === '') delete configuration.port;
  return configuration;
}
async function saveConfiguration() {
  const workspaceId = state.workspaceId, current = project.value; if (!current) return;
  const serialized = current.configurations.map(serialize);
  const saved = await call<DebugWorkspaceState>('debug.configurations.save', { workspaceId, configurations: serialized, expectedRevision: current.revision });
  current.revision = saved.configurationRevision; current.dirty = false; debugState.settings[workspaceId] = saved;
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value) return; busy.value = true; error.value = ''; debugState.error = '';
  try { await operation(); } catch (failure) { error.value = String(failure); } finally { busy.value = false; }
}
async function removeConfiguration() {
  const current = project.value; if (!current) return;
  const before = current.configurations;
  current.configurations = before.filter(value => value.configuration.id !== current.selected);
  try { await saveConfiguration(); current.selected = current.configurations[0]?.configuration.id ?? ''; }
  catch (error) { current.configurations = before; throw error; }
}
async function start() {
  const current = draft.value; if (!current) return;
  const workspaceId = state.workspaceId, configuration = serialize(current);
  await saveConfiguration();
  const result = await call('debug.start', { workspaceId, configuration });
  debugState.activeId = result.id; project.value.editing = false;
}
async function loadSession() {
  const active = session.value, epoch = ++selectionEpoch; ++frameEpoch;
  frames.value = []; scopes.value = []; selectedFrame.value = undefined; virtualSource.value = '';
  if (!active) return;
  try {
    const snapshot = await call('debug.snapshot', { id: active.id });
    if (epoch !== selectionEpoch) return;
    const received = debugState.output[active.id] ?? [];
    debugState.output[active.id] = [...snapshot.output, ...received.filter(value => value.sequence > (snapshot.output.at(-1)?.sequence ?? 0))];
    debugState.results[active.id] = snapshot.breakpoints;
    if (!debugAlive(active) || active.status === 'starting') { threads.value = []; return; }
    const result = await debugRequest(active.id, 'threads'); if (epoch !== selectionEpoch) return;
    threads.value = result.threads;
    selectedThread.value = active.threadId ?? result.threads[0]?.id;
    if (active.status === 'stopped' && selectedThread.value !== undefined) await loadStack();
  } catch (failure) { if (epoch === selectionEpoch && session.value?.status === 'stopped') error.value = String(failure); }
}
async function loadStack() {
  const active = session.value, threadId = selectedThread.value, epoch = ++frameEpoch;
  if (!active || active.status !== 'stopped' || threadId === undefined) return;
  try {
    const result = await debugRequest<{ stackFrames: DebugStackFrame[] }>(active.id, 'stackTrace', { threadId, startFrame: 0, levels: 100 });
    if (epoch !== frameEpoch || active.id !== session.value?.id || session.value?.status !== 'stopped') return;
    frames.value = result.stackFrames;
    const first = frames.value.find(value => value.line > 0); if (first) await selectFrame(first);
  } catch (failure) { if (epoch === frameEpoch) error.value = String(failure); }
}
async function selectFrame(frame: DebugStackFrame, open = false) {
  const active = session.value, epoch = ++frameEpoch; if (!active) return;
  selectedFrame.value = frame.id; virtualSource.value = '';
  const result = await debugRequest<{ scopes: DebugScope[] }>(active.id, 'scopes', { frameId: frame.id });
  if (epoch !== frameEpoch || active.id !== session.value?.id || session.value?.status !== 'stopped') return;
  scopes.value = result.scopes; expandedScopes.value = scopes.value.filter(value => !value.expensive).map(value => value.variablesReference); variablesRevision.value++;
  if (frame.source?.sourceReference) {
    if (open) {
      const source = await debugRequest(active.id, 'source', { sourceReference: frame.source.sourceReference, source: frame.source });
      if (epoch === frameEpoch) virtualSource.value = source.content;
    }
  } else if (frame.source?.path) {
    await selectDebugFrame(active, frame);
    if (open && epoch === frameEpoch && debugState.location) emit('open', debugState.location.path, frame.line, frame.column, active.workspaceId);
  }
}
watch(() => [debugState.activeId, session.value?.status, session.value?.threadId, session.value?.reason], () => void loadSession());
watch(() => output.value.length + evaluations.value.length, async () => { const nearEnd = !consoleElement.value || consoleElement.value.scrollHeight - consoleElement.value.scrollTop - consoleElement.value.clientHeight < 60;
  await nextTick(); if (nearEnd && consoleElement.value) consoleElement.value.scrollTop = consoleElement.value.scrollHeight; });
async function evaluate() {
  const active = session.value, text = expression.value; if (!active || !text.trim()) return;
  evaluating.value = true;
  try {
    const result = await debugRequest(active.id, 'evaluate', { expression: text, frameId: selectedFrame.value, context: 'repl' });
    (evaluationsBySession[active.id] ??= []).push({ id: ++evaluationSequence, expression: text, result: result.result, variablesReference: result.variablesReference });
    if (active.id === session.value?.id) variablesRevision.value++;
  } catch (failure) { (evaluationsBySession[active.id] ??= []).push({ id: ++evaluationSequence, expression: text, result: String(failure) }); } finally { evaluating.value = false; }
}
function changeBreakpoint(value: DebugBreakpoint, patch: Partial<DebugBreakpoint>) {
  return action(() => changeBreakpoints(state.workspaceId, values => values.map(item => item.id === value.id ? { ...item, ...patch } : item)));
}
const sourceName = (frame: DebugStackFrame) => frame.source?.name || frame.source?.path?.split(/[\\/]/).at(-1) || '';
const statusText = (value: string) => ({ starting: '启动中', running: '运行中', stopped: '已暂停', terminated: '已结束', failed: '失败' }[value] ?? value);
const reasonText = (value?: string) => ({ breakpoint: '命中断点', step: '单步停止', pause: '手动暂停', exception: '发生异常', entry: '程序入口' }[value ?? ''] ?? value);
onUnmounted(() => { disposed = true; selectionEpoch++; frameEpoch++; });
</script>
<template>
  <section class="debug-panel">
    <div class="debug-toolbar"><strong>运行与调试</strong><span v-if="project && !adapters.length" class="muted">正在检测调试器…</span><span class="debug-spacer"></span><button :disabled="!project || !adapters.length || busy" @click="addConfiguration">添加配置</button></div>
    <p v-if="!state.workspaceId" class="debug-empty">先选择一个项目，再设置要调试的程序。</p>
    <template v-if="project">
      <div class="debug-toolbar"><select v-model="project.selected" aria-label="选择调试配置"><option v-if="!project.configurations.length" value="">尚未配置</option><option v-for="item in project.configurations" :key="item.configuration.id" :value="item.configuration.id">{{ item.configuration.name || '未命名配置' }}</option></select><button :disabled="!draft || busy" @click="project.editing = !project.editing">配置{{ project.dirty ? ' · 未保存' : '' }}</button><button :disabled="!draft || busy" @click="action(start)">{{ draft?.configuration.request === 'attach' ? '保存并附加' : '保存并启动' }}</button></div>
      <DebugConfigurationEditor v-if="project.editing && draft" :draft="draft" :adapters="adapters" :saving="busy" @input="project.dirty = true" @change="project.dirty = true" @save="action(saveConfiguration)" @remove="action(removeConfiguration)" />
      <p v-if="!project.configurations.length" class="debug-empty">添加调试配置，选择 Node.js、Python 或自定义调试器。程序参数、工作目录与环境变量会保存在当前项目中。</p>
      <div v-if="error || debugState.error" class="debug-error" role="alert">{{ error || debugState.error }}<button v-if="(error || debugState.error).includes('未保存')" @click="action(props.saveAll)">保存编辑器中的全部文件</button></div>
      <div class="debug-body">
        <div class="debug-inspector">
          <details open><summary>会话 <span>{{ sessions.filter(debugAlive).length }} 个运行中</span></summary>
            <button v-for="item in sessions" :key="item.id" class="debug-session-row" :class="{ selected: debugState.activeId === item.id }" @click="debugState.activeId = item.id"><span>{{ item.parentId ? '↳ ' : '' }}{{ item.name }}</span><small>{{ statusText(item.status) }}{{ item.exitCode !== undefined ? ' · ' + item.exitCode : '' }}</small></button>
            <p v-if="session?.error" class="debug-error">{{ session.error }}</p><p v-if="session?.status === 'stopped'" class="debug-reason">{{ reasonText(session.reason) }}</p>
          </details>
          <details open><summary>调用栈</summary><select v-if="threads.length > 1" v-model="selectedThread" aria-label="调试线程" @change="loadStack"><option v-for="thread in threads" :key="thread.id" :value="thread.id">{{ thread.name }}</option></select>
            <div class="stack-list"><div v-for="frame in frames" :key="frame.id" class="stack-row" :class="{ selected: selectedFrame === frame.id }"><button @click="action(() => selectFrame(frame))">{{ frame.name }}<small>{{ sourceName(frame) }}{{ frame.line > 0 ? ':' + frame.line : '' }}</small></button><button v-if="frame.source && frame.line > 0" aria-label="显示调用栈文件" @click="action(() => selectFrame(frame, true))">打开</button></div></div>
            <p v-if="!frames.length" class="muted">程序暂停后显示调用栈。</p>
          </details>
          <details open><summary>变量与作用域</summary><template v-for="scope in scopes" :key="scope.variablesReference"><button class="scope-toggle" :aria-expanded="expandedScopes.includes(scope.variablesReference)" @click="expandedScopes = expandedScopes.includes(scope.variablesReference) ? expandedScopes.filter(value => value !== scope.variablesReference) : [...expandedScopes, scope.variablesReference]">{{ expandedScopes.includes(scope.variablesReference) ? '▾' : '▸' }} {{ scope.name }}</button><DebugVariables v-if="expandedScopes.includes(scope.variablesReference) && session" :session-id="session.id" :reference="scope.variablesReference" :revision="variablesRevision" /></template></details>
          <details open><summary>断点 <span>{{ breakpoints.length }}</span></summary>
            <article v-for="breakpoint in breakpoints" :key="breakpoint.id" class="breakpoint-row"><div><input type="checkbox" :checked="breakpoint.enabled" :aria-label="'启用断点 ' + breakpoint.path + ':' + breakpoint.line" @change="changeBreakpoint(breakpoint, { enabled: ($event.target as HTMLInputElement).checked })" /><button class="breakpoint-path" @click="emit('open', breakpoint.path, breakpoint.line, breakpoint.column ?? 1, state.workspaceId)">{{ breakpoint.path }}:{{ breakpoint.line }}</button><button aria-label="删除断点" @click="action(() => changeBreakpoints(state.workspaceId, values => values.filter(value => value.id !== breakpoint.id)))">×</button></div><details><summary>条件与日志</summary><label>条件<input :value="breakpoint.condition" @change="changeBreakpoint(breakpoint, { condition: ($event.target as HTMLInputElement).value || undefined })" /></label><label>命中次数<input :value="breakpoint.hitCondition" @change="changeBreakpoint(breakpoint, { hitCondition: ($event.target as HTMLInputElement).value || undefined })" /></label><label>日志消息<input :value="breakpoint.logMessage" @change="changeBreakpoint(breakpoint, { logMessage: ($event.target as HTMLInputElement).value || undefined })" /></label></details></article>
            <p v-if="!breakpoints.length" class="muted">在编辑器行号左侧单击，或按 F9 添加断点。</p>
          </details>
        </div>
        <div class="debug-console"><div class="console-heading">调试控制台<button @click="debugState.output[session?.id ?? ''] = []; evaluationsBySession[session?.id ?? ''] = []">清空显示</button></div><div ref="consoleElement" class="console-output" aria-live="polite"><div v-for="entry in output" :key="entry.sequence" :class="entry.category"><pre>{{ entry.output }}</pre><DebugVariables v-if="entry.variablesReference && session" :session-id="session.id" :reference="entry.variablesReference" :revision="0" /></div><div v-for="entry in evaluations" :key="entry.id" class="evaluation"><pre>&gt; {{ entry.expression }}
{{ entry.result }}</pre><DebugVariables v-if="entry.variablesReference && session" :session-id="session.id" :reference="entry.variablesReference" :revision="0" /></div></div><form @submit.prevent="evaluate"><input v-model="expression" aria-label="调试表达式" placeholder="输入表达式，在当前会话中求值" :disabled="!session || !debugAlive(session)" /><button :disabled="!session || !debugAlive(session) || evaluating">求值</button></form><pre v-if="virtualSource" class="virtual-source">{{ virtualSource }}</pre></div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.debug-panel{height:100%;min-height:0;display:flex;flex-direction:column;overflow:auto;background:var(--background);font-size:12px}.debug-toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);flex-shrink:0}.debug-toolbar>select{flex:1;min-width:100px}.debug-spacer{flex:1}button,input,select{border:1px solid var(--border);border-radius:0;background:var(--panel);color:var(--text);font:inherit;padding:6px 8px;min-width:0}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:hover{background:var(--hover)}.debug-empty{padding:18px;color:var(--muted);line-height:1.7}.debug-body{flex:1;min-height:300px;display:grid;grid-template-columns:minmax(200px,42%) minmax(0,1fr);border-bottom:1px solid var(--border)}.debug-inspector{overflow:auto;border-right:1px solid var(--border);min-width:0}.debug-inspector>details{padding:9px 12px;border-bottom:1px solid var(--border)}summary{cursor:pointer;padding:5px 0;font-weight:500}summary span{float:right;font-weight:400;color:var(--muted)}.debug-session-row{display:flex;justify-content:space-between;width:100%;gap:8px;background:transparent;border:0;text-align:left}.debug-session-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{color:var(--muted);font-size:11px}.selected{background:var(--hover)!important;border-left:2px solid var(--accent)!important}.debug-reason{color:var(--accent)}.stack-list{max-height:280px;overflow:auto}.stack-row{display:flex}.stack-row>button:first-child{min-width:0;flex:1;text-align:left;overflow:hidden;border:0;background:transparent}.stack-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stack-row>button:last-child{align-self:center;border:0;background:transparent}.scope-toggle{border:0;background:transparent;padding:6px 0}.breakpoint-row>div{display:flex;align-items:center;gap:6px}.breakpoint-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left;white-space:nowrap;border:0;background:transparent}.breakpoint-row label{display:grid;gap:4px;margin:7px 0}.breakpoint-row details{margin-left:20px;font-size:11px}.debug-console{display:flex;flex-direction:column;min-width:0;min-height:200px}.console-heading{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-bottom:1px solid var(--border)}.console-heading button{border:0;background:transparent;font-size:11px}.console-output{flex:1;min-height:150px;overflow:auto;padding:10px}.console-output pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--code-font,monospace)}.console-output .stderr,.debug-error{color:var(--danger,#f08080)}.console-output .adapter{color:var(--muted)}.evaluation{border-top:1px solid var(--border);padding-top:8px!important;color:var(--accent)}.debug-console form{display:flex;border-top:1px solid var(--border);padding:7px;gap:6px}.debug-console input{flex:1;width:0}.debug-error{padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere}.debug-error button{display:block;margin-top:7px}.muted{color:var(--muted);line-height:1.6}.virtual-source{white-space:pre;overflow:auto;border-top:1px solid var(--border);padding:12px;max-height:320px}
@media(max-width:850px){.debug-body{grid-template-columns:minmax(0,1fr)}.debug-inspector{overflow:visible;border-right:0}.debug-toolbar{flex-wrap:wrap}.debug-console{min-height:300px}.debug-panel .debug-configuration{flex-shrink:0}.debug-body{flex:none}.console-output{max-height:340px}}
</style>
