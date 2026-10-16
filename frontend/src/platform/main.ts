import warningSound from '../../../resources/sound/warning.mp3?url';
import errorSound from '../../../resources/sound/error.mp3?url';
import completeSound from '../../../resources/sound/taskComplete.mp3?url';
import taskErrorSound from '../../../resources/sound/taskError.mp3?url';
import type { HostTransport } from '../utils/hostTransport';
import { watch } from 'vue';
import { getLanguage, setLanguage, SUPPORTED_LANGUAGES } from '../i18n';
import type { SupportedLanguage } from '../i18n/types';
import type { UiStartupSnapshot } from '../../../packages/contracts/src/uiStartup';
import type { GlobalSettings, PromptMode, CheckpointConfig } from '../../../backend/modules/settings/types';
import { WORKSPACE_PANEL_MESSAGE } from '@shared/workspacePanelNavigation';
import { CHAT_INITIALIZATION_MESSAGE } from '@shared/chatInitialization';
import { SHELL_SHORTCUTS_MESSAGE, SHELL_SHORTCUT_MESSAGE, matchShellShortcut, type ShellShortcutBinding } from '@shared/shellShortcutBridge';
import { callDesktopBridge, type DesktopBridge } from '@shared/desktopBridge';
import './theme.css';
import '@vscode/codicons/dist/codicon.css';
import { applyDesktopAppearance } from './appearance';
import { invalidateWorkspaceAssets } from '../components/common/markdown/markdownItCore';
import { trackPreferenceRequest, desktopSettingsDraft, saveDesktopSettings } from './settingsDraft';
import { characterPresentation } from './characterPresentation';
import { setChannelConfigsCache } from '../services/channelConfigCache';

const bridge = (window.parent as unknown as { graycode: DesktopBridge }).graycode;
if (!bridge) throw new Error('The desktop host is unavailable.');
// 仅给尚无桥接的 iframe 补上原始句柄；Electron contextBridge 提供的只读属性必须保留。
if (!window.graycode) window.graycode = bridge;
const desktop: DesktopBridge = { ...bridge, call: (method, params) => callDesktopBridge(bridge, method, params) };
const viewQuery = new URLSearchParams(window.location.search);
const isMonitorView = viewQuery.get('view') === 'subagents';
if (isMonitorView) {
  window.__GRAYCODE_VIEW_MODE = 'subagentMonitor';
  (window as unknown as { __GRAYCODE_INITIAL_RUN_ID?: string }).__GRAYCODE_INITIAL_RUN_ID = viewQuery.get('runId') ?? undefined;
}
const subscribers = new Set<(message: unknown) => void>();
// 启动快照只供每项首次读取使用，后续刷新继续取得服务端的最新设置。
const startupResponses = new Map<string, unknown>();
let startupSnapshotPending = true;
let startupSnapshotVersion = 0;
const lifetime = new AbortController();
let shellShortcutBindings: ShellShortcutBinding[] = [];
function receiveShellMessage(event: MessageEvent) {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.type === SHELL_SHORTCUTS_MESSAGE && Array.isArray(event.data.bindings)) shellShortcutBindings = event.data.bindings;
  if (event.data?.type === 'command' && event.data.command === 'platform.modeSelected') {
    if (startupSnapshotPending) startupSnapshotVersion++;
    startupResponses.delete('getPromptModes'); startupResponses.delete('getWorkspaceUri');
    const mode = event.data.data?.mode;
    if (mode === 'chat' || mode === 'code' || mode === 'character') characterPresentation.mode = mode;
  }
}
function forwardShellShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat || (event.target as Element | null)?.closest?.('.monaco-editor')) return;
  const binding = matchShellShortcut(event, shellShortcutBindings);
  if (!binding) return;
  event.preventDefault();
  window.parent.postMessage({ type: SHELL_SHORTCUT_MESSAGE, command: binding.command }, window.location.origin === 'null' ? '*' : window.location.origin);
}
if (!isMonitorView) {
  window.addEventListener('message', receiveShellMessage, { signal: lifetime.signal });
  window.addEventListener('keydown', forwardShellShortcut, { signal: lifetime.signal });
  window.parent.postMessage({ type: SHELL_SHORTCUTS_MESSAGE }, window.location.origin === 'null' ? '*' : window.location.origin);
}
let unsubscribeDesktop: (() => void) | undefined;
let activityTimer: number | undefined;
let assetTimer: ReturnType<typeof setTimeout> | undefined;
const notifyLanguage = () => window.parent.postMessage({ type: 'graycode.language', language: getLanguage() },
  window.location.origin === 'null' ? '*' : window.location.origin);
