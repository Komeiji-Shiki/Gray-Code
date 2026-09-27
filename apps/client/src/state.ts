import { computed, reactive } from 'vue';
import type { ConversationViewInfo, SettingsSnapshot } from '@graycode/contracts';
import { rpc as call, subscribe } from './api';

export const state = reactive({ panelResizing: false, panelObscured: false, panelMenuOpen: false, contentPreviewOpen: false, inspectorOpen: false, ready: false, error: '', settingsOpen: false, chatFocused: true, workbenchExpanded: false,
  notice: null as { message: string; severity: 'info' | 'warning' } | null,
  conversationId: null as string | null, mode: 'chat' as 'chat' | 'code' | 'character',
  conversationViews: [] as ConversationViewInfo[],
  navigationDialogOpen: false, fileDialogOpen: false,
  snapshot: null as SettingsSnapshot | null, workspaceId: localStorage.getItem('graycode.workspaceId') ?? '' });
export const appearance = computed(() => state.snapshot?.settings.appearance);
let settingsRequestSequence = 0;
let settingsLoad: { sequence: number; completion: Promise<void> } | undefined;
export function report(error: unknown) { state.error = error instanceof Error ? error.message : String(error); }
export async function guard<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); } catch (error) { report(error); }
}
export function loadSettings(signal?: AbortSignal): Promise<void> {
  const sequence = ++settingsRequestSequence;
  const completion = (async () => {
    try {
      const snapshot = await call('settings.get');
      // 设置事件与工作区操作可以同时刷新，旧响应不能清空较新配置中的工作区选择。
      if (signal?.aborted || sequence !== settingsRequestSequence) return;
      state.snapshot = snapshot;
      if (state.workspaceId && !snapshot.settings.workspaces.some(workspace => workspace.id === state.workspaceId)) state.workspaceId = '';
    } catch (error) { if (!signal?.aborted && sequence === settingsRequestSequence) throw error; }
  })();
  settingsLoad = { sequence, completion };
  return completion;
}
export async function initialize(signal?: AbortSignal) {
  if (signal?.aborted) return () => {};
  state.ready = false;
  let initializing = true;
  const unsubscribe = subscribe(event => {
    if (signal?.aborted) return;
    if (event.type === 'settings.changed') {
      // 启动读取期间合并变更，并立即作废旧快照，避免清空刚选中的新工作区。
      if (initializing) settingsRequestSequence++;
      else void guard(() => loadSettings(signal));
    }
    if (event.source === 'desktop' && ['workspace.file.open', 'workspace.selected'].includes(event.type)) {
      state.workspaceId = event.workspaceId; state.chatFocused = false; state.settingsOpen = false;
    }
    if (event.type === 'ui.conversation.focused') {
      state.conversationId = event.conversationId; if (['chat', 'code', 'character'].includes(event.mode)) state.mode = event.mode;
      if (event.conversationId && !event.resynchronized) state.workspaceId = typeof event.workspaceId === 'string' ? event.workspaceId : '';
    }
    if (event.type === 'ui.conversation.views') state.conversationViews = event.views;
    if (event.type === 'notification') {
      if (event.severity === 'info' || event.severity === 'warning') state.notice = { message: event.message, severity: event.severity };
      else state.error = event.message;
    }
    if (event.type === 'ui.message' && event.message?.command === 'platform.appearance' && state.snapshot)
      state.snapshot.settings.appearance = event.message.data;
  });
  const dispose = () => { unsubscribe(); signal?.removeEventListener('abort', dispose); };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    loadSettings(signal);
    for (;;) {
      const loading = settingsLoad!;
      try { await loading.completion; }
      catch (error) { if (!signal?.aborted && loading === settingsLoad && loading.sequence === settingsRequestSequence) throw error; }
      if (signal?.aborted) return dispose;
      if (loading !== settingsLoad) continue;
      if (loading.sequence === settingsRequestSequence) break;
      loadSettings(signal);
    }
    state.ready = true;
    return dispose;
  } catch (error) { dispose(); throw error; }
  finally { initializing = false; }
}
