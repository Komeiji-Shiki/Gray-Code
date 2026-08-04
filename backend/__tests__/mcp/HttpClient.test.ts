/**
 * HttpMcpClient 单测
 *
 * 覆盖：
 * - JSON 成功 / JSON-RPC 错误 / HTTP 错误
 * - SSE 只消费与请求 id 匹配的响应（id:null 通知不被当结果消费）
 * - SSE 多行 data: 按规范合并解析
 * - body 读取超时（AbortController 保持到 json() 完成）
 * - sendNotification 超时
 * - disconnect 中止进行中的请求与 SSE 读流
 */
import { HttpMcpClient } from '../../modules/mcp/HttpClient';

const encoder = new TextEncoder();

function jsonResponse(body: any, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sseResponse(chunks: string[], keepOpen = false): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) {
                controller.enqueue(encoder.encode(c));
            }
            if (!keepOpen) {
                controller.close();
            }
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

describe('HttpMcpClient', () => {
    let fetchMock: jest.Mock;
    const originalFetch = global.fetch;

    beforeEach(() => {
        fetchMock = jest.fn();
        global.fetch = fetchMock as any;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    function makeClient(timeout = 1000): HttpMcpClient {
        return new HttpMcpClient('http://example.test/mcp', 'streamable-http', {}, timeout);
    }

    // ==================== JSON 响应 ====================

    it('should return result for a JSON response', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        const client = makeClient();
        await expect(client.callTool('t', { a: 1 })).resolves.toEqual({ ok: true });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://example.test/mcp');
        expect(JSON.parse(init.body)).toMatchObject({ method: 'tools/call' });
    });

    it('should throw the JSON-RPC error message', async () => {
        fetchMock.mockResolvedValue(jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'rpc boom' },
        }));
        const client = makeClient();
        await expect(client.callTool('t', {})).rejects.toThrow('rpc boom');
    });

    it('should throw on non-OK HTTP status', async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 500));
        const client = makeClient();
        await expect(client.callTool('t', {})).rejects.toThrow(/HTTP error: 500/);
    });

    // ==================== SSE 响应 ====================

    it('should return the result from SSE matching the request id', async () => {
        fetchMock.mockResolvedValue(sseResponse([
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
        ]));
        const client = makeClient(30000);
        // 流在响应后即关闭，结果应快速返回（不等 30s 空闲超时）
        await expect(client.callTool('t', {})).resolves.toEqual({ ok: true });
    });

    it('should NOT consume server notifications (id null) as the response', async () => {
        // 流只包含一个带 result 的通知（id:null）后关闭：不能当作请求结果
        fetchMock.mockResolvedValue(sseResponse([
            'data: {"jsonrpc":"2.0","id":null,"result":{"hacked":true}}\n\n',
        ]));
        const client = makeClient(200);
        await expect(client.callTool('t', {})).rejects.toThrow(/(请求超时|timeout)/i);
    });

    it('should pick the response matching the request id even when a notification arrives first', async () => {
        fetchMock.mockResolvedValue(sseResponse([
            'data: {"jsonrpc":"2.0","id":null,"result":{"hacked":true}}\n\n',
            'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
        ]));
        const client = makeClient(1000);
        await expect(client.callTool('t', {})).resolves.toEqual({ ok: true });
    });

    it('should merge multi-line SSE data fields per spec', async () => {
        fetchMock.mockResolvedValue(sseResponse([
            'data: {"jsonrpc":"2.0",\ndata: "id":1,\ndata: "result":{"ok":true}}\n\n',
        ]));
        const client = makeClient(1000);
        await expect(client.callTool('t', {})).resolves.toEqual({ ok: true });
    });

    it('should propagate JSON-RPC error from SSE response', async () => {
        fetchMock.mockResolvedValue(sseResponse([
            'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"sse boom"}}\n\n',
        ]));
        const client = makeClient(1000);
        await expect(client.callTool('t', {})).rejects.toThrow('sse boom');
    });

    // ==================== 超时 ====================

    it('should time out while reading the JSON body (not just headers)', async () => {
        // body 永不产生数据；AbortController 超时中止时应拒绝 body 读取（模拟真实 fetch 的 signal 传播）
        fetchMock.mockImplementation((_url: string, init: any) => {
            const stream = new ReadableStream<Uint8Array>({
                pull() {
                    return new Promise((_resolve, reject) => {
                        init.signal.addEventListener('abort', () =>
                            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                        );
                    });
                },
            });
            return Promise.resolve(new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        });
        const client = makeClient(100);
        await expect(client.callTool('t', {})).rejects.toThrow(/(请求超时|timeout)/i);
    });

    it('should time out sendNotification', async () => {
        fetchMock.mockImplementation((_url: string, init: any) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
        }));
        const client = makeClient(100);
        await expect((client as any).sendNotification('notifications/test', {})).rejects.toThrow(/(请求超时|timeout)/i);
    });

    // ==================== disconnect 中止 ====================

    it('should abort an in-flight fetch on disconnect', async () => {
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementation((_url: string, init: any) => new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener('abort', () =>
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
        }));
        const client = makeClient(30000);
        const pending = client.callTool('t', {});
        await Promise.resolve();

        await client.disconnect();

        expect(signal?.aborted).toBe(true);
        await expect(pending).rejects.toThrow(/(请求超时|timeout)/i);
    });

    it('should cancel an in-flight SSE read stream on disconnect', async () => {
        // SSE 流永不关闭
        fetchMock.mockResolvedValue(sseResponse([], true));
        const client = makeClient(30000);
        const pending = client.callTool('t', {});
        await Promise.resolve();

        await client.disconnect();

        await expect(pending).rejects.toThrow(/(请求超时|timeout)/i);
    });
});