const stopLanguageWatch = watch(() => getLanguage(), notifyLanguage);
function disposePlatform() {
  lifetime.abort(); unsubscribeDesktop?.(); stopLanguageWatch(); subscribers.clear();
  window.clearInterval(activityTimer); clearTimeout(assetTimer);
  window.removeEventListener('pagehide', disposePlatform);
}
// 父页面比聊天 iframe 活得更久，卸载必须主动解除父页面持有的回调。
window.addEventListener('pagehide', disposePlatform, { once: true });
let defaultPromptModeId = 'code';
let persistedState: unknown;
const dispatch = (message: unknown) => { if (!lifetime.signal.aborted) for (const listener of subscribers) listener(message); };
const host: HostTransport = {
  kind: desktop.kind,
  openWorkspacePanel: panel => window.parent.postMessage({ type: WORKSPACE_PANEL_MESSAGE, panel }, window.location.origin),
  writeClipboardText: desktop.kind === 'web' ? undefined : text => desktop.call('desktop.clipboard.writeText', { text }),
  getDefaultPromptModeId: () => defaultPromptModeId,
  reportInitialization: error => {
    if (!isMonitorView && !lifetime.signal.aborted) window.parent.postMessage({ type: CHAT_INITIALIZATION_MESSAGE,
      status: error === undefined ? 'ready' : 'failed', error }, window.location.origin === 'null' ? '*' : window.location.origin);
  },
  getState: () => persistedState,
  setState: value => { if (!lifetime.signal.aborted) { persistedState = value; void desktop.call('ui.state.set', { value }); } },
  subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
  postMessage: value => {
    if (lifetime.signal.aborted) return;
    const message = value as { type: string; data: unknown; requestId: string };
    const data = isMonitorView && message.type.startsWith('subagents.')
      ? { conversationId: viewQuery.get('conversationId') ?? undefined, runId: viewQuery.get('runId') ?? undefined, ...message.data as Record<string, unknown> }
      : message.data;
    if (message.type === 'ui.settings.begin') startupResponses.clear();
    const request = () => desktop.call('ui.request', { type: message.type, data });
    const responseKey = message.type === 'config.getConfig' ? `${message.type}:${(data as { configId?: string }).configId}` : message.type;
    const initialResponse = startupResponses.has(responseKey) ? Promise.resolve(startupResponses.get(responseKey)) : request();
    startupResponses.delete(responseKey);
    void trackPreferenceRequest(message.type, message.data, initialResponse, request).then(
      data => dispatch({ type: 'response', success: true, requestId: message.requestId, data }),
      error => dispatch({ type: 'error', success: false, requestId: message.requestId, error: { code: error.code ?? 'HOST_ERROR', message: error.message } }),
    );
  },
};
let lastUserActivity = Date.now();
let lastActivitySent = 0;
function recordActivity() {
  lastUserActivity = Date.now();
  if (lastUserActivity - lastActivitySent < 30_000) return;
  lastActivitySent = lastUserActivity;
  void desktop.call('activity.pulse').catch(() => {});
}
const changedAssetPaths = new Set<string>();
function resetWorkspaceAssets() { if (assetTimer) clearTimeout(assetTimer); assetTimer = undefined; changedAssetPaths.clear(); invalidateWorkspaceAssets(); }
function receiveDesktopEvent(event: Record<string, any>) {
  if (lifetime.signal.aborted) return;
  if (startupSnapshotPending && (['workspace.selected', 'ui.conversation.focused', 'settings.changed', 'transport.resumed'].includes(event.type)
    || event.type === 'ui.message' && (event.message?.type === 'workspaceUri'
      || ['platform.modeSelected', 'platform.appearance', 'channels.configChanged', 'mcp.configChanged', 'settings.imported'].includes(event.message?.command))))
    startupSnapshotVersion++;
  if (event.type === 'workspace.selected' || event.type === 'ui.conversation.focused'
    || event.type === 'ui.message' && event.message?.type === 'workspaceUri') startupResponses.delete('getWorkspaceUri');
  if (event.type === 'ui.conversation.focused') startupResponses.delete('getPromptModes');
  if (event.type === 'transport.resumed') startupResponses.clear();
  if (event.type === 'desktop.saveAll' && !isMonitorView) {
    void (async () => {
      let error: string | undefined;
      try {
        if (desktopSettingsDraft.busy) throw new Error('设置正在保存，请稍后重试。');
        if (desktopSettingsDraft.editing) await saveDesktopSettings();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        await desktop.call('ui.command', { command: 'showSettings' }).catch(() => {});
      }
      await desktop.call('desktop.saveResult', { requestId: event.requestId, participant: 'settings', error });
    })().catch(error => { desktopSettingsDraft.error = String(error); });
  }
  if (event.type === 'workspace.selected' || event.type === 'ui.message' && event.message?.type === 'workspaceUri'
    || event.type === 'ui.conversation.focused' && !event.resynchronized
    || event.type === 'transport.resumed') resetWorkspaceAssets();
  // 消息所属项目可以与工作台选择不同；按变更路径刷新各对话的资源引用。
  if (event.type === 'file.changed') {
    if (typeof event.path === 'string') changedAssetPaths.add(event.path);
    if (typeof event.absolute === 'string') changedAssetPaths.add(event.absolute);
    // 固定窗口合并，不因持续写文件无限推迟失效。
    if (!assetTimer) assetTimer = setTimeout(() => { assetTimer = undefined; const paths = [...changedAssetPaths]; changedAssetPaths.clear(); invalidateWorkspaceAssets(paths.length ? paths : undefined); }, 150);
  }
  if (event.type === 'ui.message' && event.message?.command === 'platform.modeSelected') resetWorkspaceAssets();
  if (event.type === 'settings.changed') {
    startupResponses.clear();
    dispatch({ type: 'settingsChanged' });
    if (!startupSnapshotPending) void desktop.call('ui.request', { type: 'getPromptModes', data: {} })
      .then(result => { defaultPromptModeId = result.currentModeId || 'code'; }).catch(() => {});
  }
  if (event.type === 'ui.conversation.focused' && event.defaultPromptModeId) defaultPromptModeId = event.defaultPromptModeId;
  if (event.type === 'transport.resumed' && (event.snapshotRequired || event.authenticatedAgain))
    dispatch({ type: 'platformTransportResumed', data: { authenticatedAgain: event.authenticatedAgain === true } });
  if (event.type === 'remote.changed') dispatch({ type: 'command', command: 'platform.remote.changed' });
  if (event.type === 'migration.progress' || event.type === 'migration.completed')
    dispatch({ type: 'command', command: event.type, data: event });
  if (event.type === 'conversation.changed') dispatch({ type: 'platformConversationChanged', data: { conversationId: event.conversationId, deleted: event.deleted, metadataOnly: event.metadataOnly, preserveWindow: event.preserveWindow } });
  if (event.type === 'event' && (event.event?.type?.startsWith('question.') || event.event?.type?.startsWith('approval.') || event.event?.type?.startsWith('run.')))
    dispatch({ type: 'platformQuestionsChanged' });
  if (event.type === 'ui.message') {
    if (event.message?.command === 'platform.modeSelected') {
      startupResponses.delete('getPromptModes'); startupResponses.delete('getWorkspaceUri');
    }
    if (['channels.configChanged', 'mcp.configChanged', 'settings.imported'].includes(event.message?.command)) startupResponses.clear();
    if (['channels.configChanged', 'settings.imported'].includes(event.message?.command)) setChannelConfigsCache(null);
    if (event.message?.command === 'platform.modeSelected' && event.message.data?.promptModeId) defaultPromptModeId = event.message.data.promptModeId;
    if (event.message?.command === 'platform.appearance') applyDesktopAppearance(event.message.data);
    if (event.message?.command === 'platform.settingsDraftChanged') desktopSettingsDraft.dirty = event.message.data.dirty;
    dispatch(event.message);
  }
}

