/**
 * 模型列表（modelList）模块单元测试。
 *
 * 覆盖：
 * 1. Gemini 基础 URL 规范化：trim / 去尾斜杠 / 保留并合并基础 query / 不产生 //models
 * 2. 请求认证：默认同时发 key query + x-goog-api-key 头（兼容行为保持不变）；
 *    useAuthorizationHeader 时发 Bearer；gemini-interactions 渠道同样支持 Bearer
 * 3. 缓存键一致性：使用真实 config.type 与规范化 URL（同义 URL 命中同一缓存；
 *    不同 type / 不同 apiKey 独立缓存）
 * 4. 非 2xx 错误：读取响应体 → extractUpstreamErrorMessage 提取上游说明 →
 *    ModelListRequestError；apiKey 明文 / URL query key 脱敏；超长消息截断
 * 5. 模型 name/id 健壮映射：models/ 前缀仅从开头去除；displayName 缺失回退 id
 *
 * 依赖：global.fetch 以 jest.fn 替换（createProxyFetch 无代理时直接使用原生 fetch）。
 */

import {
    getGeminiModels,
    getOpenAIModels,
    getClaudeModels,
    ModelListRequestError,
    normalizeGeminiModelsBaseUrl,
    sanitizeUpstreamMessage
} from '../../modules/channel/modelList';
import type { ChannelConfig } from '../../modules/config';
import { t } from '../../i18n';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function createConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
    return {
        id: 'test-config',
        name: 'Test',
        type: 'gemini',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        timeout: 120000,
        url: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-test-key',
        model: 'gemini-2.5-pro',
        ...overrides
    } as ChannelConfig;
}

function jsonResponse(body: unknown, status = 200, statusText = ''): Response {
    return new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { 'content-type': 'application/json' }
    });
}

