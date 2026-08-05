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

    it('正常路径按文件分组返回引用与代码内容', async () => {
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

    it('TypeScript 语言服务首次未就绪时短暂等待后重试', async () => {
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

    it('provider 挂起时在 LSP_TIMEOUT_MS 后返回失败而不是无限等待', async () => {
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

    it('已中止的 signal 立即失败且不发起 provider 请求', async () => {
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
