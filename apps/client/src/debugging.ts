import { reactive } from 'vue';
import type { DebugBreakpoint, DebugBreakpointResult, DebugOutput, DebugSessionInfo, DebugStackFrame, DebugWorkspaceState } from '@graycode/contracts';
import { call, subscribe } from './api';

export const debugState = reactive({
  sessions: [] as DebugSessionInfo[], activeId: '', error: '', controlling: false,
  settings: {} as Record<string, DebugWorkspaceState>,
  output: {} as Record<string, DebugOutput[]>, results: {} as Record<string, Record<string, DebugBreakpointResult[]>>,
  location: null as null | { sessionId: string; workspaceId: string; path: string; line: number; column: number },
  revision: 0,
});
let listening = false;
const changes = new Map<string, Promise<unknown>>();
export const debugAlive = (session: DebugSessionInfo) => !['terminated', 'failed'].includes(session.status);
function updateSession(session: DebugSessionInfo) {
  const index = debugState.sessions.findIndex(value => value.id === session.id);
  if (index < 0) debugState.sessions.push(session); else debugState.sessions[index] = session;
  if (!debugState.activeId || session.status === 'stopped') debugState.activeId = session.id;
  if (session.status !== 'stopped' && debugState.location?.sessionId === session.id) debugState.location = null;
  debugState.revision++;
}
export function connectDebugging() {
  if (listening) return;
  listening = true;
  subscribe(event => {
    if (event.type === 'debug.session') updateSession(event.session);
    else if (event.type === 'debug.output') {
      const output = debugState.output[event.sessionId] ??= [];
      if (!output.some(value => value.sequence === event.entry.sequence)) output.push(event.entry);
      while (output.length > 1000) output.shift();
    } else if (event.type === 'debug.breakpoints') {
      if (debugState.settings[event.workspaceId]) debugState.settings[event.workspaceId].breakpoints = event.breakpoints;
      void loadDebugSettings(event.workspaceId).catch(error => { debugState.error = String(error); });
    } else if (event.type === 'debug.breakpointResult') (debugState.results[event.sessionId] ??= {})[event.path] = event.breakpoints;
    else if (event.type === 'debug.event' && event.event === 'breakpoint') {
      for (const values of Object.values(debugState.results[event.sessionId] ?? {})) {
        const found = values.find(value => value.id === event.body.breakpoint?.id);
        if (found) Object.assign(found, event.body.breakpoint);
      }
    }
  });
}
export async function loadDebugSettings(workspaceId: string) {
  const settings = await call<DebugWorkspaceState>('debug.settings', { workspaceId });
  const current = debugState.settings[workspaceId];
  // 较早的读取结果不能覆盖事件触发的新版本。
  if (!current || (settings.configurationRevision ?? 0) >= (current.configurationRevision ?? 0) &&
    (settings.breakpointRevision ?? 0) >= (current.breakpointRevision ?? 0)) debugState.settings[workspaceId] = settings;
  return debugState.settings[workspaceId];
}
export async function loadDebugSessions(workspaceId?: string) {
  const sessions = await call<DebugSessionInfo[]>('debug.list', { workspaceId });
  for (const session of sessions) updateSession(session);
}
export function changeBreakpoints(workspaceId: string, apply: (values: DebugBreakpoint[]) => DebugBreakpoint[]) {
  const previous = changes.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = await loadDebugSettings(workspaceId);
    const breakpoints = apply(state.breakpoints.map(value => ({ ...value })));
    const result = await call<DebugWorkspaceState>('debug.breakpoints.set', { workspaceId, breakpoints, expectedRevision: state.breakpointRevision });
    debugState.settings[workspaceId] = result;
  });
  changes.set(workspaceId, next);
  return next.finally(() => { if (changes.get(workspaceId) === next) changes.delete(workspaceId); });
}
export function toggleBreakpoint(workspaceId: string, path: string, line: number) {
  return changeBreakpoints(workspaceId, values => {
    const existing = values.find(value => value.path === path && value.line === line);
    return existing ? values.filter(value => value.id !== existing.id) : [...values, { id: crypto.randomUUID(), path, line, enabled: true }];
  });
}
export async function debugRequest<T = any>(id: string, command: string, args: Record<string, unknown> = {}) {
  return call<T>('debug.request', { id, command, arguments: args });
}
export async function debugControl(command: string) {
  if (debugState.controlling && command !== 'stop') return;
  const session = debugState.sessions.find(value => value.id === debugState.activeId);
  if (!session) return;
  debugState.error = '';
  debugState.controlling = true;
  try {
    if (command === 'stop' || command === 'restart') {
      const value = await call('debug.' + command, { id: session.id });
      if (command === 'restart') { updateSession(value); debugState.activeId = value.id; }
      return;
    }
    const threadId = session.threadId ?? (await debugRequest(session.id, 'threads')).threads[0]?.id;
    if (threadId === undefined) throw new Error('该会话没有可控制的线程，请选择程序的子会话。');
    await debugRequest(session.id, command, { threadId });
  } catch (error) { if (debugAlive(session)) debugState.error = String(error); }
  finally { debugState.controlling = false; }
}
export async function selectDebugFrame(session: DebugSessionInfo, frame: DebugStackFrame) {
  if (!frame.source?.path) { debugState.location = null; return; }
  const path = await call<string>('debug.path', { workspaceId: session.workspaceId, path: frame.source.path });
  debugState.location = { sessionId: session.id, workspaceId: session.workspaceId, path, line: frame.line, column: frame.column };
}
