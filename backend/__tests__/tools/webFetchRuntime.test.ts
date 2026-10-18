import { executeWebFetch, type WebFetchRuntimeConfig } from '../../tools/web/fetchRuntime';

const config: WebFetchRuntimeConfig = {
    endpoint: 'https://api.deepseek.com/v1/tools/fetch',
    apiKey: 'sk-test'
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

describe('executeWebFetch', () => {
    it('未配置 API Key 时直接返回配置错误', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({}));
        const outcome = await executeWebFetch({ url: 'https://example.com' }, { ...config, apiKey: '' }, signal(), fetchImpl);
        expect(outcome).toMatchObject({ success: false, code: 'WEB_FETCH_NOT_CONFIGURED' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('构造抓取请求并映射标题与正文', async () => {
        const calls: FetchCall[] = [];
        const fetchImpl = jest.fn(async (url: string, init: FetchCall['init']) => {
            calls.push({ url, init });
            return jsonResponse({ title: 'Example article', content: '# Example\n\nBody.' });
        });

        const outcome = await executeWebFetch({ url: 'https://example.com/article' }, config, signal(), fetchImpl);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(config.endpoint);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers?.authorization).toBe('Bearer sk-test');
        expect(JSON.parse(calls[0].init.body ?? '')).toEqual({ url: 'https://example.com/article' });
        expect(outcome).toMatchObject({
            success: true,
            data: {
                url: 'https://example.com/article',
                title: 'Example article',
                content: '# Example\n\nBody.',
                contentLength: 16,
                truncated: false
            }
        });
    });

    it('正文超过 maxChars 时截断并保留原始长度', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ title: 'Long', content: 'x'.repeat(2_500) }));

        const outcome = await executeWebFetch({ url: 'https://example.com/long', maxChars: 1_000 }, config, signal(), fetchImpl);

        expect(outcome.success).toBe(true);
        if (!outcome.success) return;
        expect(outcome.data.content).toHaveLength(1_000);
        expect(outcome.data.contentLength).toBe(2_500);
        expect(outcome.data.truncated).toBe(true);
    });

    it('拒绝非 HTTP/HTTPS 地址与带凭据的地址', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ content: 'x' }));

        for (const url of ['ftp://example.com/file', 'https://user:pass@example.com/page', 'not a url', '']) {
            const outcome = await executeWebFetch({ url }, config, signal(), fetchImpl);
            expect(outcome).toMatchObject({ success: false, code: 'WEB_FETCH_FAILED' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('404 映射为页面不可用的可读错误', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ error: { message: 'content unavailable' } }, 404));

        const outcome = await executeWebFetch({ url: 'https://example.com/missing' }, config, signal(), fetchImpl);

        expect(outcome).toMatchObject({ success: false, code: 'WEB_FETCH_FAILED', status: 404 });
        if (outcome.success) throw new Error('expected failure');
        expect(outcome.error).toContain('无法取得页面内容');
        expect(outcome.error).toContain('content unavailable');
    });

    it('响应没有正文时返回明确错误', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ title: 'Empty', content: '' }));

        const outcome = await executeWebFetch({ url: 'https://example.com/empty' }, config, signal(), fetchImpl);

        expect(outcome).toMatchObject({ success: false, code: 'WEB_FETCH_FAILED' });
        if (outcome.success) throw new Error('expected failure');
        expect(outcome.error).toContain('没有可提取的正文');
    });

    it('取消信号会中止等待中的请求', async () => {
        const controller = new AbortController();
        const fetchImpl = jest.fn((_url: string, init: FetchCall['init']) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));

        const pending = executeWebFetch({ url: 'https://example.com' }, config, controller.signal, fetchImpl);
        controller.abort();

        await expect(pending).rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
