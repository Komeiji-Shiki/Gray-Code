/**
 * BranchService 共享核心（拆分自 BranchService.ts 的私有工具方法组）。
 *
 * 这些方法原本是 BranchService 的私有实例方法，被 BR-06/07、TREE-01/03/09、BS-2、
 * BCP-02 等各职责组大量复用。抽为自由函数后，各职责服务（branchStoreService /
 * branchReconcileService / branchCandidateService / branchRetentionService /
 * branchHistorySyncService）与 BranchService 委托入口共用同一份实现，保持行为不变。
 *
 * 上下文只依赖 ConversationManager 与 BranchGraphRepository（二者均来自 BranchService
 * 构造入参），外加实例级共享状态（deferredStructuralSyncConversationIds /
 * pendingRewriteExpectations），避免把 BranchService 实例本身暴露给子模块。
 */

import { newUuid } from '../../../core/id';
import { Logger } from '../../../core/logger';
import type { Content } from '../types';
import {
    activePath,
    childrenIndex,
    findUnsyncedFunctionResponses,
    importLinearHistory,
    isFunctionResponseMessage,
    validate,
} from './BranchGraph';
import {
    computeCheckpointReferenceCounts,
    getGlobalCheckpointRefCountCleaner,
} from './checkpointCleanerBridge';
import { getBranchGraphCacheKey, getBranchGraphCached, setBranchGraphCached } from './branchGraphCache';
import { MAX_CANDIDATES_PER_PARENT } from './branchServiceTypes';
import type { BranchCandidateInput } from './branchServiceTypes';
import { BranchError } from './types';
import type { BranchGraphRepository } from './BranchGraphRepository';
import type { ConversationBranchGraph, ConversationBranchNode } from './types';
import type { ConversationManager } from '../ConversationManager';

const log = Logger.get('BranchService');

/** BranchService 实例级共享状态（各职责服务共用同一份引用）。 */
export interface BranchServiceState {
    /** 活跃空候选期间被延迟的总结结构同步；候选终结后一次性收敛。 */
    deferredStructuralSyncConversationIds: Set<string>;
    /**
     * 「切图 → 主历史重写」非原子窗口的预期状态（switchBranchCandidate 记录，重写消费）。
     */
    pendingRewriteExpectations: Map<
        string,
        { mainHistoryTailId: string | null; graphActiveTailNodeId: string | null }
    >;
}

/** 各职责服务共享的核心上下文。 */
export interface BranchServiceCoreContext {
    conversationManager: ConversationManager;
    repository: BranchGraphRepository;
    state: BranchServiceState;
}

/** 从节点 parts 生成候选摘要 preview（首段文本，无文本用工具名/空） */
export function buildCandidateSummary(node: ConversationBranchNode): { preview: string } {
    const texts: string[] = [];
    for (const part of node.parts ?? []) {
        if (typeof part.text === 'string' && part.text.trim()) {
            texts.push(part.text.trim());
        }
    }
    if (texts.length > 0) {
        return { preview: texts.join(' ').slice(0, 120) };
    }
    const toolNames = (node.parts ?? [])
        .map(part => part.functionCall?.name)
        .filter((name): name is string => typeof name === 'string');
    return { preview: toolNames.length > 0 ? `[tool: ${toolNames.join(', ')}]` : '' };
}

/**
 * TREE-02（决策 4）：每父节点候选数量上限校验（不含软删除节点）。
 * 超限抛 BRANCH_OPERATION_CONFLICT，提示用户清理，不自动删除。
 */
export function assertCandidateLimit(graph: ConversationBranchGraph, parentNodeId: string): void {
    const children = (childrenIndex(graph).get(parentNodeId) ?? [])
        .filter(childId => !graph.nodes[childId]?.deleted);
    if (children.length >= MAX_CANDIDATES_PER_PARENT) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `candidate limit reached: parent ${parentNodeId} already has ${children.length} `
                + `candidates (max ${MAX_CANDIDATES_PER_PARENT}); please clean up old candidates first`
        );
    }
}

