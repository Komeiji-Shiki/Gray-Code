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
export function report(error: unknown) { state.error = error instanceof Error ? error.message : String(error); }
export async function guard<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); } catch (error) { report(error); }
}
export async function loadSettings() {
  state.snapshot = await call('settings.get');
  if (state.workspaceId && !state.snapshot.settings.workspaces.some(workspace => workspace.id === state.workspaceId)) state.workspaceId = '';
}
export async function initialize() {
  await loadSettings(); state.ready = true;
  return subscribe(event => {
    if (event.type === 'settings.changed') void guard(loadSettings);
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
}
