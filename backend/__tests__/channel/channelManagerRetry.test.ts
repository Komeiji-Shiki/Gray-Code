/**
 * ChannelManager 重试链路回归测试
 *
 * 验证「超时/网络错误 → 自动重试」的真实行为：
 * - 重试真的会重新发送 HTTP 请求（fetch 调用次数 = 尝试次数）
 * - retrying / retrySuccess / retryFailed 事件序列正确
 * - 请求级 retryStatusCallback（SubAgent → Monitor 路由）会被调用，
 *   即使 suppressRetryNotification = true（只抑制全局回调）
 * - 全部重试失败后抛出错误且不重复回调
 */

import { ChannelManager } from '../../modules/channel/ChannelManager';
import type { GenerateRequest, StreamChunk } from '../../modules/channel/types';
import type { OpenAIConfig } from '../../modules/config/configs/openai';
import type { ConfigManager } from '../../modules/config/ConfigManager';

// ============ 测试夹具 ============

function makeConfig(overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    return {
        id: 'test-openai',
        name: 'Test OpenAI',
        type: 'openai',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        url: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        timeout: 60000,
        preferStream: true,
        retryEnabled: true,
        retryCount: 2,
        retryInterval: 10,
        options: {},
        systemInstruction: '',
        ...overrides
    } as OpenAIConfig;
}

function makeConfigManager(config: OpenAIConfig): ConfigManager {
    return {
        getConfig: jest.fn().mockResolvedValue(config)
    } as unknown as ConfigManager;
}

function makeRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
    return {
        configId: 'test-openai',
        history: [],
        skipTools: true,
        ...overrides
    } as GenerateRequest;
}

/** 构造一个 OpenAI SSE 流式响应（内容 + usage + [DONE]） */
function sseResponse(events: string[]): Response {
    const encoder = new TextEncoder();
    const body = events.map(e => `data: ${e}\n\n`).join('');
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        }
    }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
    });
}

const CONTENT_CHUNK = '{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}';
const USAGE_CHUNK = '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';

function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
    return (async () => {
        const out: StreamChunk[] = [];
        for await (const chunk of stream) {
            out.push(chunk);
        }
        return out;
    })();
}

// ============ 测试 ============

describe('ChannelManager 重试链路', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('网络错误后重试会重新发送请求，并依次发出 retrying → retrySuccess', async () => {
        let fetchCount = 0;
        global.fetch = jest.fn(async () => {
            fetchCount++;
            if (fetchCount === 1) {
                throw new TypeError('fetch failed');  // 首次请求网络失败
            }
            return sseResponse([CONTENT_CHUNK, USAGE_CHUNK, '[DONE]']);
        }) as unknown as typeof fetch;

        const manager = new ChannelManager(makeConfigManager(makeConfig()));
        const statuses: Array<{ type: string; attempt?: number; maxAttempts?: number }> = [];
        const request = makeRequest({
            retryStatusCallback: (status) => {
                statuses.push(status);
            }
        });

        const result = await manager.generate(request);
        const chunks = await collect(result as AsyncGenerator<StreamChunk>);

        // 1. 请求被重新发送：fetch 调用次数 = 尝试次数（2）
        expect(fetchCount).toBe(2);
        // 2. 事件序列：retrying(第1次尝试失败) → retrySuccess(第2次成功)
        expect(statuses.map(s => s.type)).toEqual(['retrying', 'retrySuccess']);
        expect(statuses[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
        expect(statuses[1]).toMatchObject({ attempt: 1, maxAttempts: 2 });
        // 3. 重试成功后内容完整产出
        const text = chunks.map(c => (c.delta[0] as any)?.text).filter(Boolean).join('');
        expect(text).toBe('hi');
        expect(chunks[chunks.length - 1]?.done).toBe(true);
    });

    it('suppressRetryNotification 只抑制全局回调，请求级回调仍收到事件（SubAgent → Monitor 路由）', async () => {
        let fetchCount = 0;
        global.fetch = jest.fn(async () => {
            fetchCount++;
            if (fetchCount === 1) {
                throw new TypeError('fetch failed');
            }
            return sseResponse([CONTENT_CHUNK, USAGE_CHUNK, '[DONE]']);
        }) as unknown as typeof fetch;

        const globalCallback = jest.fn();
        const manager = new ChannelManager(makeConfigManager(makeConfig()));
        manager.setRetryStatusCallback(globalCallback);

        const requestCallback = jest.fn();
        const request = makeRequest({
            suppressRetryNotification: true,
            retryStatusCallback: requestCallback
        });

        const result = await manager.generate(request);
        await collect(result as AsyncGenerator<StreamChunk>);

        expect(fetchCount).toBe(2);
        // 请求级回调收到事件（Monitor 展示重试状态）
        expect(requestCallback).toHaveBeenCalledTimes(2);
        expect(requestCallback.mock.calls.map((c: any[]) => c[0].type)).toEqual(['retrying', 'retrySuccess']);
        // 全局回调被 suppressRetryNotification 抑制（主窗口不被污染）
        expect(globalCallback).not.toHaveBeenCalled();
    });

    it('全部重试失败后发出 retryFailed，不再重复回调，并抛出错误', async () => {
        global.fetch = jest.fn(async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;

        const manager = new ChannelManager(makeConfigManager(makeConfig()));
        const statuses: Array<{ type: string; attempt?: number }> = [];
        const request = makeRequest({
            retryStatusCallback: (status) => statuses.push(status)
        });

        const result = await manager.generate(request);
        await expect(collect(result as AsyncGenerator<StreamChunk>)).rejects.toThrow();

        // 尝试次数 = retryCount(2) + 1
        expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
        // 事件序列：retrying(尝试1失败) → retrying(尝试2失败) → retryFailed
        expect(statuses.map(s => s.type)).toEqual(['retrying', 'retrying', 'retryFailed']);
        expect(statuses[0]).toMatchObject({ attempt: 1 });
        expect(statuses[1]).toMatchObject({ attempt: 2 });
        expect(statuses[2]).toMatchObject({ attempt: 2 });
    });

    it('skipRetry 时不重试，仅发送一次请求并直接抛错', async () => {
        global.fetch = jest.fn(async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch;

        const manager = new ChannelManager(makeConfigManager(makeConfig()));
        const requestCallback = jest.fn();
        const request = makeRequest({
            skipRetry: true,
            retryStatusCallback: requestCallback
        });

        const result = await manager.generate(request);
        await expect(collect(result as AsyncGenerator<StreamChunk>)).rejects.toThrow();

        expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
        expect(requestCallback).not.toHaveBeenCalled();
    });
});