/**
 * BS-3：候选创建的父节点必须在当前活跃路径上。缺失 → NODE_NOT_FOUND；
 * 存在但不在活跃路径（非活跃分支上的节点）→ BRANCH_OPERATION_CONFLICT
 * （与 deleteBranchCandidate 的活跃路径冲突语义一致，拒绝从非活跃分支再分支）。
 */
export function assertParentOnActivePath(graph: ConversationBranchGraph, parentNodeId: string): void {
    if (!graph.nodes[parentNodeId]) {
        throw new BranchError('NODE_NOT_FOUND', `parent node not found: ${parentNodeId}`);
    }
    if (!activePath(graph).includes(parentNodeId)) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `parent node ${parentNodeId} is not on the active path; cannot create a candidate under an inactive branch`
        );
    }
}

/**
 * BS-4：写路径入口的「会话存在性」检查。ConversationManager 的 deletedConversationIds
 * 为私有集合（且会随上限淘汰），BranchService 通过 getMetadata() === null 判定
 * 「会话不存在（从未创建或已被删除）」，在会话写锁内拒绝分支图写入——防止删除后
 * 迟到的写重建 sidecar（与 ConversationManager 的 append/mutate 短路同一目标）。
 * 说明：deleteConversationBranch（级联清理路径，删除进行中正是其调用时机）与
 * initializeBranchConversation（目标对话刚创建）不经过此检查。
 */
export async function assertConversationWritable(ctx: BranchServiceCoreContext, conversationId: string): Promise<void> {
    const metadata = await ctx.conversationManager.getMetadata(conversationId);
    if (!metadata) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `conversation ${conversationId} does not exist or has been deleted; refusing to write branch graph`
        );
    }
}

/**
 * TREE-01：解析 reroll 目标节点。显式传入时校验节点存在且在当前活跃路径上；
 * 省略时取活跃路径上最后一条助手消息（前端「重新生成」默认行为）。
 */
export function resolveRerollTarget(graph: ConversationBranchGraph, assistantNodeId?: string): string {
    if (assistantNodeId !== undefined) {
        if (!graph.nodes[assistantNodeId]) {
            throw new BranchError('NODE_NOT_FOUND', `node not found: ${assistantNodeId}`);
        }
        const path = activePath(graph);
        if (!path.includes(assistantNodeId)) {
            throw new BranchError(
                'INVALID_BRANCH_RELATION',
                `node ${assistantNodeId} is not on the active path; cannot reroll it`
            );
        }
        return assistantNodeId;
    }
    const path = activePath(graph);
    for (let i = path.length - 1; i >= 0; i -= 1) {
        if (graph.nodes[path[i]]!.role === 'model') {
            return path[i];
        }
    }
    throw new BranchError(
        'INVALID_BRANCH_RELATION',
        'no assistant node found on the active path to reroll'
    );
}

/** 主历史是否已经完整归档进图（节点存在性 + functionResponse parts）。 */
export function getMainHistoryRepresentationGaps(
    history: ReadonlyArray<Content>,
    graph: ConversationBranchGraph
): {
    historyIds: string[];
    missingMessageIds: string[];
    unsyncedFunctionResponseIds: string[];
} {
    const historyIds = history
        .filter(message => !isFunctionResponseMessage(message))
        .map(message => message.id ?? '');
    return {
        historyIds,
        missingMessageIds: historyIds.filter(id => !id || !graph.nodes[id]),
        unsyncedFunctionResponseIds: findUnsyncedFunctionResponses(history, graph),
    };
}

export function assertNoMainHistoryRepresentationGaps(
    history: ReadonlyArray<Content>,
    graph: ConversationBranchGraph
): void {
    const gaps = getMainHistoryRepresentationGaps(history, graph);
    if (gaps.missingMessageIds.length === 0 && gaps.unsyncedFunctionResponseIds.length === 0) {
        return;
    }
    throw new BranchError(
        'BRANCH_OPERATION_CONFLICT',
        `switch rejected: ${gaps.missingMessageIds.length} message(s) in main history are not yet synced to `
        + `the branch graph (${gaps.unsyncedFunctionResponseIds.length} functionResponse message(s) `
        + `not yet synced to their owner node parts); no branch or workspace state was changed`
    );
}

