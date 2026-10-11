/**
 * find_files 工具测试
 *
 * 覆盖：
 * - maxResults 规范化：0/负值/非数字回退默认 500，浮点数取整（负值不再原样传入 findFiles）
 * - truncated 判定：采用 maxResults+1 探测后，“恰好等于 maxResults”不再误报 truncated，
 *   只有真的超出才置 truncated（含多工作区聚合场景）
 */
import { createFindFilesRuntime } from '../../../tools/search/findFilesRuntime';
import { createFileToolHostMock } from '../../__fixtures__/mockFixtures';

const { host, setWorkspaces } = createFileToolHostMock();
const findFilesMock = host.findFiles;
const statMock = host.stat;
const createFindFilesTool = () => createFindFilesRuntime(host).createFindFilesTool();

function makeFileUri(fsPath: string) {
    return { fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/') };
}

/** 按工作区路径映射可用文件总数，maxResults 由调用方传入（已含 +1 探测） */
function mockFindFiles(availableByWorkspace: Record<string, number>) {
    findFilesMock.mockReset();
    findFilesMock.mockImplementation(async (root, _pattern, _exclude, maxResults) => {
        const base = root.fsPath;
        const total = availableByWorkspace[base] ?? 0;
        const count = Math.min(total, maxResults);
        return Array.from({ length: count }, (_, i) => makeFileUri(`${base}/f${i}.txt`));
    });
    statMock.mockReset();
    statMock.mockResolvedValue({ size: 100, type: 1 });
}

async function runFind(patterns: string[], maxResults?: number) {
    const tool = createFindFilesTool();
    const args: any = { patterns };
    if (maxResults !== undefined) {
        args.maxResults = maxResults;
    }
    const result = await tool.handler(args);
    const data = result.data;
    return { result, findResult: data?.results?.[0] };
}

beforeEach(() => {
    findFilesMock.mockReset();
    statMock.mockReset();
    setWorkspaces([]);
});

describe('find_files maxResults 规范化', () => {
    beforeEach(() => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        mockFindFiles({ 'C:/gc-test-repo1': 600 });
    });

    test('maxResults=0 回退默认 500，且 +1 探测请求 501', async () => {
        const { result, findResult } = await runFind(['**/*.ts'], 0);
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 501, { includeIgnored: false });
        expect(findResult.files).toHaveLength(500);
        expect(findResult.truncated).toBe(true);
    });

    test('maxResults 为负值回退默认 500，不再把负值传入 findFiles', async () => {
        const { result, findResult } = await runFind(['**/*.ts'], -5);
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 501, { includeIgnored: false });
        expect(findResult.files).toHaveLength(500);
    });

    test('maxResults 浮点数向下取整', async () => {
        const { result, findResult } = await runFind(['**/*.ts'], 7.9);
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 8, { includeIgnored: false });
        expect(findResult.files).toHaveLength(7);
        expect(findResult.truncated).toBe(true);
    });

    test('未传 maxResults 时使用默认 500', async () => {
        const { result, findResult } = await runFind(['**/*.ts']);
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 501, { includeIgnored: false });
        expect(findResult.files).toHaveLength(500);
        expect(findResult.truncated).toBe(true);
    });
});

describe('find_files truncated 判定（单工作区）', () => {
    beforeEach(() => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
    });

    test('恰好等于 maxResults 时不误报 truncated', async () => {
        mockFindFiles({ 'C:/gc-test-repo1': 10 });
        const { result, findResult } = await runFind(['**/*.ts'], 10);
        expect(result.success).toBe(true);
        expect(findFilesMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 11, { includeIgnored: false });
        expect(findResult.files).toHaveLength(10);
        expect(findResult.truncated).toBe(false);
    });

    test('超过 maxResults 时报告 truncated 并截断到 maxResults', async () => {
        mockFindFiles({ 'C:/gc-test-repo1': 20 });
        const { result, findResult } = await runFind(['**/*.ts'], 10);
        expect(result.success).toBe(true);
        expect(findResult.files).toHaveLength(10);
        expect(findResult.truncated).toBe(true);
    });
});

describe('find_files truncated 判定（多工作区聚合）', () => {
    test('各工作区合计恰好达到 maxResults 时不误报 truncated', async () => {
        setWorkspaces([
            { name: 'ws1', fsPath: 'C:/gc-test-repo1' },
            { name: 'ws2', fsPath: 'C:/gc-test-repo2' }
        ]);
        mockFindFiles({ 'C:/gc-test-repo1': 30, 'C:/gc-test-repo2': 20 });
        const { result, findResult } = await runFind(['**/*.ts'], 50);
        expect(result.success).toBe(true);
        expect(findResult.files).toHaveLength(50);
        expect(findResult.truncated).toBe(false);
    });

    test('某个工作区超出剩余配额时报告 truncated', async () => {
        setWorkspaces([
            { name: 'ws1', fsPath: 'C:/gc-test-repo1' },
            { name: 'ws2', fsPath: 'C:/gc-test-repo2' }
        ]);
        mockFindFiles({ 'C:/gc-test-repo1': 30, 'C:/gc-test-repo2': 30 });
        const { result, findResult } = await runFind(['**/*.ts'], 50);
        expect(result.success).toBe(true);
        expect(findResult.files).toHaveLength(50);
        expect(findResult.truncated).toBe(true);
    });
});
