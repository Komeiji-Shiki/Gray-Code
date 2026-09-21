import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// 在轻量浏览器环境执行实际入口，覆盖 SSE 普通事件与重连事件的相同分发路径。
function fixture() {
  const log = jest.fn(); const exports: Record<string, any> = {};
  class EventSource {
    onmessage?: (event: { data: string; lastEventId: string }) => void;
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
    throw new Error(name);
  }, window: { addEventListener() {} }, sessionStorage: { getItem: () => 'client', setItem() {} },
  console: { error: log }, EventSource });
  const bridge = exports.installWebBridge();
  return { bridge, events: EventSource.latest, log };
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

test('同一回调的独立订阅可以分别取消', () => {
  const { bridge, events } = fixture(); const listener = jest.fn();
  const first = bridge.subscribe(listener); const second = bridge.subscribe(listener);
  first(); events.onmessage!({ data: '{"type":"document.reset"}', lastEventId: '1' });
  expect(listener).toHaveBeenCalledTimes(1);
  second(); events.onmessage!({ data: '{"type":"document.reset"}', lastEventId: '2' });
  expect(listener).toHaveBeenCalledTimes(1);
});
