/**
 * TokenCountService smoke 测试（模块化重构回归网）
 *
 * 覆盖点：
 * - countTokens 基本路径：渠道未启用 / 缺 apiKey 的错误分支
 * - countTokensWithChannelConfig：local 估算公式、channel_default 路由、未知 method、
 *   openai_custom 网络路径（URL/Authorization 头/代理 URL 透传）、HTTP 错误、
 *   缺字段错误、fetch 抛错包装
 * - countTokens 全局配置路径（OpenAI 渠道，请求体 model 正确）
 * - countTokensBatch 顺序结果
 * - URL 构建器：buildAnthropicCountUrl / buildOpenAIResponsesCountUrl 的兼容输入
 *
 * 网络隔离：jest.mock proxyFetch 的 createProxyFetch，所有 HTTP 均由内联 mock 响应，
 * 不发起真实网络请求（CI 安全）。
 */

import { TokenCountService } from '../../modules/channel/TokenCountService';
import type { Content } from '../../modules/conversation/types';

jest.mock('../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn()
}));

import { createProxyFetch } from '../../modules/channel/proxyFetch';

const createProxyFetchMock = jest.mocked(createProxyFetch);

function makeResponse(body: any, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
}

/** 让 createProxyFetch 返回固定的 fetch mock，并返回该 fetch 供断言 */
function mockFetchReturning(body: any, ok = true, status = 200): jest.Mock {
    const fetch = jest.fn(async () => makeResponse(body, ok, status));
    createProxyFetchMock.mockReturnValue(fetch as any);
    return fetch;
}

function makeContent(text: string, role: 'user' | 'model' = 'user'): Content {
    return { role, parts: [{ text }] };
}

