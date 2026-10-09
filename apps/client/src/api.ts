import type { RpcCall, UiRequestCall } from '@graycode/contracts';
import { callDesktopBridge, type DesktopBridge } from '../../../shared/desktopBridge';
export type { DesktopBridge } from '../../../shared/desktopBridge';
declare global {
  interface Window {
    graycode: DesktopBridge;
  }
}
export function call<T = any>(
  method: string,
  params: object = {},
): Promise<T> {
  if (!window.graycode)
    return Promise.reject(new Error("请从 GrayCode 桌面应用打开此界面。"));
  // Vue 表单中的代理对象不能直接交给 Electron 的结构化克隆。
  if (method === 'files.upload' && 'bytes' in params && params.bytes instanceof Uint8Array) {
    const { bytes, ...fields } = params;
    return callDesktopBridge<T>(window.graycode, method, { ...JSON.parse(JSON.stringify(fields)), bytes });
  }
  return callDesktopBridge<T>(window.graycode, method, JSON.parse(JSON.stringify(params)));
}
export function subscribe(
  listener: (event: Record<string, any>) => void,
): () => void {
  return window.graycode?.subscribe(listener) ?? (() => {});
}
/** 已有契约的方法共用原有传输实现，同时由方法名推导参数和结果。 */
export const rpc: RpcCall = call;
/** 按内部操作名推导参数和结果，角色与导航组件共用现有传输。 */
export const uiRequest: UiRequestCall = (type, ...args) => call('ui.request', { type, data: args[0] ?? {} });
