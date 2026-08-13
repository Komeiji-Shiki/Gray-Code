/**
 * 主历史 ↔ 分支图对账服务（拆分自 BranchService.ts 的 BR-05 / ensure / sync 方法组）。
 *
 * ensureBranchGraph / ensureMainHistoryRepresentedInGraph / syncMainHistoryAfterStructuralMutation /
 * assertMainHistoryRepresentedInGraph / validateActivePathMatchesHistory 都是「主历史与分支图
 * 一致性」职责，与候选生命周期、保留期清理相互独立。抽到本文件后 BranchService 在同名
 * public 方法中委托，方法签名与行为保持不变。
 */

import { Logger } from '../../../core/logger';
import {
    activePath,
    importLinearHistory,
    isActiveEmptyPlaceholder,
    isFunctionResponseMessage,
    rebaseActivePathFromHistory,
    softDeleteNode,
    validate,
} from './BranchGraph';
import {
    assertConversationWritable,
    assertNoMainHistoryRepresentationGaps,
    getMainHistoryRepresentationGaps,
    loadGraphCached,
    loadGraphForWrite,
    validateAndSave,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import type {
    BranchHistoryReconcileResult,
    BranchPathConsistencyResult,
    BranchStructuralSyncResult,
} from './branchServiceTypes';
import { BranchError } from './types';
import type { ConversationBranchGraph } from './types';

const log = Logger.get('BranchService');

/**
 * 确保分支图 sidecar 存在（TREE-03 keep 模式前置）：无图时以主历史建线性基线图。
 *
 * 用于「先建图后截断」——让截断前的完整旧历史先进图，截断后再软删被移除的子树，
 * 保证旧版本可回看（与 branch 模式 editCandidate 的惰性建图时机对齐，MIG-01）。
 * 已有图 / sidecar 损坏（抛 BRANCH_STORAGE_CORRUPT，不覆盖）→ 幂等。
 *
 * @returns true 表示本次新建了图；false 表示图已存在或无需建图
 */
export async function ensureBranchGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<boolean> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        await assertConversationWritable(ctx, conversationId);
        const loaded = await ctx.repository.load(conversationId);
        if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `branches.json is corrupt for ${conversationId}; refusing to ensure branch graph (${loaded.errorMessage ?? 'unknown error'})`
            );
        }
        if (loaded.graph) {
            return false; // 已有图：无需重建
        }
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        const graph = importLinearHistory(history);
        await validateAndSave(ctx, conversationId, graph);
        return true;
    });
}

/**
 * 确保当前主历史的每条消息都已归档进分支图。
 *
 * 旧版本会把已经结束的空 reroll/edit 占位节点留在活跃尾，普通追加因而持续跳过 sidecar；
 * 结构性历史更新也可能在路径中间插入节点。编辑/重试若继续使用旧图，会 NODE_NOT_FOUND，
 * 甚至在截断主历史后丢掉未归档的当前路径。本方法在这些破坏性操作之前执行：
 *
 * - 无图：从主历史建立基线；
 * - 图已包含主历史全部消息与 functionResponse：幂等返回；主历史与图活跃路径不同可能只是
 *   尚未执行历史重写的合法候选切换，不能擅自回切；
 * - 图确实缺少主历史消息/回执：先生成逐字节备份，再以主历史重建活跃路径，旧候选继续保留；
 * - 根节点不一致或重建后图无效：拒绝覆盖，原 sidecar 保持不变。
 */
export async function ensureMainHistoryRepresentedInGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<BranchHistoryReconcileResult> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        await assertConversationWritable(ctx, conversationId);
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        const graph = await loadGraphCached(ctx, conversationId);
        if (!graph) {
            const baseline = importLinearHistory(history);
            await validateAndSave(ctx, conversationId, baseline);
            return {
                created: true,
                reconciled: false,
                missingMessageCount: 0,
                unsyncedFunctionResponseCount: 0,
            };
        }

        const gaps = getMainHistoryRepresentationGaps(history, graph);
        const graphPath = activePath(graph);
        const historyIsActivePrefix = gaps.historyIds.every((id, index) => graphPath[index] === id);
        if (gaps.missingMessageIds.length === 0
            && gaps.unsyncedFunctionResponseIds.length === 0) {
            return {
                created: false,
                reconciled: false,
                missingMessageCount: 0,
                unsyncedFunctionResponseCount: 0,
            };
        }

        // 先在内存中完成合并与 validate；无法无损并入时不制造无意义备份，也绝不覆盖旧图。
        const reconciled = rebaseActivePathFromHistory(graph, history);
        const backupPath = await ctx.repository.backup(conversationId, 'history-diverged');
        if (!backupPath) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `refusing to reconcile branches.json for ${conversationId}: source sidecar disappeared before backup`
            );
        }
        await validateAndSave(ctx, conversationId, reconciled);
        log.warn('branch_history_reconciled', {
            conversationId,
            missingMessageCount: gaps.missingMessageIds.length,
            unsyncedFunctionResponseCount: gaps.unsyncedFunctionResponseIds.length,
            activePathMismatch: !historyIsActivePrefix,
        });
        return {
            created: false,
            reconciled: true,
            backupPath,
            missingMessageCount: gaps.missingMessageIds.length,
            unsyncedFunctionResponseCount: gaps.unsyncedFunctionResponseIds.length,
        };
    });
}

/**
 * 把预期内的主历史结构变更同步到已有分支图。
 *
 * 与 ensureMainHistoryRepresentedInGraph 的异常修复路径不同：这里不新建 sidecar、不生成备份，
 * 仅在已有图上以主历史重建活跃路径并保留所有旧候选。调用方必须已经成功提交主历史变更。
 */
export async function syncMainHistoryAfterStructuralMutation(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    reason: 'summary_inserted' | 'summary_restored' | 'summary_deleted' | 'message_deleted_middle' | 'branch_finished' | 'message_inserted' | 'tool_calls_rejected'
): Promise<BranchStructuralSyncResult> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        await assertConversationWritable(ctx, conversationId);
        const graph = await loadGraphCached(ctx, conversationId);
        if (!graph) {
            ctx.state.deferredStructuralSyncConversationIds.delete(conversationId);
            return { synced: false, deferred: false };
        }

        const tail = graph.activeTailNodeId ? graph.nodes[graph.activeTailNodeId] : undefined;
        if (isActiveEmptyPlaceholder(tail)) {
            // 进行中的分支流以空占位锁定活跃路径；总结可能发生在模型请求前，不能在此抢占
            // activeTail。finishReroll 会处理本次流的尾部，下一次分支操作仍有完整对账兜底。
            // 超龄空占位（进程崩溃/被杀遗留）不再视为活跃流，直接收敛，避免图永久冻结。
            ctx.state.deferredStructuralSyncConversationIds.add(conversationId);
            return { synced: false, deferred: true };
        }

        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        // 删头部（主历史根前移）等根变更场景：rebase 默认拒绝（单根模型无法保留旧根为候选）。
        // 主历史已变更的调用方允许重链——新根挂到图、旧根专属子树清理，避免图根永久陈旧、
        // 后续 append 挂旧根（round4 复查 P1）；实际发生重链时显式告警便于观测。
        const historyRootId = history.length > 0 ? (history[0]?.id ?? null) : null;
        let next = rebaseActivePathFromHistory(graph, history, { allowRootChange: true });
        if (historyRootId !== null && graph.rootNodeId !== null && graph.rootNodeId !== historyRootId) {
            log.warn('branch_root_relinked_after_structural_mutation', {
                conversationId,
                reason,
                oldRootNodeId: graph.rootNodeId,
                newRootNodeId: historyRootId,
            });
        }
        // 收敛被移出活跃路径的空占位幽灵（超龄占位经 isActiveEmptyPlaceholder 放行后
        // rebase 会把它们降级为非活跃节点）：空内容、非软删的 reroll/edit 节点没有其它
        // 回收路径，会永久占用候选上限（每父节点 10 个）并在面板显示空条目。软删后可被
        // prune 清理，且不破坏候选归档语义。进行中的流不会产生非活跃空节点（其占位是
        // 活跃尾），此处只会命中崩溃/被杀遗留的幽灵。
        const reconciledPathIds = new Set(activePath(next));
        for (const node of Object.values(next.nodes)) {
            if (node.deleted || (node.parts?.length ?? 0) !== 0) {
                continue;
            }
            if (node.kind !== 'reroll' && node.kind !== 'edit') {
                continue;
            }
            if (reconciledPathIds.has(node.id)) {
                continue;
            }
            next = softDeleteNode(next, node.id);
        }
        await validateAndSave(ctx, conversationId, next);
        ctx.state.deferredStructuralSyncConversationIds.delete(conversationId);
        log.info('branch_structural_history_synced', { conversationId, reason });
        return { synced: true, deferred: false };
    });
}

