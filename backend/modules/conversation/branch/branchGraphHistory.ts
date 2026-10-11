/** 主历史与分支图之间的内容映射、导入和活跃路径对齐。 */
import { BranchError } from './types';
import type { BranchCandidateSummary, BranchContentMetadata, ConversationBranchGraph, ConversationBranchNode } from './types';
import type { Content } from '../types';
import { activePath, createEmptyBranchGraph, deriveActiveTail, removeNodeSet, syncRootMirror } from './branchGraphTopology';
import { validate } from './branchGraphValidation';

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
    // 节点对象和节点表都在本函数内新建，直接原地构建。逐条 insertNode 会复制整张节点表并
    // 重新推导尾指针，长历史下是平方复杂度；这里的结果与逐条插入（setActive + updateTail）一致。
    const graph = createEmptyBranchGraph();
    const nodes = graph.nodes;
    const now = options.createdAt ?? Date.now();
    let previousNode: ConversationBranchNode | null = null;
    // 已为合并 functionResponse 复制过 parts 的节点，避免改写消息自身的 parts 数组。
    const ownedParts = new Set<ConversationBranchNode>();
    // M-4/复查：createdAt 沿消息顺序严格递增（相同/乱序 timestamp 时按序 +1），
    // 保证 childrenIndex 候选排序 = 消息顺序，不回退到同毫秒的 id 字典序。
    let previousCreatedAt = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        if (isFunctionResponseMessage(message)) {
            // 决策 8：functionResponse 依附前一个节点（模型节点），不建独立节点。
            if (previousNode) {
                if (!ownedParts.has(previousNode)) {
                    previousNode.parts = [...previousNode.parts];
                    ownedParts.add(previousNode);
                }
                previousNode.parts.push(...(message.parts ?? []));
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
                && nodes[message.parentId]
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
        if (nodes[id]) {
            throw new BranchError('INVALID_BRANCH_RELATION', `duplicate node id: ${id}`);
        }
        nodes[id] = node;
        if (parentId === null) {
            graph.rootNodeId = id;
            graph.activeTailNodeId = id;
        } else {
            nodes[parentId]!.activeChildId = id;
            // 父节点就是当前尾时新节点直接成为尾；父链指向更早的节点时按活跃链重新推导。
            graph.activeTailNodeId = parentId === graph.activeTailNodeId ? id : deriveActiveTail(graph);
        }
        previousNode = node;
    }
    return syncRootMirror(graph);
}

/**
 * 以主历史重建“活跃路径”，同时保留 sidecar 中的旧候选与非活跃子树。
 *
 * 用于恢复这种可解析但已落后的 sidecar：已经结束的空 reroll/edit 占位节点曾让后续追加
 * 永久跳过同步，或结构性历史更新没有同步进 branches.json。主历史是当前路径的唯一真源；
 * 旧图只作为候选归档保留。
 *
 * 安全边界：
 * - 两边根节点必须一致；根已变化意味着无法在单根模型中无损合并——默认明确拒绝（不修改原图）；
 *   调用方确认主历史已变更（如删除头部消息导致根前移）时可传 options.allowRootChange=true
 *   走根变更重链（rebaseWithRootChange：新根挂到图、旧根专属子树清理），避免图根永久陈旧；
 * - 当前历史节点复用同 id 的旧节点元数据（标签、工作区存档、kind），正文与父链以历史为准；
 * - 从旧活跃路径移出的节点仍留在 nodes 中，成为非活跃候选，不做物理删除；
 * - 返回前执行完整 validate，无法保持图不变量时拒绝修复。
 */
