/** 分支软删除、恢复及物理修剪，保持子树和候选摘要的现有联动规则。 */
import { BranchError } from './types';
import type { BranchCandidateSummary, ConversationBranchGraph, ConversationBranchNode } from './types';
import { activePath, createEmptyBranchGraph, removeNodeSet, syncRootMirror } from './branchGraphTopology';

/**
 * TREE-09：判断软删节点是否已过保留期（deletedAt + retentionDays）。
 * - deletedAt 缺失（TREE-09 之前的遗留软删节点）：以 createdAt 兜底（删除必晚于创建），
 *   保证遗留节点最终也能被 prune 清理；节点既无 deletedAt 也无 createdAt 时视为未过期（保守保留）。
 * - retentionDays <= 0：永不过期（不自动清理）。
 */
export function isDeletedNodeExpired(
    node: ConversationBranchNode,
    now: number,
    retentionDays: number
): boolean {
    if (!node.deleted || retentionDays <= 0) {
        return false;
    }
    const deletedAt = node.deletedAt ?? node.createdAt ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(deletedAt)) {
        return false;
    }
    return now - deletedAt >= retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * TREE-09：软删除节点（纯函数）。
 * - 节点标记 deleted + deletedAt（deletedAt 缺省取调用方传入，BranchService 传 Date.now()）；
 * - 候选摘要同步标记 deleted + deletedAt（保留条目供前端灰显「已删除」）；
 * - 活跃路径上的节点拒绝删除（BRANCH_OPERATION_CONFLICT，与 BranchService 一致：
 *   删除活跃节点会破坏 activeTailNodeId 终端不变量，需先切换走）；
 * - R8c-P1：**级联软删整棵子树**——沿 children 递归标记 deleted + deletedAt（含候选摘要同步）。
 *   此前只标记分支头，子树中从未软删的 live 子孙会在 prune 时被物理移除（静默数据丢失）；
 *   级联后 prune 物理清理前子孙始终处于「已软删、可整体恢复」状态；
 * - 子树内所有指向（已删）子节点的 activeChildId 一并清空（validate 的「activeChildId 不得
 *   指向已删除节点」不变量）；若分支头是父节点的当前活跃子且父节点不在活跃路径上，同步清空
 *   父节点 activeChildId；
 * - 已软删节点保留首次 deletedAt（幂等：重复软删不重置删除时间）。
 */
