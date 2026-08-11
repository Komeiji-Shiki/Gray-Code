/**
 * generate_image 工具测试
 *
 * 覆盖：
 * - 单张模式参数缺失的错误路径会先注销 TaskManager 任务（不再残留永久 running 任务）
 * - isCancelled 判定：'fetch failed' 网络错误不再被误判为用户取消；
 *   只有用户 abortSignal 实际中止时 AbortError 才识别为用户取消，
 *   未中止的 AbortError（createFetchSignal 请求超时签名）报为任务错误
 */
import * as vscode from 'vscode';
import { createGenerateImageTool } from '../../../tools/media/generate_image';
import { TaskManager } from '../../../tools/taskManager';
import { createProxyFetch } from '../../../modules/channel/proxyFetch';

jest.mock('../../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn()
}));

const mockCreateProxyFetch = createProxyFetch as jest.Mock;

beforeEach(() => {
    mockCreateProxyFetch.mockReset();
    (vscode.workspace as any).workspaceFolders = [];
});

describe('generate_image 单张模式参数缺失', () => {
    test('返回错误的同时注销任务，不残留 running 任务', async () => {
        const tool = createGenerateImageTool();
        const result = await tool.handler(
            {},
            { config: { apiKey: 'test-key' }, toolId: 't-missing-args' } as any
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('Please use one of the following');
        expect(TaskManager.getTask('t-missing-args')).toBeUndefined();
    });

    test('配置校验失败路径（无 API Key）同样注销任务', async () => {
        const tool = createGenerateImageTool();
        const result = await tool.handler(
            { prompt: 'cat', output_path: 'C:/out/cat.png' },
            { toolId: 't-no-apikey' } as any
        );
        expect(result.success).toBe(false);
        expect((result.error || '')).toContain('API Key');
        expect(TaskManager.getTask('t-no-apikey')).toBeUndefined();
    });
});

describe('generate_image isCancelled 判定', () => {
    test("'fetch failed' 网络错误不再被误判为用户取消", async () => {
        mockCreateProxyFetch.mockReturnValue(async () => {
            throw new Error('fetch failed');
        });
        const tool = createGenerateImageTool();
        const result = await tool.handler(
            { prompt: 'a cat', output_path: 'C:/out/cat.png' },
            { config: { apiKey: 'test-key' }, toolId: 't-fetch-fail' } as any
        );
        expect(result.success).toBe(false);
        expect(result.cancelled).toBeFalsy();
        expect((result.error || '')).toContain('fetch failed');
        expect((result.error || '')).not.toContain('User cancelled');
        expect(TaskManager.getTask('t-fetch-fail')).toBeUndefined();
    });

    test('AbortError 且 abortSignal 未中止（请求超时签名）不再被误判为用户取消', async () => {
        mockCreateProxyFetch.mockReturnValue(async () => {
            const err: any = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        });
        const tool = createGenerateImageTool();
        const result = await tool.handler(
            { prompt: 'a cat', output_path: 'C:/out/cat.png' },
            { config: { apiKey: 'test-key' }, toolId: 't-timeout' } as any
        );
        // 超时保护（createFetchSignal 的 timeout abort）同样以 AbortError 拒绝，
        // 但此时用户 abortSignal 并未中止：应报为任务错误而非"用户取消"
        expect(result.cancelled).toBeFalsy();
        expect((result.error || '')).toContain('The operation was aborted');
        expect((result.error || '')).not.toContain('User cancelled');
        expect(TaskManager.getTask('t-timeout')).toBeUndefined();
    });

    test('用户中止信号后抛出的 AbortError 仍被识别为用户取消', async () => {
        const controller = new AbortController();
        // 模拟 fetch 挂起直到注入的 signal 中止（用户取消），随后以 AbortError 拒绝
        mockCreateProxyFetch.mockReturnValue(async (_url: string, init: any) => {
            await new Promise<void>((_resolve, reject) => {
                const signal = init.signal as AbortSignal | undefined;
                if (signal?.aborted) {
                    const err: any = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                    return;
                }
                signal?.addEventListener('abort', () => {
                    const err: any = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            });
        });
        const tool = createGenerateImageTool();
        const handlerPromise = tool.handler(
            { prompt: 'a cat', output_path: 'C:/out/cat.png' },
            { config: { apiKey: 'test-key' }, toolId: 't-abort', abortSignal: controller.signal } as any
        );
        // 等待 fetch 进入挂起状态后模拟用户取消
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        const result = await handlerPromise;
        expect(result.cancelled).toBe(true);
        expect((result.error || '')).toContain('User cancelled');
        expect(TaskManager.getTask('t-abort')).toBeUndefined();
    });
});