let consoleErrorSpy: jest.SpyInstance;
beforeEach(() => {
    // 错误路径的 console.error 属预期输出，测试内静音
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// normalizeGeminiModelsBaseUrl
// ---------------------------------------------------------------------------
describe('normalizeGeminiModelsBaseUrl', () => {
    test('trim 首尾空白 + 去路径尾斜杠', () => {
        const result = normalizeGeminiModelsBaseUrl('  https://generativelanguage.googleapis.com/v1beta/  ');
        expect(result.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
        expect(result.baseQuery.toString()).toBe('');
    });

    test('根路径（无子路径）不产生尾斜杠', () => {
        expect(normalizeGeminiModelsBaseUrl('https://my-proxy.example.com').baseUrl)
            .toBe('https://my-proxy.example.com');
        expect(normalizeGeminiModelsBaseUrl('https://my-proxy.example.com/').baseUrl)
            .toBe('https://my-proxy.example.com');
    });

    test('基础 URL 自带 query 单独取出，不污染 baseUrl', () => {
        const result = normalizeGeminiModelsBaseUrl('https://my-proxy.example.com/v1beta?project=my-proj&api-version=1');
        expect(result.baseUrl).toBe('https://my-proxy.example.com/v1beta');
        expect(result.baseQuery.toString()).toBe('project=my-proj&api-version=1');
    });

    test('自定义端口保留', () => {
        expect(normalizeGeminiModelsBaseUrl('https://my-proxy.example.com:8443/v1beta').baseUrl)
            .toBe('https://my-proxy.example.com:8443/v1beta');
    });

    test('缺省 URL 使用官方默认端点', () => {
        expect(normalizeGeminiModelsBaseUrl(undefined).baseUrl)
            .toBe('https://generativelanguage.googleapis.com/v1beta');
    });

    test('非法 URL 直接报错，不把请求静默改发到官方端点', () => {
        expect(() => normalizeGeminiModelsBaseUrl('not a url')).toThrow(ModelListRequestError);
        expect(() => normalizeGeminiModelsBaseUrl('file:///tmp/models')).toThrow(ModelListRequestError);
    });
});

// ---------------------------------------------------------------------------
// sanitizeUpstreamMessage
// ---------------------------------------------------------------------------
describe('sanitizeUpstreamMessage', () => {
    test('替换 apiKey 明文（Bearer / x-api-key / x-goog-api-key 回显场景）', () => {
        expect(sanitizeUpstreamMessage('Invalid api key AIza-secret-123 in header x-goog-api-key', 'AIza-secret-123'))
            .toBe('Invalid api key *** in header x-goog-api-key');
    });

    test('替换 URL query 中的 key= 值（含编码形式）', () => {
        expect(sanitizeUpstreamMessage('Request to https://h/v1beta/models?key=abc123%2Bdef&pageSize=1000 failed', 'other-key'))
            .toBe('Request to https://h/v1beta/models?key=***&pageSize=1000 failed');
    });

    test('无 apiKey 时仅处理 URL query key', () => {
        expect(sanitizeUpstreamMessage('see https://h/m?key=abc123&x=1'))
            .toBe('see https://h/m?key=***&x=1');
    });

    test('截断超长消息（500 + 省略号）', () => {
        const long = 'A'.repeat(2000);
        const result = sanitizeUpstreamMessage(long, 'k');
        expect(result.length).toBeLessThan(long.length);
        expect(result.length).toBeLessThanOrEqual(501);
        expect(result.startsWith('A'.repeat(500))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getGeminiModels：请求 URL 与认证头
// ---------------------------------------------------------------------------
describe('getGeminiModels - URL 与认证', () => {
    test('默认同时发送 key query 与 x-goog-api-key（兼容行为），URL 规范无 //models', async () => {
        const originalFetch = global.fetch;
        let capturedInit: any;
        global.fetch = jest.fn(async (url: string, init?: any) => {
            capturedInit = init;
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] });
        }) as unknown as typeof fetch;
        try {
            const models = await getGeminiModels(createConfig({ apiKey: 'AIza-dual-auth-1' }));
            expect(models).toEqual([
                { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
            ]);
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=AIza-dual-auth-1');
            expect(capturedInit.headers['x-goog-api-key']).toBe('AIza-dual-auth-1');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('尾斜杠 URL 不产生 //models，query 不插入路径', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ apiKey: 'AIza-trailing-1', url: 'https://generativelanguage.googleapis.com/v1beta/' }));
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=AIza-trailing-1');
            expect(url).not.toContain('//models');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('基础 URL 自带 query 保留并合并进 /models 查询串', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ apiKey: 'AIza-base-query-1', url: 'https://my-proxy.example.com/v1beta?project=my-proj' }));
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toBe('https://my-proxy.example.com/v1beta/models?project=my-proj&pageSize=1000&key=AIza-base-query-1');
            // query 未被拼进路径段
            expect(url).not.toContain('?project=my-proj/models');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('useAuthorizationHeader=true：发 Bearer，不发 x-goog-api-key / key query', async () => {
        const originalFetch = global.fetch;
        let capturedInit: any;
        global.fetch = jest.fn(async (url: string, init?: any) => {
            capturedInit = init;
            return jsonResponse({ models: [] });
        }) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ apiKey: 'AIza-bearer-1', useAuthorizationHeader: true }));
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
            expect(capturedInit.headers['Authorization']).toBe('Bearer AIza-bearer-1');
            expect(capturedInit.headers['x-goog-api-key']).toBeUndefined();
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('gemini-interactions + useAuthorizationHeader=true：同样发 Bearer', async () => {
        const originalFetch = global.fetch;
        let capturedInit: any;
        global.fetch = jest.fn(async (url: string, init?: any) => {
            capturedInit = init;
            return jsonResponse({ models: [] });
        }) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ type: 'gemini-interactions', apiKey: 'AIza-int-bearer-1', useAuthorizationHeader: true }));
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
            expect(capturedInit.headers['Authorization']).toBe('Bearer AIza-int-bearer-1');
            expect(capturedInit.headers['x-goog-api-key']).toBeUndefined();
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('gemini-interactions 默认：key query + x-goog-api-key 双认证', async () => {
        const originalFetch = global.fetch;
        let capturedInit: any;
        global.fetch = jest.fn(async (url: string, init?: any) => {
            capturedInit = init;
            return jsonResponse({ models: [] });
        }) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ type: 'gemini-interactions', apiKey: 'AIza-int-dual-1' }));
            const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
            expect(url).toContain('key=AIza-int-dual-1');
            expect(capturedInit.headers['x-goog-api-key']).toBe('AIza-int-dual-1');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

// ---------------------------------------------------------------------------
// 缓存键一致性
// ---------------------------------------------------------------------------
describe('getGeminiModels - 缓存键一致性', () => {
    test('同义 URL（尾斜杠差异）命中同一缓存条目', async () => {
        const originalFetch = global.fetch;
        let callCount = 0;
        global.fetch = jest.fn(async () => {
            callCount += 1;
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] });
        }) as unknown as typeof fetch;
        try {
            const configA = createConfig({ apiKey: 'AIza-cache-same-1', url: 'https://generativelanguage.googleapis.com/v1beta' });
            const configB = createConfig({ apiKey: 'AIza-cache-same-1', url: 'https://generativelanguage.googleapis.com/v1beta/' });
            const modelsA = await getGeminiModels(configA);
            const modelsB = await getGeminiModels(configB);
            expect(modelsA).toEqual(modelsB);
            expect(callCount).toBe(1);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('不同 config.type（gemini / gemini-interactions）独立缓存', async () => {
        const originalFetch = global.fetch;
        let callCount = 0;
        global.fetch = jest.fn(async () => {
            callCount += 1;
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] });
        }) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ apiKey: 'AIza-cache-type-1' }));
            await getGeminiModels(createConfig({ type: 'gemini-interactions', apiKey: 'AIza-cache-type-1' }));
            expect(callCount).toBe(2);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('不同 apiKey 独立缓存', async () => {
        const originalFetch = global.fetch;
        let callCount = 0;
        global.fetch = jest.fn(async () => {
            callCount += 1;
            return jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] });
        }) as unknown as typeof fetch;
        try {
            await getGeminiModels(createConfig({ apiKey: 'AIza-cache-key-a' }));
            await getGeminiModels(createConfig({ apiKey: 'AIza-cache-key-b' }));
            expect(callCount).toBe(2);
        } finally {
            global.fetch = originalFetch;
        }
    });
});