/**
 * 分支切换的零副作用预检：主历史有任何消息/函数回执尚未入图时立即拒绝。
 * handler 在工作区恢复之前调用；switchBranchCandidate 在持锁变更前还会再次校验以防竞态。
 */
export async function assertMainHistoryRepresentedInGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<void> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    await ctx.conversationManager.runExclusive(conversationId, async () => {
        const graph = await loadGraphForWrite(ctx, conversationId);
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        assertNoMainHistoryRepresentationGaps(history, graph);
    });
}

/**
 * BR-05 调试校验：主历史消息 id 链（不含 functionResponse，决策 8）== 图活跃路径。
 * 无分支图时：主历史为空 → valid；主历史非空 → 报「图缺失」。
 * 同时报告图结构校验（validate）问题。
 *
 * 用途：BranchService 的调试/完整性检查入口（MIG-05 完整性工具的前身），
 * 不强制重写主历史（BR-05 本阶段只建立不变量文档与校验函数）。
 */
export async function validateActivePathMatchesHistory(
    ctx: BranchServiceCoreContext,
    conversationId: string
): Promise<BranchPathConsistencyResult> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        const loaded = await ctx.repository.load(conversationId);
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        const historyIds = history
            .filter(message => !isFunctionResponseMessage(message))
            .map(message => message.id ?? '');

        if (!loaded.graph) {
            const issues = historyIds.length > 0
                ? ['branch graph is missing while main history has messages (first branch op will build baseline)']
                : [];
            return {
                valid: issues.length === 0,
                issues,
                graphMissing: true,
                historyIds,
                activePathIds: [],
            };
        }

        const issues: string[] = [];
        const graphValidation = validate(loaded.graph);
        if (!graphValidation.valid) {
            issues.push(...graphValidation.issues.map(issue => `graph[${issue.code}]: ${issue.message}`));
        }

        let graphPathIds: string[];
        try {
            graphPathIds = activePath(loaded.graph);
        } catch (error) {
            graphPathIds = [];
            issues.push(`activePath resolution failed: ${(error as Error)?.message ?? String(error)}`);
        }

        if (historyIds.length !== graphPathIds.length) {
            issues.push(`length mismatch: main history ${historyIds.length} vs graph active path ${graphPathIds.length}`);
        }
        const commonLength = Math.min(historyIds.length, graphPathIds.length);
        for (let i = 0; i < commonLength; i++) {
            if (historyIds[i] !== graphPathIds[i]) {
                issues.push(`id mismatch at position ${i}: main history ${historyIds[i] ?? '(missing)'} vs graph ${graphPathIds[i] ?? '(missing)'}`);
            }
        }

        return {
            valid: issues.length === 0,
            issues,
            graphMissing: false,
            historyIds,
            activePathIds: graphPathIds,
        };
    });
}
