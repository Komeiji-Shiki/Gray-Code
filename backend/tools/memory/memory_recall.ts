/**
 * memory_recall 工具
 *
 * 正则搜索全部记忆。
 * 对应 OptMem 的 `memo recall`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryRecallDeclaration(): ToolDeclaration {
    return {
        name: 'memory_recall',
        description:
            '搜索全部永久记忆（逐字匹配）。支持正则表达式。\n' +
            '搜索范围包括已被压缩摘要的原始记忆——压缩不会丢失信息。\n' +
            '结果限制在单次输出容量内，如果被截断会提示缩小正则范围。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                regex: {
                    type: 'string',
                    description: '搜索正则表达式（大小写不敏感）。搜索范围包括 ID 和日期。',
                },
            },
            required: ['regex'],
        },
        readOnly: true,
    };
}

async function memoryRecallHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const regex = String(args.regex ?? '');
        const result = await mgr.recall(regex);

        const lines = [...result.lines];
        if (result.totalHits === 0) {
            lines.push('No match.');
        } else if (result.truncated) {
            lines.push(`Newest ${result.lines.length} of ${result.totalHits} matches. Narrow the regex.`);
        } else {
            lines.push(`${result.totalHits} match${result.totalHits === 1 ? '' : 'es'}.`);
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                totalHits: result.totalHits,
                truncated: result.truncated,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryRecallTool(): Tool {
    return {
        declaration: createMemoryRecallDeclaration(),
        handler: memoryRecallHandler,
    };
}

export function registerMemoryRecall(): Tool {
    return createMemoryRecallTool();
}
