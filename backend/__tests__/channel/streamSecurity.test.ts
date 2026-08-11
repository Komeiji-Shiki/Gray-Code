/**
 * 流式请求安全加固测试（SEC 批次）。
 *
 * 覆盖：
 * - 流式请求配置验证：无效 API Key / URL / 模型配置在发起网络请求前被拦截（VALIDATION_ERROR）
 * - 纯文本错误体不丢失：text() 优先读取，上游真实错误正文进入错误信息（不再 body used already）
 * - 流式缓冲上限：上游持续发送无法解析的数据 → 超限终止（PARSE_ERROR），不无限累积
 * - 多模态流内容判定：inlineData/fileData 不被误判为空响应（不触发整流重播/重复计费）
 */

import { ChannelManager } from '../../modules/channel';
import { createProxyFetch, proxyStreamFetch } from '../../modules/channel/proxyFetch';
import { ChannelError, ErrorType } from '../../modules/channel';
import type { GenerateRequest } from '../../modules/channel';

// mock 代理 fetch 模块：ChannelManager 只用 createProxyFetch / proxyStreamFetch 两个导出；
// extractUpstreamErrorMessage 保留真实实现（纯函数，错误正文提取语义需与生产一致）
jest.mock('../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn(() => jest.fn()),
    proxyStreamFetch: jest.fn(),
    extractUpstreamErrorMessage: jest.requireActual('../../modules/channel/proxyFetch').extractUpstreamErrorMessage
}));

const mockCreateProxyFetch = createProxyFetch as jest.Mock;
const mockProxyStreamFetch = proxyStreamFetch as jest.Mock;

function createManager(configOverrides: Record<string, unknown> = {}): ChannelManager {
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
            retryInterval: 10,
            ...configOverrides
        })
    };
    const settingsManager = {
        getEffectiveProxyUrl: jest.fn().mockReturnValue('http://127.0.0.1:7890')
    };
    return new ChannelManager(configManager as any, undefined, settingsManager as any);
}

function createGeminiManager(): ChannelManager {
    const configManager = {
        getConfig: jest.fn().mockResolvedValue({
            id: 'gemini-config',
            name: 'Gemini',
            type: 'gemini',
            enabled: true,
            model: 'gemini-2.5-pro',
            url: 'https://generativelanguage.googleapis.com/v1beta',
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

/** 消费整个流并返回第一个错误（流正常结束则抛错） */
async function collectError(gen: AsyncGenerator<unknown>): Promise<ChannelError> {
    try {
        for await (const _chunk of gen) { /* consume */ }
    } catch (error) {
        return error as ChannelError;
    }
    throw new Error('expected stream to fail, but it completed normally');
}

beforeEach(() => {
    mockCreateProxyFetch.mockReset();
    mockProxyStreamFetch.mockReset();
});

describe('流式请求配置验证（SEC）', () => {
    test('无效配置（缺 url/model）：发起网络请求前抛 VALIDATION_ERROR', async () => {
        const manager = createManager({ model: undefined, url: undefined, apiKey: undefined });

        const error = await collectError(manager.generateStream(REQUEST) as AsyncGenerator<any>);
        expect(error.type).toBe(ErrorType.VALIDATION_ERROR);
        // 未发起任何网络请求（代理流、原生 fetch 都不应被调用）
        expect(mockProxyStreamFetch).not.toHaveBeenCalled();
        expect(mockCreateProxyFetch).not.toHaveBeenCalled();
    });

    test('无效配置不触发重试（VALIDATION_ERROR 不可重试，立即失败）', async () => {
        const manager = createManager({ model: undefined });
        const error = await collectError(manager.generateStream(REQUEST) as AsyncGenerator<any>);
        expect(error.type).toBe(ErrorType.VALIDATION_ERROR);
        expect(mockProxyStreamFetch).not.toHaveBeenCalled();
    });
});

describe('纯文本错误体不丢失（SEC）', () => {
    test('原生 fetch 分支：网关 502 纯文本错误正文进入错误信息', async () => {
        // 无代理 → 走原生 fetch 分支（getEffectiveProxyUrl 返回 undefined）
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
                toolMode: 'function_call',
                retryEnabled: true,
                retryCount: 0,
                retryInterval: 10
            })
        };
        const settingsManager = {
            getEffectiveProxyUrl: jest.fn().mockReturnValue(undefined)
        };
        const manager = new ChannelManager(configManager as any, undefined, settingsManager as any);

        // json() 必然失败（纯文本错误体）；修复前 text() 会抛 body used already，正文丢失
        // 原生 fetch 分支直接调用全局 fetch（不经 createProxyFetch），spy 全局 fetch
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 502,
            headers: new Map(),
            text: async () => 'Bad Gateway: upstream exploded mid-flight',
            json: async () => { throw new Error('invalid json body'); }
        } as any);

        const error = await collectError(manager.generateStream(REQUEST) as AsyncGenerator<any>);
        expect(error.type).toBe(ErrorType.API_ERROR);
        expect(String(error.message)).toContain('upstream exploded');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        fetchSpy.mockRestore();
    });
});

