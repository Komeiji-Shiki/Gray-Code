/**
 * memory_wake 工具
 *
 * 唤醒记忆：每次会话开始时读取永久记忆。
 * 对应 OptMem 的 `memo wake`。
 *
 * 记忆分两个作用域：全局记忆（所有工作区共享）与当前工作区记忆（按工作区隔离）。
 * 本工具一次调用合并唤醒两个作用域的全部可用记忆：全局段 + 工作区段。
 */

import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import {
    getGlobalMemoryManager,
    getMemoryManagerForWorkspace,
    getWorkspaceFolderName,
    type MemoryManager,
    type WakeResult,
} from '../../modules/memory';

export function createMemoryWakeDeclaration(): ToolDeclaration {
    return {
        name: 'memory_wake',
        description:
            '唤醒永久记忆。在每次会话开始时、做任何其他事情之前必须先调用此工具。\n' +
            '输出包含两部分：全局记忆与当前工作区记忆（按工作区隔离），以 --- Global memory --- / --- Workspace memory --- 标注。\n' +
            '它会一次输出你的全部可用记忆：近期的记忆保持原文，远期的记忆被压缩为摘要。\n' +
            '不需要任何参数。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {},
        },
        readOnly: true,
    };
}

/** 把单个作用域的 wake 结果拼进输出行 */
function appendWakeSection(lines: string[], result: WakeResult, label: string): void {
    for (const block of result.blocks) {
        if (block.isRaw) {
            lines.push(`#${block.lo} ${block.text}`);
        } else {
            lines.push(`#${block.lo}-${block.hi} ${block.text}`);
        }
    }
}

async function memoryWakeHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const globalMgr = getGlobalMemoryManager();
    if (!globalMgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        // 双作用域各自唤醒（全局 + 当前工作区），一次输出全部记忆
        const globalResult = await globalMgr.wake();
        let wsResult: WakeResult | null = null;
        let wsAvailable = false; // 工作区记忆实例是否可用（只读：目录不存在则不创建）
        if (context?.activeWorkspaceUri) {
            // wake 是只读工具：不创建工作区记忆目录（createIfMissing=false）
            const wsMgr = await getMemoryManagerForWorkspace(context.activeWorkspaceUri, false);
            if (wsMgr) {
                wsAvailable = true;
                wsResult = await wsMgr.wake();
            }
        }

        const globalEmpty = globalResult.totalMemories === 0;
        const wsEmpty = !wsResult || wsResult.totalMemories === 0;

        // 压缩提示：带作用域标注，模型能判断应作用于哪个作用域
        // （memory_compress 只操作单个作用域，未标注时无法区分）
        const globalPc = globalResult.pendingCompression;
        const wsPc = wsResult?.pendingCompression;
        const napLines: string[] = [];
        if (globalPc) napLines.push(`[Global] Compress: ${globalPc.prompt}`);
        if (wsPc) napLines.push(`[Workspace] Compress: ${wsPc.prompt}`);

        const lines: string[] = [];
        if (globalEmpty && wsEmpty) {
            lines.push('No memories yet. Record the first with memory_note.');
            lines.push('You are awake.');
        } else {
            // 全局段（双段并存时加段首标注，便于模型区分两个作用域）
            if (!globalEmpty) {
                if (!wsEmpty) lines.push('--- Global memory ---');
                appendWakeSection(lines, globalResult, 'Global');
            }
            // 工作区段（该工作区存在记忆时才追加）
            if (wsResult && !wsEmpty) {
                const wsName = context?.activeWorkspaceUri ? getWorkspaceFolderName(context.activeWorkspaceUri) : null;
                lines.push(wsName ? `--- Workspace memory (${wsName}) ---` : '--- Workspace memory ---');
                appendWakeSection(lines, wsResult, 'Workspace');
            }

            lines.push('You are awake.');
            if (napLines.length > 0) {
                lines.push('');
                lines.push(napLines.join('\n\n'));
            }
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                // 顶层元数据合并两个作用域口径
                blocks: [...globalResult.blocks, ...(wsResult?.blocks ?? [])],
                totalMemories: globalResult.totalMemories + (wsResult?.totalMemories ?? 0),
                awake: true,
                // 压缩提示：返回两段中非空的那个（合并提示文本，带作用域标注）
                pendingCompression: (() => {
                    if (napLines.length === 0) return undefined;
                    const base = globalPc ?? wsPc;
                    return base ? { ...base, prompt: napLines.join('\n\n') } : undefined;
                })(),
                workspace: wsResult ? { uri: context?.activeWorkspaceUri, totalMemories: wsResult.totalMemories } : undefined,
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
