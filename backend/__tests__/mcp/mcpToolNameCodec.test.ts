/**
 * mcpToolNameCodec 单测
 *
 * 覆盖：编码/解码、server ID 校验模式、边界情况
 */
import {
    encodeMcpToolName,
    decodeMcpToolName,
    isMcpToolName,
    MCP_SERVER_ID_PATTERN,
    MCP_TOOL_PREFIX,
    MCP_TOOL_SEPARATOR
} from '../../modules/mcp/mcpToolNameCodec';

describe('mcpToolNameCodec', () => {
    // ==================== MCP_SERVER_ID_PATTERN ====================

    describe('MCP_SERVER_ID_PATTERN', () => {
        const validIds = [
            'exa',
            'my_server',
            'my-server',
            'server_1',
            'a',
            'A_B-C',
            'abc123',
            'foo_bar_baz',
        ];

        const invalidIds = [
            'has__double',        // 双下划线
            '___leading',
            'trailing___',
            'a__b__c',
            '__only',
            'has space',
            'has.dot',
            '',
            '中文',
        ];

        it.each(validIds)('should accept valid server ID: %s', (id) => {
            expect(MCP_SERVER_ID_PATTERN.test(id)).toBe(true);
        });

        it.each(invalidIds)('should reject invalid server ID: %s', (id) => {
            expect(MCP_SERVER_ID_PATTERN.test(id)).toBe(false);
        });

        it('should reject server IDs with double underscore anywhere', () => {
            expect(MCP_SERVER_ID_PATTERN.test('a__b')).toBe(false);
            expect(MCP_SERVER_ID_PATTERN.test('__a')).toBe(false);
            expect(MCP_SERVER_ID_PATTERN.test('a__')).toBe(false);
        });
    });

    // ==================== encodeMcpToolName ====================

    describe('encodeMcpToolName', () => {
        it('should encode serverId and toolName with mcp__ prefix', () => {
            const result = encodeMcpToolName('exa', 'web_search');
            expect(result).toBe('mcp__exa__web_search');
        });

        it('should handle serverId with single underscores', () => {
            const result = encodeMcpToolName('my_server', 'do_thing');
            expect(result).toBe('mcp__my_server__do_thing');
        });

        it('should handle toolName with underscores', () => {
            const result = encodeMcpToolName('srv', 'web_search_exa');
            expect(result).toBe('mcp__srv__web_search_exa');
        });
    });

    // ==================== decodeMcpToolName ====================

    describe('decodeMcpToolName', () => {
        it('should decode a valid MCP tool name', () => {
            const result = decodeMcpToolName('mcp__exa__web_search');
            expect(result).toEqual({ serverId: 'exa', toolName: 'web_search' });
        });

        it('should handle toolName containing double underscores', () => {
            // toolName 可以含 __，只用第一个分隔符定位
            const result = decodeMcpToolName('mcp__srv__tool__with__underscores');
            expect(result).toEqual({ serverId: 'srv', toolName: 'tool__with__underscores' });
        });

        it('should handle serverId with single underscores', () => {
            const result = decodeMcpToolName('mcp__my_server__do_thing');
            expect(result).toEqual({ serverId: 'my_server', toolName: 'do_thing' });
        });

        it('should return null for non-MCP names', () => {
            expect(decodeMcpToolName('regular_tool')).toBeNull();
            expect(decodeMcpToolName('mcp_exa_tool')).toBeNull(); // 单下划线前缀
        });

        it('should return null for incomplete MCP names', () => {
            expect(decodeMcpToolName('mcp__incomplete')).toBeNull(); // 缺少分隔符
            expect(decodeMcpToolName('mcp__')).toBeNull();
        });

        it('should return null for empty serverId or toolName', () => {
            expect(decodeMcpToolName('mcp____tool')).toBeNull(); // serverId 为空
            expect(decodeMcpToolName('mcp__srv__')).toBeNull(); // toolName 为空
        });

        it('should round-trip encode then decode', () => {
            const pairs: Array<[string, string]> = [
                ['exa', 'web_search'],
                ['my_server', 'do_thing'],
                ['srv', 'simple'],
                ['a', 'b'],
            ];
            for (const [serverId, toolName] of pairs) {
                const encoded = encodeMcpToolName(serverId, toolName);
                const decoded = decodeMcpToolName(encoded);
                expect(decoded).toEqual({ serverId, toolName });
            }
        });
    });

    // ==================== isMcpToolName ====================

    describe('isMcpToolName', () => {
        it('should return true for MCP tool names', () => {
            expect(isMcpToolName('mcp__exa__web_search')).toBe(true);
            expect(isMcpToolName('mcp__srv__tool')).toBe(true);
        });

        it('should return false for non-MCP tool names', () => {
            expect(isMcpToolName('regular_tool')).toBe(false);
            expect(isMcpToolName('mcp_exa_tool')).toBe(false); // 单下划线
            expect(isMcpToolName('')).toBe(false);
        });
    });
});