describe('流式缓冲上限（SEC）', () => {
    test('上游持续发送无法解析的数据：超限终止（PARSE_ERROR），缓冲不再无限累积', async () => {
        // 非 SSE/JSON 垃圾数据：parseStreamBuffer 整段保留为 remaining → 缓冲逐轮增长
        const garbage = 'x'.repeat(8 * 1024 * 1024);
        mockProxyStreamFetch.mockImplementation(async function* () {
            for (let i = 0; i < 9; i++) yield garbage; // 72MB > 64MB 上限
        });

        const manager = createManager();
        const error = await collectError(manager.generateStream(REQUEST) as AsyncGenerator<any>);
        expect(error.type).toBe(ErrorType.PARSE_ERROR);
    });

    test('合法巨型单事件（低于上限，跨多块到达）：不被上限误杀', async () => {
        // 模拟一个 40MB 的巨型 SSE data 事件（多模态 base64 附件），分块到达；
        // 事件完成前解析「无进展」，但 40MB < 64MB 上限，不允许被误杀
        const bigEvent = `data: ${JSON.stringify({
            id: '1',
            choices: [{ index: 0, delta: { content: 'a'.repeat(40 * 1024 * 1024) }, finish_reason: null }]
        })}\n\n`;
        const chunkSize = 8 * 1024 * 1024;
        mockProxyStreamFetch.mockImplementation(async function* () {
            for (let offset = 0; offset < bigEvent.length; offset += chunkSize) {
                yield bigEvent.slice(offset, offset + chunkSize);
            }
            yield sse({ id: 'done', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        });

        const manager = createManager();
        const gen = manager.generateStream(REQUEST) as AsyncGenerator<any>;
        let totalText = 0;
        for await (const chunk of gen) {
            for (const part of chunk.delta ?? []) {
                if (part.text) totalText += part.text.length;
            }
        }
        expect(totalText).toBe(40 * 1024 * 1024);
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
    });

    test('正常 SSE 流不受缓冲上限影响', async () => {
        mockProxyStreamFetch.mockImplementation(async function* () {
            for (let i = 0; i < 50; i++) {
                yield sse({ id: String(i), choices: [{ index: 0, delta: { content: '数据' }, finish_reason: null }] });
            }
            yield sse({ id: 'done', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        });

        const manager = createManager();
        const gen = manager.generateStream(REQUEST) as AsyncGenerator<any>;
        let texts = '';
        for await (const chunk of gen) {
            for (const part of chunk.delta ?? []) {
                if (part.text) texts += part.text;
            }
        }
        expect(texts).toBe('数据'.repeat(50));
    });
});

describe('多模态流内容判定（SEC）', () => {
    test('只有 inlineData/fileData 的流被截断：判定为有内容（API_ERROR 截断），不误判空响应、不重试', async () => {
        mockProxyStreamFetch.mockImplementation(async function* () {
            yield sse({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }, finishReason: null }] });
            yield sse({ candidates: [{ content: { role: 'model', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/x.pdf' } }] }, finishReason: null }] });
            // 连接中断：无 finishReason / [DONE]
        });

        const manager = createGeminiManager();
        const error = await collectError(manager.generateStream(REQUEST) as AsyncGenerator<any>);
        // 修复前：多模态部分被忽略 → EMPTY_RESPONSE_ERROR → 整流重播（重复计费）
        expect(error.type).toBe(ErrorType.API_ERROR);
        // 已产出内容：不重试
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
    });

    test('多模态流正常完成（有 finishReason）：不受影响', async () => {
        mockProxyStreamFetch.mockImplementation(async function* () {
            yield sse({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }, finishReason: null }] });
            yield sse({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] });
        });

        const manager = createGeminiManager();
        const gen = manager.generateStream(REQUEST) as AsyncGenerator<any>;
        let hasInlineData = false;
        for await (const chunk of gen) {
            for (const part of chunk.delta ?? []) {
                if (part.inlineData) hasInlineData = true;
            }
        }
        expect(hasInlineData).toBe(true);
        expect(mockProxyStreamFetch).toHaveBeenCalledTimes(1);
    });
});