export function rebaseActivePathFromHistory(
    graph: ConversationBranchGraph,
    history: ReadonlyArray<Content>,
    options: { allowRootChange?: boolean } = {}
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
        if (!options.allowRootChange) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `cannot safely reconcile branch graph root ${graph.rootNodeId} with main history root ${canonical.rootNodeId}`
            );
        }
        return rebaseWithRootChange(graph, canonical);
    }

    const next = mergeHistoryPath(graph, canonical);
    const validation = validate(next);
    if (!validation.valid) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot safely reconcile branch graph with main history: ${validation.issues.map(issue => issue.message).join('; ')}`
        );
    }
    return next;
}

/**
 * 以 canonical（主历史线性导入）的活跃路径重写图中活跃路径（rebase 根一致路径与根变更
 * 重链共用；round4 复查后自 rebaseActivePathFromHistory 抽出）。
 *
 * 语义与既有 rebase 完全一致：
 * - 复用同 id 旧节点元数据（标签、工作区存档、kind），正文与父链以主历史为准；
 * - 主历史节点清除旧的软删除状态（属于当前活跃路径）；
 * - 旧指针清理后重写活跃链指针，保证当前路径是唯一活跃链；
 * - 从旧活跃路径移出的节点仍留在 nodes 中，成为非活跃候选，不做物理删除。
 */
function mergeHistoryPath(
    graph: ConversationBranchGraph,
    canonical: ConversationBranchGraph
): ConversationBranchGraph {
    const historyPath = activePath(canonical);
    // nodes 保持对象表（Record）而非 Map：全文件图变更/序列化路径（BranchGraphRepository、
    // validate、childrenIndex）均按对象表遍历，改 Map 需同步改造所有调用点，收益不抵风险。
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
    const rootNodeId = canonical.rootNodeId;
    if (rootNodeId === null) {
        // 防御：调用方保证 canonical 非空（rebase 入口已拒绝空历史），此处仅满足类型收窄
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            'cannot merge an empty main history into a branch graph'
        );
    }
    const root = nodes[rootNodeId]!;
    return {
        ...graph,
        rootNodeId: canonical.rootNodeId,
        activeTailNodeId: canonical.activeTailNodeId,
        nodes,
        activeChildId: root.activeChildId ?? null,
        candidateSummaries,
    };
}

/**
 * 根变更重链（rebaseActivePathFromHistory 的 allowRootChange 路径）。
 *
 * 触发场景：主历史头部被删（deleteMessage index 0 且非尾删）等导致主历史根前移/替换。
 *
 * 单根模型约束：parentId=null 只允许 rootNodeId 一个，旧根无法像中间删除那样退化为非活跃
 * 候选（软删节点同样受单根约束；重挂到新根下会造成父子关系倒置）。因此：
 * - 新活跃路径（canonical）整体并入图、新根成为图根（mergeHistoryPath，复用同 id 旧节点
 *   元数据，正文/父链以主历史为准）；
 * - 「不沿任何新历史节点可达」的旧节点（旧根及其专属子树，如旧根下的其它候选分支）物理移除
 *   （removeNodeSet 同步清理候选摘要 / exportedFrom / exportedRefs / activeChildId）——
 *   主历史已删除且从新根不可达，保留会产生悬空父链/多根，违反单根不变量；物理移除与
 *   softDeleteSubtreeFrom 的根锚定重置（resetToEmpty）语义一致，旧根无法以软删形态保留；
 * - 挂在新历史节点下的旧候选（新根/后继节点的分支）原样保留为非活跃候选；
 * - 返回前执行完整 validate，无法保持图不变量时拒绝修复（抛 BRANCH_OPERATION_CONFLICT）。
 */
function rebaseWithRootChange(
    graph: ConversationBranchGraph,
    canonical: ConversationBranchGraph
): ConversationBranchGraph {
    const merged = mergeHistoryPath(graph, canonical);
    // 旧根专属子树清理：保留「新历史节点」及「沿 parentId 链可达任一新历史节点」的旧节点。
    const canonicalIds = new Set(activePath(canonical));
    const nodeCount = Object.keys(merged.nodes).length;
    const toRemove = new Set<string>();
    for (const [id, node] of Object.entries(merged.nodes)) {
        if (canonicalIds.has(id)) {
            continue;
        }
        let cursor = node.parentId;
        let guard = 0;
        let reachable = false;
        while (cursor !== null) {
            if (canonicalIds.has(cursor)) {
                reachable = true;
                break;
            }
            const parent = merged.nodes[cursor];
            if (!parent) {
                break; // 防御：悬空父链按不可达处理（并入移除集合）
            }
            if (++guard > nodeCount) {
                break; // 防御：异常环时终止，按不可达处理
            }
            cursor = parent.parentId;
        }
        if (!reachable) {
            toRemove.add(id);
        }
    }
    const { graph: next } = removeNodeSet(merged, toRemove);
    const validation = validate(next);
    if (!validation.valid) {
        throw new BranchError(
            'BRANCH_OPERATION_CONFLICT',
            `cannot safely reconcile branch graph root with main history: ${validation.issues.map(issue => issue.message).join('; ')}`
        );
    }
    return next;
}
