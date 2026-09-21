import { contextBridge, ipcRenderer } from 'electron';
import '../../../apps/desktop/src/preload';

jest.mock('electron', () => {
  const ipcRenderer = new (require('node:events').EventEmitter)();
  ipcRenderer.invoke = jest.fn();
  return { ipcRenderer, contextBridge: { exposeInMainWorld: jest.fn() } };
});

const bridge = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1] as {
  kind: 'desktop';
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
};

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
