import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { workspaceTools } from '../../../apps/server/src/workspace/tools';
import { mutationTools } from '../../../apps/server/src/workspace/mutationTools';
import { createFindFilesRuntime } from '../../../backend/tools/search/findFilesRuntime';
import { createListFilesTool } from '../../../backend/tools/file/listFilesRuntime';
import { createReadFileTool } from '../../../backend/tools/file/readFileRuntime';
import { MAX_LINE_COUNT_FILE_BYTES } from '../../../backend/tools/shared/fileSizeGuards';

let directory: string;
let files: WorkspaceFiles;
let app: PlatformApplication;
let context: ToolContext;
let host: NodeFileHost;
let workspaceFileTool: RuntimeTool;
const propose = jest.fn();
const write = jest.fn();

beforeEach(async () => {
  await mkdir('.tmp', { recursive: true });
  directory = await mkdtemp(path.resolve('.tmp', 'text-lines-'));
  files = new WorkspaceFiles();
  propose.mockReset().mockResolvedValue({ status: 'accepted', id: 'proposal' });
  write.mockReset().mockResolvedValue({ hash: 'written' });
  app = { files, diffs: { propose }, changes: { write }, product: { runtimeSettings: () => ({
    getFindFilesConfig: () => ({ excludePatterns: [] }), getListFilesConfig: () => ({ ignorePatterns: [] }),
  }) } } as unknown as PlatformApplication;
  context = { actorId: 'owner', runId: 'text-lines', signal: new AbortController().signal,
    workspace: { id: 'workspace', name: 'Fixture', directory, deviceId: 'local' },
    progress: () => {}, askUser: async () => { throw new Error('unused'); } };
  host = new NodeFileHost(app, context);
  workspaceFileTool = workspaceTools(files, {} as any, app.changes).find(tool => tool.declaration.name === 'workspace_files')!;
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const cases: Array<[string, number, string]> = [
  ['', 1, ''], ['首😀', 1, '首😀'], ['首😀\n', 1, '首😀'], ['\n', 1, ''],
  ['\n\n', 2, ''], ['首\n\n', 2, ''], ['首\n尾', 2, '尾'],
  ['首\r\n尾\r\n', 2, '尾'], ['首\r尾\r', 2, '尾'], ['首\r尾', 2, '尾'],
  ['首\r\n中\r尾\n', 3, '尾'],
];

test.each(cases)('发现、两个读取工具和末行范围使用同一行号：%j', async (text, totalLines, lastLine) => {
  await writeFile(path.join(directory, 'sample.txt'), text);
  const find = await createFindFilesRuntime(host).createFindFilesTool().handler({ patterns: ['sample.txt'] });
  const list = await createListFilesTool(host).handler({ paths: ['.'] });
  const read = createReadFileTool(host);
  const whole = await read.handler({ path: 'sample.txt' });
  const workspaceRead = await workspaceFileTool.execute({ action: 'read', path: 'sample.txt' }, context);
  expect(find.data.results[0].fileDetails).toEqual([{ path: 'sample.txt', lineCount: totalLines }]);
  expect(list.data.results[0].entries).toEqual([{ name: 'sample.txt', type: 'file', lineCount: totalLines }]);
  expect(whole.data.results[0]).toMatchObject({ success: true, lineCount: totalLines });
  expect(workspaceRead).toMatchObject({ success: true, data: { startLine: 1, endLine: totalLines, totalLines,
    hash: createHash('sha256').update(text).digest('hex') } });

  const last = await read.handler({ path: 'sample.txt', startLine: totalLines, endLine: totalLines });
  expect(last.data.results[0]).toMatchObject({ success: true, lineCount: 1, totalLines, startLine: totalLines,
    endLine: totalLines, content: `${String(totalLines).padStart(4)} | ${lastLine}` });
  expect(await workspaceFileTool.execute({ action: 'read', path: 'sample.txt', startLine: totalLines, endLine: totalLines }, context))
    .toMatchObject({ success: true, data: { totalLines, startLine: totalLines, endLine: totalLines, content: lastLine } });

  const beyond = await read.handler({ path: 'sample.txt', startLine: totalLines + 1 });
  expect(beyond.data.results[0]).toMatchObject({ success: false, totalLines });
  expect(await workspaceFileTool.execute({ action: 'read', path: 'sample.txt', startLine: totalLines + 1 }, context))
    .toMatchObject({ success: false, data: { totalLines } });
});

test('末行收敛、反向 endLine 和 workspace_files 读取上限保持兼容', async () => {
  await writeFile(path.join(directory, 'sample.txt'), Array.from({ length: 1305 }, (_, i) => `line${i + 1}\n`).join(''));
  expect(await workspaceFileTool.execute({ action: 'read', path: 'sample.txt' }, context))
    .toMatchObject({ data: { startLine: 1, endLine: 300, totalLines: 1305 } });
  expect(await workspaceFileTool.execute({ action: 'read', path: 'sample.txt', endLine: 9999 }, context))
    .toMatchObject({ data: { startLine: 1, endLine: 1200, totalLines: 1305 } });
  for (const endLine of [1, 9999]) {
    const range = { path: 'sample.txt', startLine: 1305, endLine };
    expect((await createReadFileTool(host).handler(range)).data.results[0])
      .toMatchObject({ startLine: 1305, endLine: 1305, totalLines: 1305, content: '1305 | line1305' });
    expect(await workspaceFileTool.execute({ action: 'read', ...range }, context))
      .toMatchObject({ data: { startLine: 1305, endLine: 1305, totalLines: 1305, content: 'line1305' } });
  }
});

test.each(['\r\n', '\r'])('workspace_files 的 %j 读取内容仍可直接用于精确编辑', async eol => {
  const text = `首${eol}尾${eol}`;
  await writeFile(path.join(directory, 'sample.txt'), text);
  const result = await workspaceFileTool.execute({ action: 'read', path: 'sample.txt' }, context);
  const data = result.data as { content: string; hash: string };
  expect(data.content).toBe(`首${eol}尾`);
  expect(await workspaceFileTool.execute({ action: 'edit', path: 'sample.txt', oldText: data.content,
    newText: '替换', expectedHash: data.hash }, context)).toMatchObject({ success: true });
  expect(write).toHaveBeenCalledWith(context, [{ path: 'sample.txt', text: `替换${eol}`, expectedHash: data.hash }]);
});

test.each([
  'x'.repeat(64 * 1024 - 1) + '\r\n尾\r',
  'x'.repeat(64 * 1024 - 1) + '中😀\n尾',
])('Node 宿主跨 64 KiB 的 CRLF/多字节边界不会额外计行', async text => {
  await writeFile(path.join(directory, 'sample.txt'), text);
  expect(await host.countLines(host.file(path.join(directory, 'sample.txt')), 'sample.txt')).toBe(2);
  expect((await createReadFileTool(host).handler({ path: 'sample.txt', startLine: 2 })).data.results[0])
    .toMatchObject({ totalLines: 2, lineCount: 1, content: '   2 | 尾' });
});

test('发现保留文件大小和二进制护栏，不用全文读取补行数', async () => {
  await writeFile(path.join(directory, 'large.txt'), Buffer.alloc(MAX_LINE_COUNT_FILE_BYTES + 1, 97));
  await writeFile(path.join(directory, 'image.png'), Buffer.from([0, 10, 13]));
  const fullRead = jest.spyOn(host, 'readFile');
  const found = await createFindFilesRuntime(host).createFindFilesTool().handler({ patterns: ['*'] });
  expect(found.data.results[0].fileDetails).toEqual(expect.arrayContaining([
    { path: 'large.txt', lineCount: undefined }, { path: 'image.png', lineCount: undefined },
  ]));
  expect(fullRead).not.toHaveBeenCalled();
});

test.each([
  ['首\n尾\n', '首\n尾\n新增\n', '首\n'],
  ['首\r\n尾\r\n', '首\n尾\n新增\n', '首\n'],
  ['首\r尾\r', '首\n尾\n新增\n', '首\n'],
  ['首\n尾', '首\n尾\n新增', '首'],
])('平台按读取末行插入/删除，拒绝尾换行幻影范围：%j', async (text, appended, deleted) => {
  await writeFile(path.join(directory, 'sample.txt'), text);
  const mutations = mutationTools(app, 'unified');
  const insert = mutations.find(tool => tool.declaration.name === 'insert_code')!;
  const remove = mutations.find(tool => tool.declaration.name === 'delete_code')!;
  expect(await insert.execute({ files: [{ path: 'sample.txt', line: 3, content: '新增\r\n' }] }, context))
    .toMatchObject({ success: true, data: { results: [{ insertedLines: 1 }] } });
  expect(propose.mock.calls[0][3]).toBe(appended);
  expect(await remove.execute({ files: [{ path: 'sample.txt', start_line: 2, end_line: 2 }] }, context))
    .toMatchObject({ success: true, data: { results: [{ deletedLines: 1 }] } });
  expect(propose.mock.calls[1][3]).toBe(deleted);
  propose.mockClear();
  expect(await insert.execute({ files: [{ path: 'sample.txt', line: 4, content: '新增' }] }, context)).toMatchObject({ success: false });
  expect(await remove.execute({ files: [{ path: 'sample.txt', start_line: 3, end_line: 3 }] }, context)).toMatchObject({ success: false });
  expect(propose).not.toHaveBeenCalled();
});

test('空文本保留可读取/删除的第 1 行，插入仍可从第 1 行进行', async () => {
  await writeFile(path.join(directory, 'sample.txt'), '');
  const mutations = mutationTools(app, 'unified');
  expect(await mutations.find(tool => tool.declaration.name === 'delete_code')!.execute({ files: [{ path: 'sample.txt', start_line: 1, end_line: 1 }] }, context))
    .toMatchObject({ success: true });
  expect(propose).not.toHaveBeenCalled();
  expect(await mutations.find(tool => tool.declaration.name === 'insert_code')!.execute({ files: [{ path: 'sample.txt', line: 1, content: '新增' }] }, context))
    .toMatchObject({ success: true });
  expect(propose.mock.calls[0][3]).toBe('新增\n');
});
