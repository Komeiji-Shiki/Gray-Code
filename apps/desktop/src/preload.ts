import { contextBridge, ipcRenderer } from "electron";
import { validateRpcParams } from '@graycode/contracts';
// 页面中的组件共用一个 IPC 监听，打开多个文件时不会触发监听数量警告。
const eventListeners = new Set<(event: Record<string, unknown>) => void>();
ipcRenderer.on('graycode:event', (_event: Electron.IpcRendererEvent, value: Record<string, unknown>) => {
  for (const listener of [...eventListeners]) {
    try { listener(value); }
    catch (error) { console.error('桌面事件订阅者处理失败：', value.type, error); }
  }
});
contextBridge.exposeInMainWorld("graycode", {
  kind: 'desktop',
  call: async (method: string, params: Record<string, unknown> = {}) => {
    validateRpcParams(method, params);
    // 原样传递结构化回执，不能在隔离桥内重新抛出带自定义字段的异常。
    return ipcRenderer.invoke('graycode:rpc', method, params);
  },
  subscribe: (listener: (event: Record<string, unknown>) => void) => {
    const callback = (value: Record<string, unknown>) => listener(value);
    eventListeners.add(callback);
    return () => { eventListeners.delete(callback); };
  },
});
