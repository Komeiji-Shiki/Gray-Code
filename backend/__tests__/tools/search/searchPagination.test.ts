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
    test('分页与一次读取顺序相同，最后一页恰好达到上限不误报', async () => {
        const tool = fixture({ '/one/a.ts': 'hit hit\nhit', '/one/b.ts': 'hit' });
        const first = await tool.handler({ query: 'hit', maxResults: 2 });
        expect(first.data).toMatchObject({ count: 2, nextOffset: 2, truncated: true, truncationReasons: ['maxResults'] });
        const second = await tool.handler({ query: 'hit', maxResults: 2, offset: first.data.nextOffset });
        expect(second.data).toMatchObject({ count: 2, offset: 2, truncated: false });
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
        const result = await fallback.handler({ query: 'alpha beta', offset: 1, maxResults: 1 });
        expect(result.data.queryFallback).toMatchObject({ applied: true, reason: 'whitespace_keyword_or' });
        expect(result.data.results[0].line).toBe(2);
        expect(result.data.nextOffset).toBe(2);
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

    test('文件发现达到上限时明确指出 offset 无法读到未发现文件', async () => {
        const tool = fixture({ '/one/a.ts': 'hit', '/one/b.ts': 'hit' }, { maxFindFiles: 1 });
        const result = await tool.handler({ query: 'hit', maxResults: 1 });
        expect(result.data.truncationReasons).toEqual(['maxFindFiles']);
        expect(result.data.nextOffset).toBeUndefined();
        expect(result.data.continuationHint).toContain('undiscovered');
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
});
