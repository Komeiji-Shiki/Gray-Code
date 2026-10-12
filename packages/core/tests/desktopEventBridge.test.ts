import { contextBridge, ipcRenderer } from 'electron';
import '../../../apps/desktop/src/preload';
import { callDesktopBridge, desktopRpcReply, type DesktopBridge } from '../../../shared/desktopBridge';
import { DesktopRequests } from '../../../apps/desktop/src/requests';
import { getLanguage, setLanguage } from '../../../backend/i18n';

jest.mock('electron', () => {
  const ipcRenderer = new (require('node:events').EventEmitter)();
  ipcRenderer.invoke = jest.fn();
  return { ipcRenderer, contextBridge: { exposeInMainWorld: jest.fn() } };
});

const bridge = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1] as DesktopBridge;

test('桌面 RPC 经过两次跨上下文复制后仍保留取消错误码', async () => {
  (ipcRenderer.invoke as jest.Mock).mockImplementationOnce(async () => structuredClone(await desktopRpcReply(async () => {
    throw Object.assign(new Error('Cancelled by user.'), { code: 'CANCELLED_ERROR' });
  })));
  const renderer: DesktopBridge = { ...bridge, call: async (method, params) => structuredClone(await bridge.call(method, params)) };
  await expect(callDesktopBridge(renderer, 'ui.request', { type: 'chatStream', data: {} }))
    .rejects.toMatchObject({ code: 'CANCELLED_ERROR', message: 'Cancelled by user.' });
});

test.each([
  { language: 'zh-CN' as const, message: '应用正在关闭，请稍后重新打开。' },
  { language: 'en' as const, message: 'The app is closing. Please reopen it shortly.' },
  { language: 'ja' as const, message: 'アプリを終了しています。しばらくしてからもう一度開いてください。' },
])('桌面关闭拒绝经过桥接后保留 APP_CLOSING 和 $language 提示', async ({ language, message }) => {
  const previousLanguage = getLanguage();
  const requests = new DesktopRequests({ isClosing: () => true } as ConstructorParameters<typeof DesktopRequests>[0]);
  try {
    setLanguage(language);
    (ipcRenderer.invoke as jest.Mock).mockImplementationOnce(async () => structuredClone(await desktopRpcReply(
      () => requests.call(1, 'ui.request', { type: 'config.listConfigs', data: {} }),
    )));
    const renderer: DesktopBridge = { ...bridge, call: async (method, params) => structuredClone(await bridge.call(method, params)) };
    await expect(callDesktopBridge(renderer, 'ui.request', { type: 'config.listConfigs', data: {} }))
      .rejects.toMatchObject({ code: 'APP_CLOSING', message });
  } finally { setLanguage(previousLanguage); }
});

test('桌面 RPC 成功结果与 Web 原始结果保持业务数据原样', async () => {
  const value = { success: false, code: 'RUN_CANCEL_TIMEOUT' };
  (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(await desktopRpcReply(async () => value));
  expect(await callDesktopBridge(bridge, 'ui.request', { type: 'cancelStream', data: {} })).toEqual(value);
  expect(await callDesktopBridge({ ...bridge, kind: 'web', call: async () => value }, 'ui.request')).toBe(value);
});

test('多个编辑器订阅共用一个 IPC 监听，并各自收到一次事件', () => {
  expect(bridge.kind).toBe('desktop');
  const listeners = Array.from({ length: 20 }, () => jest.fn());
  const cleanup = listeners.map(listener => bridge.subscribe(listener));
  try {
    expect(ipcRenderer.listenerCount('graycode:event')).toBe(1);
    const event = { type: 'language.diagnostics' };
    ipcRenderer.emit('graycode:event', {}, event);
    for (const listener of listeners) { expect(listener).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledWith(event); }
  } finally { cleanup.forEach(dispose => dispose()); }
});

test('重复使用同一回调的订阅仍可分别取消', () => {
  const listener = jest.fn(); const first = bridge.subscribe(listener); const second = bridge.subscribe(listener);
  first();
  ipcRenderer.emit('graycode:event', {}, { type: 'document.reset' });
  expect(listener).toHaveBeenCalledTimes(1);
  second();
  ipcRenderer.emit('graycode:event', {}, { type: 'document.reset' });
  expect(listener).toHaveBeenCalledTimes(1);
});

test('订阅者抛错不影响其他订阅者或后续事件', () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const broken = bridge.subscribe(() => { throw new Error('界面错误'); });
  const listener = jest.fn(); const unsubscribe = bridge.subscribe(listener);
  try {
    ipcRenderer.emit('graycode:event', {}, { type: 'document.reset' });
    ipcRenderer.emit('graycode:event', {}, { type: 'transport.resumed' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  } finally { broken(); unsubscribe(); log.mockRestore(); }
});
