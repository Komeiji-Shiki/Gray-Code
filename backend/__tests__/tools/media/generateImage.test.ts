/**
 * generate_image 工具测试
 *
 * 覆盖：
 * - 单张模式参数缺失的错误路径会先注销 TaskManager 任务（不再残留永久 running 任务）
 * - isCancelled 判定：'fetch failed' 网络错误不再被误判为用户取消；
 *   AbortError 仍被正确识别为用户取消
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

    test('AbortError 仍被识别为用户取消', async () => {
        mockCreateProxyFetch.mockReturnValue(async () => {
            const err: any = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        });
        const tool = createGenerateImageTool();
        const result = await tool.handler(
            { prompt: 'a cat', output_path: 'C:/out/cat.png' },
            { config: { apiKey: 'test-key' }, toolId: 't-abort' } as any
        );
        expect(result.cancelled).toBe(true);
        expect((result.error || '')).toContain('User cancelled');
        expect(TaskManager.getTask('t-abort')).toBeUndefined();
    });
});
