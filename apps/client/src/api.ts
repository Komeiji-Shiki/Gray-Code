import { shellText as t } from './i18n';
import type { RpcCall, UiRequestCall } from '@graycode/contracts';
import { callDesktopBridge, type DesktopBridge } from '../../../shared/desktopBridge';
import { prepareHostPayload } from '../../../shared/hostPayload';
import { toRaw } from 'vue';
export type { DesktopBridge } from '../../../shared/desktopBridge';
declare global {
  interface Window {
    graycode: DesktopBridge;
  }
}
export function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!window.graycode) return Promise.reject(new Error(t('uiapiDesktopAppRequired')));
  // 代理只复制相关分支；普通文档和附件参数继续直接传输。
  if (method === 'files.upload' && 'bytes' in params && params.bytes instanceof Uint8Array) {
    const { bytes, ...fields } = params;
    const prepared = prepareHostPayload(fields, toRaw);
    return callDesktopBridge<T>(window.graycode, method, { ...prepared, bytes });
  }
  const payload = prepareHostPayload(params, toRaw);
  return callDesktopBridge<T>(window.graycode, method, payload);
}
export function subscribe(listener: (event: Record<string, any>) => void): () => void {
  return window.graycode?.subscribe(listener) ?? (() => {});
}
/** 已有契约的方法共用原有传输实现，同时由方法名推导参数和结果。 */
export const rpc: RpcCall = call;
/** 按内部操作名推导参数和结果，角色与导航组件共用现有传输。 */
export const uiRequest: UiRequestCall = (type, ...args) => call('ui.request', { type, data: args[0] ?? {} });
