import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';
import { completionItems } from '../../../apps/client/src/completionItems';

test('内置语言服务使用受控运行程序，首次跨文件定位和文档诊断保持完整、可清除', async () => {
  const f = await fixture(); await f.store.close();
  const source = "import { add } from './math';\nexport const result = add(1, 2);\n";
  await writeFile(path.join(f.source, 'main.ts'), source);
  await writeFile(path.join(f.source, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  await writeFile(path.join(f.source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true } }));
  // 项目中的同名包不能替代内置的语言服务运行程序。
  const localTypeScript = path.join(f.source, 'node_modules', 'typescript');
  await mkdir(path.join(localTypeScript, 'lib'), { recursive: true });
  await writeFile(path.join(localTypeScript, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
  await writeFile(path.join(localTypeScript, 'lib', 'tsserver.js'), "throw new Error('Workspace compiler must not execute');");
  const app = await PlatformApplication.open({ dataDirectory: f.data }); const router = new ApplicationRouter(app);
  const client = { actorId: 'owner', clientId: 'language-test' };
  const call = (method: string, params: Record<string, unknown>) => router.call(client, method, params) as Promise<any>;
  async function diagnostics(match: (diagnostics: any[]) => boolean) {
    for (let count = 0; count < 80; count++) {
      const values = await call('language.diagnostics', { workspaceId: 'project' });
      const result = values.find((value: any) => match(value.diagnostics)); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('语言服务没有更新诊断');
  }
  try {
    const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'project', name: '语言测试', directory: f.source, deviceId: 'local' });
    settings.settings.accounts.push({ id: 'reader', displayName: '只读成员', role: 'member', effects: ['workspace_read'], workspaceIds: ['project'] });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    let document = await call('documents.open', { workspaceId: 'project', path: 'main.ts' });
    const ready = await call('language.ensure', { workspaceId: 'project', path: 'main.ts' });
    const definition = await call('language.request', { workspaceId: 'project', path: 'main.ts', version: document.version,
      method: 'textDocument/definition', requestId: 'definition', params: { position: { line: 1, character: 23 } } });
    const target = definition[0].targetUri ?? definition[0].uri;
    expect(await call('language.path', { workspaceId: 'project', uri: target })).toBe('math.ts');
    document = await call('documents.update', { workspaceId: 'project', path: 'main.ts', version: document.version, text: source + "export const invalid: number = 'wrong';\n" });
    expect((await diagnostics(values => values.some(value => value.code === 2322))).uri).toBe(ready.uri);
    await call('documents.update', { workspaceId: 'project', path: 'main.ts', version: document.version, text: source });
    expect((await diagnostics(values => values.length === 0)).uri).toBe(ready.uri);
    await expect(router.call({ actorId: 'reader', clientId: 'other' }, 'language.ensure', { workspaceId: 'project', path: 'main.ts' })).rejects.toThrow('Owner');
  } finally { await app.close(); await f.cleanup(); }
});

test('补全保留列表共享范围、片段与解析数据，条目自身的设置优先', () => {
  const selection = { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } };
  const items = completionItems({ isIncomplete: false, itemDefaults: { editRange: selection, insertTextFormat: 2, data: { module: 'math' }, commitCharacters: ['.'] },
    items: [{ label: 'addNumbers', textEditText: 'addNumbers(${1:left}, ${2:right})' }, { label: 'constant', insertTextFormat: 1, data: { literal: true } }] });
  expect(items[0]).toMatchObject({ textEdit: { range: selection, newText: 'addNumbers(${1:left}, ${2:right})' }, insertTextFormat: 2, data: { module: 'math' }, commitCharacters: ['.'] });
  expect(items[1]).toMatchObject({ insertTextFormat: 1, data: { literal: true } });
});

