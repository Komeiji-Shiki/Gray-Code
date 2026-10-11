/**
 * search_in_files 工具测试
 *
 * 覆盖：
 * - ReDoS 防护：超长正则源串直接拒绝；非法正则给出可读错误；恰好 500 字符仍可用
 * - 多根工作区下 path 解析失败（未知前缀/未带前缀）直接返回错误，不再静默回退到第一个工作区；
 *   "." 搜索所有工作区不受影响
 * - 替换模式 matches 收集预算上限（MAX_REPLACE_MATCHES=20000）：超出截断收集并置 truncated，
 *   替换本身仍完整执行
 */
import { createSearchDeclaration } from '../../../tools/search/declarationRuntime';
import { createFileToolHostMock } from '../../__fixtures__/mockFixtures';

const { host, setWorkspaces } = createFileToolHostMock();
const findFilesMock = host.findFiles;
const readFileMock = host.readFile;
const statMock = host.stat;
const reviewMock = host.review;
const createSearchInFilesTool = () => createSearchDeclaration(host).createSearchInFilesTool();

function makeFileUri(fsPath: string) {
    return { fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/') };
}

function makeContext(overrides?: any) {
    return { config: {}, toolId: 'test-tool', ...overrides } as any;
}

beforeEach(() => {
    findFilesMock.mockReset();
    readFileMock.mockReset();
    statMock.mockReset();
    statMock.mockResolvedValue({ size: 100, type: 1 });
    reviewMock.mockReset().mockResolvedValue({ wasAccepted: true, wasInterrupted: false, pendingDiffId: 'test-diff' });
    setWorkspaces([]);
});

describe('ReDoS 防护（正则源串长度与构造异常）', () => {
    test('超长正则源串（>500）被拒绝并给出可读错误', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'a'.repeat(501), isRegex: true },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('too long');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('非正则超长字面量查询同样被拒绝（转义后仍超长）', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'a'.repeat(501), isRegex: false },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('too long');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('非法正则给出可读错误而不是堆栈', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: '([unclosed', isRegex: true },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Invalid regular expression');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('恰好 500 字符的正则仍可正常搜索', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        findFilesMock.mockResolvedValue([]);
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'a'.repeat(500), isRegex: true, maxResults: 100 },
            makeContext()
        );
        expect(result.success).toBe(true);
    });
});

describe('多根工作区 path 解析失败不再静默回退', () => {
    beforeEach(() => {
        setWorkspaces([
            { name: 'ws1', fsPath: 'C:/gc-test-repo1' },
            { name: 'ws2', fsPath: 'C:/gc-test-repo2' }
        ]);
        findFilesMock.mockResolvedValue([]);
    });

    test('未知工作区前缀直接返回错误，错误信息透传给模型', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: '@unknown_ws/src/' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Unknown workspace');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('多根下未带前缀的 path 返回要求前缀的错误，不再回退第一个工作区', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: 'src/' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('workspace prefix');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('replace 模式同样在解析失败时直接返回错误', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: '@unknown_ws/src/', mode: 'replace', replace: 'bar' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Unknown workspace');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    test('"." 仍表示搜索所有工作区，不被解析错误拦截', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: '.' },
            makeContext()
        );
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalled();
    });
});

describe('单工作区基础搜索不受影响', () => {
    test('单工作区不带前缀正常搜索', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        findFilesMock.mockResolvedValue([makeFileUri('C:/gc-test-repo1/a.ts')]);
        readFileMock.mockResolvedValue(Buffer.from('foo bar\n', 'utf8'));
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo' },
            makeContext()
        );
        expect(result.success).toBe(true);
        const data = result.data;
        expect(data.count).toBeGreaterThan(0);
        expect(data.results[0].file).toBe('a.ts');
    });
});

describe('替换模式 matches 收集预算上限', () => {
    test.each([
        ['全部拒绝', ['rejected', 'rejected'], 0, 0],
        ['接受与拒绝混合', ['accepted', 'rejected'], 1, 2]
    ] as const)('%s时统计实际应用的替换，保留候选结果', async (_name, decisions, filesModified, totalReplacements) => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const files = ['first.txt', 'second.txt'].map(name => makeFileUri(`C:/gc-test-repo1/${name}`));
        findFilesMock.mockResolvedValue(files);
        readFileMock.mockResolvedValue(Buffer.from('xx'));
        statMock.mockResolvedValue({ size: 2, type: 1 });
        for (const decision of decisions) {
            reviewMock.mockResolvedValueOnce({ wasAccepted: decision === 'accepted', wasInterrupted: false, pendingDiffId: 'test-diff' });
        }
        const result = await createSearchInFilesTool().handler({ query: 'x', mode: 'replace', replace: 'y' }, makeContext());
        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ filesModified, totalReplacements, proposedReplacements: 4,
            filesRejected: decisions.filter(value => value === 'rejected').length });
        expect(result.data.results.map(item => item.status)).toEqual(decisions);
    });

    test('高频 query 超过 MAX_REPLACE_MATCHES 时截断收集并置 truncated，替换仍完整执行', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const fileUri = makeFileUri('C:/gc-test-repo1/big.txt');
        findFilesMock.mockResolvedValue([fileUri]);
        const content = 'x'.repeat(25000);
        readFileMock.mockResolvedValue(Buffer.from(content, 'utf8'));
        statMock.mockResolvedValue({ size: content.length, type: 1 });

        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'x', mode: 'replace', replace: 'y' },
            makeContext()
        );
        expect(reviewMock).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        const data = result.data;
        // matches 被预算截断到 20000 且置 truncated
        expect(data.truncated).toBe(true);
        expect(data.matches).toHaveLength(20000);
        // 替换本身仍完整执行（25000 处全部替换）
        expect(data.totalReplacements).toBe(25000);
        expect(data.results).toHaveLength(1);
        expect(data.results[0].replacements).toBe(25000);
    });

    test('未超过预算时 truncated 为 false', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const fileUri = makeFileUri('C:/gc-test-repo1/small.txt');
        findFilesMock.mockResolvedValue([fileUri]);
        const content = 'x'.repeat(100);
        readFileMock.mockResolvedValue(Buffer.from(content, 'utf8'));
        statMock.mockResolvedValue({ size: content.length, type: 1 });

        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'x', mode: 'replace', replace: 'y' },
            makeContext()
        );
        expect(reviewMock).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        const data = result.data;
        expect(data.truncated).toBe(false);
        expect(data.matches).toHaveLength(100);
        expect(data.totalReplacements).toBe(100);
    });
});