async function initializePlatform() {
  unsubscribeDesktop = desktop.subscribe(receiveDesktopEvent);
  let startup: UiStartupSnapshot<Readonly<GlobalSettings>, PromptMode, Readonly<CheckpointConfig>>;
  let version: number;
  do {
    version = startupSnapshotVersion;
    startup = await callDesktopBridge<typeof startup>(bridge, 'ui.startup');
    // 在途设置或上下文变更使整份快照失效；顺序重读，不能把旧响应重新写回已失效的缓存。
  } while (!lifetime.signal.aborted && version !== startupSnapshotVersion);
  startupSnapshotPending = false;
  persistedState = startup.state;
  if (lifetime.signal.aborted) return;
  for (const [type, value] of [
    ['getSettings', startup.settings], ['getPromptModes', startup.promptModes],
    ['settings.getActiveChannelId', startup.activeChannel], ['checkpoint.getConfig', startup.checkpoint],
    ['getWorkspaceUri', startup.workspaceUri],
  ] as const) startupResponses.set(type, value);
  if (startup.channels) {
    setChannelConfigsCache(startup.channels);
    const activeConfig = startup.channels.find(config => config.id === startup.activeChannel.channelId);
    if (activeConfig) startupResponses.set(`config.getConfig:${activeConfig.id}`, activeConfig);
  }
  window.__GRAYCODE_HOST = host;
  window.__GRAYCODE_BUILTIN_SOUND_ASSETS = { warning: { url: warningSound, name: 'warning.mp3' }, error: { url: errorSound, name: 'error.mp3' },
    taskComplete: { url: completeSound, name: 'taskComplete.mp3' }, taskError: { url: taskErrorSound, name: 'taskError.mp3' } };
  window.addEventListener('pointerdown', recordActivity, { passive: true, signal: lifetime.signal });
  window.addEventListener('keydown', recordActivity, { passive: true, signal: lifetime.signal });
  window.addEventListener('focus', recordActivity, { signal: lifetime.signal });
  activityTimer = window.setInterval(() => {
    if (document.hasFocus() && Date.now() - lastUserActivity < 5 * 60_000) {
      lastActivitySent = Date.now(); void desktop.call('activity.pulse').catch(() => {});
    }
  }, 60_000);
  recordActivity();

  document.documentElement.classList.add('platform-host');
  defaultPromptModeId = startup.promptModes.currentModeId || 'code';
  // 主界面挂载前读取已保存偏好，查看子代理不重复播放启动动画。
  window.__GRAYCODE_STARTUP_SPLASH_ENABLED = !isMonitorView && startup.settings.settings.ui?.appearance?.splashEnabled !== false;
  applyDesktopAppearance(startup.appearance);
  const language = startup.settings.settings.ui?.language;
  if (SUPPORTED_LANGUAGES.some(item => item.value === language)) await setLanguage(language as SupportedLanguage);
  if (lifetime.signal.aborted) return;
  notifyLanguage();
  await import('../main');
}

try { await initializePlatform(); }
catch (error) {
  host.reportInitialization?.(error instanceof Error ? error.message : String(error));
  disposePlatform();
  throw error;
}
