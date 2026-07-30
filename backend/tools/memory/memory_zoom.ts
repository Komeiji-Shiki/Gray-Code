/**
 * memory_zoom 工具
 *
 * 展开树节点查看两半。
 * 对应 OptMem 的 `memo zoom`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryZoomDeclaration(): ToolDeclaration {
    return {
        name: 'memory_zoom',
        description:
            '展开一个记忆树节点，查看它的两个半部分。\n' +
            '记忆形成一棵二叉树：memory_wake 输出的每一行 #a-b 都是一个节点。\n' +
            '用 memory_zoom 可以展开它，看到下一层的两个半部分，直到原始记忆本身。\n' +
            '参数：blockId（块 ID，如 "16-31"）。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要展开的块 ID（如 "16-31"）。从 wake 输出或上一次 zoom 的结果中复制。',
                },
            },
            required: ['blockId'],
        },
        readOnly: true,
    };
}

async function memoryZoomHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const blockId = String(args.blockId ?? '');
        const result = await mgr.zoom(blockId);

        const lines: string[] = [];
        for (const block of [result.left, result.right]) {
            if (!block.text && !block.isRaw) continue;
            if (block.isRaw) {
                lines.push(`#${block.lo} ${block.text}`);
            } else {
                lines.push(`#${block.lo}-${block.hi} ${block.text}`);
            }
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                left: result.left,
                right: result.right,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryZoomTool(): Tool {
    return {
        declaration: createMemoryZoomDeclaration(),
        handler: memoryZoomHandler,
    };
}

export function registerMemoryZoom(): Tool {
    return createMemoryZoomTool();
}
