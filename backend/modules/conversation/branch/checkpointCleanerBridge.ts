/**
 * BCP-06：分支引用计数扫描 + 存档清理器注册桥（conversation 域接线点，E1 解环）。
 *
 * E1 环解除（第五批模块化重构）：
 * - 重构前：BranchService（conversation）运行时 import checkpoint/checkpointRefCounts，
 *   而 checkpointRefCounts 又 type-import conversation/branch 类型、CheckpointManager
 *   type-import conversation 门面 → conversation ↔ checkpoint 双向依赖同一套
 *   「branch 引用计数 ↔ checkpoint 清理」逻辑，两模块无法独立演进；
 * - 重构后：引用计数扫描（computeCheckpointReferenceCounts——数据源是 BranchGraph，
 *   扫描属分支侧职责）与清理器注册表收敛到本桥（conversation 域，零 checkpoint 依赖）；
 *   checkpoint 侧只做两件事：
 *   1. CheckpointManager 构造时经 setGlobalCheckpointRefCountCleaner 注册生产实现
 *      （注册时机与语义不变，见 CheckpointManager 构造函数）；
 *   2. checkpointRefCounts.ts 保留为兼容导出壳（checkpoint/index.ts 门面与既有测试
 *      导入路径零改动）。
 *   依赖方向收敛为单向：checkpoint → conversation（注册 + 类型），
 *   conversation 不再 import checkpoint 内部实现（含类型）。
 *
 * 职责（与 CheckpointRetentionService 正交）：
 * - Retention 管「数量上限」（maxCheckpoints），本模块管「分支节点引用归零」的存档回收；
 * - 计数模型 v1 = 扫描所有 BranchGraph（规划 L1657 选项一），不做持久化 counter
 *   （研究 §5.2：持久化 counter 需绑定/解绑/迁移三处维护且崩溃不一致风险高，节点数有限扫描成本可接受）；
 * - 删除执行复用 CheckpointManager.deleteCheckpointsByNodeIds（CP-05 祖先闭包合并）。
 *
 * 计数口径（研究 §5.2 + BCP-08 场景 17-23）：
 * - 只统计**存活**节点（!deleted）的 workspaceCheckpointId；软删节点不计数
 *   （保留期内引用不算，prune 后即失效；恢复软删分支时其存档可能已被清理 →
 *   BCP-05 恢复前校验存档存在性兜底，workspaceState 置 'unavailable'）；
 * - 同一对话多节点引用同一存档 → 计数累加（去重按节点天然完成：每节点最多一个绑定）；
 * - 损坏/缺失 sidecar 跳过（与 pruneDeletedBranches 同口径），warn 记录；
 * - checkpointId 全局唯一生成（CheckpointManager.generateCheckpointId），跨对话引用
 *   天然计数（全量扫描保证），无需按对话隔离。
 */

import { Logger } from '../../../core/logger';
import type { BranchGraphReadResult } from './BranchGraphRepository';
import type { ConversationBranchGraph } from './types';

// 日志类别保持 'checkpointRefCounts'（与解环前逐位一致，日志过滤行为不变）。
const log = Logger.get('checkpointRefCounts');

// 本地有界并发（与 checkpoint/checkpointConcurrency 的 runBounded 语义逐行一致）。
// 本桥处于 conversation 域，为保持「conversation 不再 import checkpoint 内部实现」的
// 单向依赖，不反向引用 checkpoint 模块（checkpointConcurrency 头注释即记载了
// 「模块内私有 runBounded 与共享实现语义一致」的同模式先例）。
const DEFAULT_CHECKPOINT_CONCURRENCY = 8;

/** C-7: 规整并发度——NaN/负值/非法数值回退 DEFAULT，避免 Array.from({length:NaN}) 生成 0 个 worker 静默跳过全部任务 */
function effectiveConcurrency(concurrency: number): number {
    return Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : DEFAULT_CHECKPOINT_CONCURRENCY;
}

/**
 * 有界并发池：以固定并发度执行 items，全部完成后返回。
 *
 * 错误语义：任意 worker 抛错时停止取新任务，只抛出第一个错误；
 * 其余 worker 的错误被吞掉，避免多个并发 rejection 产生 unhandled rejection。
 */
async function runBounded<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    let nextIndex = 0;
    let firstError: unknown;
    const runNext = async (): Promise<void> => {
        while (nextIndex < items.length) {
            if (firstError !== undefined) return;
            const index = nextIndex;
            nextIndex += 1;
            try {
                await worker(items[index]);
            } catch (error) {
                if (firstError === undefined) {
                    firstError = error;
                }
                return;
            }
        }
    };
    const workers = Array.from(
        { length: Math.min(Math.max(effectiveConcurrency(concurrency), 1), items.length) },
        () => runNext()
    );
    await Promise.all(workers);
    if (firstError !== undefined) {
        throw firstError;
    }
}

