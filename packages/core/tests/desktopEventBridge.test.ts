import { contextBridge, ipcRenderer } from 'electron';
import '../../../apps/desktop/src/preload';
import { callDesktopBridge, desktopRpcReply, type DesktopBridge } from '../../../shared/desktopBridge';

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
