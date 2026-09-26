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

    test('打开大型文件激活语言服务并转换层级 DocumentSymbol', async () => {
        executeCommandMock.mockResolvedValue([
            documentSymbol('ChatFlowService', vscode.SymbolKind.Class, 100, 2300, [
                documentSymbol('handleChatStream', vscode.SymbolKind.Method, 1100, 1250)
            ])
        ]);

        const result = await createGetSymbolsTool().handler({
            paths: ['backend/modules/api/chat/ChatFlowService.ts'],
            maxDepth: 2
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

    test('默认只返回顶层，海量嵌套符号明确折叠而不是预算截断', async () => {
        executeCommandMock.mockResolvedValue([
            documentSymbol('Root', vscode.SymbolKind.Class, 1, 900, Array.from({ length: 700 }, (_, index) =>
                documentSymbol(`member${index}`, vscode.SymbolKind.Property, index + 2, index + 2)))
        ]);
        const result = await createGetSymbolsTool().handler({ paths: ['src/main.ts'] }, {} as any);
        expect(result.data).toMatchObject({ maxDepth: 1, totalSymbolCount: 1, truncated: false });
        expect(result.data.results[0]).toMatchObject({ symbolCount: 1, availableSymbolCount: 701,
            collapsedSymbolCount: 700, filteredSymbolCount: 0, truncated: false });
        expect(result.data.results[0].symbols).toEqual([expect.objectContaining({ name: 'Root', kind: 'class',
            line: 1, column: 1, depth: 1, childCount: 700, childrenCollapsed: true })]);
        expect(result.data.results[0].symbols[0].children).toBeUndefined();
    });

    test('显式展开按行列排序，kinds 不剪断未匹配父节点下的匹配项，也不隐式增加深度', async () => {
        const early = documentSymbol('zEarlier', vscode.SymbolKind.Method, 5, 9, [
            documentSymbol('local', vscode.SymbolKind.Variable, 6, 6)
        ]);
        const late = documentSymbol('aLater', vscode.SymbolKind.Method, 15, 18);
        executeCommandMock.mockResolvedValue([
            documentSymbol('aLast', vscode.SymbolKind.Function, 40, 45),
            documentSymbol('zFirst', vscode.SymbolKind.Class, 1, 30, [late, early])
        ]);
        const tool = createGetSymbolsTool();
        const expanded = await tool.handler({ paths: ['src/main.ts'], maxDepth: 2 }, {} as any);
        expect(expanded.data.results[0].symbols.map((symbol: any) => symbol.name)).toEqual(['zFirst', 'aLast']);
        expect(expanded.data.results[0].symbols[0].children.map((symbol: any) => symbol.name)).toEqual(['zEarlier', 'aLater']);
        expect(expanded.data.results[0]).toMatchObject({ symbolCount: 4, availableSymbolCount: 5, collapsedSymbolCount: 1, truncated: false });
        const filtered = await tool.handler({ paths: ['src/main.ts'], maxDepth: 2, kinds: ['method'] }, {} as any);
        expect(filtered.data.results[0]).toMatchObject({ symbolCount: 2, collapsedSymbolCount: 1, filteredSymbolCount: 2, truncated: false });
        expect(filtered.data.results[0].symbols.map((symbol: any) => [symbol.name, symbol.depth])).toEqual([['zEarlier', 2], ['aLater', 2]]);
        const folded = await tool.handler({ paths: ['src/main.ts'], kinds: ['method'] }, {} as any);
        expect(folded.data.results[0]).toMatchObject({ symbols: [], collapsedSymbolCount: 3, filteredSymbolCount: 2, truncated: false });
        const allKinds = await tool.handler({ paths: ['src/main.ts'], maxDepth: 3, kinds: [] }, {} as any);
        expect(allKinds.data.results[0]).toMatchObject({ symbolCount: 5, collapsedSymbolCount: 0, filteredSymbolCount: 0 });
    });

    test('平面 SymbolInformation 按源顺序保留；范围包含和容器名不能作为折叠依据', async () => {
        const flat = (name: string, start: number, end: number, column = 0, uri = 'file:///main.ts') => ({
            name, kind: vscode.SymbolKind.Function, containerName: 'notARealParent',
            location: { uri, range: { start: { line: start, character: column }, end: { line: end, character: column + 1 } } }
        });
        executeCommandMock.mockResolvedValue([
            flat('aLast', 30, 31), flat('aChild', 5, 6), flat('zRoot', 0, 20),
            flat('otherUri', 2, 3, 0, 'file:///other.ts'), flat('sameRange1', 40, 41), flat('sameRange2', 40, 41)
        ]);
        const tool = createGetSymbolsTool();
        const folded = await tool.handler({ paths: ['src/main.ts'] }, {} as any);
        expect(folded.data.results[0]).toMatchObject({ symbolCount: 6, availableSymbolCount: 6, collapsedSymbolCount: 0, hierarchyAvailable: false, truncated: false });
        expect(folded.data.results[0].symbols.map((symbol: any) => symbol.name)).toEqual(['zRoot', 'otherUri', 'aChild', 'aLast', 'sameRange1', 'sameRange2']);
        const expanded = await tool.handler({ paths: ['src/main.ts'], maxDepth: 2 }, {} as any);
        expect(expanded.data.results[0].symbols).toEqual(folded.data.results[0].symbols);
        expect(expanded.data.results[0].symbols.every((symbol: any) => symbol.depth === 1 && !symbol.children)).toBe(true);
        const filtered = await tool.handler({ paths: ['src/main.ts'], kinds: ['class'] }, {} as any);
        expect(filtered.data.results[0]).toMatchObject({ symbols: [], hierarchyAvailable: false, filteredSymbolCount: 6, truncated: false });
        executeCommandMock.mockResolvedValue([flat('aLaterColumn', 1, 1, 12), flat('zEarlierColumn', 1, 1, 3)]);
        const columns = await tool.handler({ paths: ['src/main.ts'] }, {} as any);
        expect(columns.data.results[0].symbols.map((symbol: any) => [symbol.name, symbol.column])).toEqual([['zEarlierColumn', 4], ['aLaterColumn', 13]]);
    });

    test.each([
        { count: 500, flat: false }, { count: 501, flat: false },
        { count: 500, flat: true }, { count: 501, flat: true }
    ])('只有实际超过500个可返回符号才截断：%j', async ({ count, flat }) => {
        executeCommandMock.mockResolvedValue(Array.from({ length: count }, (_, index) => {
            const symbol = documentSymbol(`symbol${index}`, vscode.SymbolKind.Variable, index + 1, index + 1);
            return flat ? { name: symbol.name, kind: symbol.kind, location: { range: symbol.range } } : symbol;
        }).reverse());
        const result = await createGetSymbolsTool().handler({ paths: ['src/main.ts'], maxDepth: 1000 }, {} as any);
        expect(result.data).toMatchObject({ totalSymbolCount: 500, truncated: count > 500 });
        expect(result.data.results[0]).toMatchObject({ symbolCount: 500, availableSymbolCount: count,
            collapsedSymbolCount: 0, truncated: count > 500 });
        expect(result.data.results[0].symbols[0].name).toBe('symbol0');
        expect(result.data.results[0].symbols[499].name).toBe('symbol499');
    });

    test('嵌套展开共享500预算，极深层级不递归溢出', async () => {
        let symbol = documentSymbol('leaf', vscode.SymbolKind.Variable, 6000, 6000);
        for (let depth = 5999; depth >= 1; depth--) symbol = documentSymbol(`node${depth}`, vscode.SymbolKind.Function, depth, 6000, [symbol]);
        executeCommandMock.mockResolvedValue([symbol]);
        const result = await createGetSymbolsTool().handler({ paths: ['src/main.ts'], maxDepth: 6000 }, {} as any);
        expect(result.data.results[0]).toMatchObject({ symbolCount: 500, availableSymbolCount: 6000, collapsedSymbolCount: 0, truncated: true });
    });

    test('多文件成功、空结果和失败混合仍按输入顺序聚合', async () => {
        openTextDocumentMock.mockImplementation(async (uri: vscode.Uri) => {
            if (uri.fsPath.endsWith('broken.ts')) throw new Error('cannot open file');
            return {};
        });
        executeCommandMock.mockImplementation(async (_command: string, uri: vscode.Uri) => uri.fsPath.endsWith('empty.ts') ? null : [
            documentSymbol('Root', vscode.SymbolKind.Class, 1, 3, [documentSymbol('hidden', vscode.SymbolKind.Property, 2, 2)])
        ]);
        const result = await createGetSymbolsTool().handler({ paths: ['src/main.ts', 'src/broken.ts', 'src/empty.ts'] }, {} as any);
        expect(result.success).toBe(false);
        expect(result.data).toMatchObject({ successCount: 2, failCount: 1, totalCount: 3, totalSymbolCount: 1, truncated: false });
        expect(result.data.results.map((file: any) => file.path)).toEqual(['src/main.ts', 'src/broken.ts', 'src/empty.ts']);
        expect(result.data.results[2]).toMatchObject({ symbols: [], availableSymbolCount: 0, collapsedSymbolCount: 0, truncated: false });
        expect(result.error).toContain('src/broken.ts: cannot open file');
    });

    test('文件预算保持20，折叠不会掩盖文件预算截断', async () => {
        executeCommandMock.mockResolvedValue([documentSymbol('Root', vscode.SymbolKind.Class, 1, 3)]);
        const result = await createGetSymbolsTool().handler({ paths: Array.from({ length: 21 }, (_, index) => `src/file${index}.ts`) }, {} as any);
        expect(result.data).toMatchObject({ successCount: 20, totalCount: 21, totalSymbolCount: 20, truncated: true });
        expect(result.data.results).toHaveLength(20);
        expect(executeCommandMock).toHaveBeenCalledTimes(20);
    });

    test.each([{ maxDepth: 0 }, { maxDepth: 1.5 }, { maxDepth: '2' }, { kinds: 'class' }, { kinds: ['not_a_kind'] }])('无效提纲参数在调用提供器前返回错误：%j', async options => {
        const result = await createGetSymbolsTool().handler({ paths: ['src/main.ts'], ...options }, {} as any);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/maxDepth|kinds/);
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    test('TypeScript 语言服务首次未就绪时短暂等待后重试', async () => {
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

    test('provider 挂起时按时返回具体失败原因，而不是无限等待', async () => {
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

    test('持续失败时顶层错误包含文件级 tsserver 原因', async () => {
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
