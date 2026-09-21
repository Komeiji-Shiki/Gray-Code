import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function client() {
  const exports: Record<string, any> = {};
  const requests: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const source = fs.readFileSync(path.resolve('apps/client/src/state.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, localStorage: { getItem: () => null }, require: (name: string) => {
    if (name === 'vue') return { reactive: (value: unknown) => value, computed: (value: unknown) => value };
    if (name === './api') return { rpc: () => new Promise((resolve, reject) => requests.push({ resolve, reject })), subscribe: () => () => {} };
    throw new Error(name);
  } });
  return { state: exports.state, load: exports.loadSettings as () => Promise<void>, requests };
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
