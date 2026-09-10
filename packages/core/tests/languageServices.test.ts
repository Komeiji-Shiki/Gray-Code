import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

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
