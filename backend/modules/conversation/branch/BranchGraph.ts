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

import { BRANCH_GRAPH_VERSION, BranchError } from './types';
import type {
    BranchCandidateSummary,
    BranchContentMetadata,
    ConversationBranchGraph,
    ConversationBranchNode,
} from './types';
import type { Content, ContentPart, UsageMetadata } from '../types';

/** 从主历史消息提取需要随分支节点往返保留的非拓扑元数据。 */
export function extractBranchContentMetadata(message: Content): BranchContentMetadata | undefined {
    const metadata: Record<string, unknown> = { ...message };
    for (const key of [
        'id',
        'parentId',
        'role',
        'parts',
        'index',
        'timestamp',
        'modelVersion',
        'usageMetadata',
        'usageMetadataPartial',
        // 回合内动态上下文的完整序列化快照（可能数 KB~数十 KB）：随节点往返 sidecar 会让
        // branches.json 显著膨胀，且切分支重写主历史时会回写图中**旧回合**的缓存，若该消息
        // 的缓存之后已被 updateMessagesBatch 刷新（工具循环每回合重写），切走切回会把陈旧
        // 缓存覆盖回主历史。动态上下文缓存本应在下一回合按当前上下文重新生成，不参与往返。
        'turnDynamicContext',
        'turnDynamicContextStrategy',
    ]) {
        delete metadata[key];
    }
    // 显式 undefined 字段（如流式完成时被移除的 thinkingStartTime）不参与往返，
    // 否则 sidecar 会序列化出空对象/无效键，且后续每次对账都产生无意义的元数据差异。
    for (const key of Object.keys(metadata)) {
        if (metadata[key] === undefined) {
            delete metadata[key];
        }
    }
    if (Object.keys(metadata).length === 0) {
        return undefined;
    }
    return structuredClone(metadata) as BranchContentMetadata;
}

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

/** 校验问题分类 */
export interface BranchValidationIssue {
    code: 'NODE_NOT_FOUND' | 'INVALID_BRANCH_RELATION' | 'BRANCH_STORAGE_CORRUPT';
    /** 人类可读描述 */
    message: string;
    /** 关联节点 ID（如有） */
    nodeId?: string;
}

/** 校验结果 */
export interface BranchValidationResult {
    valid: boolean;
    issues: BranchValidationIssue[];
}

/** 空图（线性模式 / 首次建图前使用） */
export function createEmptyBranchGraph(): ConversationBranchGraph {
    return {
        version: BRANCH_GRAPH_VERSION,
        rootNodeId: null,
        activeTailNodeId: null,
        nodes: {},
        activeChildId: null,
        candidateSummaries: [],
    };
}

/**
 * 判断一条主历史消息是否为 functionResponse 消息（决策 8：不独立成节点）。
 * 显式标记 isFunctionResponse=true，或 role='user' 且 parts 全部为 functionResponse。
 */
export function isFunctionResponseMessage(message: Pick<Content, 'role' | 'isFunctionResponse' | 'parts'>): boolean {
    if (message.isFunctionResponse === true) {
        return true;
    }
    if (message.role !== 'user') {
        return false;
    }
    const parts = message.parts ?? [];
    return parts.length > 0 && parts.every(part => !!part.functionResponse);
}

/**
 * R8a-M2：沿主历史追踪「最近非 FR 消息 id」作为 owner，校验 functionResponse 内容是否已并入图。
 *
 * 决策 8：functionResponse 消息不独立成节点，其 parts 并入所属节点（owner）。切换重写
 * （rewriteHistoryFromBranchGraph）只取图节点内容重建主历史——若 FR 的 functionResponse parts
 * 未同步进 owner 节点 parts（appendHistoryToGraph 为锁外 fire-and-forget，失败仅告警；且
 * addContent(FR) 走 mutateContents 不触发图同步），切换会静默丢弃 FR 内容。本函数在 R8a-M2
 * 非 FR 检查（主历史非 FR 消息 id ∈ 图节点集合）基础上补齐 FR 内容校验：
 *
 * 规则：
 * - 沿主历史顺序追踪最近非 FR 消息 id 作为当前 owner；遇到 functionResponse 消息时，其
 *   parts 中非空 functionResponse.id 集合必须是 graph.nodes[ownerId].parts 中
 *   functionResponse.id 集合的【子集】——多条 FR 消息对同一 owner 各自做子集匹配而非全等
 *   （owner 同步了更多 FR 不影响单条判定），不满足则把该 FR 消息 id（缺失用空串）加入结果；
 * - owner 为 null（首条即 FR）跳过（无可依附节点，由导入/追加路径显式丢弃，不重复计数）；
 * - owner 节点不在图中跳过（未入图由现有非 FR 检查兜底，避免重复计数）；
 * - 无 id 的 FR part 跳过（无法关联到图节点 parts 中的 FR id）。
 */
