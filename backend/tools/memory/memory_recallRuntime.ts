import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import type { RecallResult } from '../../modules/memory/types';
import type { MemoryToolHost } from './host';

export function createMemoryRecallRuntime(host: MemoryToolHost) {
const { getGlobalMemoryManager, getMemoryManagerForWorkspace, getWorkspaceFolderName } = host;


function createMemoryRecallDeclaration(): ToolDeclaration {
    return {
        name: 'memory_recall',
        description:
            '用正则表达式逐字搜索工程日志记忆，也就是 memory_note 写下的项目约定和经验。用户的个人长期记忆不在这里，请用 memory_search。\n' +
            '搜索同时覆盖全局记忆和当前工作区记忆，命中结果以 --- Global memory --- 和 --- Workspace memory --- 标注来源。已被压缩成摘要的原始记忆也在搜索范围内，压缩不会丢失信息。\n' +
            '结果受单次输出容量限制；被截断时会提示你缩小正则范围。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                regex: {
                    type: 'string',
                    description: '搜索用的正则表达式，不区分大小写，也会匹配记忆的 ID 和日期。',
                },
            },
            required: ['regex'],
        },
        readOnly: true,
    };
}


/** 把单个作用域的 recall 命中拼进输出行（含来源标注与命中统计） */
function appendRecallSection(lines: string[], result: RecallResult, label: string, name?: string | null): void {
    // 与 wake 一致：工作区段头带文件夹名（如 --- Workspace memory (name) ---）
    lines.push(name ? `--- ${label} memory (${name}) ---` : `--- ${label} memory ---`);
    lines.push(...result.lines);
    if (result.truncated) {
        lines.push(`Newest ${result.lines.length} of ${result.totalHits} matches. Narrow the regex.`);
    } else {
        lines.push(`${result.totalHits} match${result.totalHits === 1 ? '' : 'es'}.`);
    }
}


async function memoryRecallHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const globalMgr = getGlobalMemoryManager();
    if (!globalMgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const regex = String(args.regex ?? '');
        const globalResult = await globalMgr.recall(regex);

        // 工作区记忆也执行同一次搜索（id 各自独立，无需去重）
        let wsResult: RecallResult | null = null;
        // 修改原因：工作区记忆未初始化时静默跳过，模型会误以为工作区没有命中。
        // 修改方式：记录未初始化状态并在结果中附加提示。
        let workspaceNotInitialized = false;
        if (context?.activeWorkspaceUri) {
            // 只读工具：工作区目录不存在时不创建（createIfMissing=false），避免只读访问产生磁盘副作用
            const wsMgr = await getMemoryManagerForWorkspace(context.activeWorkspaceUri, false);
            if (wsMgr) {
                wsResult = await wsMgr.recall(regex);
            } else {
                workspaceNotInitialized = true;
            }
        }

        const lines: string[] = [];
        if (globalResult.totalHits > 0) {
            appendRecallSection(lines, globalResult, 'Global');
        }
        if (wsResult && wsResult.totalHits > 0) {
            const wsName = context?.activeWorkspaceUri ? getWorkspaceFolderName(context.activeWorkspaceUri) : null;
            appendRecallSection(lines, wsResult, 'Workspace', wsName);
        }
        if (lines.length === 0) {
            lines.push('No match.');
        }
        if (workspaceNotInitialized) {
            lines.push('(Workspace memory is not initialized; only global memory was searched.)');
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                totalHits: globalResult.totalHits + (wsResult?.totalHits ?? 0),
                truncated: globalResult.truncated || !!wsResult?.truncated,
                workspaceNotInitialized: workspaceNotInitialized || undefined,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}


function createMemoryRecallTool(): Tool {
    return {
        declaration: createMemoryRecallDeclaration(),
        handler: memoryRecallHandler,
    };
}


function registerMemoryRecall(): Tool {
    return createMemoryRecallTool();
}
return { createMemoryRecallDeclaration, createMemoryRecallTool, registerMemoryRecall };
}
