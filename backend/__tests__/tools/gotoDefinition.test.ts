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

    test('分页保持提供器顺序，只读取当前页，越界页不会反复续查', async () => {
        const first = vscode.Uri.file(path.resolve('workspace/project/z.ts'));
        const second = vscode.Uri.file(path.resolve('workspace/project/a.ts'));
        executeCommandMock.mockResolvedValue([location(first, 0, 2), location(second, 4, 6)]);
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));
        const tool = createGotoDefinitionTool();
        const page = await tool.handler({ path: 'source.ts', line: 1, maxResults: 1 }, {} as any);
        expect(page.data).toMatchObject({ definitionCount: 1, totalCount: 2, nextOffset: 1, truncated: true });
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
        expect(openTextDocumentMock).toHaveBeenLastCalledWith(first);
        const tail = await tool.handler({ path: 'source.ts', line: 1, offset: 1 }, {} as any);
        expect(tail.data).toMatchObject({ definitionCount: 1, totalCount: 2, truncated: false });
        expect(openTextDocumentMock).toHaveBeenLastCalledWith(second);
        const beyond = await tool.handler({ path: 'source.ts', line: 1, offset: 9 }, {} as any);
        expect(beyond.data).toMatchObject({ definitionCount: 0, totalCount: 2, truncated: false });
        expect(beyond.data.nextOffset).toBeUndefined();
    });

    test('超长定义最多输出60000字符，保留源码范围和明确的补读说明', async () => {
        const uri = vscode.Uri.file(path.resolve('workspace/project/long.ts'));
        executeCommandMock.mockResolvedValue([location(uri, 0, 0)]);
        openTextDocumentMock.mockResolvedValue(makeDoc(['x'.repeat(70000)]));
        const result = await createGotoDefinitionTool().handler({ path: 'source.ts', line: 1 }, {} as any);
        expect(result.data).toMatchObject({ definitionCount: 1, totalCount: 1, truncated: true, truncationReasons: ['outputBudget'] });
        expect(result.data.definitions[0]).toMatchObject({ line: 1, endLine: 1, contentTruncated: true });
        expect(result.data.definitions[0].content).toHaveLength(60000);
        expect(result.data.continuationHint).toContain('read_file');
    });

    test.each([{ offset: -1 }, { offset: 1.5 }, { maxResults: 0 }, { maxResults: 501 }])('无效分页不调用语言服务：%j', async options => {
        expect((await createGotoDefinitionTool().handler({ path: 'source.ts', line: 1, ...options }, {} as any)).success).toBe(false);
        expect(executeCommandMock).not.toHaveBeenCalled();
        expect(openTextDocumentMock).not.toHaveBeenCalled();
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
