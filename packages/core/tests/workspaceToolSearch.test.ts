import { createSearchDeclaration } from '../../../backend/tools/search/declarationRuntime';
import type { SearchFileHost } from '../../../backend/tools/search/fileHost';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../backend/modules/settings/types';
import { serializeToolResultForLLM } from '../../../backend/modules/channel/formatters/toolResponseFormatter';
import { presentToolMatch } from '../../../shared/textSearch';
import * as iconv from 'iconv-lite';

function toolsFixture(contents: Record<string, string | Buffer> = { 'a.txt': 'hit hit\r\nhit\r\n', 'nested/b.txt': 'hit\nother' }) {
  const root = { name: 'project', uri: { fsPath: '/project', scheme: 'file' } };
  const host = {
    getAllWorkspaces: () => [root],
    getWorkspaceRoot: () => root.uri,
    parseWorkspacePath: (file: string) => ({ workspace: root, relativePath: file, isExplicit: false }),
    resolveFileToolPathWithInfo: () => ({ isOutsideWorkspace: false }),
    checkAccess: () => null,
    searchConfig: () => DEFAULT_SEARCH_IN_FILES_CONFIG,
    toRelativePath: (file: { fsPath: string }) => file.fsPath,
    iterateFiles: async function* (_root?: unknown, _pattern?: string) { for (const file of Object.keys(contents)) yield { fsPath: file, scheme: 'file' }; },
    stat: jest.fn(async (file: { fsPath: string }) => ({ size: Buffer.byteLength(contents[file.fsPath] ?? ''), type: 1 })),
    readFile: jest.fn(async (file: { fsPath: string }) => Buffer.from(contents[file.fsPath])),
  };
  const search = createSearchDeclaration(host as unknown as SearchFileHost).createSearchInFilesTool();
  return { host, search };
}

