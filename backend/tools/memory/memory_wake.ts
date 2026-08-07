/**
 * memory_wake 工具
 *
 * 唤醒记忆：每次会话开始时读取永久记忆。
 * 对应 OptMem 的 `memo wake`。
 *
 * 记忆分两个作用域：全局记忆（所有工作区共享）与当前工作区记忆（按工作区隔离）。
 * 本工具合并唤醒两个作用域：全局段 + 工作区段，两者各自独立分页推进。
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

/**
 * 唤醒单个作用域。
 *
 * 续读场景（part > 1）下：
 * - "No part" 越界：该作用域已读完全部 part，返回 null 表示「已读完，跳过」——
 *   双作用域各自分页，续读时两个实例共用同一个 part 参数推进，已读完的作用域不应
 *   让整个调用失败。
 * - "T=" 快照不匹配：快照过期（记忆总数少于模型传入的快照数，常见于双作用域共用
 *   同一个 snapshotT，而该作用域记忆更少）。不能当作「已读完」跳过——那会静默丢失
 *   未读内容。记录 console.warn 后用该作用域自身当前总数重试（mgr.wake(part) 不传
 *   snapshotT），重试结果作为该段结果；重试抛 "No part"（该作用域实际 part 数少于
 *   请求值，与直接越界同义）按已读完跳过，其余错误上抛。
 * 首次读取（part 未传或 1）时这些错误说明快照参数有问题，仍按旧行为上抛，让模型重新 wake。
 */
async function wakeScope(mgr: MemoryManager, part?: number, snapshotT?: number): Promise<WakeResult | null> {
    try {
        return await mgr.wake(part, snapshotT);
    } catch (e: any) {
        const msg = e?.message ?? '';
        if (part !== undefined && part > 1) {
            if (/^No part \d+:/.test(msg)) {
                // 该作用域已读完全部 part：跳过
                return null;
            }
            if (/^T=\d+, but the log holds/.test(msg)) {
                // 快照过期：改用该作用域自身当前总数重试，避免误判为已读完而丢内容
                console.warn(`[memory_wake] snapshotT=${snapshotT} 过期（${msg}），改用当前总数重试 part=${part}`);
                try {
                    return await mgr.wake(part);
                } catch (e2: any) {
                    // 重试仍越界：该作用域实际 part 数少于请求值（双作用域共用 part 参数，
                    // 快照 T= 来自另一个更大的作用域）——与直接 "No part" 同义，按已读完跳过
                    if (/^No part \d+:/.test(e2?.message ?? '')) return null;
                    throw e2;
                }
            }
        }
        throw e;
    }
}