/**
 * 只读图源：与 BranchGraphRepository 结构化兼容（listConversationIds + load 均已具备）。
 * 定义成最小接口便于 checkpoint 域测试注入轻量假实现。
 */
export interface CheckpointRefCountGraphSource {
    listConversationIds(): Promise<string[]>;
    load(conversationId: string): Promise<BranchGraphReadResult>;
}

/**
 * 统计每个 checkpointId 被多少存活分支节点引用（节点.workspaceCheckpointId 计数）。
 *
 * @param repo 只读图源（生产传 BranchGraphRepository；listConversationIds + load）
 * @param conversationIds 显式限定扫描的会话；缺省 = 扫描全部带 sidecar 的会话
 *   （BranchGraphRepository.listConversationIds）
 * @returns Map<checkpointId, refCount>；无引用的存档不出现（缺失即 0）
 */
export async function computeCheckpointReferenceCounts(
    repo: CheckpointRefCountGraphSource,
    conversationIds?: string[]
): Promise<Map<string, number>> {
    const ids = conversationIds ?? (await repo.listConversationIds());
    const counts = new Map<string, number>();
    // C-4: 逐会话 try/catch——repo.load 直接抛异常（IO/解析失败）时不再中止整个扫描，
    // 记录后 continue，避免单会话损坏导致全部引用计数丢失。
    // C-18: 有界并发（runBounded）替代逐会话串行 await——会话多时不串行放大扫描耗时；
    // counts 是共享 Map，单线程环境下并发累加安全（worker 内 try/catch 语义与串行一致）
    await runBounded(ids, DEFAULT_CHECKPOINT_CONCURRENCY, async conversationId => {
        let loaded: BranchGraphReadResult;
        try {
            loaded = await repo.load(conversationId);
        } catch (err) {
            log.warn('checkpoint_refcount_load_failed', {
                conversationId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        const graph: ConversationBranchGraph | null = loaded.graph;
        if (!graph || loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                log.warn('checkpoint_refcount_skip_corrupt_graph', {
                    conversationId,
                    errorMessage: loaded.errorMessage ?? 'unknown',
                });
            }
            return;
        }
        for (const node of Object.values(graph.nodes)) {
            if (node.deleted) {
                continue;
            }
            const checkpointId = node.workspaceCheckpointId;
            if (typeof checkpointId === 'string' && checkpointId.length > 0) {
                counts.set(checkpointId, (counts.get(checkpointId) ?? 0) + 1);
            }
        }
    });
    return counts;
}

/**
 * 存档引用计数清理器（BranchService purge/prune 物理清理后的联动入口）。
 * 生产实现 = CheckpointManager（构造时经 setGlobalCheckpointRefCountCleaner 自注册）；
 * 测试可注入假实现。
 *
 * 返回类型取 checkpoint 域 BatchCheckpointDeleteResult 的结构化子集
 * （deletedIds / rejectedIds，BranchService 只消费这两个字段），
 * 使本桥保持零 checkpoint 依赖；CheckpointManager.deleteCheckpointsByNodeIds
 * 的完整返回类型结构化兼容本契约。
 */
export interface CheckpointRefCountCleaner {
    /**
     * 按 nodeId 过滤候选存档并按引用计数删除。
     * @param conversationId 会话 ID
     * @param nodeIds 已物理移除的分支节点 ID（候选 = 本对话中 messageNodeId ∈ nodeIds 的存档记录）
     * @param options.referenceCounts 引用计数快照（prune/purge 后重扫全量 BranchGraph 得到）；
     *   refCount>0 的候选拒绝（除非 force）
     * @param options.force 强制删除（跳过引用计数闸门；CP-05 链保护仍生效）
     */
    deleteCheckpointsByNodeIds(
        conversationId: string,
        nodeIds: string[],
        options?: { force?: boolean; referenceCounts?: Map<string, number> }
    ): Promise<{ deletedIds: string[]; rejectedIds: string[] }>;
}

/** 模块级单例（与 BranchService.setGlobalBranchService 同模式）；CheckpointManager 构造时注册 */
let globalCheckpointRefCountCleaner: CheckpointRefCountCleaner | undefined;

/** 注册全局存档引用计数清理器（测试可用 undefined 重置） */
export function setGlobalCheckpointRefCountCleaner(cleaner: CheckpointRefCountCleaner | undefined): void {
    globalCheckpointRefCountCleaner = cleaner;
}

/** 获取全局存档引用计数清理器（未注册返回 undefined；BranchService 的 purge/prune 联动用它） */
export function getGlobalCheckpointRefCountCleaner(): CheckpointRefCountCleaner | undefined {
    return globalCheckpointRefCountCleaner;
}
