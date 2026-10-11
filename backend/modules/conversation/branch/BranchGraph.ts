/**
 * 树状分支图纯函数模块（第五阶段 BR-08）。
 *
 * 只做内存中的图运算，不碰文件系统，全部可单测：
 * - insertNode：插入节点（可选激活 + 更新尾指针）
 * - rerollCandidate / editCandidate：同一父节点下新增候选并切换 activeChildId（旧候选保留）
 * - activateChild / switchActivePath：切换活跃子指针 / 切换整条活跃路径（TREE-04/06 基础）
 * - activePath：从 root 沿 activeChildId 到 activeTail 的节点 id 链
 * - rebuildActivePath：给定目标节点，解析到其活跃尾的完整路径
 * - childrenIndex：Map<parentId, childIds>（运行时索引，不落盘）
 * - validate：图一致性校验（parentId 存在性、无环、activeChildId 指向真实子节点、单根等）
 * - upsertCandidateSummary / removeCandidateSummary：候选摘要维护
 * - softDeleteNode / restoreNode / renameBranchLabel / collectDeletedNodes /
 *   isDeletedNodeExpired / pruneDeletedNodes：TREE-09 软删除 / 恢复 / 重命名 / 修剪（纯函数）
 *
 * 决策 3 不变式：单 parentId 索引、不存 childrenIds、activeChildId 指针。
 * 规划不变量（L1310–1337）：主历史 = 当前活跃路径；本模块只提供路径解析，不触碰主历史。
 */

import { BranchError } from './types';
import type {
    BranchCandidateSummary,
    BranchContentMetadata,
    ConversationBranchGraph,
    ConversationBranchNode,
} from './types';
import type { ContentPart, UsageMetadata } from '../types';
import { cloneGraph, deriveActiveTail, syncRootMirror } from './branchGraphTopology';

// 原入口保留完整 API，内部模块直接依赖各职责来源，避免经入口形成循环依赖。
export { createEmptyBranchGraph, activePath, rebuildActivePath, childrenIndex } from './branchGraphTopology';
export { validate } from './branchGraphValidation';
export type { BranchValidationIssue, BranchValidationResult } from './branchGraphValidation';
export {
    extractBranchContentMetadata, isFunctionResponseMessage, findUnsyncedFunctionResponses,
    importLinearHistory, rebaseActivePathFromHistory,
} from './branchGraphHistory';
export {
    isDeletedNodeExpired, softDeleteNode, softDeleteSubtreeFrom, restoreNode,
    collectDeletedNodes, pruneDeletedNodes, removeSubtree,
} from './branchGraphRetention';
export type { SoftDeleteSubtreeResult } from './branchGraphRetention';

/**
 * 空占位候选（reroll/edit 流式窗口的活跃尾）的超龄阈值。
 *
 * 进程崩溃/被杀会让空占位永久残留为活跃尾，后续普通追加因此持续跳过图同步，
 * branches.json 永久冻结（PR #16 只修了优雅路径）。超过该时长仍为空的占位视为
 * 「流已死亡」——正常流式窗口内的占位是新建的（远小于该阈值），超龄只会出现在
 * 流从未回填且不再活跃的场景，允许图同步把它移出活跃路径。
 */
export const EMPTY_PLACEHOLDER_STALE_MS = 10 * 60 * 1000;

/**
 * 判定活跃尾是否为「仍在流式窗口内」的空占位候选（reroll/edit、parts 为空、未超龄）。
 * 非活跃路径上的空节点或超龄占位返回 false——前者本就不锁活跃路径，
 * 后者视为流已死亡，不应再阻止图同步。
 */
export function isActiveEmptyPlaceholder(
    tail: ConversationBranchNode | undefined,
    now: number = Date.now()
): boolean {
    if (!tail || (tail.parts?.length ?? 0) !== 0) {
        return false;
    }
    if (tail.kind !== 'reroll' && tail.kind !== 'edit') {
        return false;
    }
    if (typeof tail.createdAt === 'number' && now - tail.createdAt > EMPTY_PLACEHOLDER_STALE_MS) {
        return false;
    }
    return true;
}

/**
 * 插入节点。
 *
 * 语义：
 * - parentId 为 null 且图中尚无根 → 该节点成为根（rootNodeId）；
 * - parentId 为 null 但已有根 → INVALID_BRANCH_RELATION（单根不变量）；
 * - parentId 非 null 但根尚未建立 → INVALID_BRANCH_RELATION；
 * - setActive（默认 true）：父节点 activeChildId 指向新节点；
 * - updateTail（默认 true）：activeTailNodeId 指向新节点；
 * - 根节点为 null 的图插入子节点前必须先有根。
 */
