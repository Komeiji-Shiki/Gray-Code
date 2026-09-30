import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// 在轻量浏览器环境执行实际入口，覆盖 SSE 普通事件与重连事件的相同分发路径。
function fixture(fetcher?: typeof fetch) {
  const log = jest.fn(); const exports: Record<string, any> = {};
  class EventSource {
    onmessage?: (event: { data: string; lastEventId: string }) => void;
    onopen?: () => void;
    onerror?: () => void;
    handlers = new Map<string, (event: { data: string }) => void>();
    static latest: EventSource;
    constructor() { EventSource.latest = this; }
    addEventListener(name: string, callback: (event: { data: string }) => void) { this.handlers.set(name, callback); }
    close() {}
  }
  const source = fs.readFileSync(path.resolve('apps/client/src/webBridge.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, require: (name: string) => {
    if (name === 'vue') return { reactive: (value: unknown) => value };
    if (name === '@graycode/contracts') return require('@graycode/contracts');
    if (name === './i18n') return { shellText: (key: string) => key };
    throw new Error(name);
  }, window: { addEventListener() {} }, sessionStorage: { getItem: () => 'client', setItem() {} },
  console: { error: log }, EventSource, fetch: fetcher, AbortController, setTimeout, clearTimeout });
  const bridge = exports.installWebBridge();
  return { bridge, events: EventSource.latest, log, request: exports.webRequest, state: exports.webUi };
}

test('普通事件与恢复通知在订阅者出错后继续按顺序交付', () => {
  const { bridge, events, log } = fixture();
  bridge.subscribe(() => { throw new Error('失效组件'); });
  const listener = jest.fn(); bridge.subscribe(listener);
  events.onmessage!({ data: '{"type":"document.reset"}', lastEventId: '12' });
  events.handlers.get('synchronized')!({ data: '{"reset":true}' });
  expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['document.reset', 'transport.resumed']);
  expect(log).toHaveBeenCalledTimes(2);
});

test('请求超时能取消认证读取并给出恢复文案，不给普通长运行请求设期限', async () => {
  const fetcher = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const f = fixture(fetcher as typeof fetch);
  await expect(f.request('/auth/session', undefined, 5)).rejects.toThrow('connectionTimeout');
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  const immediate = fixture(jest.fn(async (_url, options) => {
    expect(options.signal).toBeUndefined(); return { ok: true, json: async () => ({ result: 'ready' }) };
  }) as unknown as typeof fetch);
  expect(await immediate.request('/rpc', { method: 'chat.awaitConversationIdle' })).toEqual({ result: 'ready' });
});

test('SSE错误只在首次断开时通知，重连补发后恢复通知仍按顺序交付', () => {
  const f = fixture(jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch);
  const listener = jest.fn(); f.bridge.subscribe(listener);
  f.events.onopen!(); f.events.onerror!(); f.events.onerror!();
  f.events.handlers.get('synchronized')!({ data: '{"reset":true}' });
  expect(listener.mock.calls.map(([event]) => event.type)).toEqual(['transport.connected', 'transport.disconnected', 'transport.resumed']);
  expect(f.state.connection).toBe('disconnected');
});

test('同一回调的独立订阅可以分别取消', () => {
  const { bridge, events } = fixture(); const listener = jest.fn();
  const first = bridge.subscribe(listener); const second = bridge.subscribe(listener);
  first(); events.onmessage!({ data: '{"type":"document.reset"}', lastEventId: '1' });
  expect(listener).toHaveBeenCalledTimes(1);
  second(); events.onmessage!({ data: '{"type":"document.reset"}', lastEventId: '2' });
  expect(listener).toHaveBeenCalledTimes(1);
});
