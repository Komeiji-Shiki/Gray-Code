import { createFindFilesRuntime } from '../../../tools/search/findFilesRuntime';
import type { SearchFileHost, FileLocation } from '../../../tools/search/fileHost';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../modules/settings/types';
import { serializeToolResultForLLM } from '../../../modules/channel/formatters/toolResponseFormatter';

// 顺序故意不按字母排列：分页必须跳过发现序列，不能为添加游标而改变旧首批结果。
function fixture(filesByRoot: Record<string, string[]>, excludes?: string[]) {
    const location = (fsPath: string): FileLocation => ({ fsPath, scheme: 'file' });
    const roots = Object.keys(filesByRoot).map(name => ({ name, uri: location(`/${name}`) }));
    const host: SearchFileHost = {
        getAllWorkspaces: () => roots,
        getWorkspaceRoot: () => roots[0]?.uri,
        parseWorkspacePath: () => ({ relativePath: '.', isExplicit: false }),
        resolveFileToolPathWithInfo: () => ({ isOutsideWorkspace: false }),
        toRelativePath: (file, prefix) => prefix ? `@${file.fsPath.slice(1)}` : file.fsPath.split('/').slice(2).join('/'),
        joinPath: (root, file) => location(`${root.fsPath}/${file}`),
        file: location,
        stat: async () => ({ size: 5, type: 1 }),
        readFile: async () => Buffer.from('text'),
        findFiles: jest.fn(async (root, _pattern, _exclude, limit) => filesByRoot[root.fsPath.slice(1)].slice(0, limit).map(file => location(`${root.fsPath}/${file}`))),
        countLines: jest.fn(async () => 3),
        findExcludePatterns: () => excludes,
        searchConfig: () => DEFAULT_SEARCH_IN_FILES_CONFIG,
        checkAccess: () => null,
        review: jest.fn()
    };
    return { host, tool: createFindFilesRuntime(host).createFindFilesTool() };
}