export function insertNode(
    graph: ConversationBranchGraph,
    node: ConversationBranchNode,
    options: { setActive?: boolean; updateTail?: boolean } = {}
): ConversationBranchGraph {
    const setActive = options.setActive ?? true;
    const updateTail = options.updateTail ?? true;

    if (node.id === node.parentId) {
        throw new BranchError('INVALID_BRANCH_RELATION', `node cannot be its own parent: ${node.id}`);
    }
    if (graph.nodes[node.id]) {
        throw new BranchError('INVALID_BRANCH_RELATION', `duplicate node id: ${node.id}`);
    }
    if (node.parentId !== null) {
        const parent = graph.nodes[node.parentId];
        if (!parent) {
            throw new BranchError('NODE_NOT_FOUND', `parent node not found: ${node.parentId}`);
        }
        if (parent.deleted) {
            throw new BranchError(
                'INVALID_BRANCH_RELATION',
                `cannot insert child under deleted node: ${node.parentId}`
            );
        }
        if (graph.rootNodeId === null) {
            throw new BranchError('INVALID_BRANCH_RELATION', 'cannot insert a child before the root node');
        }
    } else if (graph.rootNodeId !== null) {
        throw new BranchError(
            'INVALID_BRANCH_RELATION',
            `graph already has a root node: ${graph.rootNodeId}`
        );
    }

    const next = cloneGraph(graph);
    if (node.parentId !== null) {
        const parent = next.nodes[node.parentId]!;
        if (setActive) {
            next.nodes[node.parentId] = { ...parent, activeChildId: node.id };
        }
    } else {
        next.rootNodeId = node.id;
    }
    next.nodes[node.id] = { ...node };
    if (updateTail) {
        // 尾指针必须从活跃路径派生：仅当新节点（因 setActive）落在活跃路径上时才会成为新尾；
        // 插入到非活跃分支下的节点不改变活跃尾。
        next.activeTailNodeId = deriveActiveTail(next);
    }
    return syncRootMirror(next);
}

/**
 * 重新生成候选（TREE-01）：同一父节点下新增候选并切换 activeChildId，旧候选及其子树保留。
 * kind 固定为 'reroll'（需要其他 kind 请直接使用 insertNode）。
 */
export function rerollCandidate(
    graph: ConversationBranchGraph,
    parentId: string,
    node: ConversationBranchNode,
    options: { updateTail?: boolean } = {}
): ConversationBranchGraph {
    return insertNode(
        graph,
        { ...node, parentId, kind: 'reroll' },
        { setActive: true, updateTail: options.updateTail ?? true }
    );
}

/**
 * 编辑分支候选（TREE-03）：在旧用户节点的父节点下创建编辑版候选并切换 activeChildId，
 * 旧子树完整保留。kind 固定为 'edit'（需要其他 kind 请直接使用 insertNode）。
 */
export function editCandidate(
    graph: ConversationBranchGraph,
    parentId: string,
    node: ConversationBranchNode,
    options: { updateTail?: boolean } = {}
): ConversationBranchGraph {
    return insertNode(
        graph,
        { ...node, parentId, kind: 'edit' },
        { setActive: true, updateTail: options.updateTail ?? true }
    );
}

/**
 * 切换父节点的活跃子指针（TREE-04 候选左右切换的核心原语）。
 * 尾指针更新为该子节点子树的活跃尾（updateTail 默认 true）。
 */
export function activateChild(
    graph: ConversationBranchGraph,
    parentId: string,
    childId: string,
    options: { updateTail?: boolean } = {}
): ConversationBranchGraph {
    const parent = graph.nodes[parentId];
    if (!parent) {
        throw new BranchError('NODE_NOT_FOUND', `parent node not found: ${parentId}`);
    }
    const child = graph.nodes[childId];
    if (!child) {
        throw new BranchError('NODE_NOT_FOUND', `child node not found: ${childId}`);
    }
    if (child.parentId !== parentId) {
        throw new BranchError(
            'INVALID_BRANCH_RELATION',
            `node ${childId} is not a direct child of ${parentId}`
        );
    }
    if (child.deleted) {
        throw new BranchError('INVALID_BRANCH_RELATION', `cannot activate deleted node: ${childId}`);
    }
    const next = cloneGraph(graph);
    next.nodes[parentId] = { ...parent, activeChildId: childId };
    if (options.updateTail !== false) {
        next.activeTailNodeId = deriveActiveTail(next);
    }
    return syncRootMirror(next);
}

