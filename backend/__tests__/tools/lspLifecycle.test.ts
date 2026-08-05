/**
 * LSP 生命周期保护共享模块单元测试。
 *
 * 覆盖：超时（挂起后 LSP_TIMEOUT_MS 拒绝、不重试）、中止（已中止立即拒绝 /
 * 挂起中中止）、瞬时 reject 重试一次、listener 与 timer 清理、openDocumentWithGuard。
 */

import * as vscode from 'vscode';
import {
    LSP_TIMEOUT_MS,
    LSP_RETRY_DELAY_MS,
    LSP_MAX_ATTEMPTS,
    LspRequestTimeoutError,
    LspRequestAbortedError,
    waitWithAbort,
    withTimeoutAndAbort,
    openDocumentWithGuard,
    executeLspCommandWithRetry
} from '../../tools/lsp/lspLifecycle';

const executeCommandMock = vscode.commands.executeCommand as jest.Mock;
const openTextDocumentMock = vscode.workspace.openTextDocument as jest.Mock;

/** 包装 signal 的 add/removeEventListener，记录并比对监听器的添加与移除 */
function trackSignalListeners(signal: AbortSignal) {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: never) => {
        added.push(listener);
        realAdd(type, listener);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: never) => {
        removed.push(listener);
        realRemove(type, listener);
    }) as typeof signal.removeEventListener;
    return { added, removed };
}

