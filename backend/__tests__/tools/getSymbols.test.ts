import * as path from 'path';
import * as vscode from 'vscode';
import {
    createGetSymbolsTool,
    GET_SYMBOLS_RETRY_DELAY_MS,
    GET_SYMBOLS_TIMEOUT_MS
} from '../../tools/lsp/get_symbols';

const executeCommandMock = vscode.commands.executeCommand as jest.Mock;
const openTextDocumentMock = vscode.workspace.openTextDocument as jest.Mock;

function documentSymbol(
    name: string,
    kind: number,
    startLine: number,
    endLine: number,
    children: unknown[] = []
) {
    return {
        name,
        detail: '',
        kind,
        range: {
            start: { line: startLine - 1, character: 0 },
            end: { line: endLine - 1, character: 0 }
        },
        selectionRange: {
            start: { line: startLine - 1, character: 0 },
            end: { line: startLine - 1, character: 1 }
        },
        children
    };
}

describe('get_symbols LSP lifecycle', () => {
    beforeEach(() => {
        jest.useRealTimers();
        executeCommandMock.mockReset();
        openTextDocumentMock.mockReset().mockResolvedValue({});
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(path.resolve('workspace/project'))
        }];
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('打开大型文件激活语言服务并转换层级 DocumentSymbol', async () => {
        executeCommandMock.mockResolvedValue([
            documentSymbol('ChatFlowService', vscode.SymbolKind.Class, 100, 2300, [
                documentSymbol('handleChatStream', vscode.SymbolKind.Method, 1100, 1250)
            ])
        ]);

        const result = await createGetSymbolsTool().handler({
            paths: ['backend/modules/api/chat/ChatFlowService.ts']
        }, {} as any);

        expect(result.success).toBe(true);
        expect(openTextDocumentMock).toHaveBeenCalledTimes(1);
        expect(executeCommandMock).toHaveBeenCalledWith(
            'vscode.executeDocumentSymbolProvider',
            expect.anything()
        );
        expect(result.data.totalSymbolCount).toBe(2);
        expect(result.data.results[0].symbols[0]).toMatchObject({
            name: 'ChatFlowService',
            kind: 'class',
            line: 100,
            endLine: 2300,
            children: [{ name: 'handleChatStream', kind: 'method', line: 1100 }]
        });
    });

    it('TypeScript 语言服务首次未就绪时短暂等待后重试', async () => {
        jest.useFakeTimers();
        executeCommandMock
            .mockRejectedValueOnce(new Error('TypeScript language service is not ready'))
            .mockResolvedValueOnce([documentSymbol('ready', vscode.SymbolKind.Function, 1, 3)]);

        const resultPromise = createGetSymbolsTool().handler({ paths: ['src/ready.ts'] }, {} as any);
        await jest.advanceTimersByTimeAsync(GET_SYMBOLS_RETRY_DELAY_MS);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(executeCommandMock).toHaveBeenCalledTimes(2);
    });

    it('provider 挂起时按时返回具体失败原因，而不是无限等待', async () => {
        jest.useFakeTimers();
        executeCommandMock.mockImplementation(() => new Promise(() => undefined));

        const resultPromise = createGetSymbolsTool().handler({
            paths: ['backend/modules/api/chat/ChatFlowService.ts']
        }, {} as any);
        await jest.advanceTimersByTimeAsync(GET_SYMBOLS_TIMEOUT_MS);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('ChatFlowService.ts');
        expect(result.error).toContain(`timed out after ${GET_SYMBOLS_TIMEOUT_MS}ms`);
        expect(executeCommandMock).toHaveBeenCalledTimes(1);
    });

    it('持续失败时顶层错误包含文件级 tsserver 原因', async () => {
        jest.useFakeTimers();
        executeCommandMock.mockRejectedValue(new Error('tsserver crashed'));

        const resultPromise = createGetSymbolsTool().handler({ paths: ['src/broken.ts'] }, {} as any);
        await jest.advanceTimersByTimeAsync(GET_SYMBOLS_RETRY_DELAY_MS);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('src/broken.ts: tsserver crashed');
        expect(result.data.failCount).toBe(1);
    });
});
