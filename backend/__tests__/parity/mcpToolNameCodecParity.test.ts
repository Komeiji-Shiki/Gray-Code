/**
 * 跨端 parity：MCP 工具名编解码器
 *
 * 同步点：backend/modules/mcp/mcpToolNameCodec.ts（re-export）
 *         vs frontend/src/utils/tools/mcp/mcpToolNameCodec.ts（re-export）
 *         vs shared/mcpToolNameCodec.ts（唯一事实源）
 *
 * 09 批合并结论：两端 codec 逻辑已合并进 shared 包（唯一事实源），两端改为 re-export；
 * 本 parity 退化为「验证 re-export 一致性」——两端命名空间与 shared 为同一实例
 * （=== 相等），并继续守护全部编解码行为语义（常量/编码/解码/isMcpToolName/往返）。
 * 原「MCP_SERVER_ID_PATTERN 仅后端导出」的有意差异已随合并消除：前端 re-export
 * 同样暴露该符号，且与后端为同一正则实例。
 *
 * 测试方式：backend jest 直接 import 两端 codec 文件 + shared 源文件，
 * 断言两端 === shared 同一实例、导出面与 shared 完全一致；行为断言保留防语义漂移。
 *
 * 09 批 M4 约束：前端 codec 现 re-export '@shared/mcpToolNameCodec'，backend jest
 * 运行时解析该别名依赖 jest.backend.config.js 的 moduleNameMapper 映射
 * '^@shared/(.*)$' → '<rootDir>/shared/$1'（与既有 '^@/(.*)$' → frontend/src 同一机制）。
 */

import * as sharedCodec from '../../../shared/mcpToolNameCodec';
import * as backendCodec from '../../modules/mcp/mcpToolNameCodec';
import * as frontendCodec from '../../../frontend/src/utils/tools/mcp/mcpToolNameCodec';

describe('跨端 parity：MCP 工具名编解码器（backend vs frontend，统一来自 shared）', () => {
    test('常量一致：MCP_TOOL_PREFIX / MCP_TOOL_SEPARATOR', () => {
        expect(frontendCodec.MCP_TOOL_PREFIX).toBe(backendCodec.MCP_TOOL_PREFIX);
        expect(frontendCodec.MCP_TOOL_SEPARATOR).toBe(backendCodec.MCP_TOOL_SEPARATOR);
        expect(backendCodec.MCP_TOOL_PREFIX).toBe('mcp__');
        expect(backendCodec.MCP_TOOL_SEPARATOR).toBe('__');
        expect(backendCodec.MCP_TOOL_PREFIX).toBe(sharedCodec.MCP_TOOL_PREFIX);
        expect(backendCodec.MCP_TOOL_SEPARATOR).toBe(sharedCodec.MCP_TOOL_SEPARATOR);
    });

    test('encodeMcpToolName 两端行为一致', () => {
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

    test('decodeMcpToolName 两端行为一致（含 null 分支）', () => {
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

    test('isMcpToolName 两端行为一致', () => {
        const inputs = ['mcp__exa__web_search', 'mcp__', 'mcp__srv__tool', 'regular_tool', 'mcp_exa_tool', ''];
        for (const input of inputs) {
            expect(frontendCodec.isMcpToolName(input)).toBe(backendCodec.isMcpToolName(input));
        }
        expect(backendCodec.isMcpToolName('mcp__exa__web_search')).toBe(true);
        expect(backendCodec.isMcpToolName('regular_tool')).toBe(false);
    });

    test('encode→decode 往返两端一致', () => {
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

    test('两端 codec 与 shared 为同一实例（=== 相等，re-export 直接转发）', () => {
        expect(frontendCodec.encodeMcpToolName).toBe(backendCodec.encodeMcpToolName);
        expect(frontendCodec.decodeMcpToolName).toBe(backendCodec.decodeMcpToolName);
        expect(frontendCodec.isMcpToolName).toBe(backendCodec.isMcpToolName);
        expect(backendCodec.encodeMcpToolName).toBe(sharedCodec.encodeMcpToolName);
        expect(backendCodec.decodeMcpToolName).toBe(sharedCodec.decodeMcpToolName);
        expect(backendCodec.isMcpToolName).toBe(sharedCodec.isMcpToolName);
    });

    test('两端导出面与 shared 完全一致（MCP_SERVER_ID_PATTERN 原「仅后端」差异已随合并消除）', () => {
        const sharedExports = Object.keys(sharedCodec).sort();
        const backendExports = Object.keys(backendCodec).sort();
        const frontendExports = Object.keys(frontendCodec).sort();
        expect(backendExports).toEqual(sharedExports);
        expect(frontendExports).toEqual(sharedExports);
        // 两端 === shared 同一实例（re-export 直接转发，而非复制）
        expect(backendCodec.MCP_SERVER_ID_PATTERN).toBe(sharedCodec.MCP_SERVER_ID_PATTERN);
        expect(frontendCodec.MCP_SERVER_ID_PATTERN).toBe(sharedCodec.MCP_SERVER_ID_PATTERN);
        expect(frontendCodec.MCP_SERVER_ID_PATTERN).toBe(backendCodec.MCP_SERVER_ID_PATTERN);
    });
});