export function findUnsyncedFunctionResponses(
    history: ReadonlyArray<Content>,
    graph: ConversationBranchGraph
): string[] {
    const unsynced: string[] = [];
    let ownerId: string | null = null;
    for (const message of history) {
        if (!isFunctionResponseMessage(message)) {
            ownerId = message.id ?? null;
            continue;
        }
        if (ownerId === null) {
            continue; // 首条即 FR：无可依附 owner
        }
        const ownerNode = graph.nodes[ownerId];
        if (!ownerNode) {
            continue; // owner 未入图：由非 FR 检查兜底，避免重复计数
        }
        const frIds = (message.parts ?? [])
            .map(part => part.functionResponse?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (frIds.length === 0) {
            continue; // 无 id 的 FR part 跳过
        }
        const ownerFrIds = new Set(
            (ownerNode.parts ?? [])
                .map(part => part.functionResponse?.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
        );
        if (frIds.some(id => !ownerFrIds.has(id))) {
            unsynced.push(message.id ?? '');
        }
    }
    return unsynced;
}

/**
 * 把线性主历史（Content[]）导入为 BranchGraph（MIG-01 / BR-09：节点 kind='imported'）。
 *
 * 规则（与「主历史 = 活跃路径」不变量对齐）：
 * - 每条消息一个节点，parentId 线性链接：首条为 null，后续优先沿用消息自带 parentId（仅当它
 *   指向图中已存在的节点，避免指向被吸收的 functionResponse 造成悬空），否则取前一个节点 id；
 * - 活跃路径 = 全量（线性历史即当前活跃路径），尾指针 = 最后一条消息；
 * - functionResponse 消息不独立成节点（决策 8）：其 parts 合并进前一个节点（模型节点），
 *   连续多条 functionResponse 依次累积；
 * - 消息无 id 时用确定性兜底 id（调用方应先 ensureHistoryNodeIds，此处仅防异常输入）。
 */
export function importLinearHistory(
    history: ReadonlyArray<Content>,
    options: { createdAt?: number } = {}
): ConversationBranchGraph {
    let graph = createEmptyBranchGraph();
    const now = options.createdAt ?? Date.now();
    let previousNode: ConversationBranchNode | null = null;
    // M-4/复查：createdAt 沿消息顺序严格递增（相同/乱序 timestamp 时按序 +1），
    // 保证 childrenIndex 候选排序 = 消息顺序，不回退到同毫秒的 id 字典序。
    let previousCreatedAt = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        if (isFunctionResponseMessage(message)) {
            // 决策 8：functionResponse 依附前一个节点（模型节点），不建独立节点。
            if (previousNode) {
                const merged: ConversationBranchNode = {
                    ...previousNode,
                    parts: [...previousNode.parts, ...(message.parts ?? [])],
                };
                graph = { ...graph, nodes: { ...graph.nodes, [merged.id]: merged } };
                previousNode = merged;
            } else {
                // M-4：首条消息即为 functionResponse 且无前驱节点——无法挂载（没有可依附的
                // 模型/用户节点），静默丢弃会掩盖异常历史输入，此处显式记录丢弃原因。
                console.warn(
                    `importLinearHistory: dropping leading functionResponse message `
                    + `(id=${typeof message.id === 'string' ? message.id : '(missing)'}) — `
                    + `no preceding node to attach its parts to; the graph would have no root user node`
                );
            }
            continue;
        }
        const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : `imported-${i}`;
        const parentId =
            typeof message.parentId === 'string'
                && message.parentId !== id
                && graph.nodes[message.parentId]
                ? message.parentId
                : (previousNode ? previousNode.id : null);
        const rawCreatedAt = typeof message.timestamp === 'number' ? message.timestamp : now + i;
        const createdAt = Number.isFinite(previousCreatedAt)
            ? Math.max(rawCreatedAt, previousCreatedAt + 1)
            : rawCreatedAt;
        previousCreatedAt = createdAt;
        const node: ConversationBranchNode = {
            id,
            parentId,
            role: message.role,
            parts: message.parts ?? [],
            kind: 'imported',
            createdAt,
            timestamp: message.timestamp,
            modelVersion: message.modelVersion,
            usageMetadata: message.usageMetadata,
            contentMetadata: extractBranchContentMetadata(message),
            // R8b-M2：中断/取消流的截断用量标记随节点一起拷贝（统计端回退估算）
            usageMetadataPartial: message.usageMetadataPartial,
        };
        graph = insertNode(graph, node, { setActive: true, updateTail: true });
        previousNode = node;
    }
    return graph;
}

/**
 * 以主历史重建“活跃路径”，同时保留 sidecar 中的旧候选与非活跃子树。
 *
 * 用于恢复这种可解析但已落后的 sidecar：已经结束的空 reroll/edit 占位节点曾让后续追加
 * 永久跳过同步，或结构性历史更新没有同步进 branches.json。主历史是当前路径的唯一真源；
 * 旧图只作为候选归档保留。
 *
 * 安全边界：
 * - 两边根节点必须一致；根已变化意味着无法在单根模型中无损合并，明确拒绝；
 * - 当前历史节点复用同 id 的旧节点元数据（标签、工作区存档、kind），正文与父链以历史为准；
 * - 从旧活跃路径移出的节点仍留在 nodes 中，成为非活跃候选，不做物理删除；
 * - 返回前执行完整 validate，无法保持图不变量时拒绝修复。
 */
export function rebaseActivePathFromHistory(
    graph: ConversationBranchGraph,
    history: ReadonlyArray<Content>
): ConversationBranchGraph {
    const canonical = importLinearHistory(history);
    if (graph.rootNodeId === null) {
        return canonical;
    }
    if (canonical.rootNodeId === null) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            'cannot reconcile a non-empty branch graph with an empty main history'
        );
    }
    if (graph.rootNodeId !== canonical.rootNodeId) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot safely reconcile branch graph root ${graph.rootNodeId} with main history root ${canonical.rootNodeId}`
        );
    }

    const historyPath = activePath(canonical);
    const nodes: Record<string, ConversationBranchNode> = { ...graph.nodes };
    for (let index = 0; index < historyPath.length; index += 1) {
        const id = historyPath[index]!;
        const source = canonical.nodes[id]!;
        const existing = nodes[id];
        const merged: ConversationBranchNode = existing
            ? {
                ...existing,
                id,
                parentId: source.parentId,
                role: source.role,
                parts: structuredClone(source.parts),
                createdAt: source.createdAt,
                timestamp: source.timestamp,
                modelVersion: source.modelVersion,
                usageMetadata: source.usageMetadata,
                usageMetadataPartial: source.usageMetadataPartial,
                contentMetadata: source.contentMetadata ? structuredClone(source.contentMetadata) : undefined,
                activeChildId: historyPath[index + 1] ?? null,
            }
            : {
                ...source,
                parts: structuredClone(source.parts),
                kind: 'imported',
                activeChildId: historyPath[index + 1] ?? null,
            };
        // 主历史中的节点属于当前活跃路径，不能继续携带旧的软删除状态。
        delete merged.deleted;
        delete merged.deletedAt;
        nodes[id] = merged;
    }

    // 当前节点被重新挂接后，旧父节点可能仍指向它；清除所有不再指向真实直接子节点的活动指针。
    for (const [id, node] of Object.entries(nodes)) {
        const childId = node.activeChildId;
        if (childId && nodes[childId]?.parentId !== id) {
            nodes[id] = { ...node, activeChildId: null };
        }
    }
    // 上一步只清旧指针；再次明确写入当前路径，保证当前路径始终是唯一活跃链。
    for (let index = 0; index < historyPath.length; index += 1) {
        const id = historyPath[index]!;
        nodes[id] = { ...nodes[id]!, activeChildId: historyPath[index + 1] ?? null };
    }

    const candidateSummaries = (graph.candidateSummaries ?? []).map(summary => {
        const node = nodes[summary.nodeId];
        if (!node) return summary;
        const nextSummary: BranchCandidateSummary = { ...summary, parentId: node.parentId };
        if (!node.deleted) {
            delete nextSummary.deleted;
            delete nextSummary.deletedAt;
        }
        return nextSummary;
    });
    const root = nodes[canonical.rootNodeId]!;
    const next: ConversationBranchGraph = {
        ...graph,
        rootNodeId: canonical.rootNodeId,
        activeTailNodeId: canonical.activeTailNodeId,
        nodes,
        activeChildId: root.activeChildId ?? null,
        candidateSummaries,
    };
    const validation = validate(next);
    if (!validation.valid) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot safely reconcile branch graph with main history: ${validation.issues.map(issue => issue.message).join('; ')}`
        );
    }
    return next;
}

