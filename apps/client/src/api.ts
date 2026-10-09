import type { RpcCall, UiRequestCall } from '@graycode/contracts';
import { callDesktopBridge, type DesktopBridge } from '../../../shared/desktopBridge';
import { requiresJsonRoundTrip } from '../../../shared/hostPayload';
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
  // 仅为代理对象及非 JSON 数据解包；普通文档和附件参数直接传输，避免复制正文。
  if (method === 'files.upload' && 'bytes' in params && params.bytes instanceof Uint8Array) {
    const { bytes, ...fields } = params;
    return callDesktopBridge<T>(window.graycode, method, { ...(requiresJsonRoundTrip(fields) ? JSON.parse(JSON.stringify(fields)) : fields), bytes });
  }
  const payload = requiresJsonRoundTrip(params) ? JSON.parse(JSON.stringify(params)) : params;
  return callDesktopBridge<T>(window.graycode, method, payload);
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
