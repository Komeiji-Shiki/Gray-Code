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
import * as vscode from 'vscode';
import { createSearchInFilesTool } from '../../../tools/search/search_in_files';
import { DiffManager } from '../../../tools/file/diffManager';

// vscode mock 未提供 RelativePattern，测试内补齐（运行时与生产代码共享同一 mock 实例）
class FakeRelativePattern {
    constructor(public base: any, public pattern: string) {}
}
(vscode as any).RelativePattern = FakeRelativePattern;

// DiffManager / DiffCodeLensProvider 依赖 vscode.EventEmitter 与 registerTextDocumentContentProvider，
// 测试内补齐最小实现（替换模式走 diff 审阅链路时需要）
class FakeEventEmitter<T = any> {
    private listeners: Array<(e: T) => any> = [];
    event(listener: (e: T) => any): { dispose: () => void } {
        this.listeners.push(listener);
        return { dispose: () => { /* noop */ } };
    }
    fire(e: T): void {
        for (const l of this.listeners) {
            l(e);
        }
    }
    dispose(): void {
        this.listeners = [];
    }
}
(vscode as any).EventEmitter = FakeEventEmitter;
(vscode.workspace as any).registerTextDocumentContentProvider = jest.fn(() => ({ dispose: jest.fn() }));

// DiffManager 接受/拒绝 diff 时会构造 WorkspaceEdit 并通过 applyEdit 应用，测试内补齐
class FakeWorkspaceEdit {
    replace(_uri: any, _range: any, _newText: string): void { /* noop */ }
}
(vscode as any).WorkspaceEdit = FakeWorkspaceEdit;

/** 生成与 diff absolutePath 匹配的假文本文档（避免 rejectDiff 落入写盘分支） */
function makeFakeDocument(fsPath: string, content: string) {
    return {
        uri: makeFileUri(fsPath),
        getText: () => content,
        positionAt: (offset: number) => ({ line: 0, character: offset }),
        isDirty: false,
        save: async () => true
    };
}

const findFilesMock = vscode.workspace.findFiles as jest.Mock;
const readFileMock = vscode.workspace.fs.readFile as jest.Mock;
const statMock = vscode.workspace.fs.stat as jest.Mock;

function makeFileUri(fsPath: string) {
    return { fsPath, scheme: 'file', path: fsPath.replace(/\\/g, '/') };
}

function setWorkspaces(folders: Array<{ name: string; fsPath: string }>) {
    (vscode.workspace as any).workspaceFolders = folders.map((f, index) => ({
        name: f.name,
        uri: makeFileUri(f.fsPath),
        index
    }));
}

function makeContext(overrides?: any) {
    return { config: {}, toolId: 'test-tool', ...overrides } as any;
}

beforeEach(() => {
    findFilesMock.mockReset();
    readFileMock.mockReset();
    statMock.mockReset();
    statMock.mockResolvedValue({ size: 100 });
    (vscode.workspace as any).workspaceFolders = [];
    (vscode.workspace as any).textDocuments = [];
    (vscode.workspace.openTextDocument as jest.Mock).mockReset();
    (vscode.workspace.applyEdit as jest.Mock).mockReset();
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
});

