/**
 * 跨对话分支建模 / 主历史追加与删除同步（BR-09 + BS-2 + 决策 6，拆分自 BranchService.ts）。
 *
 * initializeBranchConversation / recordExport（BR-09「复制为新对话」）与
 * appendHistoryToGraph（BS-2 主历史追加并入图）、syncGraphAfterHistoryDelete（决策 6
 * 主历史删除后软删图子树）都是「主历史变更 → 分支图同步」职责。抽到本文件后
 * BranchService 在同名 public 方法中委托，方法签名与行为保持不变。
 */

import { Logger } from '../../../core/logger';
import type { Content } from '../types';
import {
    createEmptyBranchGraph,
    extractBranchContentMetadata,
    importLinearHistory,
    insertNode,
    isFunctionResponseMessage,
    softDeleteSubtreeFrom,
    updateNodeContent,
} from './BranchGraph';
import {
    assertConversationWritable,
    loadGraphCached,
    loadGraphForWrite,
    validateAndSave,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import type { BranchHistoryDeleteSyncResult } from './branchServiceTypes';
import { BranchError } from './types';
import type { BranchExportRecord, ConversationBranchGraph, ConversationBranchNode } from './types';

const log = Logger.get('BranchService');

/**
 * BR-09：为新创建的分支对话初始化 BranchGraph。
 * - 把目标对话主历史全量导入为节点（kind='imported'，functionResponse 合并进模型节点）；
 * - 图元数据记录 exportedFrom: { conversationId: 源头对话, nodeId: 来源节点 }。
 * 由 ConversationManager.createBranchConversation 接线调用。
 */
export async function initializeBranchConversation(
    ctx: BranchServiceCoreContext,
    targetConversationId: string,
    sourceConversationId: string,
    sourceNodeId: string
): Promise<void> {
    await ctx.conversationManager.ensureHistoryNodeIds(targetConversationId);
    await ctx.conversationManager.runExclusive(targetConversationId, async () => {
        const history = await ctx.conversationManager.getMessagesRaw(targetConversationId);
        const graph = importLinearHistory(history);
        const withMeta: ConversationBranchGraph = {
            ...graph,
            exportedFrom: { conversationId: sourceConversationId, nodeId: sourceNodeId },
        };
        await validateAndSave(ctx, targetConversationId, withMeta);
    });
}

/**
 * BR-09：在源头对话的分支图中记录导出关系（exportedRefs 列表，最小实现——不新增
 * 'exported' 标注节点，避免制造无消息内容的假节点干扰活跃路径/校验）。
 * 源头对话尚无分支图时先以主历史建线性基线图。
 */
export async function recordExport(
    ctx: BranchServiceCoreContext,
    sourceConversationId: string,
    targetConversationId: string,
    nodeId: string
): Promise<void> {
    await ctx.conversationManager.ensureHistoryNodeIds(sourceConversationId);
    await ctx.conversationManager.runExclusive(sourceConversationId, async () => {
        const graph = await loadGraphForWrite(ctx, sourceConversationId);
        // BS-4：源会话历史为空时 loadGraphForWrite 只会产出空图（无节点可导出）——
        // 不保存空 sidecar：导出记录指向不存在的节点没有意义，也避免制造「空图」。
        if (Object.keys(graph.nodes).length === 0) {
            log.warn('branch_export_skipped_empty_source', {
                sourceConversationId,
                targetConversationId,
                nodeId,
                reason: 'source conversation has no history; not persisting an empty branch graph',
            });
            return;
        }
        const record: BranchExportRecord = {
            targetConversationId,
            nodeId,
            exportedAt: Date.now(),
        };
        const existing = graph.exportedRefs ?? [];
        if (existing.some(r => r.targetConversationId === targetConversationId && r.nodeId === nodeId)) {
            return; // 幂等：同一导出关系不重复记录
        }
        const next: ConversationBranchGraph = { ...graph, exportedRefs: [...existing, record] };
        await validateAndSave(ctx, sourceConversationId, next);
    });
}

/**
 * BS-2：把主历史尾部新增消息逐条并入分支图（在会话写锁内执行）。
 *
 * 语义：
 * - 无分支图（线性对话尚未建图）→ 跳过，不强制建图（返回 false）；
 * - sidecar 损坏（解析失败或读取侧语义校验失败）→ 抛 BRANCH_STORAGE_CORRUPT（不覆盖）；
 * - 已删除 / 不存在的会话 → 抛 BRANCH_OPERATION_CONFLICT（BS-4，防删除后迟到写重建 sidecar）；
 * - 有图：按追加消息顺序逐条 insertNode 并入活跃路径（setActive + updateTail），
 *   functionResponse 消息（决策 8）并入前一个节点，不独立成节点；createdAt 沿消息顺序
 *   严格递增（与 importLinearHistory 一致，保证候选排序稳定）。
 *
 * 入参约定：newMessages 必须是主历史尾部**新增**的消息数组（调用方保证只传新消息，
 * 且消息已带稳定 id）；本方法不做去重——重复 id 由 insertNode 抛 INVALID_BRANCH_RELATION。
 *
 * 调用点（后续批次接线）：应挂在 ConversationManager.appendContents 之后（主历史追加
 * 成功后调用，传本次新增的消息数组）。本批次只实现方法 + 单测，不接调用点。
 *
 * @returns true = 已并入分支图；false = 无分支图，跳过（线性对话未建图不强制建）
 */
export async function appendHistoryToGraph(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    newMessages: ReadonlyArray<Content>
): Promise<boolean> {
    if (newMessages.length === 0) {
        return false;
    }
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        await assertConversationWritable(ctx, conversationId);
        let graph = await loadGraphCached(ctx, conversationId);
        if (!graph) {
            // 线性对话未建图：不强制建（图只在首次分支/导入时建立）
            return false;
        }
        // 首条新消息的父节点 = 当前活跃尾（未插入节点前）；之后为上一个已插入节点
        let cursor: string | null = graph.activeTailNodeId;
        let previousCreatedAt = cursor !== null && graph.nodes[cursor]
            ? graph.nodes[cursor]!.createdAt
            : Number.NEGATIVE_INFINITY;
        let changed = false;
        for (const message of newMessages) {
            if (isFunctionResponseMessage(message)) {
                // 决策 8：functionResponse 并入前一个节点（不独立成节点）
                if (cursor !== null && graph.nodes[cursor]) {
                    const current = graph.nodes[cursor]!;
                    graph = updateNodeContent(graph, cursor, {
                        parts: [...current.parts, ...(message.parts ?? [])],
                    });
                    changed = true;
                } else {
                    log.warn('branch_append_dropped_function_response', {
                        conversationId,
                        reason: 'functionResponse has no preceding node to merge into; dropped',
                    });
                }
                continue;
            }
            const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : null;
            if (id === null) {
                throw new BranchError(
                    'INTERNAL_ERROR',
                    `appendHistoryToGraph: message without stable id cannot be appended to the branch graph (role=${message.role})`
                );
            }
            // createdAt 沿消息顺序严格递增（相同 timestamp 也按序 +1）
            const rawCreatedAt = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
            const createdAt = Number.isFinite(previousCreatedAt)
                ? Math.max(rawCreatedAt, previousCreatedAt + 1)
                : rawCreatedAt;
            previousCreatedAt = createdAt;
            const node: ConversationBranchNode = {
                id,
                parentId: cursor,
                role: message.role,
                parts: JSON.parse(JSON.stringify(message.parts ?? [])),
                kind: 'normal',
                createdAt,
                timestamp: message.timestamp,
                modelVersion: message.modelVersion,
                usageMetadata: message.usageMetadata,
                // R8b-M2：中断/取消流的截断用量标记随节点一起拷贝
                usageMetadataPartial: message.usageMetadataPartial,
                contentMetadata: extractBranchContentMetadata(message),
            };
            graph = insertNode(graph, node, { setActive: true, updateTail: true });
            cursor = id;
            changed = true;
        }
        if (!changed) {
            return false; // 全部消息被丢弃（异常输入），图未变化则不落盘
        }
        await validateAndSave(ctx, conversationId, graph);
        return true;
    });
}