/** 浅拷贝图（nodes 记录复制，节点对象与 parts 共享引用——数据视为不可变） */
function cloneGraph(graph: ConversationBranchGraph): ConversationBranchGraph {
    return { ...graph, nodes: { ...graph.nodes } };
}

/** 同步根节点 activeChildId 镜像指针（内部维护，调用方传入的是克隆后的图） */
function syncRootMirror(graph: ConversationBranchGraph): ConversationBranchGraph {
    if (graph.rootNodeId !== null) {
        const root = graph.nodes[graph.rootNodeId];
        graph.activeChildId = root ? (root.activeChildId ?? null) : null;
    } else {
        graph.activeChildId = null;
    }
    return graph;
}

/**
 * 沿当前 activeChildId 指针推导活跃路径尾节点（不抛错：遇环/缺失即停止，返回最后可达节点）。
 * 这是 activeTailNodeId 的唯一派生源：任何活跃指针变更后都应调用它重算尾指针，
 * 保证「尾指针 = 活跃路径最后一个节点」的不变量（规划 L1310–1337）。
 */
function deriveActiveTail(graph: ConversationBranchGraph): string | null {
    if (graph.rootNodeId === null) {
        return null;
    }
    let cursor: string | null = graph.rootNodeId;
    const seen = new Set<string>();
    let last: string | null = null;
    while (cursor !== null) {
        if (seen.has(cursor)) {
            break;
        }
        seen.add(cursor);
        last = cursor;
        cursor = graph.nodes[cursor]?.activeChildId ?? null;
    }
    return last;
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

/**
 * 活跃路径：从 root 沿 activeChildId 到 activeTail 的节点 id 链（含两端）。
 * - 空图 → []
 * - activeTailNodeId 为 null → 沿 activeChildId 走到链尾
 * - 尾不可达 / 链上节点缺失 / 环 → BRANCH_STORAGE_CORRUPT
 */
export function activePath(graph: ConversationBranchGraph): string[] {
    if (graph.rootNodeId === null) {
        return [];
    }
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = graph.rootNodeId;
    while (cursor !== null) {
        if (seen.has(cursor)) {
            throw new BranchError('BRANCH_STORAGE_CORRUPT', `cycle detected along activeChildId chain at node ${cursor}`);
        }
        seen.add(cursor);
        const current = graph.nodes[cursor];
        if (!current) {
            throw new BranchError('BRANCH_STORAGE_CORRUPT', `node missing on activeChildId chain: ${cursor}`);
        }
        path.push(cursor);
        if (cursor === graph.activeTailNodeId) {
            break;
        }
        cursor = current.activeChildId ?? null;
    }
    if (graph.activeTailNodeId !== null && path[path.length - 1] !== graph.activeTailNodeId) {
        throw new BranchError(
            'BRANCH_STORAGE_CORRUPT',
            `activeTailNodeId ${graph.activeTailNodeId} is not reachable via activeChildId chain`
        );
    }
    return path;
}

/**
 * 重建活跃路径：给定目标节点，解析从 root 到目标（沿 parentId）再到其活跃尾（沿 activeChildId）
 * 的完整路径（TREE-06 切换重建的核心解析）。
 * 目标节点缺失 → NODE_NOT_FOUND；链上环 / 缺失 → BRANCH_STORAGE_CORRUPT。
 */
export function rebuildActivePath(graph: ConversationBranchGraph, targetNodeId: string): string[] {
    if (!graph.nodes[targetNodeId]) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${targetNodeId}`);
    }

    // 向上：parentId 链 root → … → target
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
    upward.reverse();

    // 向下：从 target 沿 activeChildId 到其子树尾
    const downward: string[] = [];
    seen.clear();
    cursor = targetNodeId;
    while (cursor !== null) {
        if (seen.has(cursor)) {
            throw new BranchError('BRANCH_STORAGE_CORRUPT', `cycle detected along activeChildId chain at node ${cursor}`);
        }
        seen.add(cursor);
        const current = graph.nodes[cursor]!;
        downward.push(cursor);
        cursor = current.activeChildId ?? null;
    }

    // 合并（target 出现两次，去掉向下段的首个重复）
    return upward.concat(downward.slice(1));
}

/**
 * 子节点索引：Map<parentId, childIds>（运行时建立，不落盘）。
 * 每个父节点的子列表按 createdAt 升序（同毫秒按 id 字典序），保证候选顺序稳定；
 * 软删除的节点也包含在内（由调用方按需过滤）。
 */
export function childrenIndex(graph: ConversationBranchGraph): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const current of Object.values(graph.nodes)) {
        if (current.parentId === null) {
            continue;
        }
        const list = index.get(current.parentId);
        if (list) {
            list.push(current.id);
        } else {
            index.set(current.parentId, [current.id]);
        }
    }
    for (const list of index.values()) {
        list.sort((a, b) => {
            const na = graph.nodes[a]!;
            const nb = graph.nodes[b]!;
            if (na.createdAt !== nb.createdAt) {
                return na.createdAt - nb.createdAt;
            }
            return a < b ? -1 : a > b ? 1 : 0;
        });
    }
    return index;
}

/**
 * 图一致性校验。
 * 检查项：
 * - rootNodeId 存在且图非空时必须非 null（单根）
 * - 仅允许一个 parentId 为 null 的节点（即 rootNodeId）
 * - 每个 parentId 指向存在的节点；无自引用；parentId 链无环
 * - activeChildId 指向存在的、直接的、未删除的子节点
 * - activeTailNodeId 存在且从 root 沿 activeChildId 可达
 * - graph.activeChildId 镜像与 rootNode.activeChildId 一致
 * - candidateSummaries 引用的节点存在
 */
export function validate(graph: ConversationBranchGraph): BranchValidationResult {
    const issues: BranchValidationIssue[] = [];
    const push = (code: BranchValidationIssue['code'], message: string, nodeId?: string): void => {
        issues.push({ code, message, nodeId });
    };
    const nodes = graph.nodes;

    // BG-1：版本不符视为损坏（写路径只产生 BRANCH_GRAPH_VERSION；读侧旧/新版本由
    // 迁移/降级处理，validate 不做猜测式放行）。
    if (graph.version !== BRANCH_GRAPH_VERSION) {
        push(
            'BRANCH_STORAGE_CORRUPT',
            `graph version ${graph.version} does not match supported version ${BRANCH_GRAPH_VERSION}`
        );
    }

    // root 存在性与单根
    if (graph.rootNodeId !== null && !nodes[graph.rootNodeId]) {
        push('NODE_NOT_FOUND', `rootNodeId points to missing node`, graph.rootNodeId ?? undefined);
    }
    if (graph.rootNodeId === null && Object.keys(nodes).length > 0) {
        push('INVALID_BRANCH_RELATION', 'graph has nodes but rootNodeId is null');
    }

    for (const current of Object.values(nodes)) {
        // 单根：非根节点不允许 parentId 为 null
        if (current.parentId === null && graph.rootNodeId !== null && current.id !== graph.rootNodeId) {
            push('INVALID_BRANCH_RELATION', 'multiple root nodes detected', current.id);
        }
        // 自引用
        if (current.parentId === current.id) {
            push('INVALID_BRANCH_RELATION', 'node is its own parent', current.id);
        }
        // parentId 存在性
        if (current.parentId !== null && !nodes[current.parentId]) {
            push('NODE_NOT_FOUND', `parentId points to missing node: ${current.parentId}`, current.id);
        }
        // parentId 链无环
        const seen = new Set<string>();
        let cursor: string | null = current.parentId;
        while (cursor !== null) {
            if (seen.has(cursor)) {
                push('INVALID_BRANCH_RELATION', 'cycle detected in parentId chain', current.id);
                break;
            }
            seen.add(cursor);
            const parent = nodes[cursor];
            if (!parent) {
                break; // 已在上方报告
            }
            cursor = parent.parentId;
        }
    }

    // activeChildId 指向真实子节点
    for (const current of Object.values(nodes)) {
        const childId = current.activeChildId;
        if (childId == null) {
            continue;
        }
        const child = nodes[childId];
        if (!child) {
            push('NODE_NOT_FOUND', `activeChildId points to missing node: ${childId}`, current.id);
            continue;
        }
        if (child.parentId !== current.id) {
            push('INVALID_BRANCH_RELATION', `activeChildId does not point to a direct child`, current.id);
            continue;
        }
        if (child.deleted) {
            push('INVALID_BRANCH_RELATION', 'activeChildId points to deleted node', current.id);
        }
    }

    // activeTailNodeId 存在性
    if (graph.activeTailNodeId !== null && !nodes[graph.activeTailNodeId]) {
        push('NODE_NOT_FOUND', 'activeTailNodeId points to missing node', graph.activeTailNodeId ?? undefined);
    }

    // activeTailNodeId 从 root 沿 activeChildId 可达
    if (graph.rootNodeId !== null && graph.activeTailNodeId !== null) {
        let cursor: string | null = graph.rootNodeId;
        const seen = new Set<string>();
        let reached = false;
        while (cursor !== null) {
            if (seen.has(cursor)) {
                break;
            }
            seen.add(cursor);
            if (cursor === graph.activeTailNodeId) {
                reached = true;
                break;
            }
            cursor = nodes[cursor]?.activeChildId ?? null;
        }
        if (!reached) {
            push(
                'BRANCH_STORAGE_CORRUPT',
                'activeTailNodeId not reachable from root via activeChildId chain',
                graph.activeTailNodeId ?? undefined
            );
        }
    }

    // BG-2：activeTailNodeId 必须是活跃链的终端（从 root 沿 activeChildId 走到链尾，
    // 尾指针必须等于该链尾；指向中间节点 / 环上的节点 / 无根却有尾 均视为损坏）。
    // 写入侧 deriveActiveTail 保证尾指针 = 链尾，读取侧此校验兜底手工/旧版损坏数据。
    if (graph.rootNodeId === null) {
        if (graph.activeTailNodeId !== null) {
            push(
                'BRANCH_STORAGE_CORRUPT',
                'activeTailNodeId set but rootNodeId is null',
                graph.activeTailNodeId ?? undefined
            );
        }
    } else if (graph.activeTailNodeId !== null) {
        let cursor: string | null = graph.rootNodeId;
        const seen = new Set<string>();
        let chainEnd: string | null = null;
        while (cursor !== null) {
            if (seen.has(cursor)) {
                break; // 环：以最后可达节点为链尾（环本身由 parentId 链/直子检查另行报告）
            }
            seen.add(cursor);
            chainEnd = cursor;
            cursor = nodes[cursor]?.activeChildId ?? null;
        }
        if (chainEnd !== null && graph.activeTailNodeId !== chainEnd) {
            push(
                'BRANCH_STORAGE_CORRUPT',
                `activeTailNodeId ${graph.activeTailNodeId} is not the terminal node of the active chain (terminal: ${chainEnd})`,
                graph.activeTailNodeId ?? undefined
            );
        }
    }

    // graph.activeChildId 镜像一致性
    // 注意：根节点无子时其 activeChildId 为 undefined，镜像为 null（syncRootMirror 的 ?? null 语义），
    // 两者等价——单节点图（仅 root）不得因此被误判为损坏（复查发现）。
    if (graph.rootNodeId !== null) {
        const root = nodes[graph.rootNodeId];
        if (root && (root.activeChildId ?? null) !== (graph.activeChildId ?? null)) {
            push(
                'BRANCH_STORAGE_CORRUPT',
                'graph.activeChildId does not mirror rootNode.activeChildId',
                graph.rootNodeId
            );
        }
    } else if (graph.activeChildId != null) {
        push('BRANCH_STORAGE_CORRUPT', 'graph.activeChildId set but rootNodeId is null');
    }

    // candidateSummaries 引用存在性
    for (const summary of graph.candidateSummaries ?? []) {
        if (!nodes[summary.nodeId]) {
            push('BRANCH_STORAGE_CORRUPT', 'candidate summary references missing node', summary.nodeId);
        }
    }

    // BR-09 元数据引用存在性（exportedFrom / exportedRefs 指向的节点必须真实存在）
    if (graph.exportedFrom?.nodeId && !nodes[graph.exportedFrom.nodeId]) {
        push('BRANCH_STORAGE_CORRUPT', 'exportedFrom.nodeId references missing node', graph.exportedFrom.nodeId);
    }
    for (const record of graph.exportedRefs ?? []) {
        if (!nodes[record.nodeId]) {
            push('BRANCH_STORAGE_CORRUPT', 'exportedRefs entry references missing node', record.nodeId);
        }
    }

    return { valid: issues.length === 0, issues };
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
    const toDelete = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toDelete.has(id)) {
            continue;
        }
        toDelete.add(id);
        for (const current of Object.values(nodes)) {
            if (current.parentId === id) {
                stack.push(current.id);
            }
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

    // 收集目标子树（excludeNode 时 = 目标的所有后代，不含目标自身）
    const toDelete = new Set<string>();
    const stack = excludeNode
        ? Object.values(graph.nodes).filter(n => n.parentId === nodeId).map(n => n.id)
        : [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toDelete.has(id)) {
            continue;
        }
        toDelete.add(id);
        for (const current of Object.values(graph.nodes)) {
            if (current.parentId === id) {
                stack.push(current.id);
            }
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
    // 收集整棵子树（含自身）：软删是级联的，子孙必然也是软删（或遗留数据中未标记，一并清理标记）
    const toRestore = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (toRestore.has(id)) {
            continue;
        }
        toRestore.add(id);
        for (const current of Object.values(nodes)) {
            if (current.parentId === id) {
                stack.push(current.id);
            }
        }
    }
    for (const id of toRestore) {
        const cleaned: ConversationBranchNode = { ...nodes[id] };
        delete cleaned.deleted;
        delete cleaned.deletedAt;
        nodes[id] = cleaned;
    }
    const next: ConversationBranchGraph = { ...graph, nodes };
    for (const id of toRestore) {
        const summaries = next.candidateSummaries ?? [];
        const summary = summaries.find(s => s.nodeId === id);
        if (summary?.deleted) {
            const cleanedSummary: BranchCandidateSummary = { ...summary };
            delete cleanedSummary.deleted;
            delete cleanedSummary.deletedAt;
            next.candidateSummaries = summaries.map(s =>
                s.nodeId === id ? cleanedSummary : s
            );
        }
    }
    return next;
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

/** 从图中移除节点集合并清理所有引用（pruneDeletedNodes / removeSubtree 共用） */
function removeNodeSet(
    graph: ConversationBranchGraph,
    toRemove: Set<string>
): { graph: ConversationBranchGraph; prunedNodeIds: string[] } {
    if (toRemove.size === 0) {
        return { graph, prunedNodeIds: [] };
    }
    // 从图中移除节点，并清理引用
    const nodes: Record<string, ConversationBranchNode> = {};
    for (const [id, current] of Object.entries(graph.nodes)) {
        if (toRemove.has(id)) {
            continue;
        }
        // 父节点若指向被删节点（防御），清空指针
        const patched: ConversationBranchNode =
            current.activeChildId != null && toRemove.has(current.activeChildId)
                ? { ...current, activeChildId: null }
                : current;
        nodes[id] = patched;
    }
    const next: ConversationBranchGraph = {
        ...graph,
        nodes,
        candidateSummaries: (graph.candidateSummaries ?? []).filter(s => !toRemove.has(s.nodeId)),
    };
    if (next.rootNodeId !== null && toRemove.has(next.rootNodeId)) {
        next.rootNodeId = null;
        next.activeTailNodeId = null;
    } else if (next.activeTailNodeId !== null && toRemove.has(next.activeTailNodeId)) {
        next.activeTailNodeId = null;
    }
    if (next.exportedFrom && toRemove.has(next.exportedFrom.nodeId)) {
        next.exportedFrom = undefined;
    }
    if (next.exportedRefs) {
        const kept = next.exportedRefs.filter(r => !toRemove.has(r.nodeId));
        next.exportedRefs = kept.length > 0 ? kept : undefined;
    }
    // 镜像指针随根节点 activeChildId 同步（与 syncRootMirror 语义一致）
    if (next.rootNodeId !== null) {
        const root = next.nodes[next.rootNodeId];
        next.activeChildId = root ? (root.activeChildId ?? null) : null;
    } else {
        next.activeChildId = null;
    }
    return { graph: next, prunedNodeIds: [...toRemove] };
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
