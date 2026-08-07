/**
 * memory_config 工具
 *
 * 查看或修改记忆系统配置。
 * 对应 OptMem 的 `memo config`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getMemoryManagerForTool, DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../modules/memory';

export function createMemoryConfigDeclaration(): ToolDeclaration {
    return {
        name: 'memory_config',
        description:
            '查看或修改永久记忆系统的配置参数。\n' +
            '可配置项：\n' +
            '- wakeLines: wake 输出的行数预算（默认 96，≈8k tokens）\n' +
            '- entryChars: 单条记忆最大字节数（默认 280）\n' +
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
                    description: '单条记忆最大字节数。默认 280，上限受固定宽度记录约束（含记录头部开销）。',
                },
            },
        },
    };
}

async function memoryConfigHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const mgr = await getMemoryManagerForTool(context?.activeWorkspaceUri);
    if (!mgr) {
        // 调用方传了 workspaceUri 说明意图是工作区：解析失败不要静默回退全局
        if (context?.activeWorkspaceUri) {
            return { success: false, error: 'Workspace memory is unavailable (workspace URI could not be resolved).' };
        }
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const updates: Partial<MemoryConfig> = {};
        if (typeof args.wakeLines === 'number') updates.wakeLines = args.wakeLines;
        if (typeof args.entryChars === 'number') updates.entryChars = args.entryChars;

        let config: MemoryConfig;
        if (Object.keys(updates).length > 0) {
            config = await mgr.updateConfig(updates);
        } else {
            config = mgr.getConfig();
        }

        const defaults = DEFAULT_MEMORY_CONFIG;
        const lines: string[] = [];
        for (const [key, value] of Object.entries(config)) {
            const defVal = (defaults as any)[key];
            const marker = value !== defVal ? ` (default ${defVal})` : '';
            lines.push(`${key.padEnd(12)} ${String(value).padEnd(7)} ${marker}`);
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
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
