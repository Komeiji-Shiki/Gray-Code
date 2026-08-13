/**
 * 分支图读写删接口（BR-06，拆分自 BranchService.ts）。
 *
 * getBranchGraph / getBranchGraphMeta / saveBranchGraph / deleteConversationBranch 是
 * 分支图 sidecar 的读写删入口，与候选生命周期、保留期清理等职责相互独立。抽到本文件后
 * BranchService 在同名 public 方法中委托，方法签名与行为保持不变。
 */

import { Logger } from '../../../core/logger';
import {
    activePath,
    collectDeletedNodes,
    validate,
} from './BranchGraph';
import type { BranchGraphReadResult } from './BranchGraphRepository';
import {
    deleteBranchGraphCached,
    getBranchGraphCacheKey,
    getBranchGraphCached,
    setBranchGraphCached,
} from './branchGraphCache';
import {
    assertConversationWritable,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import type { BranchGraphMetaResult } from './branchServiceTypes';
import { BranchError } from './types';
import type { ConversationBranchGraph } from './types';

const log = Logger.get('BranchService');

/**
 * 读取分支图（BR-06）。
 * - 文件不存在 → { graph: null }（线性模式）；
 * - 损坏（解析失败 / 结构不符 / 读取侧语义校验失败）→
 *   { graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT' }（读取降级，不抛错）。
 * 只读操作不进入会话写锁（sidecar 为原子替换，读不参与写串行）。
 *
 * M-2：仓储层只做浅层 shape 检查，可解析但语义损坏（环 / 悬空 parentId /
 * activeChildId 指向非子节点 / 版本不符 / 尾指针非终端等）的图不得原样下发——
 * 此处对 loaded.graph 做 validate() + activePath() 语义校验，损坏同样返回 errorCode。
 */
export async function getBranchGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<BranchGraphReadResult> {
    const cacheKey = getBranchGraphCacheKey(ctx.repository, conversationId);
    const cached = await getBranchGraphCached(cacheKey);
    if (cached) {
        // 缓存内图在回填时已通过 validate + activePath（见下与 validateAndSave），直接复用。
        // 返回的是缓存条目共享引用（只读契约）：调用方不得原地修改，需要改动先自行拷贝。
        return { graph: cached };
    }
    const loaded = await ctx.repository.load(conversationId);
    if (loaded.graph) {
        const validation = validate(loaded.graph);
        if (!validation.valid) {
            return {
                graph: null,
                errorCode: 'BRANCH_STORAGE_CORRUPT',
                errorMessage: `semantic validation failed: ${validation.issues.map(i => i.message).join('; ')}`,
            };
        }
        try {
            activePath(loaded.graph);
        } catch (error) {
            return {
                graph: null,
                errorCode: 'BRANCH_STORAGE_CORRUPT',
                errorMessage: `active path resolution failed: ${(error as Error)?.message ?? String(error)}`,
            };
        }
        // 校验通过才回填缓存（损坏态不缓存，保持降级语义）
        await setBranchGraphCached(cacheKey, loaded.graph);
    }
    return loaded;
}

/**
 * 分支图元信息（BR-06）：轻量摘要，避免整图下发。
 * 三态语义（BS-1）：
 * - 无图：exists=false，无 errorCode；
 * - 损坏（仓储解析失败 / 结构不符 / 读取侧语义校验失败）：exists=false +
 *   corrupted=true + errorCode='BRANCH_STORAGE_CORRUPT'（M-1/M-2 兑现注释承诺）；
 * - 存在可用：exists=true。
 */
export async function getBranchGraphMeta(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<BranchGraphMetaResult> {
    const cacheKey = getBranchGraphCacheKey(ctx.repository, conversationId);
    const cached = await getBranchGraphCached(cacheKey);
    const loaded = cached
        ? { graph: cached } as BranchGraphReadResult
        : await ctx.repository.load(conversationId);
    const base: BranchGraphMetaResult = {
        conversationId,
        exists: false,
        rootNodeId: null,
        activeTailNodeId: null,
        nodeCount: 0,
        candidateCount: 0,
        deletedCount: 0,
        activePathLength: 0,
        exportedRefs: [],
    };
    if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        // 仓储损坏（JSON 解析失败 / 结构不符）：M-1 透出 errorCode
        return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
    }
    if (!loaded.graph) {
        return { ...base, exists: false };
    }
    const graph = loaded.graph;
    // M-2：读取侧语义校验（validate + activePath），语义损坏同样降级为损坏态
    const validation = validate(graph);
    if (!validation.valid) {
        log.warn('branch_graph_meta_semantic_corrupt', {
            conversationId,
            issues: validation.issues.map(i => i.message),
        });
        return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
    }
    try {
        // M-2 校验通过：回填缓存（缓存命中路径已跳过校验，见 getBranchGraph 注释）
        await setBranchGraphCached(cacheKey, graph);
        return {
            conversationId,
            exists: true,
            rootNodeId: graph.rootNodeId,
            activeTailNodeId: graph.activeTailNodeId,
            nodeCount: Object.keys(graph.nodes).length,
            candidateCount: (graph.candidateSummaries ?? []).filter(s => !s.deleted).length,
            deletedCount: collectDeletedNodes(graph).length,
            activePathLength: activePath(graph).length,
            exportedFrom: graph.exportedFrom,
            exportedRefs: graph.exportedRefs ?? [],
        };
    } catch (error) {
        // 图结构自相矛盾（环等）：与仓储损坏统一为 exists:false + corrupted + errorCode（M-2/BS-1）
        log.warn('branch_graph_meta_unavailable', { conversationId, error: (error as Error)?.message ?? String(error) });
        return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
    }
}

/**
 * 保存分支图（BR-06）。先 validate 再持久化；结构无效抛 BRANCH_STORAGE_CORRUPT。
 * 写入进入会话写锁（BR-07），保证与主历史写入串行。
 */
export async function saveBranchGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    graph: ConversationBranchGraph
): Promise<void> {
    const validation = validate(graph);
    if (!validation.valid) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `refusing to persist invalid branch graph: ${validation.issues.map(i => i.message).join('; ')}`
        );
    }
    await ctx.conversationManager.runExclusive(conversationId, async () => {
        // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）
        await assertConversationWritable(ctx, conversationId);
        await ctx.repository.save(conversationId, graph);
    });
    // 写后回填缓存（调用方传入的 graph 可能被后续复用/修改，只存快照）
    await setBranchGraphCached(getBranchGraphCacheKey(ctx.repository, conversationId), graph);
}

/**
 * 删除会话的分支图 sidecar（BR-06；级联清理，幂等）。
 * 对话删除时由 ConversationManager.deleteConversation 接线调用（BR-04 清理要求；
 * 该调用点在会话写锁之外，不会重入死锁）。
 *
 * M-5：删除与 sidecar 写入共用会话写锁，保证并发「写→删」先写后删（无残留）、
 * 「删→写」删除后不再重建（迟到写由 assertConversationWritable 在锁内拒绝）。
 * 本方法是级联清理路径，不做已删除会话检查（删除进行中/刚完成时正是它被调用的时机）。
 */
export async function deleteConversationBranch(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<void> {
    ctx.state.deferredStructuralSyncConversationIds.delete(conversationId);
    ctx.state.pendingRewriteExpectations.delete(conversationId);
    deleteBranchGraphCached(getBranchGraphCacheKey(ctx.repository, conversationId));
    await ctx.conversationManager.runExclusive(conversationId, async () => {
        await ctx.repository.deleteConversation(conversationId);
    });
}
