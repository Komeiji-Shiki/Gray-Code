/**
 * memory_note 工具
 *
 * 记录一条永久记忆。
 * 对应 OptMem 的 `memo note`。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { getMemoryManagerForTool } from '../../modules/memory';

export function createMemoryNoteDeclaration(): ToolDeclaration {
    return {
        name: 'memory_note',
        description:
            '记录一条永久记忆。当你学到新东西、发生值得记住的事情时调用。\n' +
            '记忆保存到当前工作区的记忆存储（与全局记忆分开，memory_wake 会同时读取两者）。\n' +
            '一行文本，长度受 memory_config 的 entryChars 上限控制（默认最多 280 字符，按字节计，重音字符占 2 字节；可经 memory_config 调高至 1000）。\n' +
            '不要记录冗余的、已经知道的或刚才已经记录过的内容。\n' +
            '如果返回了压缩提示（pendingCompression），请在下一次操作前执行 memory_compress。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: '要记录的记忆文本。一行，长度受 memory_config 的 entryChars 上限控制（默认最多 280 字符）。',
                },
            },
            required: ['text'],
        },
    };
}

async function memoryNoteHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const mgr = await getMemoryManagerForTool(context?.activeWorkspaceUri);
    if (!mgr) {
        // 调用方传了 workspaceUri 说明意图是工作区：解析失败不要静默回退全局
        if (context?.activeWorkspaceUri) {
            return { success: false, error: 'Workspace memory is unavailable (workspace URI could not be resolved).' };
        }
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const text = String(args.text ?? '');
        const result = await mgr.note(text);

        const output: string[] = [`Saved as #${result.id}.`];
        if (result.pendingCompression) {
            output.push('');
            output.push(result.pendingCompression.prompt);
        }

        return {
            success: true,
            data: {
                id: result.id,
                text: output.join('\n'),
                pendingCompression: result.pendingCompression,
            },
        };
    } catch (e: any) {
        let message = e?.message || String(e);
        if (/^Too long:/.test(message)) {
            message += ' (记忆配置为全局共享，可用 memory_config 调整 entryChars 上限)';
        }
        return { success: false, error: message };
    }
}

export function createMemoryNoteTool(): Tool {
    return {
        declaration: createMemoryNoteDeclaration(),
        handler: memoryNoteHandler,
    };
}

export function registerMemoryNote(): Tool {
    return createMemoryNoteTool();
}
