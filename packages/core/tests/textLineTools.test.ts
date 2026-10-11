import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { mutationTools } from '../../../apps/server/src/workspace/mutationTools';
import { readTools } from '../../../apps/server/src/workspace/readTools';
import { createFindFilesRuntime } from '../../../backend/tools/search/findFilesRuntime';
import { createListFilesTool } from '../../../backend/tools/file/listFilesRuntime';
import { createReadFileTool } from '../../../backend/tools/file/readFileRuntime';
import { MAX_LINE_COUNT_FILE_BYTES } from '../../../backend/tools/shared/fileSizeGuards';
import { TEMP_DIR_REMOVE_OPTIONS } from './fixtures';
import { RuntimeToolRegistry } from '../src/runtime/tools';
import { PlatformSkills } from '../../../apps/server/src/skills/service';

let directory: string;
let files: WorkspaceFiles;
let app: PlatformApplication;
let context: ToolContext;
let host: NodeFileHost;
const propose = jest.fn();

test('批量文件工具逐项校验并保持原始位置，默认目录入口可以执行', async () => {
  await writeFile(path.join(directory, 'sample.txt'), 'one\ntwo\nthree\n');
  const tools = [...readTools(app), ...mutationTools(app, 'unified')];
  const registry = new RuntimeToolRegistry();
  for (const tool of tools) registry.register(tool);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const entry = registry.catalog([name]).entries.get(name)!;
    const normalized = entry.normalizeArguments(args);
    const prepared = entry.tool.normalizeArgs?.(normalized).args ?? normalized;
    expect(entry.validate(prepared)).toBe(true);
    return entry.tool.execute(prepared, context) as Promise<any>;
  };
  const read = await invoke('read_file', { files: [
    { path: 'sample.txt', startLine: 0 }, null, { path: 'sample.txt', startLine: 2, endLine: 2 },
  ] });
  expect(read.data).toMatchObject({ partial: true, successCount: 1, failCount: 2, totalCount: 3 });
  expect(read.data.results.map((item: any) => [item.index, item.success])).toEqual([[0, false], [1, false], [2, true]]);
  expect(read.data.results[2].content).toBe('   2 | two');
  for (const [name, valid, invalid] of [
    ['insert_code', { path: 'sample.txt', line: 2, content: 'inserted' }, { path: 'sample.txt', line: 0, content: 'bad' }],
    ['delete_code', { path: 'sample.txt', start_line: 2, end_line: 2 }, { path: 'sample.txt', start_line: 0, end_line: 1 }],
  ] as const) {
    const result = await invoke(name, { files: [invalid, valid] });
    expect(result.data).toMatchObject({ partial: true, successCount: 1, failCount: 1 });
    expect(result.data.results[1]).toMatchObject({ index: 1, success: true, status: 'accepted' });
  }
  const diff = await invoke('apply_diff', { path: 'sample.txt', hunks: [
    { oldContent: 123, newContent: 'invalid' }, { oldContent: 'two', newContent: 'updated' },
  ] });
  expect(diff.data).toMatchObject({ appliedCount: 1, failedCount: 1, diffCount: 2, partial: true });
  expect(diff.data.results.map((item: any) => [item.index, item.success])).toEqual([[0, false], [1, true]]);
  // 有效修改仍经过原审阅入口，失败项不会创建修改提案。
  expect(propose).toHaveBeenCalledTimes(3);
  const listed = await invoke('list_files', {});
  expect(listed.success).toBe(true);
  expect(listed.data.results).toHaveLength(1);
  const partialList = await invoke('list_files', { paths: [false, '.'] });
  expect(partialList.data.results.map((item: any) => [item.index, item.success])).toEqual([[0, false], [1, true]]);
});

test('技能默认入口和查找失败都返回当前可用目录', async () => {
  const skills = new PlatformSkills(app);
  jest.spyOn(skills, 'items').mockResolvedValue([{ id: 'sample', name: 'sample', description: '示例技能', enabled: true } as any]);
  const tool = skills.tool();
  const registry = new RuntimeToolRegistry();
  registry.register(tool);
  expect(registry.catalog(['read_skill']).entries.get('read_skill')!.validate({})).toBe(true);
  expect(await tool.execute({}, context)).toMatchObject({ success: true, data: { skills: [{ name: 'sample' }] } });
  expect(await tool.execute({ name: 'missing' }, context)).toMatchObject({ success: false, data: { skills: [{ name: 'sample' }] } });
});

