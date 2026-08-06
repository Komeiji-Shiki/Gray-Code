/**
 * memory_recall 工具
 *
 * 正则搜索全部记忆。
 * 对应 OptMem 的 `memo recall`。
 *
 * 与 wake 一致：同时搜索全局记忆与当前工作区记忆，命中结果按作用域分段标注。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import {
    getGlobalMemoryManager,
    getMemoryManagerForWorkspace,
    getWorkspaceFolderName,
    type RecallResult,
} from '../../modules/memory';

export function createMemoryRecallDeclaration(): ToolDeclaration {
    return {
        name: 'memory_recall',
        description:
            '搜索全部永久记忆（逐字匹配）。支持正则表达式。\n' +
            '搜索范围包括全局记忆与当前工作区记忆（按工作区隔离），命中结果以 --- Global memory --- / --- Workspace memory --- 标注来源。\n' +
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
        if (context?.activeWorkspaceUri) {
            // 只读工具：工作区目录不存在时不创建（createIfMissing=false），避免只读访问产生磁盘副作用
            const wsMgr = await getMemoryManagerForWorkspace(context.activeWorkspaceUri, false);
            if (wsMgr) {
                wsResult = await wsMgr.recall(regex);
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

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                totalHits: globalResult.totalHits + (wsResult?.totalHits ?? 0),
                truncated: globalResult.truncated || !!wsResult?.truncated,
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
