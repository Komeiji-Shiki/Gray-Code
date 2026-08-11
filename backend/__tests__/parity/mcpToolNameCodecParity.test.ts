/**
 * 跨端 parity：MCP 工具名编解码器
 *
 * 同步点：backend/modules/mcp/mcpToolNameCodec.ts（99 行）
 *         vs frontend/src/utils/tools/mcp/mcpToolNameCodec.ts（64 行）
 *
 * 语义比对结论：一致（行数差异来自注释与后端独有导出，共享逻辑逐字相同）。
 * - 共享导出 5 个：MCP_TOOL_PREFIX / MCP_TOOL_SEPARATOR / encodeMcpToolName /
 *   decodeMcpToolName / isMcpToolName，实现逐字一致（仅注释/格式差异）。
 * - 有意差异：MCP_SERVER_ID_PATTERN 仅后端导出——serverId 合法性校验只在后端
 *   （McpManager.validateServerId）执行，前端是消费方、不需要校验。
 *
 * 测试方式：backend jest 直接 import 两端源码（前端 codec 无任何依赖，可被 ts-jest 编译），
 * 表驱动行为比对 + 常量比对 + 导出面关系比对（前端导出 ⊆ 后端导出）。
 *
 * 09 批 M4 约束：本测试直接 import 前端文件路径（含重命名/迁移时同步更新）；
 * 前端 codec 必须保持零依赖（不 import store/utils 链），否则 backend jest 无法编译。
 */

import * as backendCodec from '../../modules/mcp/mcpToolNameCodec';
import * as frontendCodec from '../../../frontend/src/utils/tools/mcp/mcpToolNameCodec';

describe('跨端 parity：MCP 工具名编解码器（backend vs frontend）', () => {
    it('常量一致：MCP_TOOL_PREFIX / MCP_TOOL_SEPARATOR', () => {
        expect(frontendCodec.MCP_TOOL_PREFIX).toBe(backendCodec.MCP_TOOL_PREFIX);
        expect(frontendCodec.MCP_TOOL_SEPARATOR).toBe(backendCodec.MCP_TOOL_SEPARATOR);
        expect(backendCodec.MCP_TOOL_PREFIX).toBe('mcp__');
        expect(backendCodec.MCP_TOOL_SEPARATOR).toBe('__');
    });

    it('encodeMcpToolName 两端行为一致', () => {
        const pairs: Array<[string, string]> = [
            ['exa', 'web_search'],
            ['my_server', 'do_thing'],
            ['srv', 'tool__with__underscores'],
            ['a', 'b'],
            ['server-1', 'tool-2'],
        ];
        for (const [serverId, toolName] of pairs) {
            const backendResult = backendCodec.encodeMcpToolName(serverId, toolName);
            const frontendResult = frontendCodec.encodeMcpToolName(serverId, toolName);
            expect(frontendResult).toBe(backendResult);
            expect(backendResult).toBe(`mcp__${serverId}__${toolName}`);
        }
    });

    it('decodeMcpToolName 两端行为一致（含 null 分支）', () => {
        const inputs = [
            'mcp__exa__web_search',
            'mcp__srv__tool__with__underscores', // toolName 含双下划线
            'mcp__my_server__do_thing',          // serverId 含单下划线
            'mcp__a__b',
            'mcp__server-1__tool-2',
            'regular_tool',      // 非 MCP 名
            'mcp_exa_tool',      // 单下划线前缀
            'mcp__incomplete',   // 缺分隔符
            'mcp__',             // 空 toolName
            'mcp____tool',       // 空 serverId
            'mcp__srv__',        // 空 toolName
            '',
        ];
        for (const input of inputs) {
            const backendResult = backendCodec.decodeMcpToolName(input);
            const frontendResult = frontendCodec.decodeMcpToolName(input);
            expect(frontendResult).toEqual(backendResult);
        }
        // 锚定具体语义（防两端同时漂移）
        expect(backendCodec.decodeMcpToolName('mcp__exa__web_search')).toEqual({
            serverId: 'exa',
            toolName: 'web_search'
        });
        expect(backendCodec.decodeMcpToolName('mcp__srv__tool__with__underscores')).toEqual({
            serverId: 'srv',
            toolName: 'tool__with__underscores'
        });
        expect(backendCodec.decodeMcpToolName('regular_tool')).toBeNull();
        expect(backendCodec.decodeMcpToolName('mcp__incomplete')).toBeNull();
    });

    it('isMcpToolName 两端行为一致', () => {
        const inputs = ['mcp__exa__web_search', 'mcp__', 'mcp__srv__tool', 'regular_tool', 'mcp_exa_tool', ''];
        for (const input of inputs) {
            expect(frontendCodec.isMcpToolName(input)).toBe(backendCodec.isMcpToolName(input));
        }
        expect(backendCodec.isMcpToolName('mcp__exa__web_search')).toBe(true);
        expect(backendCodec.isMcpToolName('regular_tool')).toBe(false);
    });

    it('encode→decode 往返两端一致', () => {
        const pairs: Array<[string, string]> = [
            ['exa', 'web_search'],
            ['my_server', 'do_thing'],
            ['srv', 'tool__with__underscores'],
            ['a', 'b'],
        ];
        for (const [serverId, toolName] of pairs) {
            const backendRound = backendCodec.decodeMcpToolName(
                backendCodec.encodeMcpToolName(serverId, toolName)
            );
            const frontendRound = frontendCodec.decodeMcpToolName(
                frontendCodec.encodeMcpToolName(serverId, toolName)
            );
            expect(frontendRound).toEqual(backendRound);
            expect(backendRound).toEqual({ serverId, toolName });
        }
    });

    it('前端导出符号 ⊆ 后端导出符号；MCP_SERVER_ID_PATTERN 仅后端提供（有意差异）', () => {
        const backendExports = Object.keys(backendCodec).sort();
        const frontendExports = Object.keys(frontendCodec).sort();
        expect(backendExports).toEqual(expect.arrayContaining(frontendExports));
        expect(backendCodec).toHaveProperty('MCP_SERVER_ID_PATTERN');
        expect(frontendExports).not.toContain('MCP_SERVER_ID_PATTERN');
    });
});
