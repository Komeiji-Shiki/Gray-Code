/**
 * memory_forget 工具
 *
 * 两种模式：
 * - 传入块 ID（如 "16-31"）：丢弃错误的树摘要，下次压缩会重建。
 * - 传入单个数字 ID（如 "5"）：截断原始 LOG，删除 ID >= 该值的所有原始记忆及关联摘要。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryForgetDeclaration(): ToolDeclaration {
    return {
        name: 'memory_forget',
        description:
            '丢弃错误的树摘要，或删除原始记忆。\n' +
            '当 blockId 是范围（如 "16-31"）：仅丢弃树摘要及其上层摘要，原始记忆（LOG）不会被触碰。\n' +
            '当 blockId 是单个数字（如 "5"）：截断原始 LOG，删除 ID >= 该值的所有原始记忆及关联的树摘要。\n' +
            '参数：blockId（块 ID 如 "16-31"，或单个 ID 如 "5"）。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '块 ID（如 "16-31"）或单个 ID（如 "5"）。单个 ID 会截断原始记忆。',
                },
            },
            required: ['blockId'],
        },
    };
}

/** 判断 blockId 是否为单个数字（截断模式） */
function isSingleId(s: string): boolean {
    return /^\d+$/.test(s);
}

async function memoryForgetHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const blockId = String(args.blockId ?? '');

        if (isSingleId(blockId)) {
            // 截断模式：删除原始 LOG
            const keepId = parseInt(blockId, 10);
            const result = await mgr.truncateLog(keepId);
            if (result.removed === 0) {
                return {
                    success: true,
                    data: {
                        removed: 0,
                        message: `No memories to remove (keepId=${keepId} is at or beyond the end).`,
                    },
                };
            }
            return {
                success: true,
                data: {
                    removed: result.removed,
                    message: `Removed ${result.removed} raw memories (ID >= ${keepId}) and their summaries.`,
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
