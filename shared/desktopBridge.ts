export interface DesktopBridge {
  kind?: 'desktop' | 'web';
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  subscribe(listener: (event: Record<string, any>) => void): () => void;
}

export type DesktopRpcReply<T = unknown> = { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

/** IPC 和隔离桥都会丢弃 Error 的自定义字段，跨越两层边界时只传普通对象。 */
export async function desktopRpcReply<T>(operation: () => Promise<T>): Promise<DesktopRpcReply<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { code } : {}) } };
  }
}

/** 在页面自己的上下文中恢复异常，工具与聊天才能按原错误码处理。 */
export async function callDesktopBridge<T = any>(bridge: DesktopBridge, method: string, params: Record<string, unknown> = {}): Promise<T> {
  let result: DesktopRpcReply<T>;
  try {
    const value = await bridge.call(method, params);
    if (bridge.kind !== 'desktop') return value;
    result = value;
  } catch (error) {
    if (bridge.kind !== 'desktop') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method 'graycode:rpc': (?:Error: )?/, ''));
  }
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error.code ? { code: result.error.code } : {});
  return result.value;
}
