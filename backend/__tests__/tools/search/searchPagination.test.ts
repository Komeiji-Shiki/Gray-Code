import { createSearchDeclaration } from '../../../tools/search/declarationRuntime';
import type { SearchFileHost, FileLocation } from '../../../tools/search/fileHost';
import { DEFAULT_SEARCH_IN_FILES_CONFIG, type SearchInFilesToolConfig } from '../../../modules/settings/types';
import { serializeToolResultForLLM } from '../../../modules/channel/formatters/toolResponseFormatter';

function fixture(contents: Record<string, string>, options: Partial<SearchInFilesToolConfig> = {}) {
    const location = (fsPath: string): FileLocation => ({ fsPath, scheme: 'file' });
    const names = [...new Set(Object.keys(contents).map(file => file.split('/')[1]))];
    const roots = names.map(name => ({ name, uri: location(`/${name}`) }));
    const host: SearchFileHost = {
        getAllWorkspaces: () => roots,
        getWorkspaceRoot: () => roots[0].uri,
        parseWorkspacePath: () => ({ relativePath: '.', isExplicit: false }),
        resolveFileToolPathWithInfo: () => ({ isOutsideWorkspace: false }),
        toRelativePath: (file, prefix) => prefix ? `@${file.fsPath.slice(1)}` : file.fsPath.split('/').slice(2).join('/'),
        joinPath: (root, file) => location(`${root.fsPath}/${file}`),
        file: location,
        stat: async file => ({ size: Buffer.byteLength(contents[file.fsPath] ?? ''), type: Object.prototype.hasOwnProperty.call(contents, file.fsPath) ? 1 : 2 }),
        readFile: async file => Buffer.from(contents[file.fsPath]),
        readHeader: async (file, bytes) => Buffer.from(contents[file.fsPath]).subarray(0, bytes),
        findFiles: async (root, _pattern, _exclude, limit) => Object.keys(contents).filter(file => file.startsWith(`${root.fsPath}/`)).slice(0, limit).map(location),
        countLines: async () => undefined,
        findExcludePatterns: () => [],
        searchConfig: () => ({ ...DEFAULT_SEARCH_IN_FILES_CONFIG, ...options }),
        checkAccess: () => null,
        review: jest.fn()
    };
    return createSearchDeclaration(host).createSearchInFilesTool();
}