describe('lspLifecycle 共享模块', () => {
    beforeEach(() => {
        jest.useRealTimers();
        executeCommandMock.mockReset();
        openTextDocumentMock.mockReset().mockResolvedValue({});
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('withTimeoutAndAbort', () => {
        it('正常完成时 resolve 请求结果并清理 timer 与 listener', async () => {
            const controller = new AbortController();
            const { added, removed } = trackSignalListeners(controller.signal);

            await expect(
                withTimeoutAndAbort(Promise.resolve('value'), 1000, controller.signal)
            ).resolves.toBe('value');

            expect(added).toHaveLength(1);
            expect(removed).toEqual(added);
        });

        it('请求 reject 时透传原始错误并清理 timer 与 listener', async () => {
            const controller = new AbortController();
            const { added, removed } = trackSignalListeners(controller.signal);

            await expect(
                withTimeoutAndAbort(Promise.reject(new Error('boom')), 1000, controller.signal)
            ).rejects.toThrow('boom');

            expect(added).toHaveLength(1);
            expect(removed).toEqual(added);
        });

        it('请求挂起超过 timeoutMs 时以 LspRequestTimeoutError 拒绝且 timer 已清理', async () => {
            jest.useFakeTimers();
            const request = withTimeoutAndAbort(new Promise<string>(() => undefined), 5000);

            const assertion = expect(request).rejects.toBeInstanceOf(LspRequestTimeoutError);
            await jest.advanceTimersByTimeAsync(5000);
            await assertion;

            expect(jest.getTimerCount()).toBe(0);
        });

        it('超时错误文案包含 timed out after Nms', async () => {
            jest.useFakeTimers();
            const request = withTimeoutAndAbort(new Promise(() => undefined), 1234);

            const assertion = expect(request).rejects.toThrow('timed out after 1234ms');
            await jest.advanceTimersByTimeAsync(1234);
            await assertion;
        });

        it('已中止的 signal 立即以 LspRequestAbortedError 拒绝', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                withTimeoutAndAbort(Promise.resolve('value'), 1000, controller.signal)
            ).rejects.toBeInstanceOf(LspRequestAbortedError);
        });

        it('请求挂起期间中止时以 LspRequestAbortedError 拒绝并摘除 listener', async () => {
            jest.useFakeTimers();
            const controller = new AbortController();
            const { added, removed } = trackSignalListeners(controller.signal);

            const request = withTimeoutAndAbort(new Promise(() => undefined), 5000, controller.signal);
            const assertion = expect(request).rejects.toBeInstanceOf(LspRequestAbortedError);

            controller.abort();
            await assertion;

            expect(added).toHaveLength(1);
            expect(removed).toEqual(added);
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('waitWithAbort', () => {
        it('延时后 resolve 并清理 timer 与 listener', async () => {
            jest.useFakeTimers();
            const controller = new AbortController();
            const { added, removed } = trackSignalListeners(controller.signal);

            const waiting = waitWithAbort(300, controller.signal);
            await jest.advanceTimersByTimeAsync(300);
            await waiting;

            expect(added).toHaveLength(1);
            expect(removed).toEqual(added);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('已中止的 signal 立即拒绝', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(waitWithAbort(300, controller.signal))
                .rejects.toBeInstanceOf(LspRequestAbortedError);
        });

        it('等待期间中止时以 LspRequestAbortedError 拒绝并摘除 listener', async () => {
            jest.useFakeTimers();
            const controller = new AbortController();
            const { added, removed } = trackSignalListeners(controller.signal);

            const waiting = waitWithAbort(5000, controller.signal);
            const assertion = expect(waiting).rejects.toBeInstanceOf(LspRequestAbortedError);

            controller.abort();
            await assertion;

            expect(added).toHaveLength(1);
            expect(removed).toEqual(added);
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('executeLspCommandWithRetry', () => {
        it('瞬时 reject 时等待 LSP_RETRY_DELAY_MS 后重试一次并成功', async () => {
            jest.useFakeTimers();
            executeCommandMock
                .mockRejectedValueOnce(new Error('TypeScript language service is not ready'))
                .mockResolvedValueOnce(['symbol']);

            const request = executeLspCommandWithRetry('vscode.executeDocumentSymbolProvider', [{}]);
            await jest.advanceTimersByTimeAsync(LSP_RETRY_DELAY_MS);
            await expect(request).resolves.toEqual(['symbol']);

            expect(executeCommandMock).toHaveBeenCalledTimes(2);
        });

        it('持续 reject 时最多尝试 LSP_MAX_ATTEMPTS 次并抛出最后一次错误', async () => {
            jest.useFakeTimers();
            executeCommandMock.mockRejectedValue(new Error('tsserver crashed'));

            const request = executeLspCommandWithRetry('cmd', []);
            const assertion = expect(request).rejects.toThrow('tsserver crashed');
            await jest.advanceTimersByTimeAsync(LSP_RETRY_DELAY_MS);
            await assertion;

            expect(executeCommandMock).toHaveBeenCalledTimes(LSP_MAX_ATTEMPTS);
        });

        it('超时不重试：仅发起一次请求并以 LspRequestTimeoutError 拒绝', async () => {
            jest.useFakeTimers();
            executeCommandMock.mockImplementation(() => new Promise(() => undefined));

            const request = executeLspCommandWithRetry('cmd', []);
            const assertion = expect(request).rejects.toBeInstanceOf(LspRequestTimeoutError);
            await jest.advanceTimersByTimeAsync(LSP_TIMEOUT_MS);
            await assertion;

            expect(executeCommandMock).toHaveBeenCalledTimes(1);
        });

        it('挂起期间中止不重试：仅发起一次请求并以 LspRequestAbortedError 拒绝', async () => {
            jest.useFakeTimers();
            const controller = new AbortController();
            executeCommandMock.mockImplementation(() => new Promise(() => undefined));

            const request = executeLspCommandWithRetry('cmd', [], { abortSignal: controller.signal });
            const assertion = expect(request).rejects.toBeInstanceOf(LspRequestAbortedError);

            controller.abort();
            await assertion;

            expect(executeCommandMock).toHaveBeenCalledTimes(1);
        });

        it('已中止的 signal 直接拒绝且不发起任何请求', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                executeLspCommandWithRetry('cmd', [], { abortSignal: controller.signal })
            ).rejects.toBeInstanceOf(LspRequestAbortedError);

            expect(executeCommandMock).not.toHaveBeenCalled();
        });

        it('透传 command 与 args 给 executeCommand', async () => {
            executeCommandMock.mockResolvedValue('ok');
            await executeLspCommandWithRetry('vscode.executeDefinitionProvider', ['uri', 'pos']);

            expect(executeCommandMock).toHaveBeenCalledWith('vscode.executeDefinitionProvider', 'uri', 'pos');
        });

        it('支持自定义 timeoutMs / maxAttempts 选项', async () => {
            jest.useFakeTimers();
            executeCommandMock.mockImplementation(() => new Promise(() => undefined));

            const request = executeLspCommandWithRetry('cmd', [], { timeoutMs: 123, maxAttempts: 3 });
            const assertion = expect(request).rejects.toThrow('timed out after 123ms');
            await jest.advanceTimersByTimeAsync(123);
            await assertion;

            expect(executeCommandMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('openDocumentWithGuard', () => {
        it('openTextDocument 正常完成时 resolve', async () => {
            openTextDocumentMock.mockResolvedValue({});
            const uri = { fsPath: '/a.ts' } as any;

            await expect(openDocumentWithGuard(uri)).resolves.toBeUndefined();
            expect(openTextDocumentMock).toHaveBeenCalledWith(uri);
        });

        it('文档打开挂起时在 LSP_TIMEOUT_MS 后以超时拒绝', async () => {
            jest.useFakeTimers();
            openTextDocumentMock.mockImplementation(() => new Promise(() => undefined));

            const request = openDocumentWithGuard({ fsPath: '/a.ts' } as any);
            const assertion = expect(request).rejects.toBeInstanceOf(LspRequestTimeoutError);
            await jest.advanceTimersByTimeAsync(LSP_TIMEOUT_MS);
            await assertion;
        });

        it('已中止的 signal 立即拒绝且不打开文档', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                openDocumentWithGuard({ fsPath: '/a.ts' } as any, controller.signal)
            ).rejects.toBeInstanceOf(LspRequestAbortedError);

            expect(openTextDocumentMock).not.toHaveBeenCalled();
        });
    });
});
