import { mcpResultToToolResult, mcpToolToDeclaration } from '../../modules/mcp/toolAdapter';
import { performToolCall } from '../../modules/mcp/mcpManager/mcpOperations';
import type { McpServerInfo, McpRawToolResult } from '../../modules/mcp/types';

describe('MCP tool result and schema preservation', () => {
    test('retains JSON Schema definitions, references and object constraints', () => {
        const inputSchema = { type: 'object' as const, properties: { path: { $ref: '#/$defs/path' } }, required: ['path'], additionalProperties: false, $defs: { path: { type: 'string', minLength: 1 } } };
        const declaration = mcpToolToDeclaration({ name: 'read', inputSchema }, 'test');
        expect(declaration.parameters).toEqual(inputSchema);
    });

    test('preserves structured, embedded and linked resources through manager and executor adapter', async () => {
        const raw: McpRawToolResult = { content: [
            { type: 'resource', resource: { uri: 'file:///fixture.txt', mimeType: 'text/plain', text: 'file body' } },
            { type: 'resource', resource: { uri: 'file:///fixture.png', mimeType: 'image/png', blob: 'aW1hZ2U=' } },
            { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
            { type: 'resource_link', name: 'report', uri: 'https://example.org/report', description: 'details' }
        ], structuredContent: { count: 4 } };
        const client = { callTool: jest.fn().mockResolvedValue(raw) };
        const result = await performToolCall(new Map([['server', client]]) as any,
            { config: { id: 'server', name: 'test' } } as McpServerInfo,
            { serverId: 'server', toolName: 'read', arguments: {} });
        expect(result.content).toEqual(raw.content);
        expect(result.structuredContent).toEqual({ count: 4 });
        const normalized = mcpResultToToolResult(result);
        expect(normalized.data).toEqual({ text: 'file body\nreport\nhttps://example.org/report\ndetails', structuredContent: { count: 4 } });
        expect(normalized.multimodal).toEqual([
            { mimeType: 'image/png', data: 'aW1hZ2U=', name: 'file:///fixture.png' },
            { mimeType: 'audio/wav', data: 'YXVkaW8=', name: undefined }
        ]);
    });

    test('structured-only output is retained and legacy flattened resources remain readable', () => {
        expect(mcpResultToToolResult({ success: true, structuredContent: { answer: 42 } }).data).toEqual({ answer: 42 });
        expect(mcpResultToToolResult({ success: true, content: [{ type: 'resource', text: 'legacy' }] }).data).toBe('legacy');
        expect(mcpResultToToolResult({ success: false, isError: true, content: [{ type: 'text', text: 'tool failed' }] })).toEqual({ success: false, error: 'tool failed' });
    });
});