/**
 * 切换整条活跃路径到目标节点（TREE-06 切换重建的基础）。
 * 把 root → … → target 每个祖先的 activeChildId 指向路径下一节点，
 * activeTailNodeId 更新为目标子树沿 activeChildId 的尾。
 *
 * R8c-P2：目标到 root 的 parentId 链上任一节点为软删节点 → BRANCH_OPERATION_CONFLICT
 * （业务冲突语义，非损坏）。级联软删落地后主要出现在「父被软删但子仍 live」的旧数据；
 * 若不拦截，切换会把软删祖先重新指为活跃路径节点，validate 报损坏且 validateAndSave
 * 拒绝落盘，节点成为“显示可用但不可用”的死状态。
 */
export function switchActivePath(
    graph: ConversationBranchGraph,
    targetNodeId: string
): ConversationBranchGraph {
    const target = graph.nodes[targetNodeId];
    if (!target) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${targetNodeId}`);
    }

    // 向上沿 parentId 收集 root → … → target
    const upward: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = targetNodeId;
    while (cursor !== null) {
        if (seen.has(cursor)) {
            throw new BranchError('BRANCH_STORAGE_CORRUPT', `cycle detected along parentId chain at node ${cursor}`);
        }
        seen.add(cursor);
        const current = graph.nodes[cursor];
        if (!current) {
            throw new BranchError('BRANCH_STORAGE_CORRUPT', `node missing on parentId chain: ${cursor}`);
        }
        upward.push(cursor);
        cursor = current.parentId;
    }
    upward.reverse(); // root → … → target

    if (graph.rootNodeId !== null && upward[0] !== graph.rootNodeId) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `target ${targetNodeId} is not reachable from rootNodeId ${graph.rootNodeId}`
        );
    }

    // R8c-P2：目标到 root 的整条链上不得存在软删节点（含目标自身）。
    // 注意：校验必须在结构校验（环/缺失/可达性）之后，保证报错优先级为损坏 → 冲突。
    const deletedOnPath = upward.find(id => graph.nodes[id]!.deleted);
    if (deletedOnPath !== undefined) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot switch to node ${targetNodeId}: node ${deletedOnPath} on the path to root is soft-deleted; restore it first`
        );
    }

    const next = cloneGraph(graph);
    for (let i = 0; i < upward.length - 1; i += 1) {
        const parentId = upward[i];
        const childId = upward[i + 1];
        const parent = next.nodes[parentId]!;
        next.nodes[parentId] = { ...parent, activeChildId: childId };
    }
    next.rootNodeId = graph.rootNodeId ?? upward[0] ?? null;
    next.activeTailNodeId = deriveActiveTail(next);
    return syncRootMirror(next);
}

/** 新增 / 覆盖候选摘要（TREE-02；摘要文本由写入方生成） */
export function upsertCandidateSummary(
    graph: ConversationBranchGraph,
    summary: BranchCandidateSummary
): ConversationBranchGraph {
    const summaries = (graph.candidateSummaries ?? []).filter(s => s.nodeId !== summary.nodeId);
    summaries.push({ ...summary });
    return { ...graph, candidateSummaries: summaries };
}

/**
 * TREE-09：重命名分支标签（纯函数）。
 * 只改 label（节点 + 候选摘要同步），不动 contents（parts/usageMetadata 等原样保留）。
 */
export function renameBranchLabel(
    graph: ConversationBranchGraph,
    nodeId: string,
    label: string
): ConversationBranchGraph {
    const node = graph.nodes[nodeId];
    if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
        throw new BranchError('INVALID_BRANCH_RELATION', 'branch label must not be empty');
    }
    if (trimmed.length > 200) {
        throw new BranchError('INVALID_BRANCH_RELATION', `branch label is too long (max 200 chars, got ${trimmed.length})`);
    }
    const nodes = { ...graph.nodes };
    nodes[nodeId] = { ...node, label: trimmed };
    const next: ConversationBranchGraph = { ...graph, nodes };
    const summaries = next.candidateSummaries ?? [];
    const summary = summaries.find(s => s.nodeId === nodeId);
    if (summary) {
        next.candidateSummaries = summaries.map(s =>
            s.nodeId === nodeId ? { ...s, label: trimmed } : s
        );
    }
    return next;
}

