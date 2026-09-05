import { HttpMcpClient } from '../../modules/mcp/HttpClient';
import { StdioMcpClient } from '../../modules/mcp/StdioClient';
import { collectMcpList, isJsonRpcResponse } from '../../modules/mcp/protocol';

describe('MCP JSON-RPC and pagination boundaries', () => {
    test('server requests do not resolve pending outbound requests with the same ID', () => {
        const client = new StdioMcpClient('unused', []) as any;
        const resolve = jest.fn();
        const write = jest.fn();
        client.process = { stdin: { write } };
        client.pendingRequests.set(7, { resolve, reject: jest.fn() });
        client.handleMessage({ jsonrpc: '2.0', id: 7, method: 'roots/list' });
        expect(resolve).not.toHaveBeenCalled();
        expect(client.pendingRequests.has(7)).toBe(true);
        expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ id: 7, error: { code: -32601 } });
        client.handleMessage({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
        expect(resolve).toHaveBeenCalledWith({ tools: [] });
    });

    test('ping is answered, notifications remain notifications, malformed responses stay pending', () => {
        const client = new StdioMcpClient('unused', []) as any;
        const write = jest.fn();
        const notification = jest.fn();
        client.process = { stdin: { write } };
        client.on('notification', notification);
        client.handleMessage({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' });
        expect(JSON.parse(write.mock.calls[0][0])).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });
        client.handleMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        expect(notification).toHaveBeenCalledWith('notifications/tools/list_changed', undefined);
        for (const malformed of [null, [], { id: 1, result: {} }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, result: {}, error: {} }]) {
            expect(isJsonRpcResponse(malformed)).toBe(false);
        }
    });

    test.each(['tools', 'resources', 'prompts'] as const)('collects every %s page and passes opaque cursors unchanged', async key => {
        const request = jest.fn()
            .mockResolvedValueOnce({ [key]: [{ name: 'one' }], nextCursor: 'opaque/+==' })
            .mockResolvedValueOnce({ [key]: [], nextCursor: '' })
            .mockResolvedValueOnce({ [key]: [{ name: 'two' }] });
        await expect(collectMcpList(request, key)).resolves.toEqual([{ name: 'one' }, { name: 'two' }]);
        expect(request.mock.calls).toEqual([[{}], [{ cursor: 'opaque/+==' }], [{ cursor: '' }]]);
    });

    test('repeated cursors reject and failed later pages preserve the previous list', async () => {
        await expect(collectMcpList(jest.fn().mockResolvedValue({ tools: [], nextCursor: 'repeat' }), 'tools')).rejects.toThrow('repeated');
        const client = new HttpMcpClient('https://example.org/mcp', 'streamable-http') as any;
        client.connected = true;
        client.capabilities = { tools: {} };
        client.tools = [{ name: 'old' }];
        client.sendRequest = jest.fn()
            .mockResolvedValueOnce({ tools: [{ name: 'partial' }], nextCursor: 'next' })
            .mockRejectedValueOnce(new Error('page failed'));
        const warning = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await client.refreshLists();
            expect(client.getTools()).toEqual([{ name: 'old' }]);
        } finally { warning.mockRestore(); }
    });

    test('HTTP requests use negotiated version and reject mismatched IDs', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: {} }), { headers: { 'Content-Type': 'application/json' } }));
        const client = new HttpMcpClient('https://example.org/mcp', 'streamable-http') as any;
        client.connected = true;
        client.protocolVersion = '2025-06-18';
        try {
            await expect(client.sendRequest('tools/list', {})).rejects.toThrow('mismatched');
            expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['MCP-Protocol-Version']).toBe('2025-06-18');
        } finally {
            fetchMock.mockRestore();
            await client.disconnect();
        }
    });

    test('HTTP SSE answers a server request before accepting the matching response', async () => {
        const events = [
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', id: 1, result: { tools: [] } }
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
        const fetchMock = jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(events, { headers: { 'Content-Type': 'text/event-stream' } }))
            .mockResolvedValueOnce(new Response(null, { status: 202 }));
        const client = new HttpMcpClient('https://example.org/mcp', 'streamable-http') as any;
        client.connected = true;
        try {
            await expect(client.sendRequest('tools/list', {})).resolves.toEqual({ tools: [] });
            expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
        } finally {
            fetchMock.mockRestore();
            await client.disconnect();
        }
    });
});
