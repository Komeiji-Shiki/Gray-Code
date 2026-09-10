import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("graycode", {
  call: async (method: string, params?: Record<string, unknown>) => {
    try { return await ipcRenderer.invoke('graycode:rpc', method, params); }
    catch (error) {
      // 界面显示后端的具体原因，不显示 Electron 通信包装的内部前缀。
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method 'graycode:rpc': (?:Error: )?/, ''));
    }
  },
  subscribe: (listener: (event: Record<string, unknown>) => void) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      value: Record<string, unknown>,
    ) => listener(value);
    ipcRenderer.on("graycode:event", callback);
    return () => ipcRenderer.removeListener("graycode:event", callback);
  },
});