beforeEach(async () => {
  await mkdir('.tmp', { recursive: true });
  directory = await mkdtemp(path.resolve('.tmp', 'text-lines-'));
  files = new WorkspaceFiles();
  propose.mockReset().mockResolvedValue({ status: 'accepted', id: 'proposal' });
  app = { files, diffs: { propose }, actor: () => ({ id: 'owner', role: 'owner' }), product: { runtimeSettings: () => ({
    getFindFilesConfig: () => ({ excludePatterns: [] }), getListFilesConfig: () => ({ ignorePatterns: [] }),
    getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }),
  }) } } as unknown as PlatformApplication;
  context = { actorId: 'owner', runId: 'text-lines', signal: new AbortController().signal,
    workspace: { id: 'workspace', name: 'Fixture', directory, deviceId: 'local' },
    progress: () => {}, askUser: async () => { throw new Error('unused'); } };
  host = new NodeFileHost(app, context);
});
afterEach(async () => { await rm(directory, TEMP_DIR_REMOVE_OPTIONS); });

const cases: Array<[string, number, string]> = [
  ['', 1, ''], ['首😀', 1, '首😀'], ['首😀\n', 1, '首😀'], ['\n', 1, ''],
  ['\n\n', 2, ''], ['首\n\n', 2, ''], ['首\n尾', 2, '尾'],
  ['首\r\n尾\r\n', 2, '尾'], ['首\r尾\r', 2, '尾'], ['首\r尾', 2, '尾'],
  ['首\r\n中\r尾\n', 3, '尾'],
];

test.each(cases)('发现、文件读取和末行范围使用同一行号：%j', async (text, totalLines, lastLine) => {
  await writeFile(path.join(directory, 'sample.txt'), text);
  const find = await createFindFilesRuntime(host).createFindFilesTool().handler({ patterns: ['sample.txt'] });
  const list = await createListFilesTool(host).handler({ paths: ['.'] });
  const read = createReadFileTool(host);
  const runtimeRead = readTools(app).find(tool => tool.declaration.name === 'read_file')!;
  const prepared = runtimeRead.normalizeArgs!({ file_path: 'sample.txt' });
  expect(prepared.warnings.join(' ')).toContain('`file_path`');
  const whole = await read.handler(prepared.args);
  expect(find.data.results[0].fileDetails).toEqual([{ path: 'sample.txt', lineCount: totalLines }]);
  expect(list.data.results[0].entries).toEqual([{ name: 'sample.txt', type: 'file', lineCount: totalLines }]);
  expect(whole.data.results[0]).toMatchObject({ success: true, lineCount: totalLines });

  const last = await read.handler({ path: 'sample.txt', startLine: totalLines, endLine: totalLines });
  expect(last.data.results[0]).toMatchObject({ success: true, lineCount: 1, totalLines, startLine: totalLines,
    endLine: totalLines, content: `${String(totalLines).padStart(4)} | ${lastLine}` });

  const beyond = await read.handler({ path: 'sample.txt', startLine: totalLines + 1 });
  expect(beyond.data.results[0]).toMatchObject({ success: false, totalLines });
});

test('末行收敛、反向 endLine 和 read_file 的完整读取保持兼容', async () => {
  await writeFile(path.join(directory, 'sample.txt'), Array.from({ length: 1305 }, (_, i) => `line${i + 1}\n`).join(''));
  expect((await createReadFileTool(host).handler({ path: 'sample.txt' })).data.results[0])
    .toMatchObject({ lineCount: 1305 });
  for (const endLine of [1, 9999]) {
    const range = { path: 'sample.txt', startLine: 1305, endLine };
    expect((await createReadFileTool(host).handler(range)).data.results[0])
      .toMatchObject({ startLine: 1305, endLine: 1305, totalLines: 1305, content: '1305 | line1305' });
  }
});

test.each(['\r\n', '\r'])('read_file 的 %j 内容去掉行号后可用于 apply_diff 精确编辑', async eol => {
  const text = `首${eol}尾${eol}`;
  await writeFile(path.join(directory, 'sample.txt'), text);
  const data = (await createReadFileTool(host).handler({ path: 'sample.txt' })).data.results[0];
  const original = data.content.split('\n').map((line: string) => line.replace(/^\s*\d+ \| /, '')).join('\n');
  const edit = mutationTools(app, 'unified').find(tool => tool.declaration.name === 'apply_diff')!;
  expect(await edit.execute({ path: 'sample.txt', hunks: [{ oldContent: original, newContent: '替换' }] }, context))
    .toMatchObject({ success: true });
  expect(propose.mock.calls[0][3]).toBe('替换\n');
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
