import { expect, test, vi } from 'vitest';
import { closeWebBridge, installWebBridge } from '../../../../apps/client/src/webBridge';
import { shellText } from '../../../../apps/client/src/i18n';

test('主聊天准备连接挂起时按启动时限失败，随后可以明确重试', async () => {
  vi.useFakeTimers();
  const previousBridge = Object.getOwnPropertyDescriptor(window, 'graycode');
  Object.defineProperty(window, 'graycode', { configurable: true, writable: true, value: undefined });
  class EventStream extends EventTarget { close() {} }
  vi.stubGlobal('EventSource', EventStream);
  let rejectPending: ((error: Error) => void) | undefined;
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    rejectPending = reject;
    init?.signal?.addEventListener('abort', () => reject(new Error('请求已中止')), { once: true });
  }));
  vi.stubGlobal('fetch', fetcher);
  const bridge = installWebBridge();
  let failure: unknown;
  const pending = bridge.call('ui.view.prepare').catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(20_001);
    expect(failure).toEqual(new Error(shellText('connectionTimeout')));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { accepted: true, viewId: 'retry-view' } })));
    await expect(bridge.call('ui.view.prepare')).resolves.toEqual({ accepted: true, viewId: 'retry-view' });
  } finally {
    rejectPending?.(new Error('夹具结束'));
    await pending;
    closeWebBridge();
    if (previousBridge) Object.defineProperty(window, 'graycode', previousBridge);
    else Reflect.deleteProperty(window, 'graycode');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
