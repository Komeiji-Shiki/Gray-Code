import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { completionItems } from '../../../shared/completionItems';
import { fixture } from './fixtures';

async function project(files: Record<string, string>, run: (context: {
  app: PlatformApplication; call(method: string, params?: Record<string, unknown>): Promise<any>;
  diagnostics(file: string, matches: (values: any[]) => boolean): Promise<any[]>;
}) => Promise<void>) {
  const f = await fixture(); await f.store.close();
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(f.source, file), text);
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app);
  const client = { actorId: 'owner', clientId: 'common-languages' };
  const call = (method: string, params: Record<string, unknown> = {}) => router.call(client, method, params) as Promise<any>;
  try {
    const current = app.settings.snapshot();
    current.settings.workspaces.push({ id: 'project', name: '真实语言服务', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: current.settings, expectedRevision: current.revision });
    await run({ app, call, async diagnostics(file, matches) {
      let latest: any[] = [];
      for (let attempt = 0; attempt < 120; attempt++) {
        const values = await call('language.diagnostics', { workspaceId: 'project' });
        const current = values.find((value: any) => value.path === file);
        if (current) { latest = current.diagnostics; if (matches(latest)) return latest; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('诊断未满足条件：' + JSON.stringify(latest));
    } });
  } finally { await app.close(); await f.cleanup(); }
}

test.each([
  { file: 'index.html', text: '<div cla', server: 'html', label: 'class' },
  { file: 'style.css', text: '.sample { col', server: 'css', label: 'color' },
  { file: 'run.sh', text: '#!/usr/bin/env bash\nmy_variable=1\necho $my_', server: 'bash', label: 'my_variable' },
])('$server 的真实服务根据文件识别提供补全', async ({ file, text, server, label }) => {
  await project({ [file]: text }, async ({ call }) => {
    const doc = await call('documents.open', { workspaceId: 'project', path: file });
    const ready = await call('language.ensure', { workspaceId: 'project', path: file });
    expect(ready.session).toMatchObject({ serverId: server, status: 'running' });
    const lines = text.split('\n');
    const result = await call('language.request', { workspaceId: 'project', path: file, version: doc.version, requestId: 'completion',
      method: 'textDocument/completion', params: { position: { line: lines.length - 1, character: lines.at(-1)!.length }, context: { triggerKind: 1 } } });
    expect(completionItems(result).some(item => item.label.includes(label))).toBe(true);
  });
});

test('JSONC 保留注释且提供格式化，YAML 报告真实语法错误', async () => {
  await project({ 'config.jsonc': '{\n// 保留注释\n"port":80\n}', 'config.yaml': 'port: [80, 81\n' }, async ({ call, diagnostics }) => {
    const doc = await call('documents.open', { workspaceId: 'project', path: 'config.jsonc' });
    const ready = await call('language.ensure', { workspaceId: 'project', path: 'config.jsonc' });
    expect(ready.languageId).toBe('jsonc');
    const edits = await call('language.request', { workspaceId: 'project', path: 'config.jsonc', version: doc.version, requestId: 'format',
      method: 'textDocument/formatting', params: { options: { tabSize: 2, insertSpaces: true } } });
    expect(edits.length).toBeGreaterThan(0);
    expect(await diagnostics('config.jsonc', values => values.length === 0)).toEqual([]);
    await call('documents.open', { workspaceId: 'project', path: 'config.yaml' });
    expect((await call('language.ensure', { workspaceId: 'project', path: 'config.yaml' })).session.serverId).toBe('yaml');
    expect((await diagnostics('config.yaml', values => values.some(value => value.severity === 1))).length).toBeGreaterThan(0);
  });
});

test('Python 服务提供跨文件定义、类型诊断并在关闭后清理', async () => {
  const source = 'from helpers import add\nresult = add(1, 2)\nwrong: int = "text"\n';
  await project({ 'main.py': source, 'helpers.py': 'def add(left: int, right: int) -> int:\n    return left + right\n' }, async ({ call, diagnostics }) => {
    const doc = await call('documents.open', { workspaceId: 'project', path: 'main.py' });
    const ready = await call('language.ensure', { workspaceId: 'project', path: 'main.py' });
    expect(ready.session.serverId).toBe('python');
    const definitions = await call('language.request', { workspaceId: 'project', path: 'main.py', version: doc.version, requestId: 'definition',
      method: 'textDocument/definition', params: { position: { line: 1, character: 10 } } });
    const target = Array.isArray(definitions) ? definitions[0] : definitions;
    expect(await call('language.path', { workspaceId: 'project', uri: target.targetUri ?? target.uri })).toBe('helpers.py');
    await diagnostics('main.py', values => values.some(value => value.severity === 1));
    await call('documents.close', { workspaceId: 'project', path: 'main.py' });
    expect(await call('language.diagnostics', { workspaceId: 'project' })).toEqual([]);
    expect((await call('language.list')).sessions).toEqual([expect.objectContaining({ status: 'stopped' })]);
  });
});

test('Svelte 服务解析脚本类型并提供悬浮信息', async () => {
  const source = '<script lang="ts">\nlet count: number = "wrong";\n</script>\n<p>{count}</p>\n';
  await project({ 'main.svelte': source }, async ({ call, diagnostics }) => {
    const doc = await call('documents.open', { workspaceId: 'project', path: 'main.svelte' });
    const ready = await call('language.ensure', { workspaceId: 'project', path: 'main.svelte' });
    expect(ready.session.serverId).toBe('svelte');
    await diagnostics('main.svelte', values => values.some(value => String(value.code) === '2322'));
    const hover = await call('language.request', { workspaceId: 'project', path: 'main.svelte', version: doc.version, requestId: 'hover',
      method: 'textDocument/hover', params: { position: { line: 3, character: 6 } } });
    expect(JSON.stringify(hover)).toContain('number');
  });
});

test('自定义服务不接管内部辅助关系，启动失败返回实际依赖原因', async () => {
  await project({ 'main.py': 'value = 1\n' }, async ({ app, call }) => {
    const current = app.settings.snapshot();
    current.settings.development = { languageServers: [{ id: 'broken-python', name: '示例 Python 服务', languages: ['python'],
      command: process.execPath, args: ['-e', 'console.error("示例服务缺少运行依赖"); process.exit(3);'],
      companionId: 'broken-python', internal: true } as any] };
    await app.settings.save({ settings: current.settings, expectedRevision: current.revision });
    await call('documents.open', { workspaceId: 'project', path: 'main.py' });
    await expect(call('language.ensure', { workspaceId: 'project', path: 'main.py' })).rejects.toThrow('示例服务缺少运行依赖');
    expect((await call('language.list')).sessions).toEqual([expect.objectContaining({ serverId: 'broken-python', status: 'failed' })]);
  });
});

test('Vue 组合服务共用并发启动，提供脚本补全、解析及类型诊断并一起停止', async () => {
  const source = '<template><p>{{ count }}</p></template>\n<script setup lang="ts">\nconst count: number = "wrong";\nconst text = "hello";\ntext.toU\n</script>\n';
  await project({ 'main.vue': source, 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS' }, include: ['**/*.ts', '**/*.vue'] }) }, async ({ app, call, diagnostics }) => {
    const doc = await call('documents.open', { workspaceId: 'project', path: 'main.vue' });
    const [ready, again] = await Promise.all([call('language.ensure', { workspaceId: 'project', path: 'main.vue' }), call('language.ensure', { workspaceId: 'project', path: 'main.vue' })]);
    expect(ready.session.id).toBe(again.session.id);
    expect(ready.session.serverId).toBe('vue');
    expect((await call('language.list')).sessions).toHaveLength(1);
    const request = (method: string, params: Record<string, unknown>) => call('language.request', { workspaceId: 'project', path: 'main.vue', version: doc.version, requestId: method, method, params });
    await expect(request('textDocument/codeAction', { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], triggerKind: 2 } })).resolves.toBeInstanceOf(Array);
    const result = await request('textDocument/completion', { position: { line: 4, character: 8 }, context: { triggerKind: 1 } });
    const item = completionItems(result).find(value => value.label === 'toUpperCase');
    expect(item).toBeDefined();
    expect(await request('completionItem/resolve', item as unknown as Record<string, unknown>)).toMatchObject({ label: 'toUpperCase' });
    const definitions = await request('textDocument/definition', { position: { line: 0, character: source.split('\n')[0].indexOf('count') + 1 } });
    expect(definitions.some((value: any) => (value.targetSelectionRange ?? value.range)?.start.line === 2)).toBe(true);
    await diagnostics('main.vue', values => values.some(value => String(value.code) === '2322'));
    // 检查这次测试实际启动的两个进程，而不是只断言界面状态改变。
    const children = [...(app.languages as any).sessions.values()].map((session: any) => session.child);
    expect(children).toHaveLength(2);
    await call('language.stop', { id: ready.session.id });
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(await call('language.diagnostics', { workspaceId: 'project' })).toEqual([]);
  });
});