/**
 * 决策 6：主历史删除后同步软删分支图——「被删消息对应的节点及其后续整棵子树」。
 *
 * 语义（复用 TREE-09 软删：节点标记 deleted + deletedAt，不物理移除 sidecar；
 * 级联覆盖该点之后的所有后代，含非活跃候选子树；prune 前可整体恢复）：
 * - 无分支图（线性对话未建图）→ 返回 graphUpdated:false，不强制建图、不影响原有行为；
 * - 锚点消息（第一个被删消息的 id，删除前捕获）不在图中（functionResponse 等决策 8
 *   并入所属节点的消息 / 图未覆盖被删段）→ 退化用 lastKeptMessageId（最后保留消息）
 *   软删其**之后**的所有后代（保留点自身不清除）；两者都不在图中 → 幂等 no-op；
 * - 锚定根节点（删除到对话开头）→ 整图重置为空图（createEmptyBranchGraph）；
 * - options.forceResetToEmpty（主历史整体清空，clearHistory / 恢复空快照）→ 无条件重置为
 *   空图，不依赖锚点是否图根/是否存在——锚点非图根（图根陈旧）时仅软删子树会残留旧根/旧尾，
 *   「空历史 + 非空图」无法由 rebase 处理（round4 复查 P1）；
 * - 活跃尾若落在被删子树内（截断场景的常态）→ 回退到保留锚点，并清空指向被删节点的
 *   activeChildId（validate 不变量）；
 * - sidecar 损坏（解析 / 语义）→ 抛 BRANCH_STORAGE_CORRUPT（与其它写路径一致：不覆盖）。
 *
 * 锁边界：整体在会话写锁（runExclusive）内执行，与主历史删除共用同一把锁、串行化；
 * 本方法不触碰存档锁（「会话锁内严禁获取存档锁」）。调用方约定：在主历史删除完成、
 * 仓储互斥已释放后同步 await（顺序取锁，非嵌套）；图同步失败仅告警，不阻断硬删除。
 *
 * @param deletedFromMessageId 第一个被删除消息的 id（删除前捕获；null = 无锚点防御）
 * @param options.lastKeptMessageId 最后保留消息的 id（锚点不在图内时的退化锚）
 * @param options.forceResetToEmpty 主历史整体清空时无条件重置为空图（不依赖锚点）
 */
