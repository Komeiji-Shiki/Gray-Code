import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { DocumentState } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { DesktopOpenFiles, desktopFileArguments, openDesktopPath } from '../../../apps/desktop/src/openFiles';
import { DesktopEditorRegistration, editorRegistrationValues } from '../../../apps/desktop/src/editorRegistration';
import { fixture } from './fixtures';

test('文件关联命令保留中文和空格，仅注册打开方式及应用能力', async () => {
  const executable = path.resolve('编辑器 & 工具', 'GrayCode.exe');
  const values = editorRegistrationValues(executable);
  expect(values.find(value => value.key.endsWith('GrayCode.SourceFile\\shell\\open\\command'))?.value).toBe(`"${executable}" -- "%1"`);
  expect(values.some(value => /UserChoice/.test(value.key))).toBe(false);
  expect(values.filter(value => /Classes\\\./.test(value.key)).every(value => value.key.endsWith('OpenWithProgids') && value.name === 'GrayCode.SourceFile')).toBe(true);
  let command = '';
  const run = jest.fn(async input => { if (input.action === 'read') return command; command = input.values.find(value => value.key.endsWith('GrayCode.SourceFile\\shell\\open\\command')).value; return ''; });
  const registration = new DesktopEditorRegistration(executable, true, 'win32', run);
  expect((await registration.status()).registered).toBe(false); expect((await registration.register()).registered).toBe(true);
  const dev = new DesktopEditorRegistration(executable, false, 'win32', run);
  await expect(dev.register()).rejects.toThrow('GrayCode.exe');
});

test('启动和后续文件请求等待编辑器就绪，启动参数的值不作为文件打开', async () => {
  const directory = path.resolve('.tmp'); const first = path.join(directory, '中文 空格.ts');
  expect(desktopFileArguments(['--data', 'private-data', '--web-port', '8787', '--web-token-env', 'TOKEN', '--web-origin', 'https://example.invalid', '--', '中文 空格.ts', pathToFileURL(first).href, '-script.py'], directory))
    .toEqual([first, path.join(directory, '-script.py')]);
  const opened: string[] = []; const failures = jest.fn();
  const queue = new DesktopOpenFiles(async file => { if (file === 'missing') throw new Error('missing'); opened.push(file); }, failures);
  queue.enqueue(['first']); expect(opened).toEqual([]);
  await queue.clientReady(); expect(opened).toEqual(['first']);
  queue.suspend(); queue.enqueue(['missing', 'second']); expect(opened).toEqual(['first']);
  await queue.clientReady(); expect(opened).toEqual(['first', 'second']); expect(failures).toHaveBeenCalledTimes(1);
});

test('系统打开文件复用最接近的工作区和未保存文档，新目录只注册一次且不创建对话', async () => {
  const f = await fixture(); await f.store.close();
  const project = path.join(f.root, '项目 空格'); await mkdir(project);
  const nested = path.join(project, '子目录'); await mkdir(nested);
  const file = path.join(nested, '示例.ts'); await writeFile(file, 'const count = 1;');
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const client = { actorId: 'owner', clientId: 'desktop-file-test' }; const router = new ApplicationRouter(app);
  const events: Record<string, any>[] = []; app.subscribe(event => { if (event.type === 'workspace.file.open') events.push(event); });
  try {
    await router.call(client, 'workspaces.add', { directory: project, name: '外层目录' });
    await openDesktopPath(app, client, file);
    const parentWorkspace = events.at(-1)!.workspaceId;
    const doc = app.files.clientDocuments(client.clientId, parentWorkspace)[0];
    await router.call(client, 'documents.update', { workspaceId: doc.workspaceId, path: doc.path, version: doc.version, text: '尚未保存的编辑' });
    await openDesktopPath(app, client, file);
    expect(app.files.clientDocuments(client.clientId, parentWorkspace)[0].text).toBe('尚未保存的编辑');
    const child = await router.call(client, 'workspaces.add', { directory: nested, name: '子项目' }) as { id: string };
    await openDesktopPath(app, client, file); expect(events.at(-1)).toMatchObject({ workspaceId: child.id, path: '示例.ts', source: 'desktop', clientId: client.clientId });
    const other = path.join(f.root, '另一个目录'); await mkdir(other); await writeFile(path.join(other, 'hello.py'), 'print(1)');
    await openDesktopPath(app, client, path.join(other, 'hello.py')); await openDesktopPath(app, client, path.join(other, 'hello.py'));
    expect(app.settings.snapshot().settings.workspaces.filter(workspace => workspace.directory === other)).toHaveLength(1);
    expect(app.files.clientDocuments(client.clientId, events.at(-1)!.workspaceId)[0]).toMatchObject<Partial<DocumentState>>({ path: 'hello.py', text: 'print(1)' });
    expect((await app.storage.listConversations()).items).toHaveLength(0);
  } finally { await app.close(); await f.cleanup(); }
});
