/**
 * 分支软删统计 / 修剪 / 保留期配置（TREE-09，拆分自 BranchService.ts）。
 *
 * getDeletedBranchCount / pruneDeletedBranches / getBranchRetentionConfig /
 * updateBranchRetentionConfig 是「软删分支的统计与物理清理」职责，独立于候选生命周期与
 * 读写删接口。抽到本文件后 BranchService 在同名 public 方法中委托，方法签名与行为不变。
 */

import {
    activePath,
    collectDeletedNodes,
    pruneDeletedNodes,
    validate,
} from './BranchGraph';
import {
    cleanupZeroReferencedCheckpoints,
    validateAndSave,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import type { BranchDeletedCountResult, BranchPruneResult } from './branchServiceTypes';
import { BranchError } from './types';
import type { BranchRetentionConfig } from './types';

/**
 * TREE-09：统计软删分支数量。
 * - 指定 conversationId：只统计该会话（无图/损坏 → 0，不抛错）；
 * - 缺省：扫描全部带 sidecar 的会话（设置页「软删分支数量」展示用）；
 * - R8c-P4：与 pruneDeletedBranches 同口径——会话元数据不存在（孤儿 sidecar，会话已删除/不存在）
 *   不计数也不计入 conversationCount，保证设置页清理后数量归零（此前孤儿 sidecar 照常计数，
 *   prune 却跳过它们，数量清理后不归零）。
 * 只读操作，不进入会话写锁。
 */
export async function getDeletedBranchCount(
    ctx: BranchServiceCoreContext,
    options: { conversationId?: string } = {}
): Promise<BranchDeletedCountResult> {
    const conversationIds = options.conversationId
        ? [options.conversationId]
        : await ctx.repository.listConversationIds();
    let deletedNodeCount = 0;
    let conversationCount = 0;
    for (const conversationId of conversationIds) {
        const metadata = await ctx.conversationManager.getMetadata(conversationId);
        if (!metadata) {
            continue; // 孤儿 sidecar：会话已不存在，不计数（与 prune 的 skippedConversations 同口径）
        }
        conversationCount += 1;
        const loaded = await ctx.repository.load(conversationId);
        if (!loaded.graph || loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            continue;
        }
        if (!validate(loaded.graph).valid) {
            continue; // 语义损坏图不计数（读取侧同样降级）
        }
        deletedNodeCount += collectDeletedNodes(loaded.graph).length;
    }
    return { conversationCount, deletedNodeCount };
}

/**
 * TREE-09：物理清理过期软删分支（prune）。
 * - 指定 conversationId：只清理该会话；缺省：全量扫描所有带 sidecar 的会话；
 * - 过期判定：deletedAt（缺失兜底 createdAt）+ retentionDays；
 * - retentionDays 优先级：显式入参 > branches.config.json 持久化配置 > 构造默认值；
 * - 过期节点连同整棵子树物理移除，同步清理候选摘要与 exportedFrom/exportedRefs 引用；
 * - 每个会话在会话写锁内执行（BR-07）；损坏 sidecar 跳过不覆盖（MIG-05 完整性工具负责修复）；
 *   会话已删除/不存在跳过（assertConversationWritable 冲突）。
 * - 工作区存档的引用计数清理属 BCP-06，本批只做图侧清理。
 */
export async function pruneDeletedBranches(
    ctx: BranchServiceCoreContext,
    defaultRetentionDays: number,
    options: {
        conversationId?: string;
        retentionDays?: number;
        now?: number;
    } = {}
): Promise<BranchPruneResult> {
    const persisted = await ctx.repository.loadBranchRetentionConfig();
    const retentionDays = options.retentionDays ?? persisted.retentionDays ?? defaultRetentionDays;
    const conversationIds = options.conversationId
        ? [options.conversationId]
        : await ctx.repository.listConversationIds();

    const result: BranchPruneResult = {
        conversationsScanned: conversationIds.length,
        conversationsChanged: 0,
        prunedNodeCount: 0,
        corruptConversations: [],
        skippedConversations: [],
    };
    // BCP-06: 记录每个会话本次物理移除的节点 id（清理存档引用归零用；图侧绑定随节点消失）
    const prunedNodeIdsByConversation = new Map<string, string[]>();
    for (const conversationId of conversationIds) {
        const outcome = await ctx.conversationManager.runExclusive(conversationId, async () => {
            // BS-4：会话已删除/不存在 → 跳过（迟到清理不重建 sidecar）
            const metadata = await ctx.conversationManager.getMetadata(conversationId);
            if (!metadata) {
                return { corrupt: false, skipped: true, changed: false, pruned: 0 };
            }
            const loaded = await ctx.repository.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT' || !loaded.graph) {
                return { corrupt: loaded.errorCode === 'BRANCH_STORAGE_CORRUPT', skipped: false, changed: false, pruned: 0 };
            }
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                return { corrupt: true, skipped: false, changed: false, pruned: 0 };
            }
            try {
                activePath(loaded.graph);
            } catch {
                return { corrupt: true, skipped: false, changed: false, pruned: 0 };
            }
            const { graph: next, prunedNodeIds } = pruneDeletedNodes(loaded.graph, {
                now: options.now,
                retentionDays,
            });
            if (prunedNodeIds.length === 0) {
                return { corrupt: false, skipped: false, changed: false, pruned: 0 };
            }
            await validateAndSave(ctx, conversationId, next);
            prunedNodeIdsByConversation.set(conversationId, prunedNodeIds);
            return { corrupt: false, skipped: false, changed: true, pruned: prunedNodeIds.length };
        });
        if (outcome.corrupt) {
            result.corruptConversations.push(conversationId);
        }
        if (outcome.skipped) {
            result.skippedConversations.push(conversationId);
        }
        if (outcome.changed) {
            result.conversationsChanged += 1;
            result.prunedNodeCount += outcome.pruned;
        }
        // BCP-06：本会话物理清理完成后（会话写锁已释放），引用归零存档清理（同步；失败仅 warn）
        const removedNodeIds = prunedNodeIdsByConversation.get(conversationId);
        if (removedNodeIds && removedNodeIds.length > 0) {
            await cleanupZeroReferencedCheckpoints(ctx.repository, conversationId, removedNodeIds);
        }
    }
    return result;
}

/**
 * TREE-09：读取分支保留期配置（持久化 branches.config.json；缺失/损坏返回默认 30 天）。
 */
export async function getBranchRetentionConfig(
    ctx: BranchServiceCoreContext,
    defaultRetentionDays: number
): Promise<BranchRetentionConfig> {
    const persisted = await ctx.repository.loadBranchRetentionConfig();
    return { retentionDays: persisted.retentionDays ?? defaultRetentionDays };
}

/**
 * TREE-09：更新分支保留期配置（持久化 branches.config.json；非法值抛 INVALID_BRANCH_RELATION）。
 * 0 = 不自动清理（永不过期）。
 */
export async function updateBranchRetentionConfig(
    ctx: BranchServiceCoreContext,
    retentionDays: number
): Promise<BranchRetentionConfig> {
    if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays)
        || !Number.isInteger(retentionDays) || retentionDays < 0) {
        throw new BranchError(
            'INVALID_BRANCH_RELATION',
            `invalid retentionDays: ${String(retentionDays)} (must be a non-negative integer, 0 = never auto-prune)`
        );
    }
    const config: BranchRetentionConfig = { retentionDays };
    await ctx.repository.saveBranchRetentionConfig(config);
    return config;
}
