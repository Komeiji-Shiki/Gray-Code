/**
 * BCP-06：分支引用计数扫描 + 存档清理联动注册表（checkpoint 域新模块）。
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

import { Logger } from '../../core/logger';
import type { BranchGraphReadResult } from '../conversation/branch/BranchGraphRepository';
import type { ConversationBranchGraph } from '../conversation/branch/types';
import type { BatchCheckpointDeleteResult } from './types';

const log = Logger.get('checkpointRefCounts');

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
    for (const conversationId of ids) {
        // C-4: 逐会话 try/catch——repo.load 直接抛异常（IO/解析失败）时不再中止整个扫描，
        // 记录后 continue，避免单会话损坏导致全部引用计数丢失。
        let loaded: BranchGraphReadResult;
        try {
            loaded = await repo.load(conversationId);
        } catch (err) {
            log.warn('checkpoint_refcount_load_failed', {
                conversationId,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        const graph: ConversationBranchGraph | null = loaded.graph;
        if (!graph || loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                log.warn('checkpoint_refcount_skip_corrupt_graph', {
                    conversationId,
                    errorMessage: loaded.errorMessage ?? 'unknown',
                });
            }
            continue;
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
    }
    return counts;
}

/**
 * 存档引用计数清理器（BranchService purge/prune 物理清理后的联动入口）。
 * 生产实现 = CheckpointManager（构造时经 setGlobalCheckpointRefCountCleaner 自注册）；
 * 测试可注入假实现。
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
    ): Promise<BatchCheckpointDeleteResult>;
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
