import { mcpResultToToolResult, mcpToolToDeclaration } from '../../modules/mcp/toolAdapter';
import { performToolCall } from '../../modules/mcp/mcpManager/mcpOperations';
import type { McpServerInfo, McpRawToolResult } from '../../modules/mcp/types';
import { McpInputRequiredError, McpExecutionUnknownError } from '../../modules/mcp/McpClient';
import { cleanToolSchemaForModel } from '../../../shared/toolSchema';

describe('MCP tool result and schema preservation', () => {
    test('兼容清理只处理 Schema 节点，保留同名参数、引用、常量和示例', () => {
        const schema = { type: 'object', $schema: 'https://json-schema.org/draft-07/schema#', additionalProperties: false,
            properties: { additionalProperties: { type: 'string' }, $schema: { type: 'string' },
                nested: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { value: { $ref: '#/$defs/value' } } } } },
            $defs: { value: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } } },
            allOf: [{ if: { properties: { $schema: { const: 'x' } } }, then: { additionalProperties: false } }],
            const: { additionalProperties: false, $schema: 'data' }, examples: [{ additionalProperties: 'keep', $schema: 'example' }] };
        const cleaned = cleanToolSchemaForModel(schema);
        expect(cleaned).not.toHaveProperty('$schema');
        expect(cleaned).not.toHaveProperty('additionalProperties');
        expect(cleaned.properties.additionalProperties).toEqual({ type: 'string' });
        expect(cleaned.properties.$schema).toEqual({ type: 'string' });
        expect(cleaned.properties.nested.items).not.toHaveProperty('additionalProperties');
        expect(cleaned.properties.nested.items.properties.value).toEqual({ $ref: '#/$defs/value' });
        expect(cleaned.$defs.value).not.toHaveProperty('additionalProperties');
        expect(cleaned.allOf[0].then).not.toHaveProperty('additionalProperties');
        expect(cleaned.const).toEqual(schema.const);
        expect(cleaned.examples).toEqual(schema.examples);
        expect(schema.properties.nested.items.additionalProperties).toBe(false);
    });


    test.each([
        [new McpInputRequiredError({ resultType: 'input_required', requestState: 'opaque==' }), 'input_required'],
        [new McpExecutionUnknownError(new Error('connection lost')), 'unknown'],
    ] as const)('未完成调用经过管理器和工具适配后仍保留状态：%s', async (error, status) => {
        const client = { callTool: jest.fn().mockRejectedValue(error) };
        const result = await performToolCall(new Map([['server', client]]) as any,
            { config: { id: 'server', name: 'test' } } as McpServerInfo,
            { serverId: 'server', toolName: 'read', arguments: {} });
        expect(mcpResultToToolResult(result)).toMatchObject({ success: false, data: { executionStatus: status } });
        if (status === 'input_required') expect(result.inputRequired?.requestState).toBe('opaque==');
        expect(client.callTool).toHaveBeenCalledTimes(1);
    });

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
