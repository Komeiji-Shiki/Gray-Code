/**
 * goto_definition 平台入口、定义分页与语言服务超时、中止保护测试。
 */

import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLanguageToolFixture } from '../__fixtures__/languageToolFixture';

const fixture = createLanguageToolFixture('goto_definition');
const executeCommandMock = fixture.provider;
const openTextDocumentMock = fixture.openDocument;
const createGotoDefinitionTool = fixture.createTool;

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

describe('goto_definition 平台工具与语言服务', () => {
    beforeEach(() => {
        jest.useRealTimers();
        fixture.reset();
    });

    afterEach(() => {
        fixture.restore();
        jest.useRealTimers();
    });

    test('分页保持提供器顺序，只读取当前页，越界页不会反复续查', async () => {
        const first = pathToFileURL(path.resolve('workspace/project/z.ts')).href;
        const second = pathToFileURL(path.resolve('workspace/project/a.ts')).href;
        executeCommandMock.mockResolvedValue([location(first, 0, 2), location(second, 4, 6)]);
        openTextDocumentMock.mockResolvedValue(makeDoc(LINES));
        const tool = createGotoDefinitionTool();
        const page = await tool.handler({ path: 'source.ts', line: 1, maxResults: 1 }, {} as any);
        expect(page.data).toMatchObject({ definitionCount: 1, totalCount: 2, nextOffset: 1, truncated: true });
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
        expect(openTextDocumentMock).toHaveBeenLastCalledWith(fileURLToPath(first));
        const tail = await tool.handler({ path: 'source.ts', line: 1, offset: 1 }, {} as any);
        expect(tail.data).toMatchObject({ definitionCount: 1, totalCount: 2, truncated: false });
        expect(openTextDocumentMock).toHaveBeenLastCalledWith(fileURLToPath(second));
        const beyond = await tool.handler({ path: 'source.ts', line: 1, offset: 9 }, {} as any);
        expect(beyond.data).toMatchObject({ definitionCount: 0, totalCount: 2, truncated: false });
        expect(beyond.data.nextOffset).toBeUndefined();
    });

    test('超长定义最多输出60000字符，保留源码范围和明确的补读说明', async () => {
        const uri = pathToFileURL(path.resolve('workspace/project/long.ts')).href;
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
        const targetUri = pathToFileURL(path.resolve('workspace/project/src/target.ts')).href;
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
            'textDocument/definition',
            expect.objectContaining({ position: { line: 2, character: 4 } }),
            expect.any(Object)
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
        // 平台读取源文本以同步语言服务，再读取当前页中的定义代码。
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
    });

    test('provider 挂起时由平台语言服务在30秒后返回失败', async () => {
        jest.useFakeTimers();
        executeCommandMock.mockImplementation(() => new Promise(() => undefined));

        const resultPromise = createGotoDefinitionTool().handler(
            { path: 'src/source.ts', line: 3 },
            {} as any
        );
        await jest.advanceTimersByTimeAsync(30_000);
        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('语言服务请求超时：textDocument/definition');
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