/** 构建候选节点（kind 由 pure 函数 rerollCandidate/editCandidate 覆盖） */
export function buildCandidateNode(
    input: BranchCandidateInput,
    parentNodeId: string,
    defaultRole: 'user' | 'model' | 'system'
): ConversationBranchNode {
    const now = Date.now();
    return {
        id: newUuid(),
        parentId: parentNodeId,
        role: input.role ?? defaultRole,
        parts: JSON.parse(JSON.stringify(input.parts ?? [])),
        kind: 'normal',
        createdAt: input.createdAt ?? now,
        timestamp: input.createdAt ?? now,
        modelVersion: input.modelVersion,
        usageMetadata: input.usageMetadata,
    };
}

/** childrenIndex 便捷透出（供外部/测试检查候选顺序） */
export function getChildrenIndex(graph: ConversationBranchGraph): Map<string, string[]> {
    return childrenIndex(graph);
}

/**
 * BCP-06：purge/prune 物理清理后触发「引用归零存档清理」。
 *
 * 流程（研究 §5.3）：
 * 1. 被移除节点已在图中消失（调用方先 validateAndSave 落盘）；
 * 2. 重扫全部 sidecar 计算引用计数（软删节点不计数）——被移除节点绑定的存档
 *    若仍被存活节点引用则 refCount>0 → 拒绝删除；归零才进入待删候选；
 * 3. 调全局清理器 deleteCheckpointsByNodeIds（nodeIds = 被移除节点，候选 = messageNodeId
 *    匹配的存档；refCount>0 拒绝 + CP-05 祖先闭包合并 + backupDir 安全校验）；
 * 4. 失败仅 log.warn（清理是派生态，不阻塞分支删除主流程；BCP-05 恢复前仍校验存档存在性）。
 *
 * 时序取舍（同步 await 而非 fire-and-forget）：
 * - purge/prune 均为低频显式清理操作，确定性结果（deleted/rejected 落日志）价值更高；
 * - 同步等待可避免多个 prune 并发时扫描交错；失败已内部捕获，不延长用户可见错误。
 * 锁序：本方法在会话写锁之外调用（cleanupZeroReferencedCheckpoints 自身只取存档锁）。
 */
export async function cleanupZeroReferencedCheckpoints(
    repository: BranchGraphRepository,
    conversationId: string,
    removedNodeIds: string[]
): Promise<void> {
    if (removedNodeIds.length === 0) {
        return;
    }
    const cleaner = getGlobalCheckpointRefCountCleaner();
    if (!cleaner) {
        // 未注册（无 CheckpointManager / 测试环境）：跳过，图侧清理已完成
        return;
    }
    try {
        const referenceCounts = await computeCheckpointReferenceCounts(repository);
        const outcome = await cleaner.deleteCheckpointsByNodeIds(conversationId, removedNodeIds, {
            referenceCounts,
        });
        if (outcome.deletedIds.length > 0 || outcome.rejectedIds.length > 0) {
            log.info('branch_checkpoint_cleanup', {
                conversationId,
                nodeIds: removedNodeIds,
                deletedIds: outcome.deletedIds,
                rejectedIds: outcome.rejectedIds,
            });
        }
    } catch (err) {
        log.warn('branch_checkpoint_cleanup_failed', {
            conversationId,
            error: (err as Error)?.message ?? String(err),
        });
    }
}

/**
 * 读图（缓存优先，写路径与 append/syncDelete 共用）：无图 → null；损坏（解析或语义）→
 * 抛 BRANCH_STORAGE_CORRUPT（不静默覆盖）。建线性基线仅限 loadGraphForWrite 的职责。
 */