test('真实 TypeScript 服务提供自动导入、参数提示和错误修复，关闭文档清除对应诊断', async () => {
  const f = await fixture(); await f.store.close();
  const source = 'export const result = addNum';
  await writeFile(path.join(f.source, 'main.ts'), source);
  await writeFile(path.join(f.source, 'math.ts'), '/** 将两个数相加。 */\nexport function addNumbers(left: number, right: number) { return left + right; }\n');
  await writeFile(path.join(f.source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true } }));
  const app = await PlatformApplication.open({ dataDirectory: f.data }); const router = new ApplicationRouter(app);
  const client = { actorId: 'owner', clientId: 'editor-features' };
  const call = (method: string, params: Record<string, unknown>) => router.call(client, method, params) as Promise<any>;
  const events: Record<string, any>[] = []; app.subscribe(event => { if (event.type === 'language.diagnostics') events.push(event); });
  try {
    const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'project', name: '编辑器', directory: f.source, deviceId: 'local' });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    let doc = await call('documents.open', { workspaceId: 'project', path: 'main.ts' });
    const ready = await call('language.ensure', { workspaceId: 'project', path: 'main.ts' });
    let requestId = 0;
    const appliedEdits: unknown[] = [];
    app.subscribe(event => {
      if (event.type !== 'language.applyEdit') return;
      void (async () => {
        const edit = event.edit as any;
        try {
          await expect(router.call({ actorId: 'owner', clientId: 'another-editor' }, 'language.applyEditResult', { id: event.id, result: { applied: true } })).rejects.toThrow('当前客户端');
          for (const change of edit.documentChanges) {
            const file = await call('language.path', { workspaceId: 'project', uri: change.textDocument.uri });
            const current = await call('documents.open', { workspaceId: 'project', path: file });
            let text = current.text;
            const offset = (position: { line: number; character: number }) => current.text.split('\n').slice(0, position.line).reduce((sum: number, line: string) => sum + line.length + 1, 0) + position.character;
            for (const value of [...change.edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) text = text.slice(0, offset(value.range.start)) + value.newText + text.slice(offset(value.range.end));
            const updated = await call('documents.update', { workspaceId: 'project', path: file, version: current.version, text });
            if (file === 'main.ts') doc = updated;
          }
          appliedEdits.push(edit);
          await call('language.applyEditResult', { id: event.id, result: { applied: true } });
        } catch (error) { await call('language.applyEditResult', { id: event.id, result: { applied: false, failureReason: String(error) } }); }
      })();
    });
    const request = (method: string, params: Record<string, unknown>) => call('language.request', { workspaceId: 'project', path: 'main.ts', version: doc.version, method, params, requestId: `feature-${++requestId}` });
    const items = completionItems(await request('textDocument/completion', { position: { line: 0, character: source.length }, context: { triggerKind: 1 } }));
    const item = items.find(value => value.label === 'addNumbers'); expect(item).toBeDefined();
    const resolved = await request('completionItem/resolve', item as unknown as Record<string, unknown>);
    expect(JSON.stringify(resolved.additionalTextEdits)).toContain('./math');
    const signatureSource = "import { addNumbers } from './math';\nexport const result = addNumbers(1, );\n";
    doc = await call('documents.update', { workspaceId: 'project', path: 'main.ts', version: doc.version, text: signatureSource });
    const signature = await request('textDocument/signatureHelp', { position: { line: 1, character: signatureSource.split('\n')[1].indexOf(')') }, context: { triggerKind: 1, isRetrigger: false } });
    expect(signature).toMatchObject({ activeParameter: 1, signatures: expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining('right: number') })]) });
    doc = await call('documents.update', { workspaceId: 'project', path: 'main.ts', version: doc.version, text: 'export const result = addNumbers(1, 2);\n' });
    let diagnostic: any;
    for (let count = 0; count < 100 && !diagnostic; count++) {
      const files = await call('language.diagnostics', { workspaceId: 'project' });
      diagnostic = files.find((value: any) => value.uri === ready.uri)?.diagnostics.find((value: any) => value.code === 2304);
      if (!diagnostic) await new Promise(resolve => setTimeout(resolve, 40));
    }
    expect(diagnostic).toBeDefined();
    const actions = await request('textDocument/codeAction', { range: diagnostic.range, context: { diagnostics: [diagnostic], only: ['quickfix'], triggerKind: 1 } });
    const fix = actions.find((action: any) => JSON.stringify(action.command).includes('./math'));
    expect(fix).toBeDefined();
    await call('language.executeCommand', { workspaceId: 'project', path: 'main.ts', version: doc.version, requestId: 'apply-import', ...fix.command });
    expect(appliedEdits).toHaveLength(1);
    expect(doc.text).toContain('./math');
    await call('documents.open', { workspaceId: 'project', path: 'math.ts' });
    await call('documents.close', { workspaceId: 'project', path: 'main.ts', discard: true });
    expect(events.at(-1)).toMatchObject({ uri: ready.uri, diagnostics: [] });
    expect((await call('language.diagnostics', { workspaceId: 'project' })).some((item: any) => item.uri === ready.uri)).toBe(false);
    expect(await call('language.list', {})).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ status: 'running' })]) });
  } finally { await app.close(); await f.cleanup(); }
});
