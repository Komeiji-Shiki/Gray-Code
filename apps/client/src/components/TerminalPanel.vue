<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { InteractiveTerminalInfo, InteractiveTerminalSnapshot } from '@graycode/contracts';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { call, subscribe } from '../api';
import { appearance, guard, state } from '../state';
import { appearancePalette } from '../appearance';
import { useWorkspaceRoots } from '../workspaceRoots';
const { roots, directory } = useWorkspaceRoots();
const props = withDefaults(defineProps<{ compact?: boolean; visible?: boolean; sessionId?: string }>(), { compact: false, visible: true });
const root = ref<HTMLElement>();
const sessions = ref<InteractiveTerminalInfo[]>([]);
const id = ref(props.sessionId || sessionStorage.getItem('graycode.terminal') || '');
const selected = computed(() => sessions.value.find(session => session.id === id.value));
const starting = ref(false);
const attaching = ref(false);
const attachedId = ref('');
const canInput = computed(() => !!id.value && attachedId.value === id.value && !attaching.value && selected.value?.status === 'running');
const commandLine = ref('');
const sending = ref(false);
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;
let fitFrame: number | undefined;
let disposed = false;
let attachEpoch = 0;
let listEpoch = 0;
let offset = 0;
let replaying = false;
let pending: { data: string; offset: number }[] = [];
function fitTerminal() {
  if (!props.visible || !root.value?.clientWidth || !root.value.clientHeight || !terminal) return;
  fit?.fit();
  if (canInput.value) void guard(() => call('terminal.resize', { id: id.value, cols: terminal!.cols, rows: terminal!.rows }));
}
function renderData(event: { data: string; offset: number }) {
  if (event.offset <= offset) return;
  const start = event.offset - event.data.length;
  if (start > offset) { void guard(() => attach(id.value)); return; }
  terminal?.write(event.data.slice(Math.max(0, offset - start))); offset = event.offset;
}
async function attach(target: string) {
  if (disposed || !target || !terminal) return;
  const epoch = ++attachEpoch;
  id.value = target; attachedId.value = ''; attaching.value = true; replaying = true; pending = [];
  sessionStorage.setItem('graycode.terminal', target);
  try {
    const snapshot = await call<InteractiveTerminalSnapshot>('terminal.snapshot', { id: target });
    if (epoch !== attachEpoch) return;
    // 先排空上一个会话的异步解析队列，避免旧输出在 reset 后混入新画面。
    await new Promise<void>(resolve => terminal!.write('', resolve));
    if (epoch !== attachEpoch) return;
    terminal.reset(); offset = snapshot.offset;
    // 回放历史时禁止模拟终端把旧的设备查询再次应答到正在运行的 shell。
    await new Promise<void>(resolve => terminal!.write(snapshot.output, resolve));
    if (epoch !== attachEpoch) return;
    replaying = false; attachedId.value = target;
    sessions.value = sessions.value.map(session => session.id === target ? snapshot : session);
    attaching.value = false;
    // 快照请求期间的事件只追加尚未包含的部分。
    const buffered = pending; pending = [];
    for (const event of buffered) renderData(event);
    await nextTick(); fitTerminal();
  } catch (error) {
    if (epoch !== attachEpoch) return;
    // 快照失败后保持输入关闭；不能把旧画面上的操作发送到新会话。
    pending = [];
    throw error;
  } finally { if (epoch === attachEpoch) { attaching.value = false; replaying = false; } }
}
async function refresh(restore = false) {
  if (disposed) return;
  const epoch = ++listEpoch;
  const result = await call<InteractiveTerminalInfo[]>('terminal.list');
  if (epoch !== listEpoch) return;
  sessions.value = result;
  if (starting.value) return;
  if (!result.some(session => session.id === id.value)) {
    const target = result.find(session => session.workspaceId === state.workspaceId)?.id ?? result[0]?.id ?? '';
    if (target) await attach(target);
    else { ++attachEpoch; id.value = ''; attachedId.value = ''; replaying = false; pending = []; attaching.value = false; terminal?.reset(); sessionStorage.removeItem('graycode.terminal'); }
  } else if (restore) await attach(id.value);
}
async function start() {
  if (disposed || !state.workspaceId || starting.value) return;
  starting.value = true;
  try {
    const result = await call<InteractiveTerminalSnapshot>('terminal.create', { workspaceId: state.workspaceId, directory: directory.value, cols: terminal?.cols ?? 100, rows: terminal?.rows ?? 20 });
    if (disposed) return;
    await refresh();
    if (disposed) return;
    await attach(result.id);
    if (!props.compact) terminal?.focus();
  } finally { starting.value = false; }
}
async function send(data: string) {
  if (disposed || !canInput.value || replaying) return false;
  await call('terminal.input', { id: id.value, data });
  return true;
}
async function sendLine() {
  if (sending.value || !commandLine.value) return;
  sending.value = true; const text = commandLine.value;
  try { if (await send(text + '\r') && commandLine.value === text) commandLine.value = ''; }
  finally { sending.value = false; }
}
const unsubscribe = subscribe(event => {
  if (event.type === 'workspace.terminal.open') void guard(() => attach(event.id));
  if (event.type === 'terminal.data' && event.id === id.value) {
    const chunk = { data: event.data as string, offset: event.offset as number };
    if (attaching.value) pending.push(chunk); else if (attachedId.value === id.value) renderData(chunk);
  }
  if (event.type === 'terminal.changed') void guard(() => refresh());
  if (event.type === 'transport.connected') void guard(() => refresh(true));
});
onMounted(() => {
  terminal = new Terminal({ fontFamily: appearance.value?.codeFont, fontSize: appearance.value?.codeFontSize ?? 14,
    cursorBlink: true, theme: { background: appearancePalette.value.background, foreground: appearancePalette.value.text,
      cursor: appearancePalette.value.accent, selectionBackground: appearancePalette.value.selection } });
  fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(root.value!);
  terminal.onData(data => { if (!replaying) void guard(() => send(data)); });
  observer = new ResizeObserver(() => {
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => { fitFrame = undefined; fitTerminal(); });
  });
  observer.observe(root.value!); void guard(() => refresh(true));
});
watch(() => props.sessionId, target => { if (target && terminal && target !== id.value) void guard(() => attach(target)); });
watch(() => props.visible, async value => { if (value) { await nextTick(); fitTerminal(); } });
watch(appearance, value => { if (terminal && value) { terminal.options.fontFamily = value.codeFont; terminal.options.fontSize = value.codeFontSize; fitTerminal(); } }, { deep: true });
watch(appearancePalette, value => { if (terminal) terminal.options.theme = { background: value.background, foreground: value.text, cursor: value.accent, selectionBackground: value.selection }; });
onUnmounted(() => { disposed = true; attachedId.value = ''; pending = []; ++attachEpoch; ++listEpoch; unsubscribe(); observer?.disconnect(); if (fitFrame !== undefined) cancelAnimationFrame(fitFrame); terminal?.dispose(); terminal = undefined; });
</script>
<template>
  <div class="terminal-panel" :class="{ 'compact-terminal': compact }">
    <div class="panel-heading terminal-controls">
      <select :value="id" aria-label="当前终端" :disabled="!sessions.length || attaching" @change="guard(() => attach(($event.target as HTMLSelectElement).value))">
        <option v-if="!sessions.length" value="">尚未打开终端</option>
        <option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.title }} · {{ session.pid }}{{ session.status === 'exited' ? ' · 已退出' : '' }}</option>
      </select>
      <select v-if="roots.length > 1" v-model="directory" aria-label="新终端目录"><option v-for="root in roots" :key="root.directory" :value="root.directory">{{ root.name }}</option></select>
      <button :disabled="!state.workspaceId || starting" @click="guard(start)">{{ starting ? '正在打开…' : '新建终端' }}</button>
      <button v-if="selected?.status === 'running'" @click="guard(() => call('terminal.stop', { id }))">停止</button>
      <button v-if="selected" title="关闭所选终端及其进程" @click="guard(async () => { await call('terminal.close', { id }); await refresh(); })">关闭</button>
    </div>
    <div v-if="!sessions.length" class="terminal-notice">选择工作区后打开终端。页面断开后，进程会继续在部署电脑运行。</div>
    <div v-else-if="selected?.status === 'exited'" class="terminal-notice">终端已退出，退出码 {{ selected.exitCode }}。输出保留到关闭终端或退出核心服务。</div>
    <div v-else-if="attaching" class="terminal-notice" role="status">正在接续终端输出…</div>
    <div ref="root" class="terminal-root" :aria-busy="attaching"></div>
    <div v-if="compact" class="terminal-mobile-input">
      <div class="terminal-keys"><button v-for="key in [{label:'Ctrl+C',data:'\u0003'}, {label:'Tab',data:'\t'}, {label:'Esc',data:'\u001b'}, {label:'↑',data:'\u001b[A'}, {label:'↓',data:'\u001b[B'}]" :key="key.label" :disabled="!canInput" @click="guard(() => send(key.data))">{{ key.label }}</button></div>
      <form @submit.prevent="guard(sendLine)"><input v-model="commandLine" aria-label="终端命令" placeholder="输入命令" spellcheck="false" autocapitalize="off" autocorrect="off" :disabled="!canInput" /><button :disabled="!commandLine || sending || !canInput">发送 ↵</button></form>
    </div>
  </div>
</template>
<style scoped>
.terminal-controls{gap:6px;min-height:44px;height:auto;flex-shrink:0}.terminal-controls select{flex:1;min-width:0;padding:7px 4px;font-size:12px}.terminal-controls button{flex-shrink:0;padding:7px}.terminal-notice{padding:8px 12px;color:var(--gc-text-muted);font-size:12px;line-height:1.6}.terminal-mobile-input{border-top:1px solid var(--gc-border-subtle);padding:7px;flex-shrink:0}.terminal-keys{display:flex;gap:6px;margin-bottom:7px}.terminal-keys button{flex:1;min-height:36px;padding:5px}.terminal-mobile-input form{display:flex;gap:6px}.terminal-mobile-input input{flex:1;width:0;font:16px var(--gc-font-code)}.terminal-mobile-input form button{flex-shrink:0}.compact-terminal .terminal-root{padding:8px 3px}.compact-terminal .terminal-controls{padding-inline:6px}
</style>
