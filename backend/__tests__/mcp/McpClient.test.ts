import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { McpClient, McpInputRequiredError, McpExecutionUnknownError } from '../../modules/mcp/McpClient';

const { handler } = require('./fixtures/server.cjs') as { handler: (mode: string, send: (message: any) => void) => (request: any) => void };
const script = path.resolve(__dirname, 'fixtures/server.cjs');

async function httpFixture(mode: 'modern' | 'legacy') {
    const calls: Array<{ message: any; headers: import('node:http').IncomingHttpHeaders }> = [];
    const responses = new Map<string | number, ServerResponse>();
    let subscription: ServerResponse | undefined;
    let getStream: ServerResponse | undefined;
    const receive = handler(mode, message => {
        if (message.method) {
            (subscription ?? getStream)?.write(`data: ${JSON.stringify(message)}\n\n`);
        } else {
            const response = responses.get(message.id);
            responses.delete(message.id);
            response?.writeHead(200, { 'Content-Type': 'application/json', ...(mode === 'legacy' ? { 'Mcp-Session-Id': 'fixture-session' } : {}) });
            response?.end(JSON.stringify(message));
        }
    });
    const server = createServer(async (request, response) => {
        if (request.method === 'GET') {
            getStream = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return;
        }
        if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
        let text = ''; for await (const chunk of request) text += chunk.toString();
        const message = JSON.parse(text);
        calls.push({ message, headers: request.headers });
        if (message.method === 'subscriptions/listen') {
            subscription = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
        } else if (message.id !== undefined) {
            responses.set(message.id, response);
            response.on('close', () => { if (!response.writableEnded) server.emit('requestClosed', message.id); });
        }
        if (message.params?.arguments?.action === 'disconnect') { response.destroy(); return; }
        receive(message);
        if (message.id === undefined) response.writeHead(202).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
    return { calls, url, server, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe('SDK MCP client', () => {
    test.each(['modern', 'legacy', 'exit-legacy'])('stdio %s 完整目录、中文图片、变更通知及进程关闭', async mode => {
        const client = new McpClient({ type: 'stdio', command: process.execPath, args: [script, mode] }, 2000);
        let pid = 0;
        try {
            await client.connect();
            expect(client.getProtocolVersion()).toBe(mode === 'modern' ? '2026-07-28' : '2025-11-25');
            expect(client.getTools().map(tool => tool.name)).toEqual(['echo', 'second']);
            expect(client.getResources()).toHaveLength(1); expect(client.getPrompts()).toHaveLength(1);
            const result = await client.callTool('echo', {});
            pid = Number((result.structuredContent as { pid: number }).pid);
            expect(result.content).toEqual([{ type: 'text', text: '中文' }, { type: 'image', mimeType: 'image/png', data: 'cG5n' }]);
            const changed = once(client, 'notification');
            await client.callTool('echo', { action: 'notify' });
            expect((await changed)[0]).toBe('notifications/tools/list_changed');
            await client.refreshLists();
            expect(client.getTools()[0].name).toBe('echo1');
        } finally { await client.disconnect(); }
        expect(() => process.kill(pid, 0)).toThrow();
    });

    test.each(['modern', 'legacy'] as const)('HTTP %s 认证、分页、单次取消和持续使用同一连接', async mode => {
        const f = await httpFixture(mode);
        const client = new McpClient({ type: 'streamable-http', url: f.url, headers: { Authorization: 'Bearer fixture' } }, 2000);
        try {
            await client.connect();
            expect(client.getTools().map(tool => tool.name)).toEqual(['echo', 'second']);
            expect((await client.readResource('test://resource')).contents[0]).toMatchObject({ text: 'text' });
            expect((await client.getPrompt('prompt')).messages[0].content).toMatchObject({ text: 'prompt' });
            const cancelled = new AbortController();
            const closed = once(f.server, 'requestClosed');
            const pending = client.callTool('echo', { action: 'wait' }, cancelled.signal);
            const rejected = expect(pending).rejects.toBeInstanceOf(McpExecutionUnknownError);
            await new Promise(resolve => setTimeout(resolve, 30)); cancelled.abort(new Error('test cancelled')); await rejected;
            await closed;
            expect((await client.callTool('echo', {})).content?.[0].text).toBe('中文');
            expect(f.calls.every(call => call.headers.authorization === 'Bearer fixture')).toBe(true);
            const toolRequests = f.calls.filter(call => call.message.method === 'tools/call');
            expect(toolRequests).toHaveLength(2);
            if (mode === 'modern') {
                expect(f.calls.some(call => call.message.method === 'initialize')).toBe(false);
                expect(toolRequests[0].message.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
                expect(toolRequests[0].headers['mcp-session-id']).toBeUndefined();
            } else expect(toolRequests[0].headers['mcp-session-id']).toBe('fixture-session');
            if (mode === 'legacy') expect(f.calls.some(call => call.message.method === 'notifications/cancelled')).toBe(true);
        } finally { await client.disconnect(); await f.close(); }
    });

    test('需要补充输入保持原始状态，断线后不自动重放工具', async () => {
        const f = await httpFixture('modern');
        const client = new McpClient({ type: 'streamable-http', url: f.url }, 500);
        try {
            await client.connect();
            await expect(client.callTool('echo', { action: 'input' })).rejects.toMatchObject({
                constructor: McpInputRequiredError,
                inputRequired: { resultType: 'input_required', requestState: 'opaque/状态==' },
            });
            await expect(client.callTool('echo', { action: 'disconnect' })).rejects.toBeInstanceOf(McpExecutionUnknownError);
            expect(f.calls.filter(call => call.message.method === 'tools/call')).toHaveLength(2);
        } finally { await client.disconnect(); await f.close(); }
    });

    test('连接期间取消立即停止无响应的 stdio 进程', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'gray-mcp-'));
        const marker = path.join(dir, 'pid');
        const client = new McpClient({ type: 'stdio', command: process.execPath, args: [script, 'quiet', marker] }, 15000);
        const pending = client.connect();
        const rejected = expect(pending).rejects.toThrow();
        try {
            let pid = 0;
            for (let i = 0; i < 100; i++) {
                try { pid = Number(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
            }
            expect(pid).toBeGreaterThan(0);
            const started = Date.now();
            await client.disconnect(); await rejected;
            expect(Date.now() - started).toBeLessThan(3000);
            expect(() => process.kill(pid, 0)).toThrow();
        } finally { await client.disconnect(); await rm(dir, { recursive: true, force: true }); }
    });
});