describe('TokenCountService smoke', () => {
    let service: TokenCountService;

    beforeAll(() => {
        // 服务内部用 AbortSignal.timeout(30s) 作请求超时，mock 掉以免遗留 30s 定时器拖住 worker 退出
        jest.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal as any);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        service = new TokenCountService('http://proxy:1');
    });

    it('countTokens：渠道未启用返回错误', async () => {
        const result = await service.countTokens('gemini', {}, [makeContent('hi')]);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Token count not enabled for gemini');
    });

    it('countTokens：启用但缺 apiKey 返回错误', async () => {
        const config = { openai: { enabled: true, baseUrl: 'https://x', model: 'm', apiKey: '' } };
        const result = await service.countTokens('openai', config as any, [makeContent('hi')]);
        expect(result.success).toBe(false);
        expect(result.error).toContain('API key not configured for openai');
    });

    it('countTokensWithChannelConfig：local 估算（约 4 字符 1 token × 1.5 安全系数）', async () => {
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai', tokenCountMethod: 'local' } as any,
            [makeContent('12345678')] // 8 字符 → ceil(8/4)=2 → ceil(2*1.5)=3
        );
        expect(result.success).toBe(true);
        expect(result.totalTokens).toBe(3);
        expect(createProxyFetchMock).not.toHaveBeenCalled();
    });

    it('countTokensWithChannelConfig：channel_default + openai 路由到 local（不发起请求）', async () => {
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai' } as any,
            [makeContent('hi')]
        );
        expect(result.success).toBe(true);
        expect(result.totalTokens).toBe(2); // ceil(ceil(2/4)*1.5) = 2
        expect(createProxyFetchMock).not.toHaveBeenCalled();
    });

    it('countTokensWithChannelConfig：未知 method 返回错误', async () => {
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai', tokenCountMethod: 'nope' } as any,
            [makeContent('hi')]
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown token count method: nope');
    });

    it('openai_custom：成功路径（URL、Authorization 头、代理 URL 透传）', async () => {
        const fetch = mockFetchReturning({ total_tokens: 42 });
        const result = await service.countTokensWithChannelConfig(
            {
                type: 'openai',
                apiKey: 'sk-test',
                model: 'gpt-5',
                tokenCountMethod: 'openai_custom',
                tokenCountApiConfig: { url: 'http://custom/count' }
            } as any,
            [makeContent('hello')]
        );

        expect(result.success).toBe(true);
        expect(result.totalTokens).toBe(42);
        expect(createProxyFetchMock).toHaveBeenCalledWith('http://proxy:1'); // 构造器传入的代理 URL
        expect(fetch).toHaveBeenCalledWith(
            'http://custom/count',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer sk-test' })
            })
        );
    });

    it('openai_custom：HTTP 非 2xx 返回服务端错误体', async () => {
        mockFetchReturning('rate limited', false, 429);
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai', apiKey: 'sk-test', tokenCountMethod: 'openai_custom', tokenCountApiConfig: { url: 'http://custom' } } as any,
            [makeContent('hi')]
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('OpenAI compatible API error: rate limited');
    });

    it('openai_custom：响应缺 total_tokens 字段报错', async () => {
        mockFetchReturning({});
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai', apiKey: 'sk-test', tokenCountMethod: 'openai_custom', tokenCountApiConfig: { url: 'http://custom' } } as any,
            [makeContent('hi')]
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('Response missing total_tokens field');
    });

    it('fetch 抛错时包装为失败结果而非抛出', async () => {
        createProxyFetchMock.mockReturnValue((async () => {
            throw new Error('network down');
        }) as any);
        const result = await service.countTokensWithChannelConfig(
            { type: 'openai', apiKey: 'sk-test', tokenCountMethod: 'openai_custom', tokenCountApiConfig: { url: 'http://custom' } } as any,
            [makeContent('hi')]
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('network down');
    });

    it('countTokens 全局配置路径：OpenAI 渠道请求体携带 model', async () => {
        const fetch = mockFetchReturning({ total_tokens: 5 });
        const config = {
            openai: { enabled: true, apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5' }
        };
        const result = await service.countTokens('openai', config as any, [makeContent('hi')]);

        expect(result.success).toBe(true);
        expect(result.totalTokens).toBe(5);
        expect(fetch).toHaveBeenCalledWith(
            'https://api.openai.com/v1/chat/completions',
            expect.objectContaining({
                body: expect.stringContaining('"model":"gpt-5"')
            })
        );
    });

    it('countTokensBatch：并行结果与输入顺序一致（全部失败时按序返回）', async () => {
        const results = await service.countTokensBatch('gemini', {}, [
            [makeContent('a')],
            [makeContent('b')]
        ]);
        expect(results).toHaveLength(2);
        expect(results.every(r => r.success === false)).toBe(true);
        expect(results[0].error).toContain('gemini');
        expect(results[1].error).toContain('gemini');
    });

    it('buildAnthropicCountUrl：默认 URL、尾斜杠、/complete 剥离、/v1/models 规整', () => {
        const build = (service as any).buildAnthropicCountUrl.bind(service);
        expect(build(undefined)).toBe('https://api.anthropic.com/v1/messages/count_tokens');
        expect(build('https://api.anthropic.com/v1/messages/count_tokens/')).toBe('https://api.anthropic.com/v1/messages/count_tokens');
        expect(build('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1/messages/count_tokens');
        expect(build('https://x/v1/complete')).toBe('https://x/v1/messages/count_tokens');
        expect(build('https://x/v1/models')).toBe('https://x/v1/messages/count_tokens');
        expect(build('https://x')).toBe('https://x/v1/messages/count_tokens');
    });

    it('buildOpenAIResponsesCountUrl：/v1、/responses、完整端点兼容', () => {
        const build = (service as any).buildOpenAIResponsesCountUrl.bind(service);
        expect(build('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses/input_tokens');
        expect(build('https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1/responses/input_tokens');
        expect(build('https://api.openai.com/v1/responses/input_tokens')).toBe('https://api.openai.com/v1/responses/input_tokens');
        expect(build('https://api.openai.com')).toBe('https://api.openai.com/v1/responses/input_tokens');
    });
});