describe('合并后的内容搜索', () => {
  test('按匹配行分页，去掉 CR，跨目录续查且恰好一页不误报', async () => {
    const { search } = toolsFixture();
    const first = (await search.handler({ query: 'hit', maxResults: 2 })).data;
    expect(first).toMatchObject({ offset: 0, nextOffset: 2, truncated: true });
    const serialized = serializeToolResultForLLM('search_in_files', { success: true, data: first });
    expect(serialized).toContain('"nextOffset":2');
    expect(serialized).not.toContain('effectiveExclude');
    expect(first.results.map((item: any) => item.line)).toEqual([1, 2]);
    expect(first.results[0].columns).toEqual([1, 5]);
    expect(first.results.every((item: any) => !item.context.includes('\r'))).toBe(true);
    const second = (await search.handler({ query: 'hit', maxResults: 1, offset: first.nextOffset })).data;
    expect(second).toMatchObject({ offset: 2, truncated: false, results: [{ file: 'nested/b.txt', line: 1, match: 'hit' }] });
    expect(second.nextOffset).toBeUndefined();
    const all = (await search.handler({ query: 'hit', maxResults: 100 })).data;
    expect([...first.results, ...second.results]).toEqual(all.results);
  });

  test('默认严格字面量且没有关键词回退，超过末页为空', async () => {
    const { search } = toolsFixture();
    expect((await search.handler({ query: 'hit other' })).data.results).toEqual([]);
    expect((await search.handler({ query: 'hit|other', isRegex: false })).data.results).toEqual([]);
    expect((await search.handler({ query: 'hit', offset: 20 })).data).toMatchObject({ results: [], truncated: false });
  });

  test.each([-1, 0.5, Infinity, '1'])('无效 offset %s 被拒绝', async offset => {
    expect(await toolsFixture().search.handler({ query: 'hit', offset }))
      .toMatchObject({ success: false, error: expect.stringContaining('offset') });
  });

  test('搜索可到达旧轻量扫描上限之后的文件', async () => {
    const { host, search } = toolsFixture(Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`${index}.txt`, ''])));
    host.readFile.mockImplementation(async file => Buffer.from(file.fsPath === '20000.txt' ? 'missing' : ''));
    const result = (await search.handler({ query: 'missing' })).data;
    expect(result).toMatchObject({ truncated: false, results: [{ file: '20000.txt', match: 'missing' }] });
    expect(result.nextOffset).toBeUndefined();
  });

  test('文件读取中的取消不会被当作正常的空搜索结果', async () => {
    const { host, search } = toolsFixture();
    const abort = new AbortController();
    host.readFile.mockImplementation(async () => { abort.abort(new Error('cancelled')); throw new Error('read cancelled'); });
    expect(await search.handler({ query: 'hit' }, { abortSignal: abort.signal }))
      .toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
  });

  test('长行预览保留命中、原文列号和截断信息，大小写折叠不挪动列号', async () => {
    const value = 'İ' + 'a'.repeat(7293) + 'browser_read' + 'z'.repeat(2000);
    const result = (await toolsFixture({ 'long.js': value }).search.handler({ query: 'BROWSER_READ' })).data.results[0];
    expect(result).toMatchObject({ column: 7295, match: 'browser_read' });
    expect(result.context).toContain('browser_read');
    expect(result.context).toMatch(/^1: ….*…$/);
    expect(result.context.length).toBeLessThanOrEqual(DEFAULT_SEARCH_IN_FILES_CONFIG.maxMatchPreviewChars! + 5);
  });

  test('pattern 传给文件遍历，省略时搜索所有文件', async () => {
    const { host, search } = toolsFixture();
    const iterate = jest.spyOn(host, 'iterateFiles');
    await search.handler({ query: 'hit', pattern: '**/*.txt' });
    expect(iterate.mock.calls[0][1]).toBe('**/*.txt');
    await search.handler({ query: 'hit' });
    expect(iterate.mock.calls[1][1]).toBe('**/*');
  });

  test('超长命中与代理对边界仍给出完整的预览字符', () => {
    const value = 'x'.repeat(601) + '😀' + 'a'.repeat(1300) + '😀';
    for (const [index, length] of [[602, 1], [603, 1300], [1903, 2]]) {
      const result = presentToolMatch({ kind: 'fileSearch', fragments: [value], source: '', flags: 'gm', limit: 1,
        previewChars: 300, linePreviewChars: 300, contextBefore: 0, contextAfter: 0, path: 'unicode.txt' },
        0, index, length, value.slice(index, index + length));
      const preview = result.context.replace(/^1: …?/, '').replace(/…$/, '');
      expect(preview).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  test('失败与大小护栏给出跳过原因，二进制不伪造匹配', async () => {
    const { host, search } = toolsFixture({ 'large.txt': '', 'bad.txt': '', 'binary.bin': '\0hit' });
    host.stat.mockImplementation(async file => ({ size: file.fsPath === 'large.txt' ? 6 * 1024 * 1024 : 1, type: 1 }));
    host.readFile.mockImplementation(async file => {
      if (file.fsPath === 'bad.txt') throw new Error('EACCES');
      return Buffer.from('\0hit');
    });
    const result = (await search.handler({ query: 'hit' })).data;
    expect(result.results).toEqual([]);
    expect(result.skippedFiles.map((file: any) => file.file)).toEqual(['large.txt', 'bad.txt']);
    expect(result.skippedFiles[1].reason).toContain('EACCES');
  });

  test('GBK、Shift-JIS、UTF-16 文件自动识别后搜索并标注编码，也可显式指定', async () => {
    const { search } = toolsFixture({
      'start.cmd': iconv.encode('@echo off\r\nrem 启动游戏并等待退出\r\n', 'gbk'),
      'ja.txt': iconv.encode('ゲームを起動します\n', 'shift_jis'),
      'wide.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('启动 UTF-16\n', 'utf16le')]),
      'plain.txt': '启动 UTF-8\n',
    });
    const zh = (await search.handler({ query: '启动' })).data;
    expect(zh.results.map((item: any) => item.file).sort()).toEqual(['plain.txt', 'start.cmd', 'wide.txt']);
    expect(zh.encodings).toEqual({ 'start.cmd': 'gbk', 'wide.txt': 'utf-16le' });
    const ja = (await search.handler({ query: '起動' })).data;
    expect(ja).toMatchObject({ results: [{ file: 'ja.txt', match: '起動' }], encodings: { 'ja.txt': 'shift_jis' } });
    expect((await search.handler({ query: '启动游戏', encoding: 'GB2312' })).data.results)
      .toEqual([expect.objectContaining({ file: 'start.cmd', line: 2 })]);
    expect(await search.handler({ query: 'x', encoding: 'klingon' }))
      .toMatchObject({ success: false, error: expect.stringContaining('不支持的编码') });
  });

  test('搜索声明保留默认字面量匹配和可选编码', () => {
    expect(toolsFixture().search.declaration.parameters.properties.isRegex.default).toBe(false);
    expect(toolsFixture().search.declaration.parameters.properties.encoding.type).toBe('string');
  });
});
