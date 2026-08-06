/**
 * memory_forget 工具
 *
 * 三种模式：
 * - 传入块 ID（如 "16-31"，破折号）：丢弃错误的树摘要，下次压缩会重建。
 * - 传入单个数字 ID（如 "5"）：删除这一条原始记忆（其后的记录 id 前移重编号）。
 * - 传入闭区间（如 "1,3"，逗号分隔）：删除 ID 1 到 3 的所有原始记忆。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryForgetDeclaration(): ToolDeclaration {
    return {
        name: 'memory_forget',
        description:
            '丢弃错误的树摘要，或删除原始记忆。\n' +
            '当 blockId 是范围（如 "16-31"，破折号）：仅丢弃树摘要及其上层摘要，原始记忆（LOG）不会被触碰。\n' +
            '当 blockId 是单个数字（如 "5"）：删除这一条原始记忆（其后的记录 id 前移重编号）。\n' +
            '当 blockId 是闭区间（如 "1,3"，逗号分隔）：删除 ID 1 到 3 的所有原始记忆（含端点）。\n' +
            '参数：blockId（块 ID 如 "16-31"、单个 ID 如 "5"、或闭区间如 "1,3"）。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '块 ID（如 "16-31"）丢弃树摘要；单个 ID（如 "5"）删除这一条记忆；闭区间（如 "1,3"）删除 1 到 3 的所有记忆。',
                },
            },
            required: ['blockId'],
        },
    };
}

/** 判断 blockId 是否为单个数字（单条删除模式） */
function isSingleId(s: string): boolean {
    return /^\d+$/.test(s);
}

/** 判断 blockId 是否为闭区间（如 "1,3"，逗号分隔） */
function isRange(s: string): boolean {
    return /^\d+,\d+$/.test(s);
}

async function memoryForgetHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const blockId = String(args.blockId ?? '');

        if (isSingleId(blockId)) {
            // 单条删除模式：只删除这一条原始记忆
            const id = parseInt(blockId, 10);
            const result = await mgr.deleteEntry(id);
            return {
                success: true,
                data: {
                    removed: result.removed,
                    message: `Removed memory #${id}. Later ids may have been renumbered; run memory_wake to refresh before further deletes.`,
                },
            };
        }

        if (isRange(blockId)) {
            // 闭区间删除模式：删除 [lo, hi] 的所有原始记忆
            const [loStr, hiStr] = blockId.split(',');
            const lo = parseInt(loStr, 10);
            const hi = parseInt(hiStr, 10);
            if (lo > hi) {
                return { success: false, error: `Invalid range: lo(${lo}) > hi(${hi}). Expected "lo,hi" with lo <= hi.` };
            }
            const result = await mgr.deleteRange(lo, hi);
            return {
                success: true,
                data: {
                    removed: result.removed,
                    message: `Removed ${result.removed} raw memories #${lo}-#${hi}. Later ids may have been renumbered; run memory_wake to refresh before further deletes.`,
                },
            };
        }

        // 摘要模式：原行为
        const result = await mgr.forget(blockId);
        return {
            success: true,
            data: {
                gone: result.gone,
                message: `Forgot ${result.gone} summaries, from ${result.firstId} up. Run memory_compress to rebuild.`,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryForgetTool(): Tool {
    return {
        declaration: createMemoryForgetDeclaration(),
        handler: memoryForgetHandler,
    };
}

export function registerMemoryForget(): Tool {
    return createMemoryForgetTool();
}
