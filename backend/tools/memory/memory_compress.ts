/**
 * memory_compress 工具
 *
 * 执行记忆压缩合并。
 * 对应 OptMem 的 `memo nap`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getMemoryManagerForTool } from '../../modules/memory';

export function createMemoryCompressDeclaration(): ToolDeclaration {
    return {
        name: 'memory_compress',
        description:
            '执行待处理的记忆压缩合并。\n' +
            '记忆系统使用二叉树结构：相邻记忆两两合并为一行摘要，摘要再合并。\n' +
            'memory_note 可能会返回压缩提示——按顺序执行它们。\n' +
            '参数：blockId（块 ID，如 "0-1"）；summary（压缩后的摘要文本，一行，≤280 字节）。\n' +
            '不传参数时，返回下一个待压缩的提示。\n' +
            '作用域：有工作区时默认作用于当前工作区记忆；如需操作全局记忆请传 scope="global"。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要压缩的块 ID（如 "0-1"）。从压缩提示中复制。',
                },
                summary: {
                    type: 'string',
                    description: '压缩后的摘要文本。一行，最多 280 字节。保留有持久影响的内容，丢弃不再重要的。不要编造。',
                },
                scope: {
                    type: 'string',
                    enum: ['global', 'workspace'],
                    description: '记忆作用域。有工作区时默认作用于当前工作区记忆；如需操作全局记忆请传 "global"，如需显式操作工作区记忆请传 "workspace"。',
                },
            },
        },
    };
}

async function memoryCompressHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const scope = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined;
    const mgr = await getMemoryManagerForTool(context?.activeWorkspaceUri, scope);
    if (!mgr) {
        // scope 为全局或本无工作区上下文时是全局实例未初始化；
        // 其余情况说明工作区记忆不可用，不要静默回退全局
        if (scope === 'global' || (!scope && !context?.activeWorkspaceUri)) {
            return { success: false, error: 'MemoryManager is not initialized.' };
        }
        if (scope === 'workspace' && !context?.activeWorkspaceUri) {
            return { success: false, error: 'Workspace scope requires an active workspace.' };
        }
        return { success: false, error: 'Workspace memory is unavailable (workspace URI could not be resolved).' };
    }

    try {
        const blockId = args.blockId ? String(args.blockId) : undefined;
        const summary = args.summary !== undefined ? String(args.summary) : undefined;

        const result = await mgr.compress(blockId, summary);

        const lines: string[] = [];
        if (result.pendingCompression) {
            lines.push(result.pendingCompression.prompt);
        } else {
            lines.push('Nothing left to compress.');
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                done: result.done,
                pendingCompression: result.pendingCompression,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryCompressTool(): Tool {
    return {
        declaration: createMemoryCompressDeclaration(),
        handler: memoryCompressHandler,
    };
}

export function registerMemoryCompress(): Tool {
    return createMemoryCompressTool();
}
