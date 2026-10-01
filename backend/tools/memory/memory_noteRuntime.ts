import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { MAX_ENTRY_CHARS } from '../../modules/memory/logFormat';
import type { MemoryToolHost } from './host';
import { compactNapPrompt } from './napPrompt';

export function createMemoryNoteRuntime(host: MemoryToolHost) {
const { getMemoryManagerForTool } = host;


function createMemoryNoteDeclaration(): ToolDeclaration {
    return {
        name: 'memory_note',
        description:
            '记录一条在以后的会话里仍然有用的工程日志，例如项目约定、踩过的坑或长期的技术决定。用户本人的事实、偏好和经历属于个人长期记忆，请用 memory_remember 记录，不要用本工具代替。\n' +
            '有工作区时，记录保存到当前工作区的记忆中，与全局记忆分开；memory_wake 会同时读取两者。\n' +
            '不要记录临时进度、工作流水、可以从仓库重新得到的内容、秘密或重复的信息。\n' +
            '如果结果包含 pendingCompression，它只是可延后的维护提示：不要中断当前用户任务，完成当前交付后再压缩；同一个待压缩状态不会重复提示。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                text: {
                    type: 'string',
                    description: `要记录的文本，只能有一行。长度按 UTF-8 字节计算，上限是 memory_config 的 entryChars（默认 280 字节，一个中文字符通常占 3 字节），最高可调到 ${MAX_ENTRY_CHARS}。`,
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
                pendingCompression: result.pendingCompression ? compactNapPrompt(result.pendingCompression) : undefined,
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


function createMemoryNoteTool(): Tool {
    return {
        declaration: createMemoryNoteDeclaration(),
        handler: memoryNoteHandler,
    };
}


function registerMemoryNote(): Tool {
    return createMemoryNoteTool();
}
return { createMemoryNoteDeclaration, createMemoryNoteTool, registerMemoryNote };
}