export async function syncGraphAfterHistoryDelete(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    deletedFromMessageId: string | null,
    options: { deletedAt?: number; lastKeptMessageId?: string | null; forceResetToEmpty?: boolean } = {}
): Promise<BranchHistoryDeleteSyncResult> {
    const empty: BranchHistoryDeleteSyncResult = {
        graphUpdated: false,
        deletedNodeIds: [],
        resetToEmpty: false,
        activeTailAdjusted: false,
    };
    if (!deletedFromMessageId && !options.forceResetToEmpty) {
        // 无锚点（历史消息缺 id 的防御路径）：不做任何图变更（不臆测删除范围）。
        // forceResetToEmpty（整体清空）时无锚点同样重置——历史早已为空但图残留旧根的陈旧场景。
        return empty;
    }
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        await assertConversationWritable(ctx, conversationId);
        const graph = await loadGraphCached(ctx, conversationId);
        if (!graph) {
            // 线性对话未建图：删除不同步（主历史为唯一真源，不强制建图）
            return empty;
        }
        if (options.forceResetToEmpty) {
            // 主历史整体清空：无条件重置为空图（不依赖锚点是否图根/是否存在）。
            // 锚点非图根（图根陈旧）时 softDeleteSubtreeFrom 仅软删锚点子树，图根/旧活跃尾
            // 残留，清空后 append 挂旧尾（round4 复查 P1）；「空历史 + 非空图」唯一有效形态
            // 即空图，旧内容已随主历史整体清空，等价于重新开始。
            if (Object.keys(graph.nodes).length === 0) {
                // 幂等短路（round5 复查）：图已为空时重置为空图是无操作——不再空转
                // validateAndSave 写盘，也不误报 graphUpdated:true（与软删路径
                // outcome.graph === graph 短路同语义；此时 deletedNodeIds 本就为空）。
                return empty;
            }
            await validateAndSave(ctx, conversationId, createEmptyBranchGraph());
            return {
                graphUpdated: true,
                deletedNodeIds: Object.keys(graph.nodes),
                resetToEmpty: true,
                activeTailAdjusted: true,
            };
        }
        if (deletedFromMessageId === null) {
            // 防御：forceResetToEmpty 分支已提前返回；无锚点时不臆测删除范围（类型收窄）
            return empty;
        }
        let anchorNodeId: string | null = graph.nodes[deletedFromMessageId] ? deletedFromMessageId : null;
        let excludeNode = false;
        if (anchorNodeId === null) {
            // 锚点消息不在图中（functionResponse / 图未覆盖被删段）：
            // 退化为「最后保留消息之后的所有后代」整体软删（保留点自身不清除）
            const keptNodeId = options.lastKeptMessageId && graph.nodes[options.lastKeptMessageId]
                ? options.lastKeptMessageId
                : null;
            if (keptNodeId === null) {
                log.warn('branch_delete_sync_anchor_missing', {
                    conversationId,
                    deletedFromMessageId,
                    reason: 'neither deleted anchor nor last kept message exists in the branch graph; graph left unchanged',
                });
                return empty;
            }
            anchorNodeId = keptNodeId;
            excludeNode = true;
        }
        const outcome = softDeleteSubtreeFrom(graph, anchorNodeId, {
            deletedAt: options.deletedAt ?? Date.now(),
            excludeNode,
        });
        if (outcome.graph === graph) {
            return empty; // R8c-P6 幂等：图未变化，不落盘
        }
        await validateAndSave(ctx, conversationId, outcome.graph);
        return {
            graphUpdated: true,
            deletedNodeIds: outcome.deletedNodeIds,
            resetToEmpty: outcome.resetToEmpty,
            activeTailAdjusted: outcome.activeTailAdjusted,
        };
    });
}