/** 删除候选摘要（候选删除 / 修剪时） */
export function removeCandidateSummary(graph: ConversationBranchGraph, nodeId: string): ConversationBranchGraph {
    return {
        ...graph,
        candidateSummaries: (graph.candidateSummaries ?? []).filter(s => s.nodeId !== nodeId),
    };
}

/**
 * 更新节点内容（TREE-01：reroll 流式结果写入新节点）。
 * 只替换显式提供的字段（parts / modelVersion / usageMetadata / timestamp），其余字段保留；
 * parts 深拷贝，避免调用方后续原地修改污染图数据。
 */
export function updateNodeContent(
    graph: ConversationBranchGraph,
    nodeId: string,
    patch: {
        parts?: ContentPart[];
        modelVersion?: string;
        usageMetadata?: UsageMetadata;
        /** R8b-M2：中断/取消流的截断用量标记（随 usageMetadata 一起写入节点） */
        usageMetadataPartial?: boolean;
        contentMetadata?: BranchContentMetadata;
        timestamp?: number;
    }
): ConversationBranchGraph {
    const node = graph.nodes[nodeId];
    if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
    }
    const next = cloneGraph(graph);
    next.nodes[nodeId] = {
        ...node,
        ...(patch.parts !== undefined ? { parts: JSON.parse(JSON.stringify(patch.parts)) } : {}),
        ...(patch.modelVersion !== undefined ? { modelVersion: patch.modelVersion } : {}),
        ...(patch.usageMetadata !== undefined ? { usageMetadata: patch.usageMetadata } : {}),
        ...(patch.usageMetadataPartial !== undefined ? { usageMetadataPartial: patch.usageMetadataPartial } : {}),
        ...(patch.contentMetadata !== undefined
            ? { contentMetadata: structuredClone(patch.contentMetadata) }
            : {}),
        ...(patch.timestamp !== undefined ? { timestamp: patch.timestamp } : {}),
    };
    return next;
}

/**
 * 重命名节点 ID（TREE-01：reroll 完成后候选节点 ID 对齐主历史首条新消息 ID，BR-01 同源约束）。
 * 同步修正所有引用：nodes key、父节点 activeChildId、子节点 parentId、activeTailNodeId、
 * rootNodeId、graph.activeChildId 镜像、candidateSummaries、exportedFrom / exportedRefs。
 * oldId === newId 时为 no-op；newId 已被占用抛 INVALID_BRANCH_RELATION。
 */
export function renameNode(
    graph: ConversationBranchGraph,
    oldId: string,
    newId: string
): ConversationBranchGraph {
    const node = graph.nodes[oldId];
    if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${oldId}`);
    }
    if (oldId === newId) {
        return graph;
    }
    if (graph.nodes[newId]) {
        throw new BranchError('INVALID_BRANCH_RELATION', `duplicate node id: ${newId}`);
    }

    const nodes: Record<string, ConversationBranchNode> = { ...graph.nodes };
    delete nodes[oldId];
    const renamed: ConversationBranchNode = { ...node, id: newId };
    nodes[newId] = renamed;

    // 父节点 activeChildId 指向新 id
    if (node.parentId !== null) {
        const parent = nodes[node.parentId];
        if (parent && parent.activeChildId === oldId) {
            nodes[node.parentId] = { ...parent, activeChildId: newId };
        }
    }
    // 子节点 parentId 同步（重命名发生在子节点插入前，此处为一般性兜底）
    for (const child of Object.values(nodes)) {
        if (child.parentId === oldId) {
            nodes[child.id] = { ...child, parentId: newId };
        }
    }

    const next: ConversationBranchGraph = {
        ...graph,
        nodes,
        rootNodeId: graph.rootNodeId === oldId ? newId : graph.rootNodeId,
        activeTailNodeId: graph.activeTailNodeId === oldId ? newId : graph.activeTailNodeId,
        activeChildId: graph.activeChildId === oldId ? newId : graph.activeChildId,
    };
    next.candidateSummaries = (graph.candidateSummaries ?? []).map(summary =>
        summary.nodeId === oldId ? { ...summary, nodeId: newId } : summary
    );
    if (next.exportedFrom?.nodeId === oldId) {
        next.exportedFrom = { ...next.exportedFrom, nodeId: newId };
    }
    if (next.exportedRefs) {
        next.exportedRefs = next.exportedRefs.map(record =>
            record.nodeId === oldId ? { ...record, nodeId: newId } : record
        );
    }
    return next;
}