/** 把单个作用域的 wake 结果拼进输出行（沿用旧版全局段拼装逻辑） */
function appendWakeSection(lines: string[], result: WakeResult, label: string): void {
    if (result.totalParts > 1) {
        lines.push(`${label} memory, part ${result.part} of ${result.totalParts}, oldest first (${result.totalMemories} memories).`);
    }
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
        const part = typeof args.part === 'number' ? args.part : undefined;
        const snapshotT = typeof args.snapshotT === 'number' ? args.snapshotT : undefined;

        // 双作用域各自独立唤醒（全局 + 当前工作区）
        const globalResult = await wakeScope(globalMgr, part, snapshotT);
        let wsResult: WakeResult | null = null;
        let wsAvailable = false; // 工作区记忆实例是否可用（只读：目录不存在则不创建）
        if (context?.activeWorkspaceUri) {
            // wake 是只读工具：不创建工作区记忆目录（createIfMissing=false）
            const wsMgr = await getMemoryManagerForWorkspace(context.activeWorkspaceUri, false);
            if (wsMgr) {
                wsAvailable = true;
                wsResult = await wakeScope(wsMgr, part, snapshotT);
            }
        }

        const globalEmpty = !globalResult || globalResult.totalMemories === 0;
        const wsEmpty = !wsResult || wsResult.totalMemories === 0;
        // 仅当实例可用且 wake 返回 null（No part 越界）才算「已读完被跳过」；
        // 工作区目录不存在（wsAvailable=false）不算跳过，只是该作用域没有记忆。
        const globalSkipped = globalResult === null;
        const wsSkipped = wsResult === null && wsAvailable;

        // 压缩提示：带作用域标注，模型能判断应作用于哪个作用域
        // （memory_compress 只操作单个作用域，未标注时无法区分）
        const globalPc = globalResult?.pendingCompression;
        const wsPc = wsResult?.pendingCompression;
        const napLines: string[] = [];
        if (globalPc) napLines.push(`[Global] Compress: ${globalPc.prompt}`);
        if (wsPc) napLines.push(`[Workspace] Compress: ${wsPc.prompt}`);

        const awake = (!globalResult || globalResult.awake) && (!wsResult || wsResult.awake);

        const lines: string[] = [];
        if (globalEmpty && wsEmpty) {
            if (globalSkipped || wsSkipped) {
                // 两个作用域都为空是因为续读越界（都已读完全部 part），
                // 不应误导为「没有记忆」——按旧行为报错让模型重新 wake
                throw new Error(`No part ${part}: memory already fully read. Run memory_wake.`);
            }
            lines.push('No memories yet. Record the first with memory_note.');
            lines.push('You are awake.');
        } else {
            // 全局段（双段并存时加段首标注，便于模型区分两个作用域）
            if (globalResult && !globalEmpty) {
                if (!wsEmpty) lines.push('--- Global memory ---');
                appendWakeSection(lines, globalResult, 'Global');
            } else if (globalSkipped && !wsEmpty) {
                // 续读越界被跳过：占位说明，模型可区分「已读完」与「出错」
                lines.push('(Global memory already fully read)');
            }
            // 工作区段（该工作区存在记忆时才追加）
            if (wsResult && !wsEmpty) {
                const wsName = context?.activeWorkspaceUri ? getWorkspaceFolderName(context.activeWorkspaceUri) : null;
                lines.push(wsName ? `--- Workspace memory (${wsName}) ---` : '--- Workspace memory ---');
                appendWakeSection(lines, wsResult, 'Workspace');
            } else if (wsSkipped && !globalEmpty) {
                // 续读越界被跳过：占位说明，模型可区分「已读完」与「出错」
                lines.push('(Workspace memory already fully read)');
            }

            if (!awake) {
                if (globalResult && !globalResult.awake && (!wsResult || wsResult.awake)) {
                    lines.push(`Not awake yet. Run: memory_wake part=${globalResult.part + 1} snapshotT=${globalResult.totalMemories}`);
                } else if (wsResult && !wsResult.awake && (!globalResult || globalResult.awake)) {
                    lines.push(`Not awake yet. Run: memory_wake part=${wsResult.part + 1} snapshotT=${wsResult.totalMemories}`);
                } else {
                    // 两个作用域都未完：共用同一个 part 参数推进（已读完的作用域会自动跳过）
                    const nextPart = Math.max(globalResult?.part ?? 1, wsResult?.part ?? 1) + 1;
                    lines.push(`Not awake yet. Run: memory_wake part=${nextPart}`);
                }
            } else {
                lines.push('You are awake.');
                if (napLines.length > 0) {
                    lines.push('');
                    lines.push(napLines.join('\n\n'));
                }
            }
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                // 顶层元数据合并两个作用域口径（原先只取全局，与文本矛盾）
                blocks: [...(globalResult?.blocks ?? []), ...(wsResult?.blocks ?? [])],
                part: Math.max(globalResult?.part ?? 0, wsResult?.part ?? 0),
                totalParts: (globalResult?.totalParts ?? 0) + (wsResult?.totalParts ?? 0),
                totalMemories: (globalResult?.totalMemories ?? 0) + (wsResult?.totalMemories ?? 0),
                awake,
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
