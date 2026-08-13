/**
 * GrayCode MCP 服务器 ID / transport 变更判定工具函数
 *
 * 从 McpManager 抽离的纯函数层：ID 生成、slug 化、transport 实质变更比较。
 * 不依赖任何 McpManager 实例状态。
 */

import { MCP_SERVER_ID_PATTERN } from '../mcpToolNameCodec';
import type {
    McpTransportConfig,
    StdioTransportConfig,
    SseTransportConfig,
    StreamableHttpTransportConfig
} from '../types';

/**
 * 生成唯一 ID（名称无法 slug 化或 slug 冲突时的回退方案）
 */
export function generateId(): string {
    return `mcp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 将服务器名称转换为可读的 slug ID
 *
 * 规则：
 * - 转为小写，空白替换为单下划线
 * - 仅保留字母、数字、下划线、中划线
 * - 折叠连续下划线（避免双下划线破坏 MCP 工具名解码）
 * - 结果不符合 MCP_SERVER_ID_PATTERN 时返回空串（调用方回退随机 ID）
 */
export function slugifyServerName(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^-+|-+$/g, '');
    return MCP_SERVER_ID_PATTERN.test(slug) ? slug : '';
}

/**
 * 比较两份 transport 配置是否实质变化（连接参数）
 *
 * 不用 JSON.stringify 整串比较：对象键序不同（env/headers 键序变化）会误判为变化，
 * 触发无谓重连；连续两次相同内容的 updateServer 也会双重连。只比较影响连接的字段：
 * - stdio：type + command + args + env（键值对逐一比较，与键序无关）
 * - sse / streamable-http：type + url + headers（键值对逐一比较）
 */
export function transportConfigChanged(a: McpTransportConfig, b: McpTransportConfig): boolean {
    if (a.type !== b.type) {
        return true;
    }
    if (a.type === 'stdio') {
        const prev = a as StdioTransportConfig;
        const next = b as StdioTransportConfig;
        if (prev.command !== next.command) {
            return true;
        }
        const prevArgs = prev.args ?? [];
        const nextArgs = next.args ?? [];
        if (prevArgs.length !== nextArgs.length) {
            return true;
        }
        for (let i = 0; i < prevArgs.length; i++) {
            if (prevArgs[i] !== nextArgs[i]) {
                return true;
            }
        }
        return !sameStringRecord(prev.env, next.env);
    }
    const prev = a as SseTransportConfig | StreamableHttpTransportConfig;
    const next = b as SseTransportConfig | StreamableHttpTransportConfig;
    return prev.url !== next.url || !sameStringRecord(prev.headers, next.headers);
}

/**
 * 比较两个可选字符串键值表是否相等（undefined 视同空表，与键序无关）
 */
function sameStringRecord(
    a: Record<string, string> | undefined,
    b: Record<string, string> | undefined
): boolean {
    const keysA = Object.keys(a ?? {});
    const keysB = Object.keys(b ?? {});
    if (keysA.length !== keysB.length) {
        return false;
    }
    for (const key of keysA) {
        if (a?.[key] !== b?.[key]) {
            return false;
        }
    }
    return true;
}
