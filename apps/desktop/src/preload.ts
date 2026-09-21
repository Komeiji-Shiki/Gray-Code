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
    try { return await ipcRenderer.invoke('graycode:rpc', method, params); }
    catch (error) {
      // 界面显示后端的具体原因，不显示 Electron 通信包装的内部前缀。
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method 'graycode:rpc': (?:Error: )?/, ''));
    }
  },
  subscribe: (listener: (event: Record<string, unknown>) => void) => {
    const callback = (value: Record<string, unknown>) => listener(value);
    eventListeners.add(callback);
    return () => { eventListeners.delete(callback); };
  },
});
