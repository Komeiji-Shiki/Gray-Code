/**
 * 空响应 / 流截断 自动重试测试。
 *
 * 覆盖：
 * - 非流式：HTTP 200 但模型返回空内容 → EMPTY_RESPONSE_ERROR → 自动重试（重试耗尽后上抛）
 * - 非流式：正常内容不重试
 * - 流式：从未产出内容且未收到 done → EMPTY_RESPONSE_ERROR → 自动重试
 * - 流式：已产出内容但未收到 done（静默截断）→ API_ERROR(streamTruncated)，不重试（显式报错）
 * - 流式：正常完成（有 finish_reason）不受影响
 */

import { ChannelManager } from '../../modules/channel/ChannelManager';
import { createProxyFetch, proxyStreamFetch } from '../../modules/channel/proxyFetch';
import { ChannelError, ErrorType } from '../../modules/channel/types';
import type { GenerateRequest } from '../../modules/channel/types';

// mock 代理 fetch 模块：ChannelManager 只用 createProxyFetch / proxyStreamFetch 两个导出
jest.mock('../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn(() => jest.fn()),
    proxyStreamFetch: jest.fn()
}));

const mockCreateProxyFetch = createProxyFetch as jest.Mock;
const mockProxyStreamFetch = proxyStreamFetch as jest.Mock;

function createManager(): ChannelManager {
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
        getEffectiveProxyUrl: jest.fn().mockReturnValue('http://127.0.0.1:7890')
    };
    return new ChannelManager(configManager as any, undefined, settingsManager as any);
}

const REQUEST: GenerateRequest = {
    configId: 'test-config',
    history: [{ role: 'user', parts: [{ text: 'hi' }] }],
    dynamicSystemPrompt: 'sys'
} as GenerateRequest;

/** 流式 SSE 行 */
const sse = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

beforeEach(() => {
    mockCreateProxyFetch.mockReset();
    mockProxyStreamFetch.mockReset();
});

describe('非流式空响应自动重试', () => {
    it('HTTP 200 但内容为空：重试 totalAttempts 次后抛 EMPTY_RESPONSE_ERROR', async () => {
        const fetchMock = jest.fn(async () => ({
            status: 200,
            json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
            headers: new Map()
        }));
        mockCreateProxyFetch.mockReturnValue(fetchMock);

        const manager = createManager();
        await expect(manager.generate(REQUEST)).rejects.toMatchObject({
            type: ErrorType.EMPTY_RESPONSE_ERROR
        });
        // 1 次原始 + 2 次重试
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('内容正常：不重试，直接成功', async () => {
        const fetchMock = jest.fn(async () => ({
            status: 200,
            json: async () => ({ choices: [{ message: { content: '你好！' }, finish_reason: 'stop' }] }),
            headers: new Map()
        }));
        mockCreateProxyFetch.mockReturnValue(fetchMock);

        const manager = createManager();
        const response = await manager.generate(REQUEST) as any;
        expect(response.content.parts[0].text).toBe('你好！');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('流式空响应自动重试', () => {
    it('从未产出内容且未收到 done：重试后抛 EMPTY_RESPONSE_ERROR', async () => {
        // 只有空 delta、无 finish_reason/usage 的 chunk（上游抽风返回空流）
        mockProxyStreamFetch.mockImplementation(async function* () {
            yield sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: null }] });
            // 流静默结束，无 [DONE]
        });

        const manager = createManager();
        const gen = manager.generateStream(REQUEST);
        const chunks: unknown[] = [];
        await expect(async () => {
            for await (const c of gen) chunks.push(c);
        }).rejects.toMatchObject({
            type: ErrorType.EMPTY_RESPONSE_ERROR
        });
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(3);
    });

    it('已产出内容但未收到 done（静默截断）：抛 streamTruncated 且不重试', async () => {
        mockProxyStreamFetch.mockImplementation(async function* () {
            yield sse({ id: '1', choices: [{ index: 0, delta: { content: '半截内容' }, finish_reason: null }] });
            // 连接被掐断：无 finish_reason、无 [DONE]
        });

        const manager = createManager();
        const gen = manager.generateStream(REQUEST);
        const chunks: unknown[] = [];
        await expect(async () => {
            for await (const c of gen) chunks.push(c);
        }).rejects.toMatchObject({
            type: ErrorType.API_ERROR
        });
        // 已产出内容：不重试
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
        // 错误消息是截断文案
        try {
            for await (const c of manager.generateStream(REQUEST)) { /* 重新消费以拿错误 */ }
        } catch (error: any) {
            expect(String(error.message)).toContain('截断');
        }
    });

    it('正常完成（有 finish_reason）：不受影响', async () => {
        mockProxyStreamFetch.mockImplementation(async function* () {
            yield sse({ id: '1', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] });
            yield sse({ id: '2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        });

        const manager = createManager();
        const gen = manager.generateStream(REQUEST);
        const texts: string[] = [];
        for await (const chunk of gen as AsyncGenerator<any>) {
            for (const part of chunk.delta ?? []) {
                if (part.text) texts.push(part.text);
            }
        }
        expect(texts.join('')).toBe('你好');
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
    });
});
