/**
 * memory_config 工具
 *
 * 查看或修改记忆系统配置。
 * 对应 OptMem 的 `memo config`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getMemoryManagerForTool, getGlobalMemoryManager, workspaceUriToScopeKey, DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../modules/memory';

export function createMemoryConfigDeclaration(): ToolDeclaration {
    return {
        name: 'memory_config',
        description:
            '查看或修改永久记忆系统的配置参数。\n' +
            '可配置项：\n' +
            '- wakeLines: wake 输出的行数预算（默认 96，≈8k tokens）\n' +
            '- entryChars: 单条记忆最大字节数（默认 280，上限 1000）\n' +
            '不传参数时显示当前配置。传参数时修改对应项。\n' +
            '修改只影响输出格式，不需要重新计算任何东西。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                wakeLines: {
                    type: 'number',
                    description: 'wake 输出的行数预算。更大的值 = 更多细节。',
                },
                entryChars: {
                    type: 'number',
                    description: '单条记忆最大字节数。默认 280，上限 1000（固定宽度记录约束，含记录头部开销）。',
                },
            },
        },
    };
}

/** 格式化配置输出（与默认值对比标注） */
function formatConfig(config: MemoryConfig): string {
    const defaults = DEFAULT_MEMORY_CONFIG;
    const lines: string[] = [];
    for (const [key, value] of Object.entries(config)) {
        const defVal = (defaults as any)[key];
        const marker = value !== defVal ? ` (default ${defVal})` : '';
        lines.push(`${key.padEnd(12)} ${String(value).padEnd(7)} ${marker}`);
    }
    return lines.join('\n');
}

const MEMORY_CONFIG_KEYS = ['wakeLines', 'entryChars'] as const;

async function memoryConfigHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    // 修改原因：显式传入 0/负数/小数/NaN/非数字等非法配置值时，旧实现会静默走读分支
    //          （hasUpdates=false），用户以为已修改但实际没生效；或把非法值带进 updateConfig 抛错。
    // 修改方式：对「已显式传入但取值非法」的 key 直接返回明确错误，而不是静默忽略。
    for (const key of MEMORY_CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
        const v = args[key];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
            return {
                success: false,
                error: `Invalid value for memory config "${key}": expected an integer >= 1, got ${JSON.stringify(v)}`
            };
        }
    }

    // 纯读（无更新参数）时传 createIfMissing=false：不创建缺失的工作区记忆目录，
    // 与 wake/recall/zoom 的只读无副作用策略一致；有更新参数才允许创建。
    // 仅接受 >=1 的整数：0/负数/小数不是合法配置值（MemoryManager 边界为 min=1），
    // 不应被当作“更新意图”（否则会触发目录创建或走到 updateConfig 抛错）。
    const hasUpdates = MEMORY_CONFIG_KEYS.some(k => {
        const v = args[k];
        return typeof v === 'number' && Number.isInteger(v) && v >= 1;
    });
    const mgr = await getMemoryManagerForTool(context?.activeWorkspaceUri, undefined, hasUpdates);
    if (!mgr) {
        // 无工作区上下文：全局实例未初始化
        if (!context?.activeWorkspaceUri) {
            return { success: false, error: 'MemoryManager is not initialized.' };
        }
        // 有 workspaceUri 但拿不到实例：先区分 URI 是否可解析
        if (!workspaceUriToScopeKey(context.activeWorkspaceUri)) {
            return { success: false, error: 'Workspace memory is unavailable (workspace URI could not be resolved).' };
        }
        // URI 可解析但实例不可用：
        // - 有更新参数时说明工作区目录创建失败（不应静默回退全局，否则会改错作用域的配置）
        // - 纯读时说明工作区记忆目录尚未初始化：回退显示全局配置并明确标注（只读、无磁盘副作用），
        //   避免误以为该工作区已有独立配置
        if (hasUpdates) {
            return { success: false, error: 'Workspace memory is unavailable (workspace memory directory could not be created).' };
        }
        const globalMgr = getGlobalMemoryManager();
        if (!globalMgr) {
            return { success: false, error: 'MemoryManager is not initialized.' };
        }
        const config = await globalMgr.loadConfig();
        return {
            success: true,
            data: {
                text: formatConfig(config) + '\n(workspace memory not initialized yet; showing global config)',
                config,
                workspaceNotInitialized: true,
            },
        };
    }

    try {
        const updates: Partial<MemoryConfig> = {};
        if (typeof args.wakeLines === 'number') updates.wakeLines = args.wakeLines;
        if (typeof args.entryChars === 'number') updates.entryChars = args.entryChars;

        let config: MemoryConfig;
        if (Object.keys(updates).length > 0) {
            config = await mgr.updateConfig(updates);
        } else {
            config = await mgr.loadConfig();
        }

        return {
            success: true,
            data: {
                text: formatConfig(config),
                config,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryConfigTool(): Tool {
    return {
        declaration: createMemoryConfigDeclaration(),
        handler: memoryConfigHandler,
    };
}

export function registerMemoryConfig(): Tool {
    return createMemoryConfigTool();
}
