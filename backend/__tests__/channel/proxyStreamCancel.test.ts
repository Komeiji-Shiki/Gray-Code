/**
 * 代理模式下流式请求取消行为测试。
 *
 * 背景：
 * - 原生 fetch 分支：signal.aborted 时 reader.read() 抛 AbortError，
 *   executeStreamRequest 的 catch 转成 CANCELLED_ERROR 抛出。
 * - 代理分支：proxyStreamFetch 在 signal.aborted 时优雅结束（break/return）而非抛错，
 *   executeStreamRequest 的 for-await 循环结束后如果不检测 externalSignal.aborted，
 *   会把「用户取消」当成「正常结束」，generateStream 随即正常 return，
 *   调用方把半截内容当完整助手消息落盘。
 *
 * 本测试用 mock 的 proxyStreamFetch 复现「中止时优雅结束」的真实代理行为，
 * 验证修复后 executeStreamRequest / generateStream 在代理模式下取消时抛 CANCELLED_ERROR，
 * 且正常完成的流不受影响。
 */

import { ChannelManager } from '../../modules/channel';
import { proxyStreamFetch } from '../../modules/channel/proxyFetch';
import { ChannelError, ErrorType } from '../../modules/channel';
import type { GenerateRequest, StreamChunk } from '../../modules/channel';

// mock 代理 fetch 模块：ChannelManager 只用 createProxyFetch / proxyStreamFetch 两个导出
jest.mock('../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn(() => jest.fn()),
    proxyStreamFetch: jest.fn()
}));

const mockProxyStreamFetch = proxyStreamFetch as jest.Mock;

const PROXY_URL = 'http://127.0.0.1:7890';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 复现真实 proxyStreamFetch 的中止行为：
 * - 先按顺序产出若干 SSE 行；
 * - 之后进入等待循环，signal 中止时优雅 return（不抛错）。
 *
 * waitForAbort = false 时表示正常流：产完所有行后直接结束。
 */
function createGracefulProxyStream(
    lines: string[],
    options: { waitForAbort?: boolean } = {}
): (url: string, init: any, proxyUrl?: string) => AsyncGenerator<string> {
    return async function* (url: string, init: any, proxyUrl?: string) {
        for (const line of lines) {
            yield line;
        }
        if (options.waitForAbort !== false) {
            while (!init.signal?.aborted) {
                await sleep(5);
            }
        }
        // 优雅结束：不抛错（真实 proxyStreamFetch 在信号中止时的行为）
        return;
    };
}

function createManager(proxyUrl: string = PROXY_URL): ChannelManager {
    const configManager = {
        getConfig: jest.fn().mockResolvedValue({
            id: 'test-config',
            name: 'Test',
            type: 'openai',
            enabled: true,
            model: 'gpt-4o',
            url: 'https://api.example.com/v1',
            apiKey: 'sk-test',
            timeout: 1000,
            options: {},
            optionsEnabled: {},
            toolMode: 'function_call',
            retryEnabled: true,
            retryCount: 2,
            retryInterval: 10
        })
    };
    const settingsManager = {
        getEffectiveProxyUrl: jest.fn().mockReturnValue(proxyUrl)
    };
    return new ChannelManager(configManager as any, undefined, settingsManager as any);
}

const STREAM_OPTIONS = {
    url: 'https://api.example.com/v1/chat/completions',
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'gpt-4o', messages: [] },
    timeout: 60000
};

beforeEach(() => {
    mockProxyStreamFetch.mockReset();
});

