import warningSound from '../../../resources/sound/warning.mp3?url';
import errorSound from '../../../resources/sound/error.mp3?url';
import completeSound from '../../../resources/sound/taskComplete.mp3?url';
import taskErrorSound from '../../../resources/sound/taskError.mp3?url';
import type { HostTransport } from '../utils/hostTransport';
import { WORKSPACE_PANEL_MESSAGE } from '@shared/workspacePanelNavigation';
import './theme.css';
import '@vscode/codicons/dist/codicon.css';
import { applyDesktopAppearance } from './appearance';
import { trackPreferenceRequest, desktopSettingsDraft } from './settingsDraft';

type DesktopBridge = { kind?: 'desktop' | 'web'; call(method: string, params?: Record<string, unknown>): Promise<any>; subscribe(listener: (event: Record<string, any>) => void): () => void };
const desktop = (window.parent as unknown as { graycode: DesktopBridge }).graycode;
if (!desktop) throw new Error('The desktop host is unavailable.');
const viewQuery = new URLSearchParams(window.location.search);
const isMonitorView = viewQuery.get('view') === 'subagents';
if (isMonitorView) {
  window.__GRAYCODE_VIEW_MODE = 'subagentMonitor';
  (window as unknown as { __GRAYCODE_INITIAL_RUN_ID?: string }).__GRAYCODE_INITIAL_RUN_ID = viewQuery.get('runId') ?? undefined;
}
const subscribers = new Set<(message: unknown) => void>();
let defaultPromptModeId = 'code';
let persistedState = await desktop.call('ui.state.get');
const dispatch = (message: unknown) => { for (const listener of subscribers) listener(message); };
const host: HostTransport = {
  kind: desktop.kind,
  openWorkspacePanel: panel => window.parent.postMessage({ type: WORKSPACE_PANEL_MESSAGE, panel }, window.location.origin),
  writeClipboardText: desktop.kind === 'web' ? undefined : text => desktop.call('desktop.clipboard.writeText', { text }),
  getDefaultPromptModeId: () => defaultPromptModeId,
  getState: () => persistedState,
  setState: value => { persistedState = value; void desktop.call('ui.state.set', { value }); },
  subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
  postMessage: value => {
    const message = value as { type: string; data: unknown; requestId: string };
    const data = isMonitorView && message.type.startsWith('subagents.')
      ? { conversationId: viewQuery.get('conversationId') ?? undefined, runId: viewQuery.get('runId') ?? undefined, ...message.data as Record<string, unknown> }
      : message.data;
    const request = () => desktop.call('ui.request', { type: message.type, data });
    void trackPreferenceRequest(message.type, message.data, request(), request).then(
      data => dispatch({ type: 'response', success: true, requestId: message.requestId, data }),
      error => dispatch({ type: 'error', success: false, requestId: message.requestId, error: { code: error.code ?? 'HOST_ERROR', message: error.message } }),
    );
  },
};
window.__GRAYCODE_HOST = host;
window.__GRAYCODE_BUILTIN_SOUND_ASSETS = { warning: { url: warningSound, name: 'warning.mp3' }, error: { url: errorSound, name: 'error.mp3' },
  taskComplete: { url: completeSound, name: 'taskComplete.mp3' }, taskError: { url: taskErrorSound, name: 'taskError.mp3' } };
let lastUserActivity = Date.now();
let lastActivitySent = 0;
function recordActivity() {
  lastUserActivity = Date.now();
  if (lastUserActivity - lastActivitySent < 30_000) return;
  lastActivitySent = lastUserActivity;
  void desktop.call('activity.pulse').catch(() => {});
}
window.addEventListener('pointerdown', recordActivity, { passive: true });
window.addEventListener('keydown', recordActivity, { passive: true });
window.addEventListener('focus', recordActivity);
const activityTimer = window.setInterval(() => {
  if (document.hasFocus() && Date.now() - lastUserActivity < 5 * 60_000) {
    lastActivitySent = Date.now(); void desktop.call('activity.pulse').catch(() => {});
  }
}, 60_000);
window.addEventListener('pagehide', () => window.clearInterval(activityTimer), { once: true });
recordActivity();
document.documentElement.classList.add('platform-host');
const [platformSettings, startupSettings, startupPresets] = await Promise.all([
  desktop.call('ui.request', { type: 'platform.settings.get', data: {} }),
  isMonitorView ? Promise.resolve(undefined) : desktop.call('ui.request', { type: 'getSettings', data: {} }),
  desktop.call('ui.request', { type: 'getPromptModes', data: {} }),
]);
defaultPromptModeId = startupPresets.currentModeId || 'code';
// 主界面挂载前读取已保存偏好，查看子代理不重复播放启动动画。
window.__GRAYCODE_STARTUP_SPLASH_ENABLED = !isMonitorView && startupSettings?.settings?.ui?.appearance?.splashEnabled !== false;
applyDesktopAppearance(platformSettings.appearance);
desktop.subscribe(event => {
  if (event.type === 'settings.changed') void desktop.call('ui.request', { type: 'getPromptModes', data: {} })
    .then(result => { defaultPromptModeId = result.currentModeId || 'code'; }).catch(() => {});
  if (event.type === 'ui.conversation.focused' && event.defaultPromptModeId) defaultPromptModeId = event.defaultPromptModeId;
  if (event.type === 'transport.resumed' && (event.snapshotRequired || event.authenticatedAgain))
    dispatch({ type: 'platformTransportResumed', data: { authenticatedAgain: event.authenticatedAgain === true } });
  if (event.type === 'remote.changed') dispatch({ type: 'command', command: 'platform.remote.changed' });
  if (event.type === 'migration.progress' || event.type === 'migration.completed')
    dispatch({ type: 'command', command: event.type, data: event });
  if (event.type === 'conversation.changed') dispatch({ type: 'platformConversationChanged', data: { conversationId: event.conversationId, deleted: event.deleted, metadataOnly: event.metadataOnly, preserveWindow: event.preserveWindow } });
  if (event.type === 'event' && (event.event?.type?.startsWith('question.') || event.event?.type?.startsWith('run.')))
    dispatch({ type: 'platformQuestionsChanged' });
  if (event.type === 'ui.message') {
    if (event.message?.command === 'platform.modeSelected' && event.message.data?.promptModeId) defaultPromptModeId = event.message.data.promptModeId;
    if (event.message?.command === 'platform.appearance') applyDesktopAppearance(event.message.data);
    if (event.message?.command === 'platform.settingsDraftChanged') desktopSettingsDraft.dirty = event.message.data.dirty;
    dispatch(event.message);
  }
});
await import('../main');
