/**
 * find_references LSP 生命周期保护测试。
 *
 * provider 调用前通过 openDocumentWithGuard 激活语言服务；
 * executeReferenceProvider 走 executeLspCommandWithRetry（超时/中止保护 + 瞬时重试）；
 * 引用文档读取用 withTimeoutAndAbort 保护。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { createFindReferencesTool } from '../../tools/lsp/find_references';
import { LSP_TIMEOUT_MS, LSP_RETRY_DELAY_MS } from '../../tools/lsp/lspLifecycle';
import { MAX_REFERENCE_CONTENT_CHARS } from '../../tools/lsp/referencePage';

const executeCommandMock = vscode.commands.executeCommand as jest.Mock;
const openTextDocumentMock = vscode.workspace.openTextDocument as jest.Mock;

function makeDoc(lines: string[]) {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] })
    };
}

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i} content`);

function reference(uri: unknown, line: number, column: number) {
    return {
        uri,
        range: {
            start: { line, character: column },
            end: { line, character: column + 5 }
        }
    };
}

describe('find_references LSP lifecycle', () => {
    beforeEach(() => {
        jest.useRealTimers();
        executeCommandMock.mockReset();
        openTextDocumentMock.mockReset().mockResolvedValue({});
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(path.resolve('workspace/project'))
        }];
        (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
            name: 'project',
            uri: vscode.Uri.file(path.resolve('workspace/project'))
        });
        (vscode.workspace.asRelativePath as jest.Mock).mockImplementation(() => 'src/use.ts');
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('正常路径按文件分组返回引用与代码内容', async () => {
        const refUri = vscode.Uri.file(path.resolve('workspace/project/src/use.ts'));
        executeCommandMock.mockResolvedValue([
            reference(refUri, 4, 2),
            reference(refUri, 20, 0)
        ]);
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));

        const result = await createFindReferencesTool().handler(
            { path: 'src/source.ts', line: 3, column: 2, symbol: 'myFunc' },
            {} as any
        );

        expect(result.success).toBe(true);
        expect(executeCommandMock).toHaveBeenCalledWith(
            'vscode.executeReferenceProvider',
            expect.anything(),
            expect.any(Object) // vscode.Position 的 mock 构造结果
        );
        expect(result.data).toMatchObject({
            path: 'src/source.ts',
            line: 3,
            column: 2,
            symbol: 'myFunc',
            totalCount: 2,
            fileCount: 1
        });
        expect(result.data.references[0]).toMatchObject({
            path: 'src/use.ts',
            count: 2
        });
        expect(result.data.references[0].references[0]).toMatchObject({
            line: 5,     // 1-based
            column: 3    // 1-based
        });
        // 引用行被标记 '>'，且带默认 2 行上下文
        expect(result.data.references[0].references[0].content).toContain('>');
        expect(result.data.references[0].references[0].content).toContain('line 4 content');
        expect(result.data.references[0].references[0].content).toContain('line 2 content');
        expect(result.data.references[0].references[0].content).toContain('line 6 content');
        // 打开文档两次：一次激活语言服务（guard），一次读取引用文档（其余走缓存）
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
    });

    test('跨页使用稳定路径/行列顺序，统计总量与当前页数量分离', async () => {
        const a = vscode.Uri.file(path.resolve('workspace/project/a.ts'));
        const b = vscode.Uri.file(path.resolve('workspace/project/b.ts'));
        (vscode.workspace.asRelativePath as jest.Mock).mockImplementation(uri => path.basename(uri.fsPath));
        const values = [reference(b, 3, 0), reference(a, 10, 2), reference(a, 10, 1), reference(a, 1, 0)];
        executeCommandMock.mockResolvedValueOnce(values).mockResolvedValueOnce([...values].reverse());
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));
        const tool = createFindReferencesTool();
        const first = await tool.handler({ path: 'source.ts', line: 1, maxResults: 2, context: 0 }, {} as any);
        const second = await tool.handler({ path: 'source.ts', line: 1, maxResults: 2, offset: first.data.nextOffset, context: 0 }, {} as any);
        expect(first.data).toMatchObject({ totalCount: 4, totalFileCount: 2, fileCount: 1, returnedCount: 2, offset: 0, nextOffset: 2, truncated: true, truncationReasons: ['maxResults'] });
        expect(first.data.references[0].references.map((item: any) => [item.line, item.column])).toEqual([[2, 1], [11, 2]]);
        expect(second.data).toMatchObject({ totalCount: 4, totalFileCount: 2, fileCount: 2, returnedCount: 2, offset: 2, truncated: false });
        expect(second.data.nextOffset).toBeUndefined();
        expect(second.data.references.map((group: any) => [group.path, group.references[0].line, group.references[0].column])).toEqual([['a.ts', 11, 3], ['b.ts', 4, 1]]);
    });

    test('countOnly 只激活源文档，不读取引用正文，且主动省略不算截断', async () => {
        const uri = vscode.Uri.file(path.resolve('workspace/project/use.ts'));
        executeCommandMock.mockResolvedValue(Array.from({ length: 601 }, (_, index) => reference(uri, index, 0)));
        const result = await createFindReferencesTool().handler({ path: 'source.ts', line: 1, countOnly: true, offset: 9999 }, {} as any);
        expect(result.data).toMatchObject({ totalCount: 601, totalFileCount: 1, returnedCount: 0, fileCount: 0, references: [], truncated: false });
        expect(result.data.nextOffset).toBeUndefined();
        expect(openTextDocumentMock).toHaveBeenCalledTimes(1);
    });

    test('默认最多500条且可取剩余引用，越界 offset 返回空页不反复续页', async () => {
        const uri = vscode.Uri.file(path.resolve('workspace/project/use.ts'));
        executeCommandMock.mockResolvedValue(Array.from({ length: 501 }, (_, index) => reference(uri, index, 0)));
        openTextDocumentMock.mockResolvedValue(makeDoc(Array.from({ length: 501 }, () => 'x')));
        const tool = createFindReferencesTool();
        const first = await tool.handler({ path: 'source.ts', line: 1, context: 0 }, {} as any);
        expect(first.data).toMatchObject({ totalCount: 501, returnedCount: 500, nextOffset: 500, maxResults: 500, truncated: true });
        const last = await tool.handler({ path: 'source.ts', line: 1, offset: 500, context: 0 }, {} as any);
        expect(last.data).toMatchObject({ returnedCount: 1, truncated: false });
        const beyond = await tool.handler({ path: 'source.ts', line: 1, offset: 999 }, {} as any);
        expect(beyond.data).toMatchObject({ totalCount: 501, returnedCount: 0, references: [], truncated: false });
        expect(beyond.data.nextOffset).toBeUndefined();
    });

    test('代码预算不跳过中间引用，单条超长内容明确截断且分页继续前进', async () => {
        const uri = vscode.Uri.file(path.resolve('workspace/project/use.ts'));
        executeCommandMock.mockResolvedValue([reference(uri, 0, 0), reference(uri, 1, 0), reference(uri, 2, 0)]);
        openTextDocumentMock.mockResolvedValue(makeDoc(['short', 'x'.repeat(MAX_REFERENCE_CONTENT_CHARS + 10), 'last']));
        const tool = createFindReferencesTool();
        const first = await tool.handler({ path: 'source.ts', line: 1, context: 0 }, {} as any);
        expect(first.data).toMatchObject({ returnedCount: 1, nextOffset: 1, truncationReasons: ['outputBudget'] });
        const second = await tool.handler({ path: 'source.ts', line: 1, context: 0, offset: 1 }, {} as any);
        expect(second.data).toMatchObject({ returnedCount: 1, nextOffset: 2, truncationReasons: ['outputBudget'] });
        expect(second.data.references[0].references[0]).toMatchObject({ line: 2, contentTruncated: true });
        expect(second.data.references[0].references[0].content).toHaveLength(MAX_REFERENCE_CONTENT_CHARS);
        expect(second.data.continuationHint).toContain('read_file');
        const third = await tool.handler({ path: 'source.ts', line: 1, context: 0, offset: 2 }, {} as any);
        expect(third.data).toMatchObject({ returnedCount: 1, truncated: false });
        expect(third.data.references[0].references[0].line).toBe(3);
    });

    test.each([{ maxResults: 0 }, { maxResults: 501 }, { maxResults: 1.5 }, { maxResults: '2' }, { offset: -1 }, { offset: NaN }, { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { countOnly: 'true' }])('拒绝无效分页参数而不启动语言服务：%j', async options => {
        const result = await createFindReferencesTool().handler({ path: 'source.ts', line: 1, ...options }, {} as any);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/maxResults|offset|countOnly/);
        expect(executeCommandMock).not.toHaveBeenCalled();
        expect(openTextDocumentMock).not.toHaveBeenCalled();
    });

    test('TypeScript 语言服务首次未就绪时短暂等待后重试', async () => {
        jest.useFakeTimers();
        executeCommandMock
            .mockRejectedValueOnce(new Error('TypeScript language service is not ready'))
            .mockResolvedValueOnce([]);

        const resultPromise = createFindReferencesTool().handler(
            { path: 'src/source.ts', line: 3 },
            {} as any
        );
        await jest.advanceTimersByTimeAsync(LSP_RETRY_DELAY_MS);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.data.totalCount).toBe(0);
        expect(executeCommandMock).toHaveBeenCalledTimes(2);
    });

    test('provider 挂起时在 LSP_TIMEOUT_MS 后返回失败而不是无限等待', async () => {
        jest.useFakeTimers();
        executeCommandMock.mockImplementation(() => new Promise(() => undefined));

        const resultPromise = createFindReferencesTool().handler(
            { path: 'src/source.ts', line: 3 },
            {} as any
        );
        await jest.advanceTimersByTimeAsync(LSP_TIMEOUT_MS);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain(`timed out after ${LSP_TIMEOUT_MS}ms`);
        // 超时不重试
        expect(executeCommandMock).toHaveBeenCalledTimes(1);
    });

    test('已中止的 signal 立即失败且不发起 provider 请求', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await createFindReferencesTool().handler(
            { path: 'src/source.ts', line: 3 },
            { abortSignal: controller.signal } as any
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('aborted');
        expect(executeCommandMock).not.toHaveBeenCalled();
        expect(openTextDocumentMock).not.toHaveBeenCalled();
    });
});
