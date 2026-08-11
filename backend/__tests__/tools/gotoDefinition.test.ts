/**
 * goto_definition LSP 生命周期保护测试。
 *
 * provider 调用前通过 openDocumentWithGuard 激活语言服务；
 * executeDefinitionProvider 走 executeLspCommandWithRetry（超时/中止保护 + 瞬时重试）；
 * 目标文档读取用 withTimeoutAndAbort 保护。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { createGotoDefinitionTool } from '../../tools/lsp/goto_definition';
import { LSP_TIMEOUT_MS, LSP_RETRY_DELAY_MS } from '../../tools/lsp/lspLifecycle';

const executeCommandMock = vscode.commands.executeCommand as jest.Mock;
const openTextDocumentMock = vscode.workspace.openTextDocument as jest.Mock;

function makeDoc(lines: string[]) {
    return {
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] })
    };
}

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i} content`);

function location(uri: unknown, startLine: number, endLine: number) {
    return {
        uri,
        range: {
            start: { line: startLine, character: 0 },
            end: { line: endLine, character: 5 }
        }
    };
}

describe('goto_definition LSP lifecycle', () => {
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
        (vscode.workspace.asRelativePath as jest.Mock).mockImplementation(() => 'src/target.ts');
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('正常路径返回定义位置与完整代码', async () => {
        const targetUri = vscode.Uri.file(path.resolve('workspace/project/src/target.ts'));
        executeCommandMock.mockResolvedValue([
            location(targetUri, 9, 11)
        ]);
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));

        const result = await createGotoDefinitionTool().handler(
            { path: 'src/source.ts', line: 3, column: 5, symbol: 'myFunc' },
            {} as any
        );

        expect(result.success).toBe(true);
        expect(executeCommandMock).toHaveBeenCalledWith(
            'vscode.executeDefinitionProvider',
            expect.anything(),
            expect.any(Object) // vscode.Position 的 mock 构造结果
        );
        expect(result.data).toMatchObject({
            path: 'src/source.ts',
            line: 3,
            column: 5,
            symbol: 'myFunc',
            definitionCount: 1
        });
        expect(result.data.definitions[0]).toMatchObject({
            path: 'src/target.ts',
            line: 10,     // 1-based
            endLine: 12,  // 1-based
            lineCount: 3
        });
        expect(result.data.definitions[0].content).toContain('line 9 content');
        expect(result.data.definitions[0].content).toContain('line 11 content');
        // 打开文档两次：一次激活语言服务（guard），一次读取定义代码
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
    });

    test('TypeScript 语言服务首次未就绪时短暂等待后重试', async () => {
        jest.useFakeTimers();
        const targetUri = vscode.Uri.file(path.resolve('workspace/project/src/target.ts'));
        executeCommandMock
            .mockRejectedValueOnce(new Error('TypeScript language service is not ready'))
            .mockResolvedValueOnce([location(targetUri, 9, 11)]);
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));

        const resultPromise = createGotoDefinitionTool().handler(
            { path: 'src/source.ts', line: 3 },
            {} as any
        );
        await jest.advanceTimersByTimeAsync(LSP_RETRY_DELAY_MS);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(executeCommandMock).toHaveBeenCalledTimes(2);
    });

    test('provider 挂起时在 LSP_TIMEOUT_MS 后返回失败而不是无限等待', async () => {
        jest.useFakeTimers();
        executeCommandMock.mockImplementation(() => new Promise(() => undefined));

        const resultPromise = createGotoDefinitionTool().handler(
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

        const result = await createGotoDefinitionTool().handler(
            { path: 'src/source.ts', line: 3 },
            { abortSignal: controller.signal } as any
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('aborted');
        expect(executeCommandMock).not.toHaveBeenCalled();
        expect(openTextDocumentMock).not.toHaveBeenCalled();
    });
});