// ---------------------------------------------------------------------------
// 非 2xx 错误：读取响应体 + 脱敏 + ModelListRequestError
// ---------------------------------------------------------------------------
describe('非 2xx 错误处理', () => {
    test('403 JSON 错误体：提取上游 message 并抛出 ModelListRequestError', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { code: 403, message: 'Your API key was reported as leaked. Please use another API key.' } },
            403,
            'Forbidden'
        )) as unknown as typeof fetch;
        try {
            const config = createConfig({ apiKey: 'AIza-leaked-1' });
            await expect(getGeminiModels(config)).rejects.toBeInstanceOf(ModelListRequestError);
            const error = await getGeminiModels(config).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 403: Your API key was reported as leaked. Please use another API key.');
            expect(error.status).toBe(403);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('上游消息中的 apiKey 明文被替换为 ***', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { message: 'Invalid api key AIza-leaked-2 in header x-goog-api-key' } },
            403
        )) as unknown as typeof fetch;
        try {
            const error = await getGeminiModels(createConfig({ apiKey: 'AIza-leaked-2' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 403: Invalid api key *** in header x-goog-api-key');
            expect(error.message).not.toContain('AIza-leaked-2');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('常见 query 凭据名及 URL 编码后的 apiKey 都会脱敏', () => {
        const key = 'secret/key+value';
        const encoded = encodeURIComponent(key);
        const result = sanitizeUpstreamMessage(
            `raw=${key} encoded=${encoded} https://h/m?api_key=one&access_token=two&signature=three`,
            key
        );
        expect(result).not.toContain(key);
        expect(result).not.toContain(encoded);
        expect(result).toContain('raw=***');
        expect(result).toContain('encoded=***');
        expect(result).toContain('api_key=***');
        expect(result).toContain('access_token=***');
        expect(result).toContain('signature=***');
    });

    test('上游消息中的 URL query key 值被替换为 ***', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { message: 'Request to https://host/v1beta/models?key=AIza-leaked-3&pageSize=1000 failed' } },
            400
        )) as unknown as typeof fetch;
        try {
            const error = await getGeminiModels(createConfig({ apiKey: 'AIza-leaked-3' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 400: Request to https://host/v1beta/models?key=***&pageSize=1000 failed');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('超长上游消息被截断', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { message: 'A'.repeat(2000) } },
            403
        )) as unknown as typeof fetch;
        try {
            const error = await getGeminiModels(createConfig({ apiKey: 'AIza-long-1' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message.startsWith('HTTP 403: ')).toBe(true);
            expect(error.message.length).toBeLessThanOrEqual(501);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('非 JSON 文本错误体：保留原文', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => new Response('Bad Gateway upstream exploded', {
            status: 502,
            statusText: 'Bad Gateway'
        })) as unknown as typeof fetch;
        try {
            const error = await getGeminiModels(createConfig({ apiKey: 'AIza-text-1' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 502: Bad Gateway upstream exploded');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('无法提取上游消息：退回 i18n 通用文案（statusText 兜底）', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse({}, 500, 'Internal Server Error')) as unknown as typeof fetch;
        try {
            const error = await getGeminiModels(createConfig({ apiKey: 'AIza-fallback-1' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe(
                t('modules.channel.modelList.errors.fetchModelsFailed', { error: 'Internal Server Error' })
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('OpenAI 非 2xx 同样读取响应体提取上游说明', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { message: 'Incorrect API key provided: sk-***' } },
            401
        )) as unknown as typeof fetch;
        try {
            const error = await getOpenAIModels(createConfig({ type: 'openai', apiKey: 'sk-openai-1' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 401: Incorrect API key provided: sk-***');
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('Anthropic 非 2xx 同样读取响应体提取上游说明', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse(
            { error: { message: 'Rate limit exceeded' } },
            429
        )) as unknown as typeof fetch;
        try {
            const error = await getClaudeModels(createConfig({ type: 'anthropic', apiKey: 'sk-ant-1' })).catch(e => e);
            expect(error).toBeInstanceOf(ModelListRequestError);
            expect(error.message).toBe('HTTP 429: Rate limit exceeded');
        } finally {
            global.fetch = originalFetch;
        }
    });
});

// ---------------------------------------------------------------------------
// 模型 name/id 健壮映射
// ---------------------------------------------------------------------------
describe('getGeminiModels - 模型映射', () => {
    test('models/ 前缀仅从开头去除；displayName 缺失回退 id；中部 models/ 保留', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse({
            models: [
                { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
                { name: 'models/gemini-2.5-flash' },
                { name: 'foo/models/bar', displayName: 'Weird' }
            ]
        })) as unknown as typeof fetch;
        try {
            const models = await getGeminiModels(createConfig({ apiKey: 'AIza-map-1' }));
            expect(models).toEqual([
                { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
                { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash' },
                { id: 'foo/models/bar', name: 'Weird' }
            ]);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('supportedGenerationMethods 过滤保留（缺失视为兼容）', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn(async () => jsonResponse({
            models: [
                { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/b', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/c' }
            ]
        })) as unknown as typeof fetch;
        try {
            const models = await getGeminiModels(createConfig({ apiKey: 'AIza-filter-1' }));
            expect(models.map(m => m.id)).toEqual(['a', 'c']);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