describe('search_in_files 续查', () => {
    test('分页按命中行计数，与一次读取顺序相同，最后一页不误报', async () => {
        const tool = fixture({ '/one/a.ts': 'hit hit\nhit', '/one/b.ts': 'hit' });
        const first = await tool.handler({ query: 'hit', maxResults: 2 });
        expect(first.data).toMatchObject({ count: 2, nextOffset: 2, truncated: true, truncationReasons: ['maxResults'] });
        expect(first.data.results[0]).toMatchObject({ file: 'a.ts', line: 1, column: 1, columns: [1, 5] });
        const second = await tool.handler({ query: 'hit', maxResults: 2, offset: first.data.nextOffset });
        expect(second.data).toMatchObject({ count: 1, offset: 2, truncated: false });
        expect(second.data.nextOffset).toBeUndefined();
        const all = await tool.handler({ query: 'hit', maxResults: 10 });
        expect([...first.data.results, ...second.data.results]).toEqual(all.data.results);
        const beyond = await tool.handler({ query: 'hit', offset: 99 });
        expect(beyond.data).toMatchObject({ count: 0, truncated: false });
    });

    test('offset 跨工作区共享，不在每个工作区重新跳过', async () => {
        const tool = fixture({ '/one/a.ts': 'hit', '/two/b.ts': 'hit\nhit' });
        const first = await tool.handler({ query: 'hit', maxResults: 1 });
        const second = await tool.handler({ query: 'hit', maxResults: 2, offset: first.data.nextOffset });
        expect(second.data.results.map((item: any) => [item.workspace, item.line])).toEqual([['two', 1], ['two', 2]]);
        expect(second.data.truncated).toBe(false);
    });

    test('零宽正则跳过时继续推进，同一行不重复', async () => {
        const tool = fixture({ '/one/a.ts': 'a\nb' });
        const result = await tool.handler({ query: '^', isRegex: true, maxResults: 1, offset: 1 });
        expect(result.data.results.map((item: any) => [item.line, item.column])).toEqual([[2, 1]]);
        expect(result.data.truncated).toBe(false);
    });

    test('精确短语已耗尽不转为关键词搜索；原本的关键词回退可分页', async () => {
        const exact = fixture({ '/one/a.ts': 'alpha beta\nalpha\nbeta' });
        const exhausted = await exact.handler({ query: 'alpha beta', offset: 1 });
        expect(exhausted.data.count).toBe(0);
        expect(exhausted.data.queryFallback).toBeUndefined();
        const fallback = fixture({ '/one/a.ts': 'alpha\nbeta\nalpha' });
        const result = await fallback.handler({ query: 'alpha beta', keywordFallback: true, offset: 1, maxResults: 1 });
        expect(result.data.queryFallback).toMatchObject({ applied: true, reason: 'whitespace_keyword_or' });
        expect(result.data.results[0].line).toBe(2);
        expect(result.data.nextOffset).toBe(2);
    });

    test('默认及显式 false 都严格匹配，只有显式 true 才扩大搜索', async () => {
        const tool = fixture({ '/one/a.ts': 'get_symbols\nother' });
        const query = 'get_symbols __graycode_tool_ux_nonexistent__';
        for (const args of [{}, { keywordFallback: false }]) {
            const result = await tool.handler({ query, isRegex: false, ...args });
            expect(result.data).toMatchObject({ count: 0, truncated: false });
            expect(result.data.queryFallback).toBeUndefined();
            expect(result.data.searchHint).toContain('keywordFallback=true');
            expect(result.data.nextOffset).toBeUndefined();
        }
        const broad = await tool.handler({ query, keywordFallback: true });
        expect(broad.data.count).toBe(1);
        expect(broad.data.queryFallback).toMatchObject({ applied: true, reason: 'whitespace_keyword_or' });
        expect(broad.data.searchHint).toBeUndefined();
        expect(tool.declaration.parameters.properties?.keywordFallback.default).toBe(false);
    });

    test('严格字面量分页不放宽成 OR，保留大小写与正则独立语义', async () => {
        const tool = fixture({ '/one/a.ts': 'Alpha Beta\nalpha\nbeta\nalpha beta\nALPHA BETA' });
        const first = await tool.handler({ query: 'alpha beta', keywordFallback: false, maxResults: 2 });
        expect(first.data.results.map((item: any) => item.line)).toEqual([1, 4]);
        expect(first.data.nextOffset).toBe(2);
        const second = await tool.handler({ query: 'alpha beta', keywordFallback: false, maxResults: 2, offset: 2 });
        expect(second.data.results.map((item: any) => item.line)).toEqual([5]);
        expect(second.data.queryFallback).toBeUndefined();
        const sensitive = await tool.handler({ query: 'alpha beta', keywordFallback: false, caseSensitive: true });
        expect(sensitive.data.results.map((item: any) => item.line)).toEqual([4]);
        const regex = await tool.handler({ query: 'alpha|beta', keywordFallback: false, isRegex: true });
        const regexDefault = await tool.handler({ query: 'alpha|beta', isRegex: true });
        expect(regex.data.results).toEqual(regexDefault.data.results);
    });

    test('严格字面量仍可提示疑似正则但不自动执行，也不会扩大替换范围', async () => {
        const tool = fixture({ '/one/a.ts': 'alpha\nbeta' });
        const suspected = await tool.handler({ query: 'alpha|beta', keywordFallback: false });
        expect(suspected.data.count).toBe(0);
        expect(suspected.data.queryFallback).toMatchObject({ applied: false, reason: 'suspected_regex' });
        for (const keywordFallback of [true, false]) {
            const replacement = await tool.handler({ query: 'alpha beta', mode: 'replace', replace: '', keywordFallback });
            expect(replacement.data).toMatchObject({ isReplaceMode: true, totalReplacements: 0 });
        }
    });

    test.each(['false', 0])('无效 keywordFallback %s 不被静默误解', async keywordFallback => {
        const tool = fixture({ '/one/a.ts': 'alpha' });
        expect((await tool.handler({ query: 'alpha beta', keywordFallback })).error).toContain('keywordFallback must be a boolean');
    });

    test('跳过页不消耗本页输出预算', async () => {
        const tool = fixture({ '/one/a.ts': 'hit\nhit\nhit' }, { maxTotalResultChars: 230, contextLinesBefore: 0, contextLinesAfter: 0 });
        const first = await tool.handler({ query: 'hit', maxResults: 1 });
        const second = await tool.handler({ query: 'hit', maxResults: 1, offset: first.data.nextOffset });
        expect(second.data.results[0].line).toBe(2);
        expect(second.data.nextOffset).toBe(2);
        expect(second.data.truncationReasons).toEqual(['maxResults']);
    });

    test('预算跳过中间匹配后只提供收窄建议，不给出会漏结果的 offset', async () => {
        const tool = fixture({ '/one/long.ts': `${'long '.repeat(80)}needle`, '/one/b.ts': 'needle' },
            { maxTotalResultChars: 120, contextLinesBefore: 0, contextLinesAfter: 0 });
        const result = await tool.handler({ query: 'needle', maxResults: 1 });
        expect(result.data.truncationReasons).toContain('outputBudget');
        expect(result.data.nextOffset).toBeUndefined();
        expect(result.data.continuationHint).toContain('narrow');
        expect(result.data.results[0].file).toBe('b.ts');
    });

    test('搜索超过旧文件发现上限，分页仍能完整读到后续文件', async () => {
        const tool = fixture({ '/one/a.ts': 'hit', '/one/b.ts': 'hit' }, { maxFindFiles: 1 });
        const first = await tool.handler({ query: 'hit', maxResults: 1 });
        expect(first.data.truncationReasons).toEqual(['maxResults']);
        expect(first.data.nextOffset).toBe(1);
        const second = await tool.handler({ query: 'hit', maxResults: 1, offset: first.data.nextOffset });
        expect(second.data.results[0].file).toBe('b.ts');
        expect(second.data.truncated).toBe(false);
    });

    test('唯一匹配在第1000个文件之后也能找到，真正零匹配不再误报扫描截断', async () => {
        const contents = Object.fromEntries(Array.from({ length: 1005 }, (_, index) => [`/one/${index}.ts`, 'other']));
        contents['/one/target.ts'] = 'late needle';
        const tool = fixture(contents);
        const found = await tool.handler({ query: 'late needle' });
        expect(found.data).toMatchObject({ count: 1, truncated: false });
        expect(found.data.results[0].file).toBe('target.ts');
        const absent = await tool.handler({ query: 'missing' });
        expect(absent.data).toMatchObject({ count: 0, truncated: false });
        expect(absent.data.truncationReasons).toBeUndefined();
    });

    test('旧文件上限之外的精确短语不会被误判为零匹配并扩大为关键词', async () => {
        const tool = fixture({ '/one/a.ts': 'alpha', '/one/b.ts': 'alpha beta' }, { maxFindFiles: 1 });
        const result = await tool.handler({ query: 'alpha beta', keywordFallback: true });
        expect(result.data.results.map((item: any) => item.file)).toEqual(['b.ts']);
        expect(result.data.queryFallback).toBeUndefined();
    });

    test.each([-1, 1.5, Infinity, '1'])('拒绝无效 offset %s', async offset => {
        const tool = fixture({ '/one/a.ts': 'hit' });
        expect((await tool.handler({ query: 'hit', offset })).success).toBe(false);
    });

    test('替换不接受分页，缺失 replace 的说明与实际拒绝一致', async () => {
        const tool = fixture({ '/one/a.ts': 'hit' });
        expect((await tool.handler({ query: 'hit', mode: 'replace' })).error).toContain('replace parameter is required');
        expect((await tool.handler({ query: 'hit', mode: 'replace', replace: '', offset: 1 })).error).toContain('not paginated');
        const description = tool.declaration.parameters.properties?.replace.description ?? '';
        expect(description).not.toMatch(/省略会静默|would silently/);
        expect(description).toMatch(/省略会报错|omitting it returns an error/);
    });

    test('续查元数据经过真实模型结果格式化仍然可见', async () => {
        const tool = fixture({ '/one/a.ts': 'hit\nhit' });
        const result = await tool.handler({ query: 'hit', maxResults: 1 });
        const text = serializeToolResultForLLM('search_in_files', result);
        expect(text).toContain('"nextOffset":1');
        expect(text).toContain('"truncationReasons":["maxResults"]');
        expect(text).toContain('offset=1');
    });

    test('模型看到按文件分组的紧凑结果：路径只出现一次，相邻上下文合并', async () => {
        const tool = fixture({ '/one/a.ts': 'one\nhit x hit\nthree\nhit\nfive\nsix\nseven\nhit' });
        const result = await tool.handler({ query: 'hit' });
        const text = serializeToolResultForLLM('search_in_files', result);
        expect(text.match(/a\.ts/g)).toHaveLength(1);
        expect(text).toContain('a.ts\n1- one\n2:1,7: hit x hit\n3- three\n4:1: hit\n5- five\n--\n7- seven\n8:1: hit');
        expect(text).not.toContain('"context"');
    });

    test('显式 context 只覆盖本次搜索的上下文行数，越界值被拒绝', async () => {
        const tool = fixture({ '/one/a.ts': 'one\ntwo\nthree\nhit\nfive\nsix\nseven' });
        const none = serializeToolResultForLLM('search_in_files', await tool.handler({ query: 'hit', context: 0 }));
        expect(none).toContain('a.ts\n4:1: hit');
        expect(none).not.toContain('three');
        const wide = serializeToolResultForLLM('search_in_files', await tool.handler({ query: 'hit', context: 3 }));
        expect(wide).toContain('a.ts\n1- one\n2- two\n3- three\n4:1: hit\n5- five\n6- six\n7- seven');
        const defaults = serializeToolResultForLLM('search_in_files', await tool.handler({ query: 'hit' }));
        expect(defaults).toContain('3- three\n4:1: hit\n5- five');
        expect(defaults).not.toContain('two');
        for (const context of [-1, 11, 1.5, '2']) {
            expect((await tool.handler({ query: 'hit', context })).error).toContain('context must be an integer');
        }
        expect(tool.declaration.parameters.properties?.context).toMatchObject({ minimum: 0, maximum: 10 });
    });
});