describe('executeStreamRequest（代理模式）取消行为', () => {
    test('流中途 abort → 抛 CANCELLED_ERROR（不再被吞掉当成正常结束）', async () => {
        mockProxyStreamFetch.mockImplementation(createGracefulProxyStream([
            'data: {"id":"1"}\n\n',
            'data: {"id":"2'  // 半截事件：取消时残留在内部 buffer 的未完成内容
        ]));

        const manager = createManager();
        const controller = new AbortController();
        const stream = (manager as any).executeStreamRequest(
            STREAM_OPTIONS,
            controller.signal
        ) as AsyncGenerator<any>;

        const iterator = stream[Symbol.asyncIterator]();

        // 第一个完整事件正常产出
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({ id: '1' });

        // 第二个 next() 挂起：mock 在等待取消信号（半截事件已进入内部 buffer）
        const secondPromise = iterator.next();
        controller.abort();

        // 修复前：这里会正常 resolve，半截流被当成「正常结束」；
        // 修复后：与原生 fetch 分支一致，抛 CANCELLED_ERROR
        await expect(secondPromise).rejects.toMatchObject({
            name: 'ChannelError',
            type: ErrorType.CANCELLED_ERROR
        });

        // 确认走的是代理分支（第三个参数是 proxyUrl）
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyStreamFetch.mock.calls[0][2]).toBe(PROXY_URL);
    });

    test('正常完成：产出所有 chunk 并正常结束，不受影响', async () => {
        mockProxyStreamFetch.mockImplementation(createGracefulProxyStream([
            'data: {"id":"1"}\n\n',
            'data: {"id":"2"}\n\n'
        ], { waitForAbort: false }));

        const manager = createManager();
        const stream = (manager as any).executeStreamRequest(
            STREAM_OPTIONS,
            undefined
        ) as AsyncGenerator<any>;

        const chunks: any[] = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        expect(chunks).toEqual([{ id: '1' }, { id: '2' }]);
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyStreamFetch.mock.calls[0][2]).toBe(PROXY_URL);
    });

    test('超时（非用户取消）仍抛 TIMEOUT_ERROR', async () => {
        mockProxyStreamFetch.mockImplementation(createGracefulProxyStream([], { waitForAbort: true }));

        const manager = createManager();
        const stream = (manager as any).executeStreamRequest(
            { ...STREAM_OPTIONS, timeout: 50 },
            undefined
        ) as AsyncGenerator<any>;

        // 无外部取消信号 → 不被误判为 CANCELLED_ERROR，仍走 TIMEOUT_ERROR
        await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
            name: 'ChannelError',
            type: ErrorType.TIMEOUT_ERROR
        });
    });
});

describe('generateStream（代理模式）取消行为（端到端）', () => {
    // 真实 OpenAI SSE 的最后一个 chunk 带 finish_reason（否则视为流被截断）
    const openaiChunk = (content: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
    const openaiDone = () =>
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;

    test('流中途 abort → 生成器抛 CANCELLED_ERROR（不会把半截流当正常结束）', async () => {
        mockProxyStreamFetch.mockImplementation(createGracefulProxyStream([
            openaiChunk('Hello')
        ]));

        const manager = createManager();
        const controller = new AbortController();
        const request: GenerateRequest = {
            configId: 'test-config',
            history: [],
            skipTools: true,
            abortSignal: controller.signal
        };

        const gen = manager.generateStream(request);

        // 第一块正常产出
        const first = await gen.next();
        expect(first.done).toBe(false);
        expect((first.value as StreamChunk).delta).toEqual([{ text: 'Hello' }]);

        // 挂起等待下一块（mock 在等待取消）
        const secondPromise = gen.next();
        controller.abort();

        // 修复前：generateStream 会把流当成正常结束并 return，调用方把半截内容落盘；
        // 修复后：CANCELLED_ERROR 透传到调用方
        await expect(secondPromise).rejects.toMatchObject({
            name: 'ChannelError',
            type: ErrorType.CANCELLED_ERROR
        });
    });

    test('正常完成：生成器正常结束、所有 chunk 被解析产出', async () => {
        mockProxyStreamFetch.mockImplementation(createGracefulProxyStream([
            openaiChunk('Hello'),
            openaiChunk(' world'),
            openaiDone()
        ], { waitForAbort: false }));

        const manager = createManager();
        const request: GenerateRequest = {
            configId: 'test-config',
            history: [],
            skipTools: true
        };

        const gen = manager.generateStream(request);
        const texts: string[] = [];
        for await (const chunk of gen) {
            const text = (chunk as StreamChunk).delta.map(part => (part as any).text).join('');
            if (text) texts.push(text);
        }

        expect(texts).toEqual(['Hello', ' world']);
    });
});
