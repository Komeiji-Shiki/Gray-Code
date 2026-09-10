export interface DesktopBridge {
  kind?: 'web';
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  subscribe(listener: (event: Record<string, any>) => void): () => void;
}
declare global {
  interface Window {
    graycode: DesktopBridge;
  }
}
export function call<T = any>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!window.graycode)
    return Promise.reject(new Error("请从 GrayCode 桌面应用打开此界面。"));
  // Vue 表单中的代理对象不能直接交给 Electron 的结构化克隆。
  if (method === 'files.upload' && params.bytes instanceof Uint8Array) {
    const { bytes, ...fields } = params;
    return window.graycode.call(method, { ...JSON.parse(JSON.stringify(fields)), bytes });
  }
  return window.graycode.call(method, JSON.parse(JSON.stringify(params)));
}
export function subscribe(
  listener: (event: Record<string, any>) => void,
): () => void {
  return window.graycode?.subscribe(listener) ?? (() => {});
}
