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
 * 续读场景（part > 1）下，若该作用域已读完全部 part（No part）或记忆总数小于
 * 快照数（T= 错误，意味着它不可能还有未读部分），返回 null 表示「已读完，跳过」——
 * 双作用域各自分页，续读时两个实例都用同一个 part 参数推进，已读完的作用域不应
 * 让整个调用失败。首次读取（part 未传或 1）时这些错误说明快照参数有问题，仍按
 * 旧行为上抛，让模型重新 wake。
 */
async function wakeScope(mgr: MemoryManager, part?: number, snapshotT?: number): Promise<WakeResult | null> {
    try {
        return await mgr.wake(part, snapshotT);
    } catch (e: any) {
        const msg = e?.message ?? '';
        if (part !== undefined && part > 1 && /^(No part \d+:|T=\d+, but the log holds)/.test(msg)) {
            return null;
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
        if (context?.activeWorkspaceUri) {
            const wsMgr = await getMemoryManagerForWorkspace(context.activeWorkspaceUri);
            if (wsMgr) {
                wsResult = await wakeScope(wsMgr, part, snapshotT);
            }
        }

        const globalEmpty = !globalResult || globalResult.totalMemories === 0;
        const wsEmpty = !wsResult || wsResult.totalMemories === 0;
        const globalSkipped = globalResult === null;
        const wsSkipped = wsResult === null;

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
            }
            // 工作区段（该工作区存在记忆时才追加）
            if (wsResult && !wsEmpty) {
                const wsName = context?.activeWorkspaceUri ? getWorkspaceFolderName(context.activeWorkspaceUri) : null;
                lines.push(wsName ? `--- Workspace memory (${wsName}) ---` : '--- Workspace memory ---');
                appendWakeSection(lines, wsResult, 'Workspace');
            }

            const awake = (!globalResult || globalResult.awake) && (!wsResult || wsResult.awake);
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
                const naps: string[] = [];
                if (globalResult?.pendingCompression) naps.push(globalResult.pendingCompression.prompt);
                if (wsResult?.pendingCompression) naps.push(wsResult.pendingCompression.prompt);
                if (naps.length > 0) {
                    lines.push('');
                    lines.push(naps.join('\n\n'));
                }
            }
        }

        return {
            success: true,
            data: {
                text: lines.join('\n'),
                blocks: globalResult?.blocks ?? [],
                part: globalResult?.part ?? 1,
                totalParts: globalResult?.totalParts ?? 1,
                totalMemories: globalResult?.totalMemories ?? 0,
                awake: globalResult?.awake ?? true,
                pendingCompression: globalResult?.pendingCompression,
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