describe('ReDoS 防护（正则源串长度与构造异常）', () => {
    it('超长正则源串（>500）被拒绝并给出可读错误', async () => {
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

    it('非正则超长字面量查询同样被拒绝（转义后仍超长）', async () => {
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

    it('非法正则给出可读错误而不是堆栈', async () => {
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

    it('恰好 500 字符的正则仍可正常搜索', async () => {
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

    it('未知工作区前缀直接返回错误，错误信息透传给模型', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: '@unknown_ws/src/' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Unknown workspace');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    it('多根下未带前缀的 path 返回要求前缀的错误，不再回退第一个工作区', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: 'src/' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('workspace prefix');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    it('replace 模式同样在解析失败时直接返回错误', async () => {
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo', path: '@unknown_ws/src/', mode: 'replace', replace: 'bar' },
            makeContext()
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Unknown workspace');
        expect(findFilesMock).not.toHaveBeenCalled();
    });

    it('"." 仍表示搜索所有工作区，不被解析错误拦截', async () => {
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
    it('单工作区不带前缀正常搜索', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        findFilesMock.mockResolvedValue([makeFileUri('C:/gc-test-repo1/a.ts')]);
        readFileMock.mockResolvedValue(Buffer.from('foo bar\n', 'utf8'));
        const tool = createSearchInFilesTool();
        const result = await tool.handler(
            { query: 'foo' },
            makeContext()
        );
        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.count).toBeGreaterThan(0);
        expect(data.results[0].file).toBe('a.ts');
    });
});

describe('替换模式 matches 收集预算上限', () => {
    it('高频 query 超过 MAX_REPLACE_MATCHES 时截断收集并置 truncated，替换仍完整执行', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const fileUri = makeFileUri('C:/gc-test-repo1/big.txt');
        findFilesMock.mockResolvedValue([fileUri]);
        const content = 'x'.repeat(25000);
        readFileMock.mockResolvedValue(Buffer.from(content, 'utf8'));
        statMock.mockResolvedValue({ size: content.length });

        const tool = createSearchInFilesTool();
        const handlerPromise = tool.handler(
            { query: 'x', mode: 'replace', replace: 'y' },
            makeContext()
        );
        // 让 diff 审阅链路找到对应文本文档（acceptDiff 走内存编辑路径，不写磁盘）
        const fakeDoc = makeFakeDocument('C:/gc-test-repo1/big.txt', content);
        (vscode.workspace as any).textDocuments = [fakeDoc];
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(fakeDoc);

        // 等待 handler 进入 waitForDiffResolution（diff 视图等待确认），然后接受所有 pending diff
        const dm = DiffManager.getInstance();
        let pendings: any[] = [];
        for (let i = 0; i < 30 && pendings.length === 0; i++) {
            await new Promise(r => setTimeout(r, 100));
            pendings = dm.getPendingDiffs();
        }
        expect(pendings.length).toBe(1);
        for (const d of pendings) {
            await dm.acceptDiff(d.id, false);
        }

        const result = await handlerPromise;
        expect(result.success).toBe(true);
        const data = result.data as any;
        // matches 被预算截断到 20000 且置 truncated
        expect(data.truncated).toBe(true);
        expect(data.matches).toHaveLength(20000);
        // 替换本身仍完整执行（25000 处全部替换）
        expect(data.totalReplacements).toBe(25000);
        expect(data.results).toHaveLength(1);
        expect(data.results[0].replacements).toBe(25000);
    });

    it('未超过预算时 truncated 为 false', async () => {
        setWorkspaces([{ name: 'ws1', fsPath: 'C:/gc-test-repo1' }]);
        const fileUri = makeFileUri('C:/gc-test-repo1/small.txt');
        findFilesMock.mockResolvedValue([fileUri]);
        const content = 'x'.repeat(100);
        readFileMock.mockResolvedValue(Buffer.from(content, 'utf8'));
        statMock.mockResolvedValue({ size: content.length });

        const tool = createSearchInFilesTool();
        const handlerPromise = tool.handler(
            { query: 'x', mode: 'replace', replace: 'y' },
            makeContext()
        );
        const fakeDoc = makeFakeDocument('C:/gc-test-repo1/small.txt', content);
        (vscode.workspace as any).textDocuments = [fakeDoc];
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(fakeDoc);

        const dm = DiffManager.getInstance();
        let pendings: any[] = [];
        for (let i = 0; i < 30 && pendings.length === 0; i++) {
            await new Promise(r => setTimeout(r, 100));
            pendings = dm.getPendingDiffs();
        }
        expect(pendings.length).toBe(1);
        for (const d of pendings) {
            await dm.acceptDiff(d.id, false);
        }

        const result = await handlerPromise;
        expect(result.success).toBe(true);
        const data = result.data as any;
        expect(data.truncated).toBe(false);
        expect(data.matches).toHaveLength(100);
        expect(data.totalReplacements).toBe(100);
    });
});
