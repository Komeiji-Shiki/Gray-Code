/**
 * preload.ts - runs in the renderer with contextIsolation enabled.
 *
 * Provides the same bridge the frontend used inside VS Code:
 *  - window.acquireVsCodeApi() -> { postMessage, getState, setState }
 *  - backend messages re-dispatched as window 'message' events
 *  - window.__GRAYCODE_BUILTIN_SOUND_ASSETS (built-in sounds over graycode://)
 *  - window.__graycodeNative (op, payload) -> Promise (dialog/shell/clipboard)
 *
 * 安全说明：所有对外暴露的 API 都通过 contextBridge 白名单暴露，
 * 渲染层只能调用这里定义的最小接口，无法直接触碰 Node/IPC。
 */

const { ipcRenderer, contextBridge } = require('electron');

let state: Record<string, any> = {};

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (message: any) => {
    ipcRenderer.send('graycode:renderer-to-backend', message);
  },
  getState: () => state,
  setState: (newState: Record<string, any>) => {
    state = newState || {};
  }
}));

ipcRenderer.on('graycode:backend-to-renderer', (_event: any, message: any) => {
  window.postMessage(message, '*');
});

contextBridge.exposeInMainWorld('__graycodeNative', (op: string, payload?: any) =>
  ipcRenderer.invoke('graycode:native', op, payload ?? null)
);

contextBridge.exposeInMainWorld('__GRAYCODE_BUILTIN_SOUND_ASSETS', {
  warning: { url: 'graycode://local/resources/sound/warning.mp3', name: 'warning.mp3' },
  error: { url: 'graycode://local/resources/sound/error.mp3', name: 'error.mp3' },
  taskComplete: { url: 'graycode://local/resources/sound/taskComplete.mp3', name: 'taskComplete.mp3' },
  taskError: { url: 'graycode://local/resources/sound/taskError.mp3', name: 'taskError.mp3' }
});

// Expose a tiny "electron" marker so the renderer can detect the host.
contextBridge.exposeInMainWorld('__GRAYCODE_HOST', 'electron');

// System locale, used by the "auto" (follow system) UI language mode.
contextBridge.exposeInMainWorld('__GRAYCODE_DETECTED_LANG', navigator.language || 'zh-CN');

// Sub-agent monitor window mode: the frontend renders the monitor UI when
// __GRAYCODE_VIEW_MODE === 'subagentMonitor'. Values are injected by the main
// process via webPreferences.additionalArguments.
const argValue = (name: string): string | undefined => {
  const prefix = name + '=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};
const viewMode = argValue('--graycode-view-mode');
if (viewMode) {
  contextBridge.exposeInMainWorld('__GRAYCODE_VIEW_MODE', viewMode);
}
const webviewClientId = argValue('--graycode-webview-client-id');
if (webviewClientId) {
  contextBridge.exposeInMainWorld('__GRAYCODE_WEBVIEW_CLIENT_ID', webviewClientId);
}
const initialRunId = argValue('--graycode-initial-run-id');
if (initialRunId) {
  contextBridge.exposeInMainWorld('__GRAYCODE_INITIAL_RUN_ID', initialRunId);
}
