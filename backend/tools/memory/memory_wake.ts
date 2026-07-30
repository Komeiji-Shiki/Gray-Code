/**
 * memory_wake 工具
 *
 * 唤醒记忆：每次会话开始时读取永久记忆。
 * 对应 OptMem 的 `memo wake`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getGlobalMemoryManager } from '../../modules/memory';

export function createMemoryWakeDeclaration(): ToolDeclaration {
    return {
        name: 'memory_wake',
        description:
            '唤醒永久记忆。在每次会话开始时、做任何其他事情之前必须先调用此工具。\n' +
            '它会输出你的记忆摘要：近期的记忆保持原文，远期的记忆被压缩为摘要。\n' +
            '如果输出被分成多个部分，按顺序读取直到看到 "You are awake." 为止。\n' +
            '参数：part（可选，部分号，1-based）；snapshotT（可选，记忆快照总数）。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                part: {
                    type: 'number',
                    description: '要读取的部分号（1-based）。不传则从第 1 部分开始。',
                },
                snapshotT: {
                    type: 'number',
                    description: '快照时的记忆总数。不传则用当前总数。用于跨多次 wake 调用保持一致性。',
                },
            },
        },
        readOnly: true,
    };
}

async function memoryWakeHandler(args: Record<string, unknown>, _context?: ToolContext): Promise<ToolResult> {
    const mgr = getGlobalMemoryManager();
    if (!mgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const part = typeof args.part === 'number' ? args.part : undefined;
        const snapshotT = typeof args.snapshotT === 'number' ? args.snapshotT : undefined;

        const result = await mgr.wake(part, snapshotT);

        const lines: string[] = [];
        if (result.totalMemories === 0) {
            lines.push('No memories yet. Record the first with memory_note.');
            lines.push('You are awake.');
        } else {
            if (result.totalParts > 1) {
                lines.push(`Your memory, part ${result.part} of ${result.totalParts}, oldest first (${result.totalMemories} memories).`);
            }
            for (const block of result.blocks) {
                if (block.isRaw) {
                    lines.push(`#${block.lo} ${block.text}`);
                } else {
                    lines.push(`#${block.lo}-${block.hi} ${block.text}`);
                }
            }
            if (!result.awake) {
                lines.push(`Not awake yet. Run: memory_wake part=${result.part + 1} snapshotT=${result.totalMemories}`);
            } else {
                lines.push('You are awake.');
                if (result.pendingCompression) {
                    lines.push('');
                    lines.push(result.pendingCompression.prompt);
                }
            }
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                ...result,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export function createMemoryWakeTool(): Tool {
    return {
        declaration: createMemoryWakeDeclaration(),
        handler: memoryWakeHandler,
    };
}

export function registerMemoryWake(): Tool {
    return createMemoryWakeTool();
}
