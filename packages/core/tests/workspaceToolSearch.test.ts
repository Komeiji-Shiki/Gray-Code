import { workspaceTools } from '../../../apps/server/src/workspace/tools';
import { createLiteralSearchTool, literalMatchPreview } from '../../../apps/server/src/workspace/literalSearchTool';
import type { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../backend/modules/settings/types';
import { serializeToolResultForLLM } from '../../../backend/modules/channel/formatters/toolResponseFormatter';

function toolsFixture(contents: Record<string, string> = { 'a.txt': 'hit hit\r\nhit\r\n', 'nested/b.txt': 'hit\nother' }) {
  const host = {
    getAllWorkspaces: () => [{ name: 'project', uri: { fsPath: '/project', scheme: 'file' } }],
    searchConfig: () => DEFAULT_SEARCH_IN_FILES_CONFIG,
    toRelativePath: (file: { fsPath: string }) => file.fsPath,
    iterateFiles: async function* () { for (const file of Object.keys(contents)) yield { fsPath: file, scheme: 'file' }; },
    stat: jest.fn(async (_file: { fsPath: string }) => ({ size: 20, type: 1 })),
    readFile: jest.fn(async (file: { fsPath: string }) => Buffer.from(contents[file.fsPath])),
  };
  const search = createLiteralSearchTool(host as unknown as NodeFileHost);
  return { host, search };
}

describe('独立平台轻量搜索与工具选择说明', () => {
  test('按匹配行分页，去掉CR，跨目录续查且恰好一页不误报', async () => {
    const { search } = toolsFixture();
    const first = (await search.handler({ query: 'hit', limit: 2 })).data;
    expect(first).toMatchObject({ offset: 0, nextOffset: 2, truncated: true });
    const serialized = serializeToolResultForLLM('search_files', { success: true, data: first });
    expect(serialized).toContain('"nextOffset":2');
    for (const key of ['effectiveExclude', 'nextPage', 'nextActions', 'continuationHint']) expect(serialized).not.toContain(key);
    expect(first.nextActions).toHaveLength(1);
    expect(first.matches.map((item: any) => item.text)).toEqual(['hit hit', 'hit']);
    const second = (await search.handler({ query: 'hit', limit: 1, offset: first.nextOffset })).data;
    expect(second).toMatchObject({ offset: 2, truncated: false, matches: [{ path: 'nested/b.txt', line: 1, text: 'hit' }] });
    expect(second.nextOffset).toBeUndefined();
    const all = (await search.handler({ query: 'hit', limit: 100 })).data;
    expect([...first.matches, ...second.matches]).toEqual(all.matches);
  });

  test('严格字面量且没有关键词回退，超过末页为空', async () => {
    const { search } = toolsFixture();
    expect((await search.handler({ query: 'hit other' })).data.matches).toEqual([]);
    expect((await search.handler({ query: 'hit|other' })).data.matches).toEqual([]);
    expect((await search.handler({ query: 'hit', offset: 20 })).data).toMatchObject({ matches: [], truncated: false });
  });

  test.each([-1, 0.5, Infinity, '1'])('无效 offset %s 被拒绝', async offset => {
    await expect(toolsFixture().search.handler({ query: 'hit', offset })).rejects.toThrow('offset');
  });

  test('扫描上限明确标记未搜完，文件游标能继续读取未扫描文件', async () => {
    const { host, search } = toolsFixture(Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`${index}.txt`, ''])));
    host.readFile.mockImplementation(async file => Buffer.from(file.fsPath === '20000.txt' ? 'missing' : ''));
    const result = (await search.handler({ query: 'missing' })).data;
    expect(result).toMatchObject({ scanned: 20_000, truncated: true, truncationReasons: ['scanLimit'], scanComplete: false, nextScanOffset: 20_000 });
    expect(result.nextOffset).toBeUndefined();
    expect(result.continuationHint).toContain('not complete');
    const serialized = serializeToolResultForLLM('search_files', { success: true, data: result });
    expect(serialized).toContain('"nextScanOffset":20000');
    expect(serialized).toContain('"scanComplete":false');
    expect(serialized).not.toContain('nextPage');
    expect(host.readFile).toHaveBeenCalledTimes(20_000);
    const next = (await search.handler(result.nextActions[0].args)).data;
    expect(next).toMatchObject({ scanned: 1, scanComplete: true, truncated: false, matches: [{ path: '20000.txt', text: 'missing' }] });
    expect(next.nextScanOffset).toBeUndefined();
    expect(host.readFile).toHaveBeenCalledTimes(20_001);
  });

  test('文件读取中的取消不会被当作跳过的文件', async () => {
    const { host, search } = toolsFixture();
    const abort = new AbortController();
    host.readFile.mockImplementation(async () => { abort.abort(new Error('cancelled')); throw new Error('read cancelled'); });
    await expect(search.handler({ query: 'hit' }, { abortSignal: abort.signal })).rejects.toThrow('cancelled');
  });

  test('长行预览保留命中、原文列号和截断信息，大小写折叠不挪动列号', async () => {
    const value = 'İ' + 'a'.repeat(7293) + 'browser_read' + 'z'.repeat(2000);
    const result = (await toolsFixture({ 'long.js': value }).search.handler({ query: 'BROWSER_READ' })).data.matches[0];
    expect(result).toMatchObject({ column: 7295, matchLength: 12, contentTruncated: true });
    expect(result.text).toContain('browser_read');
    expect(result.text).toBe(value.slice(result.previewStartColumn - 1, result.previewStartColumn - 1 + result.text.length));
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.previewEndTruncated).toBe(true);
    expect(literalMatchPreview('hit', 0, 3)).toMatchObject({ text: 'hit', column: 1, previewStartColumn: 1, contentTruncated: false });
    expect(literalMatchPreview('hit', 0, 3).previewEndTruncated).toBeUndefined();
    const tail = literalMatchPreview('a'.repeat(1000) + 'hit', 1000, 3);
    expect(tail).toMatchObject({ contentTruncated: true });
    expect(tail.previewEndTruncated).toBeUndefined();
  });

  test('pattern 传给文件遍历，空 pattern 被拒绝', async () => {
    const { host, search } = toolsFixture();
    const iterate = jest.spyOn(host, 'iterateFiles');
    await search.handler({ query: 'hit', pattern: '**/*.txt' });
    expect(iterate.mock.calls[0][1]).toBe('**/*.txt');
    await search.handler({ query: 'hit' });
    expect(iterate.mock.calls[1][1]).toBe('**/*');
    await expect(search.handler({ query: 'hit', pattern: ' ' })).rejects.toThrow('pattern');
  });

  test('超长命中与代理对边界仍给出有效的预览坐标', () => {
    const value = 'x'.repeat(601) + '😀' + 'a'.repeat(1300) + '😀';
    for (const [index, length] of [[602, 1], [603, 1300], [1903, 2]]) {
      const preview = literalMatchPreview(value, index, length);
      expect(preview.text).toBe(value.slice(preview.previewStartColumn - 1, preview.previewStartColumn - 1 + preview.text.length));
      expect(preview.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  test('失败、二进制和大文件可见但不伪造匹配，读取前后都检查大小', async () => {
    const { host, search } = toolsFixture({ 'large.txt': '', 'bad.txt': '', 'binary.bin': '\0hit', 'grown.txt': 'x'.repeat(2 * 1024 * 1024 + 1) });
    host.stat.mockImplementation(async file => ({ size: file.fsPath === 'large.txt' ? 3 * 1024 * 1024 : 1, type: 1 }));
    host.readFile.mockImplementation(async file => { if (file.fsPath === 'bad.txt') throw new Error('EACCES'); return Buffer.from(file.fsPath === 'binary.bin' ? '\0hit' : 'x'.repeat(2 * 1024 * 1024 + 1)); });
    const result = (await search.handler({ query: 'hit' })).data;
    expect(result).toMatchObject({ matches: [], skippedCount: 4, skippedBinaryCount: 1, skippedFilesTruncated: false });
    expect(result.skippedFiles.map((file: any) => file.file)).not.toContain('binary.bin');
    expect(host.readFile).toHaveBeenCalledTimes(3);
    expect(result.skippedFiles[1].reason).toContain('EACCES');
  });

  test('声明说明互补能力和正确的进程会话来源', () => {
    const tools = workspaceTools({} as any, {} as any, {} as any);
    const description = (name: string) => tools.find(tool => tool.declaration.name === name)!.declaration.description;
    expect(description('workspace_files')).toContain('read_file');
    expect(description('workspace_files')).toContain('expectedHash');
    expect(description('workspace_files')).toContain('apply_diff');
    expect(toolsFixture().search.declaration.description).toContain('search_in_files');
    expect(description('run_command')).toContain('execute_command');
    expect(description('process_session')).toContain('taskId');
  });
});
