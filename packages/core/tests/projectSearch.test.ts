import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { searchProjectText, replaceProjectText } from '../../../shared/projectSearch';
import { EditorBatchHistory } from '../../../shared/editorBatchHistory';
import { fixture } from './fixtures';

test('项目搜索准确定位中文与多行匹配，文字替换保留美元符号，正则替换使用捕获组', () => {
  const text = 'const 灰魂 = 1;\r\nconst 灰魂助理 = 2;\r\n灰魂';
  const found = searchProjectText(text, { query: '灰魂', wholeWord: true }, 10);
  expect(found.matches.map(item => item.range.start)).toEqual([{ line: 0, character: 6 }, { line: 2, character: 0 }]);
  expect(searchProjectText(text, { query: '1;\\r\\nconst', regex: true }, 10).matches[0].range.end).toEqual({ line: 1, character: 5 });
  expect(replaceProjectText('value(12)', { query: 'value\\((\\d+)\\)', regex: true }, 'result[$1]')).toBe('result[12]');
  expect(replaceProjectText('value', { query: 'value' }, '$& $1')).toBe('$& $1');
  expect(searchProjectText('aaa', { query: '(?=a)', regex: true }, 2)).toMatchObject({ truncated: true, matches: [{}, {}] });
  expect(() => searchProjectText('text', { query: '[', regex: true }, 1)).toThrow('正则表达式');
});

test('真实搜索接口包含本窗口草稿，替换预览核对版本和工作区，且不修改磁盘', async () => {
  const f = await fixture(); await f.store.close();
  await mkdir(path.join(f.source, 'node_modules'));
  await writeFile(path.join(f.source, 'main.ts'), '\uFEFFconst original = 1;\r\n');
  await writeFile(path.join(f.source, 'other.ts'), 'const draftValue = 2;\n');
  await writeFile(path.join(f.source, 'node_modules', 'hidden.ts'), 'draftValue');
  await writeFile(path.join(f.source, 'image.bin'), Buffer.from([0, 1, 2]));
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), session = { actorId: 'owner', clientId: 'search-desktop' };
  const rpc = (method: string, params: Record<string, unknown> = {}, client = session) => router.call(client, method, { workspaceId: 'project', ...params }) as Promise<any>;
  try {
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push({ id: 'project', name: '搜索工程', directory: f.source, deviceId: 'local' });
    settings.settings.accounts.push({ id: 'reader', displayName: '成员', role: 'member', effects: ['workspace_read'], workspaceIds: ['project'] });
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    let document = await rpc('documents.open', { path: 'main.ts' });
    document = await rpc('documents.update', { path: 'main.ts', version: document.version, text: '\uFEFFconst draftValue = 1;\r\n' });
    const options = { query: 'draftValue' };
    const result = await rpc('files.search', { requestId: 'search', options });
    expect(result.files.map((file: any) => file.path).sort()).toEqual(['main.ts', 'other.ts']);
    expect(result.files.find((file: any) => file.path === 'main.ts')).toMatchObject({ draft: true, matches: [{ range: { start: { line: 0, character: 6 } } }] });
    expect(result.skipped.some((file: any) => file.path === 'image.bin')).toBe(true);
    const preview = await rpc('files.replacePreview', { options, replacement: 'nextValue', files: result.files });
    expect(preview.find((file: any) => file.path === 'main.ts')).toEqual({ path: 'main.ts', before: 'const draftValue = 1;\r\n', after: 'const nextValue = 1;\r\n' });
    expect(await readFile(path.join(f.source, 'main.ts'), 'utf8')).toBe('\uFEFFconst original = 1;\r\n');
    const otherClient = await rpc('files.search', { requestId: 'search', options }, { ...session, clientId: 'phone' });
    expect(otherClient.files.map((file: any) => file.path)).toEqual(['other.ts']);
    await rpc('documents.update', { path: 'main.ts', version: document.version, text: 'const newerInput = 3;' });
    await expect(rpc('files.replacePreview', { options, replacement: '', files: result.files })).rejects.toThrow('已变化');
    await expect(rpc('files.replacePreview', { options, replacement: '', files: [{ path: '../outside.ts', hash: '' }] })).rejects.toThrow('outside the authorized workspace');
    await expect(rpc('files.search', { requestId: 'search', options }, { actorId: 'reader', clientId: 'reader' })).rejects.toThrow('Owner');
  } finally { await app.close(); await f.cleanup(); }
});

test('整批撤销保护其他文件的新输入，处理完成后可以一起撤销与重做', async () => {
  const history = new EditorBatchHistory();
  const values = [2, 2];
  const targets = values.map((_, index) => ({ version: () => values[index], disposed: () => false,
    undo: () => { values[index]--; }, redo: () => { values[index]++; } }));
  const batch = history.record(targets.map(target => ({ target, before: 1, after: 2 })));
  values[1] = 3;
  await expect(history.move(targets[0], true)).rejects.toThrow('较新的编辑');
  expect(values).toEqual([2, 3]);
  await history.move(targets[1], true);
  await history.move(targets[0], true);
  expect(values).toEqual([1, 1]);
  await batch.redo(); expect(values).toEqual([2, 2]);
  await batch.undo(); expect(values).toEqual([1, 1]);
  history.invalidateRedo(targets[0]);
  await expect(batch.redo()).rejects.toThrow('已不能重做');
  await expect(history.move(targets[1], false)).rejects.toThrow('已不能重做');
  expect(values).toEqual([1, 1]);
  await history.move(targets[0], false); expect(values).toEqual([2, 1]);
});
