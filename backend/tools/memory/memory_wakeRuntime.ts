import type { Tool, ToolDeclaration, ToolResult, ToolContext } from '../types';
import type { MemoryEngine as MemoryManager } from '../../modules/memory/MemoryEngine';
import type { WakeResult } from '../../modules/memory/types';
import type { MemoryToolHost } from './host';
import { compactNapPrompt } from './napPrompt';

export function createMemoryWakeRuntime(host: MemoryToolHost) {
const { getGlobalMemoryManager, getMemoryManagerForWorkspace, getWorkspaceFolderName } = host;


function createMemoryWakeDeclaration(): ToolDeclaration {
    return {
        name: 'memory_wake',
        description:
            '读取工程日志记忆，也就是 memory_note 写下的项目约定和经验。它和用户的个人长期记忆是两套系统，个人长期记忆请用 memory_search 或 memory_read 查阅。\n' +
            '在新的工作会话开始、且以往的约定可能影响当前任务时调用；与历史无关、也不需要工具的简单回复不必调用。\n' +
            '输出分为全局记忆和当前工作区记忆两部分，分别以 --- Global memory --- 和 --- Workspace memory --- 标注。近期的记忆保留原文，较早的记忆以压缩摘要呈现。\n' +
            '输出较长时会分成多个部分，请按输出末尾的提示依次读取，直到看到 "You are awake." 为止。成功结果中的 pendingCompression 可延后处理，不要中断当前用户任务。',
        category: 'memory',
        parameters: {
            type: 'object',
            properties: {
                part: {
                    type: 'integer',
                    minimum: 1,
                    description: '要读取的部分号，从 1 开始，默认为 1。',
                },
                snapshotT: {
                    type: 'integer',
                    minimum: 0,
                    description: '第一次读取时的记忆总数，从输出末尾的提示中复制，用来让后续部分与第一部分保持一致。首次调用不传或传 0，表示使用当前总数。',
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


function parseWakeInteger(
    value: unknown,
    name: 'part' | 'snapshotT',
    zeroMeansOmitted: boolean
): number | undefined {
    if (value === undefined || value === null || (zeroMeansOmitted && value === 0)) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}


async function memoryWakeHandler(args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const globalMgr = getGlobalMemoryManager();
    if (!globalMgr) {
        return { success: false, error: 'MemoryManager is not initialized.' };
    }

    try {
        const part = parseWakeInteger(args.part, 'part', false);
        // 首次 wake 没有可沿用的快照。部分模型/工具客户端会为可选数值参数填 0；
        // 0 不可能对应需要续读的有效快照（空快照在第 1 页已经 awake），因此按“未传”
        // 处理并读取各作用域当前总数，避免把已有记忆伪装成空记忆。
        const snapshotT = parseWakeInteger(args.snapshotT, 'snapshotT', true);

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
                // 记忆条目与压缩提示只在 text 中出现一次；结构化字段只留不重复正文的元数据。
                text: lines.join('\n'),
                // 顶层元数据合并两个作用域口径（原先只取全局，与文本矛盾）
                part: Math.max(globalResult?.part ?? 0, wsResult?.part ?? 0),
                // 两个作用域在同一次调用中并行读取相同 part；完成全部读取所需的调用次数
                // 是两者页数的最大值，而不是页数之和。求和会让两个空作用域显示 Part 1/2。
                totalParts: Math.max(globalResult?.totalParts ?? 0, wsResult?.totalParts ?? 0),
                totalMemories: (globalResult?.totalMemories ?? 0) + (wsResult?.totalMemories ?? 0),
                awake,
                // 压缩提示正文已在 text 末尾；这里按作用域给出待压缩块，供界面与调用方判断。
                pendingCompression: awake && (globalPc || wsPc) ? {
                    ...(globalPc ? { global: compactNapPrompt(globalPc) } : {}),
                    ...(wsPc ? { workspace: compactNapPrompt(wsPc) } : {}),
                } : undefined,
                workspace: wsResult ? { uri: context?.activeWorkspaceUri, totalMemories: wsResult.totalMemories } : undefined,
            },
        };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}


function createMemoryWakeTool(): Tool {
    return {
        declaration: createMemoryWakeDeclaration(),
        handler: memoryWakeHandler,
    };
}


function registerMemoryWake(): Tool {
    return createMemoryWakeTool();
}
return { createMemoryWakeDeclaration, createMemoryWakeTool, registerMemoryWake };
}
