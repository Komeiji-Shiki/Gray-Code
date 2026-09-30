import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function client() {
  const exports: Record<string, any> = {};
  const requests: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const source = fs.readFileSync(path.resolve('apps/client/src/state.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, localStorage: { getItem: () => null }, require: (name: string) => {
    if (name === 'vue') return { reactive: (value: unknown) => value, computed: (value: unknown) => value };
    if (name === './api') return { rpc: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      subscribe: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    throw new Error(name);
  } });
  return { state: exports.state, load: exports.loadSettings as () => Promise<void>, requests, listeners,
    initialize: exports.initialize as (signal?: AbortSignal) => Promise<() => void>, emit: (event: Record<string, unknown>) => { for (const listener of listeners) listener(event); } };
}
const snapshot = (revision: number, workspaceIds: string[]) => ({ revision, credentialIds: [], settings: { workspaces: workspaceIds.map(id => ({ id })) } });

test('较早的配置响应不能覆盖新配置或清空当前工作区', async () => {
  const f = client(); f.state.workspaceId = 'selected';
  const first = f.load(), second = f.load();
  f.requests[1].resolve(snapshot(2, ['selected'])); await second;
  f.requests[0].resolve(snapshot(1, [])); await first;
  expect(f.state.snapshot.revision).toBe(2);
  expect(f.state.workspaceId).toBe('selected');
});

test('过期刷新失败不覆盖新状态，当前刷新失败仍报告原因', async () => {
  const f = client();
  const first = f.load(), second = f.load();
  f.requests[1].resolve(snapshot(2, [])); await second;
  f.requests[0].reject(new Error('old failure')); await expect(first).resolves.toBeUndefined();
  const third = f.load(); f.requests[2].reject(new Error('current failure'));
  await expect(third).rejects.toThrow('current failure');
  expect(f.state.snapshot.revision).toBe(2);
});

test('启动期间先接收项目选择与设置更新，旧快照不清空新选择，刷新合并后才就绪', async () => {
  const f = client(), initializing = f.initialize();
  f.emit({ type: 'workspace.selected', source: 'desktop', workspaceId: 'new-project' });
  f.emit({ type: 'settings.changed' }); f.emit({ type: 'settings.changed' });
  f.requests[0].resolve(snapshot(1, []));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.state.workspaceId).toBe('new-project');
  expect(f.state.ready).toBe(false);
  expect(f.requests).toHaveLength(2);
  f.requests[1].resolve(snapshot(2, ['new-project']));
  const dispose = await initializing;
  expect(f.state.snapshot.revision).toBe(2);
  expect(f.state.ready).toBe(true);
  dispose(); expect(f.listeners.size).toBe(0);
});

test('启动失败时移除提前登记的监听，避免重试留下重复订阅', async () => {
  const f = client(), initializing = f.initialize();
  const rejected = expect(initializing).rejects.toThrow('startup failed');
  f.requests[0].reject(new Error('startup failed')); await rejected;
  expect(f.state.ready).toBe(false);
  expect(f.state.initializationError).toContain('startup failed');
  expect(f.listeners.size).toBe(0);
  const retry = f.initialize();
  expect(f.state.initializationError).toBe('');
  f.requests[1].resolve(snapshot(2, []));
  const dispose = await retry;
  expect(f.state.ready).toBe(true); expect(f.listeners.size).toBe(1); dispose();
});

test('丢失补发游标或重新登录会刷新外壳设置，普通重连不重复读取', async () => {
  const f = client(), initial = f.initialize();
  f.state.workspaceId = 'removed';
  f.requests[0].resolve(snapshot(1, ['removed']));
  const dispose = await initial;
  f.emit({ type: 'transport.resumed', snapshotRequired: false });
  expect(f.requests).toHaveLength(1);
  f.emit({ type: 'transport.resumed', snapshotRequired: true });
  expect(f.requests).toHaveLength(2);
  f.requests[1].resolve(snapshot(2, [])); await new Promise(resolve => setImmediate(resolve));
  expect(f.state.snapshot.revision).toBe(2); expect(f.state.workspaceId).toBe('');
  f.emit({ type: 'transport.resumed', snapshotRequired: false, authenticatedAgain: true });
  expect(f.requests).toHaveLength(3);
  f.requests[2].resolve(snapshot(3, [])); await new Promise(resolve => setImmediate(resolve));
  expect(f.state.snapshot.revision).toBe(3); dispose();
});

test('启动读取期间收到快照重建通知时合并刷新并等待最新快照', async () => {
  const f = client(), initial = f.initialize();
  f.emit({ type: 'transport.resumed', snapshotRequired: true });
  f.requests[0].resolve(snapshot(1, [])); await new Promise(resolve => setImmediate(resolve));
  expect(f.state.ready).toBe(false); expect(f.requests).toHaveLength(2);
  f.requests[1].resolve(snapshot(2, [])); const dispose = await initial;
  expect(f.state.snapshot.revision).toBe(2); dispose();
});

test('启动等待外部已发起的较新刷新，不提前就绪或重复发起读取', async () => {
  const f = client(), initializing = f.initialize(), latest = f.load();
  f.requests[0].resolve(snapshot(1, []));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.state.ready).toBe(false);
  expect(f.requests).toHaveLength(2);
  f.requests[1].resolve(snapshot(2, []));
  await latest; const dispose = await initializing;
  expect(f.state.snapshot.revision).toBe(2);
  expect(f.state.ready).toBe(true); dispose();
});

test('读取完成前卸载会立即移除监听，迟到快照不重新标记就绪', async () => {
  const f = client(), controller = new AbortController(), initializing = f.initialize(controller.signal);
  expect(f.listeners.size).toBe(1);
  controller.abort(); expect(f.listeners.size).toBe(0);
  f.requests[0].resolve(snapshot(1, [])); await initializing;
  expect(f.state.ready).toBe(false);
  expect(f.state.snapshot).toBeNull();
});
