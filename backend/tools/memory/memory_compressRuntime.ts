import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import { MAX_TREE_SUMMARY_BYTES } from '../../modules/memory/logFormat';
import type { MemoryToolHost } from './host';
import { compactNapPrompt } from './napPrompt';

export function createMemoryCompressRuntime(host: MemoryToolHost) {
const { getMemoryManagerForTool } = host;


function createMemoryCompressDeclaration(): ToolDeclaration {
    return {
        name: 'memory_compress',
        description:
            '处理待压缩的工程日志记忆。记忆按二叉树组织：相邻的两条记忆合并成一行摘要，摘要再两两合并。\n' +
            '不传 blockId 和 summary 时，返回下一个待压缩的提示；按提示写好摘要后，再用 blockId 和 summary 提交。\n' +
            '成功的 memory_note 或 memory_wake 返回的 pendingCompression 是可延后的维护提示，不要因此中断当前用户任务；memory_wake 因缺少摘要失败时才必须立即处理。\n' +
            '开始维护后按提示顺序执行；不同作用域的独立压缩可以在同一响应中调用。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要压缩的块 ID，例如 "0-1"，从压缩提示中复制。',
                },
                summary: {
                    type: 'string',
                    description: `压缩后的摘要，只能有一行。长度不能超过 entryChars 和 ${MAX_TREE_SUMMARY_BYTES} 字节中较小的那个，默认配置下最多 280 字节。保留长期有效的决定、偏好、约束、事实和必要的上下文，去掉临时进度和重复内容，不要编造。`,
                },
                scope: {
                    type: 'string',
                    enum: ['global', 'workspace'],
                    description: '记忆作用域。有工作区时默认操作当前工作区记忆；传 "global" 操作全局记忆，传 "workspace" 显式操作工作区记忆。',
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
                pendingCompression: result.pendingCompression ? compactNapPrompt(result.pendingCompression) : undefined,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}


function createMemoryCompressTool(): Tool {
    return {
        declaration: createMemoryCompressDeclaration(),
        handler: memoryCompressHandler,
    };
}


function registerMemoryCompress(): Tool {
    return createMemoryCompressTool();
}
return { createMemoryCompressDeclaration, createMemoryCompressTool, registerMemoryCompress };
}