export async function loadGraphCached(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<ConversationBranchGraph | null> {
    const cacheKey = getBranchGraphCacheKey(ctx.repository, conversationId);
    const cached = await getBranchGraphCached(cacheKey);
    if (cached) {
        // 缓存内图已通过 validate + activePath（回填点保证）；与读路径共享同一对象，
        // 图变更依赖纯函数（insertNode/updateNodeContent 等内部 cloneGraph），不会污染共享条目。
        return cached;
    }
    const loaded = await ctx.repository.load(conversationId);
    if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `branches.json is corrupt for ${conversationId}; refusing to overwrite (${loaded.errorMessage ?? 'unknown error'})`
        );
    }
    if (loaded.graph) {
        // M-2：读取侧语义校验——语义损坏同样拒绝覆盖（与解析损坏同策略：
        // 不静默覆盖可能可恢复的数据，MIG-05 完整性工具负责修复）
        const validation = validate(loaded.graph);
        if (!validation.valid) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `branches.json is semantically corrupt for ${conversationId}; refusing to overwrite (${validation.issues.map(i => i.message).join('; ')})`
            );
        }
        try {
            activePath(loaded.graph);
        } catch (error) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `branches.json active path is unresolvable for ${conversationId}; refusing to overwrite (${(error as Error)?.message ?? String(error)})`
            );
        }
        return loaded.graph;
    }
    return null;
}

/** 读图用于写入：无图 → 主历史建线性基线；损坏（解析或语义）→ 抛 BRANCH_STORAGE_CORRUPT（不覆盖） */
export async function loadGraphForWrite(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<ConversationBranchGraph> {
    // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）。检查在会话写锁内进行，
    // 与 deleteConversation 的锁序一致：delete 先入已删除集合 → 锁内删文件 → 释放锁，
    // 迟到写入锁后在此被拒，不会与删除交错产生幽灵 sidecar。
    await assertConversationWritable(ctx, conversationId);
    const graph = await loadGraphCached(ctx, conversationId);
    if (graph) {
        return graph;
    }
    // 无 sidecar：以主历史建线性基线图（主历史是活跃路径的唯一真源）
    const history = await ctx.conversationManager.getMessagesRaw(conversationId);
    return importLinearHistory(history);
}

/** validate 通过后原子保存；无效抛 BRANCH_STORAGE_CORRUPT */
export async function validateAndSave(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    graph: ConversationBranchGraph
): Promise<void> {
    const validation = validate(graph);
    if (!validation.valid) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `refusing to persist invalid branch graph for ${conversationId}: ${validation.issues.map(i => i.message).join('; ')}`
        );
    }
    await ctx.repository.save(conversationId, graph);
    // 写后回填缓存（存快照：调用方持有的 graph 对象后续可能继续被修改）
    await setBranchGraphCached(getBranchGraphCacheKey(ctx.repository, conversationId), graph);
}

/**
 * 分支图变更通用执行器（BR-07）：
 * 1. 锁外先确保主历史带稳定 id（ensureHistoryNodeIds 自身在会话写锁内完成，避免重入死锁）；
 * 2. 进入会话写锁：读 sidecar → 无图/损坏处理 → mutator 变更 → validate → 原子保存。
 *
 * 无图：以主历史建线性基线图（首次分支惰性建图，MIG-01）；
 * 损坏：抛 BRANCH_STORAGE_CORRUPT（不静默覆盖，读取侧已降级线性模式）。
 */
export async function mutateGraph<T>(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    mutator: (graph: ConversationBranchGraph) =>
        | { next: ConversationBranchGraph; result: T }
        | Promise<{ next: ConversationBranchGraph; result: T }>
): Promise<T> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        const graph = await loadGraphForWrite(ctx, conversationId);
        const { next, result } = await mutator(graph);
        // R8c-P6：幂等路径（mutator 原样返回读到的图，如重复软删/恢复/清理不存在的节点）
        // 图未发生变化，跳过 validateAndSave——避免无意义的 sidecar 重写。
        if (next !== graph) {
            await validateAndSave(ctx, conversationId, next);
        }
        return result;
    });
}
