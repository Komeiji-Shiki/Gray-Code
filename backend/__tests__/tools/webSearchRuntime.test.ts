import { executeWebSearch, type WebSearchRuntimeConfig } from '../../tools/web/searchRuntime';

const config: WebSearchRuntimeConfig = {
    endpoint: 'https://api.deepseek.com/v1/tools/search',
    apiKey: 'sk-test',
    count: 5,
    needContent: false
};

interface FetchCall {
    url: string;
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

const signal = () => new AbortController().signal;

describe('executeWebSearch', () => {
    it('未配置 API Key 时直接返回配置错误', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({}));
        const outcome = await executeWebSearch({ query: 'DeepSeek' }, { ...config, apiKey: '' }, signal(), fetchImpl);
        expect(outcome).toMatchObject({ success: false, code: 'WEB_SEARCH_NOT_CONFIGURED' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('按调用参数构造请求并映射结果字段', async () => {
        const calls: FetchCall[] = [];
        const fetchImpl = jest.fn(async (url: string, init: FetchCall['init']) => {
            calls.push({ url, init });
            return jsonResponse({
                results: [{
                    title: 'DeepSeek V4',
                    url: 'https://example.com/v4',
                    snippet: '短摘要',
                    summary: '长摘要',
                    content: '正文',
                    site_name: 'Example',
                    date: '2026-06-01T00:00:00+00:00',
                    authority: 3,
                    rerank_score: 2.4
                }]
            });
        });

        const outcome = await executeWebSearch({
            query: 'DeepSeek V4',
            count: 2,
            needContent: true,
            oriQuestion: 'DeepSeek 发布了什么'
        }, config, signal(), fetchImpl);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(config.endpoint);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers?.authorization).toBe('Bearer sk-test');
        expect(JSON.parse(calls[0].init.body ?? '')).toEqual({
            query: 'DeepSeek V4',
            count: 2,
            need_content: true,
            ori_question: 'DeepSeek 发布了什么'
        });

        expect(outcome).toMatchObject({
            success: true,
            data: {
                query: 'DeepSeek V4',
                resultCount: 1,
                needContent: true,
                results: [{
                    title: 'DeepSeek V4',
                    url: 'https://example.com/v4',
                    snippet: '短摘要',
                    summary: '长摘要',
                    content: '正文',
                    siteName: 'Example',
                    date: '2026-06-01T00:00:00+00:00',
                    authority: 3,
                    rerankScore: 2.4
                }]
            }
        });
    });

    it('省略参数时使用设置默认值，并把 count 限制在接口范围内', async () => {
        const calls: FetchCall[] = [];
        const fetchImpl = jest.fn(async (url: string, init: FetchCall['init']) => {
            calls.push({ url, init });
            return jsonResponse({ results: [] });
        });

        await executeWebSearch({ query: 'test', count: 999 }, { ...config, count: 7, needContent: true }, signal(), fetchImpl);

        expect(JSON.parse(calls[0].init.body ?? '')).toMatchObject({ count: 50, need_content: true });
    });

    it('正文超过单条上限时截断并标记', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({
            results: [{ title: 'Long', url: 'https://example.com/long', content: 'x'.repeat(20_001) }]
        }));

        const outcome = await executeWebSearch({ query: 'long', needContent: true }, config, signal(), fetchImpl);

        expect(outcome.success).toBe(true);
        if (!outcome.success) return;
        expect(outcome.data.contentTruncated).toBe(true);
        expect(outcome.data.results[0].content).toHaveLength(20_000);
    });

    it('429 在等待后重试一次', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }))
            .mockResolvedValueOnce(jsonResponse({ results: [{ title: 'ok', url: 'https://example.com/ok' }] }));

        const outcome = await executeWebSearch({ query: 'retry' }, config, signal(), fetchImpl);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(outcome.success).toBe(true);
    });

    it('401 映射为可读的凭据错误', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ error: { message: 'invalid api key' } }, 401));

        const outcome = await executeWebSearch({ query: 'auth' }, config, signal(), fetchImpl);

        expect(outcome).toMatchObject({ success: false, code: 'WEB_SEARCH_FAILED', status: 401 });
        if (outcome.success) throw new Error('expected failure');
        expect(outcome.error).toContain('API Key 无效');
        expect(outcome.error).toContain('invalid api key');
    });

    it('取消信号会中止等待中的请求', async () => {
        const controller = new AbortController();
        const fetchImpl = jest.fn((_url: string, init: FetchCall['init']) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));

        const pending = executeWebSearch({ query: 'cancel' }, config, controller.signal, fetchImpl);
        controller.abort();

        await expect(pending).rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('200 但响应不是 JSON 时返回解析失败，而不是零结果', async () => {
        const fetchImpl = jest.fn(async () => new Response('<html>gateway</html>', {
            status: 200, headers: { 'content-type': 'text/html' }
        }));

        const outcome = await executeWebSearch({ query: 'bad payload' }, config, signal(), fetchImpl);

        expect(outcome).toMatchObject({ success: false, code: 'WEB_SEARCH_FAILED' });
        if (outcome.success) throw new Error('expected failure');
        expect(outcome.error).toContain('无法解析');
    });

    it('Retry-After 超过重试上限时直接失败，不再重试', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '60' }));

        const outcome = await executeWebSearch({ query: 'rate' }, config, signal(), fetchImpl);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ success: false, status: 429 });
    });

    it('413 映射为请求体过大', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ error: { message: 'body too large' } }, 413));

        const outcome = await executeWebSearch({ query: 'large' }, config, signal(), fetchImpl);

        expect(outcome).toMatchObject({ success: false, code: 'WEB_SEARCH_FAILED', status: 413 });
        if (outcome.success) throw new Error('expected failure');
        expect(outcome.error).toContain('请求体过大');
    });
});