describe('find_files 续查和实际排除策略', () => {
    test('保留首批选择与页内排序，续查不重复/漏项，只统计本页行数', async () => {
        const { tool, host } = fixture({ one: ['z.ts', 'd.ts', 'c.ts', 'a.ts'] });
        const first = await tool.handler({ patterns: ['**/*.ts'], maxResults: 2 });
        expect(first.data.results[0]).toMatchObject({ files: ['d.ts', 'z.ts'], offset: 0, nextOffset: 2, truncated: true });
        expect(host.findFiles).toHaveBeenLastCalledWith(expect.anything(), '**/*.ts', '**/node_modules/**', 3, { includeIgnored: false });
        expect(host.countLines).toHaveBeenCalledTimes(2);
        (host.countLines as jest.Mock).mockClear();
        const second = await tool.handler({ patterns: ['**/*.ts'], maxResults: 2, offset: 2 });
        expect(second.data.results[0]).toMatchObject({ files: ['a.ts', 'c.ts'], count: 2, offset: 2, truncated: false });
        expect(second.data.results[0].nextOffset).toBeUndefined();
        expect(second.data.results[0].fileDetails).toEqual([{ path: 'a.ts', lineCount: 3 }, { path: 'c.ts', lineCount: 3 }]);
        expect(host.countLines).toHaveBeenCalledTimes(2);
        expect((host.countLines as jest.Mock).mock.calls.map(call => call[0].fsPath)).toEqual(['/one/c.ts', '/one/a.ts']);
        const beyond = await tool.handler({ patterns: ['**/*.ts'], maxResults: 2, offset: 99 });
        expect(beyond.data.results[0]).toMatchObject({ files: [], offset: 99, truncated: false });
        expect(beyond.data.results[0].nextOffset).toBeUndefined();
    });

    test('跨根累计 offset，且每个 pattern 独立计数，不按排序后的根名跳过', async () => {
        const { tool, host } = fixture({ z: ['a.ts', 'b.ts'], a: ['c.ts', 'd.ts'], empty: [] });
        const result = await tool.handler({ patterns: ['**/*.ts', '**/*'], maxResults: 1, offset: 2 });
        for (const found of result.data.results) {
            expect(found).toMatchObject({ files: ['@a/c.ts'], offset: 2, nextOffset: 3, truncated: true });
        }
        expect((host.findFiles as jest.Mock).mock.calls.map(call => call[3])).toEqual([4, 2, 1, 4, 2, 1]);
        const last = await tool.handler({ patterns: ['**/*.ts'], maxResults: 1, offset: 3 });
        expect(last.data.results[0]).toMatchObject({ files: ['@a/d.ts'], truncated: false });
        expect(last.data.results[0].nextOffset).toBeUndefined();
    });

    test('跨根页跨边界时仍覆盖发现集合，末页恰好上限不误报', async () => {
        const { tool } = fixture({ z: ['last.ts'], a: ['b.ts', 'a.ts'] });
        const first = await tool.handler({ patterns: ['**/*'], maxResults: 2 });
        expect(first.data.results[0]).toMatchObject({ files: ['@a/b.ts', '@z/last.ts'], nextOffset: 2 });
        const second = await tool.handler({ patterns: ['**/*'], maxResults: 1, offset: 2 });
        expect(second.data.results[0]).toMatchObject({ files: ['@a/a.ts'], count: 1, truncated: false });
    });

    test('多根错误可见、保留部分文件，但不能提供漏项的 nextOffset', async () => {
        const { tool, host } = fixture({ bad: [], good: ['a.ts', 'b.ts'] });
        (host.findFiles as jest.Mock).mockImplementation(async (root: FileLocation, _pattern: string, _exclude: string, limit: number) => {
            if (root.fsPath === '/bad') throw new Error('EACCES fixture');
            return ['a.ts', 'b.ts'].slice(0, limit).map(name => host.file(`/good/${name}`));
        });
        const result = await tool.handler({ patterns: ['**/*'], maxResults: 1 });
        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({ failCount: 1, successCount: 0, totalFiles: 1 });
        expect(result.data.results[0]).toMatchObject({ success: false, files: ['@good/a.ts'], truncated: true,
            workspaceErrors: [{ workspace: 'bad', error: 'EACCES fixture' }] });
        expect(result.data.results[0].nextOffset).toBeUndefined();
        expect(result.data.results[0].continuationHint).toContain('restart');
        const text = serializeToolResultForLLM('find_files', result);
        expect(text).toContain('@good/a.ts');
        expect(text).toContain('EACCES fixture');
    });

    test('非空 exclude 替换配置而非合并，空串与省略仍使用配置', async () => {
        const { tool, host } = fixture({ one: [] }, ['**/node_modules/**', '**/dist/**']);
        for (const args of [{}, { exclude: '' }]) {
            const result = await tool.handler({ patterns: ['**/*'], ...args });
            expect(result.data).toMatchObject({ effectiveExclude: '{**/node_modules/**,**/dist/**}', excludeSource: 'settings' });
            expect(host.findFiles).toHaveBeenLastCalledWith(expect.anything(), '**/*', '{**/node_modules/**,**/dist/**}', 501, { includeIgnored: false });
        }
        const explicit = await tool.handler({ patterns: ['**/*'], exclude: '**/node_modules/**' });
        expect(explicit.data).toMatchObject({ effectiveExclude: '**/node_modules/**', excludeSource: 'argument' });
        expect(host.findFiles).toHaveBeenLastCalledWith(expect.anything(), '**/*', '**/node_modules/**', 501, { includeIgnored: false });
        expect(tool.declaration.parameters.properties?.exclude.default).toBeUndefined();
    });

    test.each([undefined, []])('未配置/空排除列表保留 node_modules 兜底：%s', async excludes => {
        const { tool } = fixture({ one: [] }, excludes);
        const result = await tool.handler({ patterns: ['**/*'] });
        expect(result.data).toMatchObject({ effectiveExclude: '**/node_modules/**', excludeSource: 'fallback' });
    });

    test('模型格式化保留页游标与策略来源，默认排除模式只留在原回执', async () => {
        const { tool } = fixture({ one: ['b.ts', 'a.ts'] });
        const result = await tool.handler({ patterns: ['**/*'], maxResults: 1 });
        const text = serializeToolResultForLLM('find_files', result);
        expect(text).toContain('"nextOffset":1');
        expect(text).not.toContain('effectiveExclude');
        expect(result.data.effectiveExclude).toBe('**/node_modules/**');
        const explicit = await tool.handler({ patterns: ['**/*'], exclude: '**/vendor/**' });
        expect(serializeToolResultForLLM('find_files', explicit)).toContain('"effectiveExclude":"**/vendor/**"');
        expect(text).toContain('"excludeSource":"fallback"');
        expect(text).toContain('discovery order');
    });

    test.each([-1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER])('拒绝非法或溢出 offset：%s', async offset => {
        const { tool, host } = fixture({ one: [] });
        expect((await tool.handler({ patterns: ['**/*'], offset })).success).toBe(false);
        expect(host.findFiles).not.toHaveBeenCalled();
    });

    test.each([Infinity, NaN, '3'])('无效 maxResults %s 不传入宿主', async maxResults => {
        const { tool, host } = fixture({ one: [] });
        expect((await tool.handler({ patterns: ['**/*'], maxResults })).success).toBe(true);
        expect(host.findFiles).toHaveBeenCalledWith(expect.anything(), '**/*', expect.anything(), 501, { includeIgnored: false });
    });

    test('小数正上限最少一项，极大数加探测溢出则拒绝', async () => {
        const { tool, host } = fixture({ one: ['b.ts', 'a.ts'] });
        expect((await tool.handler({ patterns: ['**/*'], maxResults: 0.5 })).data.results[0].count).toBe(1);
        expect(host.findFiles).toHaveBeenCalledWith(expect.anything(), '**/*', expect.anything(), 2, { includeIgnored: false });
        expect((await tool.handler({ patterns: ['**/*'], maxResults: Number.MAX_SAFE_INTEGER })).success).toBe(false);
    });

    test.each([{ patterns: [''] }, { patterns: [1] }, { patterns: ['**/*'], exclude: 1 }])('非法模式/排除先报错，不触发宿主遍历：%j', async args => {
        const { tool, host } = fixture({ one: [] });
        expect((await tool.handler(args)).success).toBe(false);
        expect(host.findFiles).not.toHaveBeenCalled();
    });
});
