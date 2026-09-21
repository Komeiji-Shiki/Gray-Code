import { reactive } from 'vue';
import { validateRpcParams } from '@graycode/contracts';
import type { DesktopBridge } from './api';

interface Directory { name: string; path: string }
export const webUi = reactive({ chooserOpen: false, directory: '', parent: '', directories: [] as Directory[],
  directoryDevice: '', directoryRoots: [] as Directory[], directoryBreadcrumbs: [] as Directory[],
  directoryError: '', directoryBusy: false, previewUrl: '', connection: 'connecting' as 'connecting' | 'connected' | 'disconnected' });
let chooseResult: ((value: { directory: string; name: string } | null) => void) | undefined;
let directoryRequestId = 0;
let dirtySettings = false;
let dirtyDocuments = false;
let pendingFileUploads = 0;
let eventSource: EventSource | undefined;
let lastEventId = '';
let bridgeInstalled = false;
const listeners = new Set<(event: Record<string, any>) => void>();
const tabId = sessionStorage.getItem('graycode.webClient') ?? crypto.randomUUID();
sessionStorage.setItem('graycode.webClient', tabId);

export async function webRequest(url: string, body?: unknown) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'X-Graycode-Client': tabId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/auth/login') window.dispatchEvent(new Event('graycode:session-expired'));
    throw Object.assign(new Error(value.error ?? '请求失败。'), { code: value.code, status: response.status });
  }
  return value;
}
async function rpc(method: string, params: Record<string, unknown> = {}) { return (await webRequest('/rpc', { method, params })).result; }
export async function browseDirectory(directory = '') {
  const requestId = ++directoryRequestId;
  webUi.directoryBusy = true; webUi.directoryError = '';
  try {
    const result = await rpc('host.directories', { path: directory });
    if (requestId !== directoryRequestId) return;
    webUi.directory = result.directory; webUi.parent = result.parent; webUi.directories = result.directories;
    webUi.directoryDevice = result.device.name; webUi.directoryRoots = result.roots;
    webUi.directoryBreadcrumbs = result.breadcrumbs;
  } catch (error) { if (requestId === directoryRequestId) webUi.directoryError = (error as Error).message; }
  finally { if (requestId === directoryRequestId) webUi.directoryBusy = false; }
}
export function finishDirectory(accepted: boolean) {
  if (accepted && (webUi.directoryBusy || webUi.directoryError || !webUi.directory)) return;
  const value = accepted ? { directory: webUi.directory, name: webUi.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? webUi.directory } : null;
  directoryRequestId++; webUi.directoryBusy = false;
  webUi.chooserOpen = false; chooseResult?.(value); chooseResult = undefined;
}
function chooseDirectory(): Promise<{ directory: string; name: string } | null> {
  if (chooseResult) throw new Error('目录选择窗口已经打开。');
  webUi.chooserOpen = true;
  const result = new Promise<{ directory: string; name: string } | null>(resolve => { chooseResult = resolve; });
  void browseDirectory(webUi.directory); return result;
}
function chooseSettingsFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
    const finish = (file: File | null) => { input.remove(); resolve(file); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.appendChild(input); input.click();
  });
}
function emit(event: Record<string, any>) {
  for (const listener of [...listeners]) {
    try { listener(event); }
    catch (error) { console.error('Web 事件订阅者处理失败：', event.type, error); }
  }
}
export function closeWebBridge() { eventSource?.close(); eventSource = undefined; finishDirectory(false); }
export function installWebBridge(): DesktopBridge {
  eventSource?.close();
  const authenticatedAgain = bridgeInstalled; bridgeInstalled = true;
  let firstSynchronization = true;
  eventSource = new EventSource(`/events?client=${encodeURIComponent(tabId)}${lastEventId ? `&after=${encodeURIComponent(lastEventId)}` : ''}`);
  eventSource.onopen = () => { webUi.connection = 'connected'; emit({ type: 'transport.connected' }); };
  eventSource.onerror = () => {
    webUi.connection = 'disconnected';
    void webRequest('/auth/session').catch(() => {});
  };
  eventSource.onmessage = event => { lastEventId = event.lastEventId; try { emit(JSON.parse(event.data)); } catch { /* 单条异常事件不终止后续推送。 */ } };
  eventSource.addEventListener('reset', () => { lastEventId = ''; });
  eventSource.addEventListener('synchronized', event => {
    const reset = JSON.parse((event as MessageEvent).data).reset === true;
    emit({ type: 'transport.resumed', snapshotRequired: reset, authenticatedAgain: authenticatedAgain && firstSynchronization });
    firstSynchronization = false;
  });
  const bridge: DesktopBridge = {
    kind: 'web',
    subscribe: listener => {
      const callback = (event: Record<string, any>) => listener(event);
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    call: async (method, input = {}) => {
      validateRpcParams(method, input);
      let params: Record<string, any> = input;
      if (method === 'pets.import') return (await webRequest('/pet-resources/import', params)).result;
      if (method === 'files.upload') {
        pendingFileUploads++;
        try {
        let response: Response;
        try { response = await fetch(`/files/upload/${encodeURIComponent(params.workspaceId)}?path=${encodeURIComponent(params.path)}`, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Graycode-Client': tabId, 'X-Graycode-File-Version': params.expectedVersion }, body: params.bytes }); }
        catch { throw new Error('上传连接中断，请刷新目录确认文件是否已经上传。'); }
        const value = await response.json();
        if (response.status === 401) window.dispatchEvent(new Event('graycode:session-expired'));
        if (!response.ok) throw new Error(value.error ?? '文件上传失败。'); return value.result;
        } finally { pendingFileUploads--; }
      }
      if (method === 'files.download') {
        const entry = await rpc('files.downloadInfo', { workspaceId: params.workspaceId, path: params.path });
        const link = document.createElement('a'); link.href = `/files/download/${encodeURIComponent(params.workspaceId)}?path=${encodeURIComponent(params.path)}`; link.download = entry.name;
        document.body.appendChild(link); link.click(); link.remove(); return { success: true, requested: true };
      }
      if (method === 'ui.request' && ['previewAttachment', 'showContextContent', 'saveImageToPath'].includes(String(params.type)))
        return (await webRequest('/ui/media', params)).result;
      if (method === 'ui.request' && params.type === 'characters.import')
        return (await webRequest('/character-resources/import', params.data)).result;
      if (method === 'ui.request' && ['openUpdatePage', 'updateNow', 'installUpdate', 'exportPromptModes', 'reloadWindow', 'desktop.fonts', 'desktop.chooseWorkspace', 'desktop.dirtySettings', 'settings.import', 'settings.export'].includes(String(params.type))) {
        method = String(params.type); params = params.data ?? {};
      }
      if (['openUpdatePage', 'updateNow', 'installUpdate'].includes(method)) { window.open('https://github.com/Komeiji-Shiki/Gray-Code/releases', '_blank', 'noopener,noreferrer'); return { success: true, manual: true, message: '已打开发布页面。请在运行服务的设备上更新应用。' }; }
      if (method === 'reloadWindow') { window.setTimeout(() => window.location.reload(), 100); return { success: true }; }
      if (method === 'exportPromptModes') {
        if (typeof params.content !== 'string') throw new Error('预设内容无效。');
        const url = URL.createObjectURL(new Blob([params.content], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = String(params.filename ?? 'graycode-prompt-modes.json'); link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000); return { success: true, filePath: link.download };
      }
      if (method === 'desktop.chooseWorkspace') return chooseDirectory();
      if (method === 'web.logout') { await webRequest('/auth/logout', {}); window.dispatchEvent(new Event('graycode:session-expired')); return; }
      if (method === 'desktop.fonts') return [];
      if (method === 'desktop.dirtySettings') { dirtySettings = params.dirty === true; return; }
      if (method === 'desktop.dirtyDocuments') { dirtyDocuments = Number(params.count) > 0; return; }
      if (method === 'settings.import') {
        const file = await chooseSettingsFile(); if (!file) return { cancelled: true };
        if (file.size > 128 * 1024 * 1024) throw new Error('设置文件不能超过 128 MiB。');
        return (await webRequest('/settings/import', JSON.parse((await file.text()).replace(/^\uFEFF/, '')))).result;
      }
      if (method === 'settings.export') {
        const value = await rpc('ui.request', { type: 'settings.exportData', data: {} });
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'graycode-settings.json'; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000); return { success: true, filePath: 'graycode-settings.json' };
      }
      if (method === 'browser.openFile') {
        const prefix = /\.html?$/i.test(params.path) ? '/preview/' : '/files/content/';
        emit({ type: 'browser.opened', url: `${prefix}${encodeURIComponent(params.workspaceId)}?path=${encodeURIComponent(params.path)}` });
        return { success: true };
      }
      if (method === 'browser.open') { if (!/^https?:\/\//i.test(params.url) && params.url !== 'about:blank') throw new Error('请输入 HTTP(S) 地址。'); emit({ type: 'browser.opened', url: params.url }); return { success: true }; }
      if (method === 'browser.layout') return;
      if (method === 'browser.control') throw new Error('Web 预览的导航由页面自身处理。');
      return rpc(method, params);
    },
  };
  window.graycode = bridge;
  return bridge;
}
window.addEventListener('beforeunload', event => {
  if (window.graycode?.kind === 'web' && (dirtySettings || dirtyDocuments || pendingFileUploads > 0)) { event.preventDefault(); event.returnValue = ''; }
});
