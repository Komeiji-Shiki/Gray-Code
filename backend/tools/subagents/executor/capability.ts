/**
 * 子代理写/执行能力口径与父 run 可用工具注册表。
 *
 * 拆分说明：从 executor.ts 迁出（纯移动，逻辑一字未改）。
 */

import { WRITE_TOOLS } from '../presets';
import type { SubAgentToolsConfig } from '../types';

/**
 * 写/执行类工具集合（H-1 / M-7 共享口径）。
 *
 * subagents 工具派发的 General Worker 是 mode='all'（全量非 memory 工具），
 * 若父代理自身缺少任一写/执行工具，嵌套派发会让子代理获得父代理没有的能力
 * （绕过只读沙箱）。因此只有「完整拥有本集合全部工具」的子代理才允许持有
 * subagents 工具；不具备的代理直接把 subagents 从可用工具集中移除。
 */
export const WRITE_CAPABILITY_TOOLS = [...WRITE_TOOLS, 'execute_command'];

/**
 * 判断子代理工具配置是否「不具备完整写/执行能力」（H-1，R4 复查）。
 *
 * - mode 'all' / 'builtin'：内置工具含全部写/执行工具 → 具备
 * - mode 'mcp'：无内置写/执行工具 → 不具备
 * - mode 'whitelist'：白名单必须包含全部写/执行工具才具备
 * - mode 'blacklist'：黑名单命中任一写/执行工具即不具备
 *
 * M-7（R4 复查）：本函数是 subagents.ts getAgentAvailableTools（同步声明路径）与
 * resolveSubAgentAvailableTools（异步 resolver 路径）共用的裁剪口径，
 * 两侧对 subagents 工具的去留保持一致，避免声明描述与实际工具集分叉。
 */
export function agentLacksWriteCapability(toolsConfig: SubAgentToolsConfig): boolean {
    switch (toolsConfig.mode) {
        case 'all':
        case 'builtin':
            return false;
        case 'mcp':
            return true;
        case 'whitelist': {
            const whitelist = new Set(toolsConfig.whitelist || toolsConfig.list || []);
            return !WRITE_CAPABILITY_TOOLS.every(tool => whitelist.has(tool));
        }
        case 'blacklist': {
            const blacklist = new Set(toolsConfig.blacklist || toolsConfig.list || []);
            return WRITE_CAPABILITY_TOOLS.some(tool => blacklist.has(tool));
        }
        default:
            return true;
    }
}

/**
 * 父 run 可用工具注册表（H-1，R4 复查）。
 *
 * 嵌套派发时，subagents handler 需要把「父 run 实际允许的工具集」传播给子 run：
 * 子 run 最终可用工具 = 子配置解析结果 ∩ 父 run 可用工具，避免子代理（尤其是
 * mode='all' 的 General Worker）获得父代理自身没有的写/执行权限。
 * 由于 ToolExecutionService 的 toolContext 无法携带额外字段（文件边界限制），
 * 这里用 runId 索引父 run 的可用工具集：executor 在解析出工具后注册（
 * setRunAllowedTools），run 结束时在最外层 finally 清理（clearRunAllowedTools）；
 * 主模型直接派发（无 mailboxRunId）不走此表。
 */
const runAllowedToolsRegistry = new Map<string, Set<string>>();

/** 注册某个 run 实际允许的工具名集合（供嵌套派发时继承） */
export function setRunAllowedTools(runId: string, tools: Set<string>): void {
    runAllowedToolsRegistry.set(runId, tools);
}

/** 读取某个 run 实际允许的工具名集合（不存在时返回 undefined） */
export function getRunAllowedTools(runId: string): Set<string> | undefined {
    return runAllowedToolsRegistry.get(runId);
}

/** run 结束时清理其工具限制登记，避免内存残留 */
export function clearRunAllowedTools(runId: string): void {
    runAllowedToolsRegistry.delete(runId);
}
