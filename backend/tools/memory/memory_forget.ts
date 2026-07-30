/**
 * memory_forget 工具
 *
 * 丢弃错误的树摘要，下次压缩会重建。
 * 对应 OptMem 的 `memo forget`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryForgetDeclaration(): ToolDeclaration {
    return {
        name: 'memory_forget',
        description:
            '丢弃一个错误的树摘要及其所有上层摘要。\n' +
            '原始记忆（LOG）不会被触碰——下一次 memory_compress 会重建被丢弃的摘要。\n' +
            '当摘要损坏、错拼或压缩质量差时使用。\n' +
            '参数：blockId（块 ID，如 "16-31"）。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要丢弃的块 ID（如 "16-31"）。',
                },
            },
            required: ['blockId'],
        },
    };
}

async function memoryForgetHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const blockId = String(args.blockId ?? '');
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
