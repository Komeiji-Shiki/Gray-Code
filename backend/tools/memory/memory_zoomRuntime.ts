import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import type { MemoryToolHost } from './host';

export function createMemoryZoomRuntime(host: MemoryToolHost) {
const { getMemoryManagerForTool, workspaceUriToScopeKey } = host;


function createMemoryZoomDeclaration(): ToolDeclaration {
    return {
        name: 'memory_zoom',
        description:
            '展开工程日志记忆树中的一个节点，查看它下一层的两个半部分。\n' +
            'memory_wake 输出中每一行 #a-b 都是一个节点。逐层展开，最终可以看到原始记忆本身。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要展开的块 ID，例如 "16-31"，从 memory_wake 的输出或上一次 memory_zoom 的结果中复制。',
                },
                scope: {
                    type: 'string',
                    enum: ['global', 'workspace'],
                    description: '记忆作用域。有工作区时默认读取当前工作区记忆；传 "global" 读取全局记忆，传 "workspace" 显式读取工作区记忆。',
                },
            },
            required: ['blockId'],
        },
        readOnly: true,
    };
}


async function memoryZoomHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const scope = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined;
    // 只读工具：工作区目录不存在时不创建（createIfMissing=false），避免只读访问产生磁盘副作用
    const mgr = await getMemoryManagerForTool(context?.activeWorkspaceUri, scope, false);
    if (!mgr) {
        // scope 为全局或本无工作区上下文时是全局实例未初始化；
        // 其余情况说明工作区记忆不可用，不要静默回退全局
        if (scope === 'global' || (!scope && !context?.activeWorkspaceUri)) {
            return { success: false, error: 'MemoryManager is not initialized.' };
        }
        if (scope === 'workspace' && !context?.activeWorkspaceUri) {
            return { success: false, error: 'Workspace scope requires an active workspace.' };
        }
        // 有 workspaceUri 但只读拿不到实例：区分 URI 解析失败与工作区记忆目录尚未初始化
        if (context?.activeWorkspaceUri && !workspaceUriToScopeKey(context.activeWorkspaceUri)) {
            return { success: false, error: 'Workspace memory is unavailable (workspace URI could not be resolved).' };
        }
        return { success: false, error: 'Workspace memory is not initialized for this workspace. Write a memory_note first.' };
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


function createMemoryZoomTool(): Tool {
    return {
        declaration: createMemoryZoomDeclaration(),
        handler: memoryZoomHandler,
    };
}


function registerMemoryZoom(): Tool {
    return createMemoryZoomTool();
}
return { createMemoryZoomDeclaration, createMemoryZoomTool, registerMemoryZoom };
}