export function softDeleteNode(
    graph: ConversationBranchGraph,
    nodeId: string,
    options: { deletedAt?: number } = {}
): ConversationBranchGraph {
    const node = graph.nodes[nodeId];
    if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
    }
    if (node.deleted) {
        return graph; // 幂等：已软删不再重复标记
    }
    if (activePath(graph).includes(nodeId)) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot soft-delete node ${nodeId}: it is on the active path; switch away first`
        );
    }
    const deletedAt = options.deletedAt ?? Date.now();
    const nodes = { ...graph.nodes };

    // 收集整棵子树（含自身）：分支头不在活跃路径 ⇒ 子孙必然也不在活跃路径
    // （活跃路径沿 parentId 链向上经过祖先），因此级联标记不会触碰活跃路径。
    // 性能：预构建 parentId → children 邻接表，一次遍历收集子树，避免每个节点
    // 一次 Object.values 全表扫描（O(n²)）。
    const childrenByParent = new Map<string, string[]>();
    for (const current of Object.values(nodes)) {
        if (current.parentId === null) {
            continue;
        }
        const siblings = childrenByParent.get(current.parentId);
        if (siblings) {
            siblings.push(current.id);
        } else {
            childrenByParent.set(current.parentId, [current.id]);
        }
    }
    const toDelete = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toDelete.has(id)) {
            continue;
        }
        toDelete.add(id);
        for (const childId of childrenByParent.get(id) ?? []) {
            stack.push(childId);
        }
    }

    for (const id of toDelete) {
        const current = nodes[id];
        // 子孙中已软删的节点保留首次 deletedAt（幂等语义），未软删的标记为本次删除时间
        const patched: ConversationBranchNode = {
            ...current,
            deleted: true,
            deletedAt: current.deleted ? (current.deletedAt ?? deletedAt) : deletedAt,
        };
        // 子树整体已软删：指向子节点的 activeChildId 全部清空（validate 不变量）
        if (patched.activeChildId != null && toDelete.has(patched.activeChildId)) {
            patched.activeChildId = null;
        }
        nodes[id] = patched;
    }
    // 分支头是父节点的当前活跃子（仅可能发生在非活跃分支上）：清空父节点指针
    if (node.parentId !== null) {
        const parent = nodes[node.parentId];
        if (parent && parent.activeChildId === nodeId) {
            nodes[node.parentId] = { ...parent, activeChildId: null };
        }
    }

    let next: ConversationBranchGraph = { ...graph, nodes };
    for (const id of toDelete) {
        next = syncSummaryDeleted(next, id, deletedAt);
    }
    return next;
}

/**
 * 决策 6：主历史删除后「软删目标节点及其后续整棵子树」（纯函数）。
 *
 * 与 softDeleteNode 的分工：
 * - softDeleteNode 是候选删除语义——拒绝活跃路径上的节点（需先切换走，删除分支头不影响主历史）；
 * - 本函数是「主历史已硬删除该点及之后消息」后的图同步——被删节点很可能正是活跃路径尾部，
 *   因此**允许**软删活跃路径节点，并同步修正活跃指针（见下）。
 *
 * 级联范围（复用 TREE-09 软删语义）：目标节点 + 其全部后代（含非活跃候选子树）整体标记
 * deleted + deletedAt，**不物理移除节点 / sidecar**——prune 物理清理前整棵子树可经 restoreNode
 * 整体恢复；已软删子孙保留首次 deletedAt（幂等）。候选摘要同步标记（保留条目供前端灰显）。
 *
 * 活跃指针修正（保证 validate 不变量）：
 * - 被删集合内所有指向（已删）子节点的 activeChildId 清空；
 * - 集合外保留节点若 activeChildId 指向被删节点（父节点指向分支头等）一并清空；
 * - 若 activeTailNodeId 落在被删集合内（锚点在活跃路径上 ⇒ 活跃尾必在其子树内），把活跃尾
 *   回退到保留锚点：默认 = 锚点父节点；excludeNode 时 = 锚点自身（保留点，不删除）；
 * - 根节点镜像（graph.activeChildId）经 syncRootMirror 同步。
 *
 * 根节点锚定（删除到对话开头，deleteToMessage(0) 等）：主历史已全部移除，任何
 * 「保留全部软删节点」的图都不可再扩展（新消息插入需要根 / 活跃尾），因此整体重置为空图
 * （createEmptyBranchGraph）——旧内容已随主历史硬删除，等价于重新开始。
 *
 * @param excludeNode 为 true 时只软删目标节点的后代（目标节点保留）——用于锚点消息
 *   （functionResponse 等决策 8 并入所属节点的消息）不在图中、退化到「最后保留消息之后
 *   所有后代」的场景。
 * @returns 变更后的图 + 本次新标记软删的节点 id 等元信息；图未变化（节点缺失 / 已软删 /
 *   无后代）时返回**原图引用**（调用方据此跳过落盘，R8c-P6 幂等）。
 */
export interface SoftDeleteSubtreeResult {
    graph: ConversationBranchGraph;
    /** 本次新标记软删的节点 id（含已软删子孙中保持原 deletedAt 的节点；resetToEmpty 时为全部旧节点 id） */
    deletedNodeIds: string[];
    /** 活跃尾是否被回退（被删集合包含原活跃尾） */
    activeTailAdjusted: boolean;
    /** 是否整体重置为空图（锚定根节点，整棵图随主历史移除） */
    resetToEmpty: boolean;
}

export function softDeleteSubtreeFrom(
    graph: ConversationBranchGraph,
    nodeId: string,
    options: { deletedAt?: number; excludeNode?: boolean } = {}
): SoftDeleteSubtreeResult {
    const noChange: SoftDeleteSubtreeResult = { graph, deletedNodeIds: [], activeTailAdjusted: false, resetToEmpty: false };
    const excludeNode = options.excludeNode ?? false;
    const anchor = graph.nodes[nodeId];
    if (!anchor) {
        return noChange; // 锚点不在图中（FR 消息 / 图未覆盖被删段）：无可同步，幂等
    }
    if (anchor.deleted) {
        return noChange; // 已软删：其子树必然已整体软删（deleted 节点下不允许再插入新子节点），幂等
    }
    if (!excludeNode && anchor.parentId === null) {
        // 锚定根节点：主历史已全部移除，重置为空图（唯一可继续扩展的有效形态）
        return {
            graph: createEmptyBranchGraph(),
            deletedNodeIds: Object.keys(graph.nodes),
            activeTailAdjusted: true,
            resetToEmpty: true,
        };
    }
    const deletedAt = options.deletedAt ?? Date.now();

    // 收集目标子树（excludeNode 时 = 目标的所有后代，不含目标自身）。
    // 性能：预构建 parentId → children 邻接表，一次遍历收集子树，避免每个节点
    // 一次 Object.values 全表扫描（O(n²)）。
    const childrenByParent = new Map<string, string[]>();
    for (const current of Object.values(graph.nodes)) {
        if (current.parentId === null) {
            continue;
        }
        const siblings = childrenByParent.get(current.parentId);
        if (siblings) {
            siblings.push(current.id);
        } else {
            childrenByParent.set(current.parentId, [current.id]);
        }
    }
    const toDelete = new Set<string>();
    const stack = excludeNode
        ? [...(childrenByParent.get(nodeId) ?? [])]
        : [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toDelete.has(id)) {
            continue;
        }
        toDelete.add(id);
        for (const childId of childrenByParent.get(id) ?? []) {
            stack.push(childId);
        }
    }
    if (toDelete.size === 0) {
        return noChange; // excludeNode 且无后代：图未变化
    }

    const nodes: Record<string, ConversationBranchNode> = {};
    for (const [id, current] of Object.entries(graph.nodes)) {
        if (toDelete.has(id)) {
            // 已软删子孙保留首次 deletedAt（幂等语义），未软删的标记为本次删除时间
            const patched: ConversationBranchNode = {
                ...current,
                deleted: true,
                deletedAt: current.deleted ? (current.deletedAt ?? deletedAt) : deletedAt,
            };
            // 子树整体软删：指向已删子节点的 activeChildId 全部清空（validate 不变量）
            if (patched.activeChildId != null && toDelete.has(patched.activeChildId)) {
                patched.activeChildId = null;
            }
            nodes[id] = patched;
        } else {
            // 集合外保留节点：若 activeChildId 指向被删节点（父节点指向分支头等），清空指针
            nodes[id] = current.activeChildId != null && toDelete.has(current.activeChildId)
                ? { ...current, activeChildId: null }
                : current;
        }
    }

    let next: ConversationBranchGraph = { ...graph, nodes };
    // 活跃尾在被删集合内（锚点在活跃路径上 ⇒ 活跃尾在其子树内）：回退到保留锚点
    let activeTailAdjusted = false;
    if (next.activeTailNodeId !== null && toDelete.has(next.activeTailNodeId)) {
        next.activeTailNodeId = excludeNode ? nodeId : (anchor.parentId ?? null);
        activeTailAdjusted = true;
    }
    for (const id of toDelete) {
        next = syncSummaryDeleted(next, id, deletedAt);
    }
    return {
        graph: syncRootMirror(next),
        deletedNodeIds: [...toDelete],
        activeTailAdjusted,
        resetToEmpty: false,
    };
}

/** 候选摘要同步软删/恢复标记（内部辅助，复用 upsertCandidateSummary 的替换语义） */
function syncSummaryDeleted(graph: ConversationBranchGraph, nodeId: string, deletedAt: number): ConversationBranchGraph {
    const summaries = graph.candidateSummaries ?? [];
    const summary = summaries.find(s => s.nodeId === nodeId);
    if (!summary || summary.deleted) {
        return graph;
    }
    return {
        ...graph,
        candidateSummaries: summaries.map(s =>
            s.nodeId === nodeId ? { ...s, deleted: true, deletedAt } : s
        ),
    };
}

/**
 * TREE-09：恢复软删节点（纯函数）。
 * - 节点清除 deleted / deletedAt；候选摘要同步清除；
 * - R8c-P1：**级联恢复整棵子树**——与 softDeleteNode 对称，子树内所有软删节点
 *   的 deleted / deletedAt 一并清除（整体恢复）；
 * - 不自动重新激活（恢复后仍是普通非活跃节点，由 switchBranchCandidate 显式切换；
 *   软删时被清空的 activeChildId 指针不会自动重建）。
 */
export function restoreNode(
    graph: ConversationBranchGraph,
    nodeId: string
): ConversationBranchGraph {
    const node = graph.nodes[nodeId];
    if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
    }
    if (!node.deleted) {
        return graph; // 幂等：未删除节点无需恢复
    }
    const nodes = { ...graph.nodes };
    // 收集整棵子树（含自身）：软删是级联的，子孙必然也是软删（或遗留数据中未标记，一并清理标记）。
    // 性能：预构建 parentId → children 邻接表，一次遍历收集子树，避免每个节点
    // 一次 Object.values 全表扫描（O(n²)）。
    const childrenByParent = new Map<string, string[]>();
    for (const current of Object.values(nodes)) {
        if (current.parentId === null) {
            continue;
        }
        const siblings = childrenByParent.get(current.parentId);
        if (siblings) {
            siblings.push(current.id);
        } else {
            childrenByParent.set(current.parentId, [current.id]);
        }
    }
    const toRestore = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toRestore.has(id)) {
            continue;
        }
        toRestore.add(id);
        for (const childId of childrenByParent.get(id) ?? []) {
            stack.push(childId);
        }
    }
    for (const id of toRestore) {
        const cleaned: ConversationBranchNode = { ...nodes[id] };
        delete cleaned.deleted;
        delete cleaned.deletedAt;
        nodes[id] = cleaned;
    }
    const next: ConversationBranchGraph = { ...graph, nodes };
    const summaries = next.candidateSummaries ?? [];
    const restoredSummaries = new Map<string, BranchCandidateSummary | undefined>();
    let summariesChanged = false;
    // 同一 nodeId 仍由首项决定是否恢复；恢复时所有同 ID 摘要沿用首项，保持旧记录语义。
    for (const summary of summaries) {
        if (!toRestore.has(summary.nodeId) || restoredSummaries.has(summary.nodeId)) continue;
        if (!summary.deleted) {
            restoredSummaries.set(summary.nodeId, undefined);
            continue;
        }
        const cleanedSummary: BranchCandidateSummary = { ...summary };
        delete cleanedSummary.deleted;
        delete cleanedSummary.deletedAt;
        restoredSummaries.set(summary.nodeId, cleanedSummary);
        summariesChanged = true;
    }
    if (summariesChanged) next.candidateSummaries = summaries.map(summary => restoredSummaries.get(summary.nodeId) ?? summary);
    return next;
}

/**
 * TREE-09：收集图中所有软删节点 id（getDeletedBranchCount 用）。
 * R8c-P1 级联软删落地后：软删分支头 ⇒ 整棵子树均已标记 deleted，计数天然含整棵子树。
 */
export function collectDeletedNodes(graph: ConversationBranchGraph): string[] {
    return Object.values(graph.nodes)
        .filter(n => n.deleted)
        .map(n => n.id);
}

/**
 * TREE-09：物理清理过期软删节点及其整棵子树（纯函数）。
 *
 * 规则：
 * - 过期判定 isDeletedNodeExpired（deletedAt ?? createdAt 兜底；retentionDays<=0 不过期）；
 * - 节点过期后其整棵子树一并物理移除（R8c-P1：softDeleteNode 已级联软删整棵子树，
 *   deleted 节点下不允许再插入新子节点，因此子树中的节点必然是软删节点——物理清理
 *   不丢失任何“从未软删”的内容，且 prune 前的任意时刻子树都可通过 restoreNode 整体恢复）；
 * - 同步清理：候选摘要、exportedFrom / exportedRefs 中对被删节点的引用、
 *   父节点 activeChildId（防御：删除节点不允许活跃，正常不会指向被删节点）；
 * - 返回清理后的图与本次物理移除的节点 id 列表。
 */
export function pruneDeletedNodes(
    graph: ConversationBranchGraph,
    options: { now?: number; retentionDays?: number } = {}
): { graph: ConversationBranchGraph; prunedNodeIds: string[] } {
    const now = options.now ?? Date.now();
    const retentionDays = options.retentionDays ?? 0;

    // 1. 找出所有过期的软删节点
    const expired = new Set<string>();
    for (const current of Object.values(graph.nodes)) {
        if (isDeletedNodeExpired(current, now, retentionDays)) {
            expired.add(current.id);
        }
    }
    if (expired.size === 0) {
        return { graph, prunedNodeIds: [] };
    }

    // 2. 从每个过期节点向下扩展整棵子树（含未单独过期的子节点）
    const toRemove = new Set<string>();
    const stack = [...expired];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toRemove.has(id)) {
            continue;
        }
        toRemove.add(id);
        for (const current of Object.values(graph.nodes)) {
            if (current.parentId === id) {
                stack.push(current.id);
            }
        }
    }
    return removeNodeSet(graph, toRemove);
}

/**
 * TREE-09：物理移除指定节点及其整棵子树（纯函数；purgeBranchCandidate 的"彻底删除"入口）。
 * 节点缺失 → NODE_NOT_FOUND；移除语义与 pruneDeletedNodes 一致（候选摘要 / exportedFrom /
 * exportedRefs / activeChildId 引用一并清理）。
 */
export function removeSubtree(
    graph: ConversationBranchGraph,
    nodeId: string
): { graph: ConversationBranchGraph; prunedNodeIds: string[] } {
    if (!graph.nodes[nodeId]) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
    }
    const toRemove = new Set<string>([nodeId]);
    const stack = [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        for (const current of Object.values(graph.nodes)) {
            if (current.parentId === id) {
                if (!toRemove.has(current.id)) {
                    toRemove.add(current.id);
                    stack.push(current.id);
                }
            }
        }
    }
    return removeNodeSet(graph, toRemove);
}
