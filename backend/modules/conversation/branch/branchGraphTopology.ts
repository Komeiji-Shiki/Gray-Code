/** 分支图的路径解析和基础结构操作，不依赖候选编辑或持久化服务。 */
import { BRANCH_GRAPH_VERSION, BranchError } from './types';
import type { ConversationBranchGraph, ConversationBranchNode } from './types';

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

/** 浅拷贝图（nodes 记录复制，节点对象与 parts 共享引用——数据视为不可变）。
 * nodes 用对象表（Record）而非 Map：与全文件 Object.values/entries 遍历、
 * JSON 序列化直接兼容。 */
export function cloneGraph(graph: ConversationBranchGraph): ConversationBranchGraph {
    return { ...graph, nodes: { ...graph.nodes } };
}

/** 同步根节点 activeChildId 镜像指针（内部维护，调用方传入的是克隆后的图） */
export function syncRootMirror(graph: ConversationBranchGraph): ConversationBranchGraph {
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
export function deriveActiveTail(graph: ConversationBranchGraph): string | null {
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

/** 从图中移除节点集合并清理所有引用（pruneDeletedNodes / removeSubtree 共用）。
 *
 * BCP-06 存档清理说明（round5 复查，仅注释不联动）：
 * - 本函数是纯图操作（无 repository 访问），物理移除节点后其 workspaceCheckpointId 绑定的
 *   工作区存档不会在此触发 cleaner；图侧绑定随节点消失，存档回收依赖调用方联动或周期扫描；
 * - 已联动路径：purgeBranchCandidate / pruneDeletedBranches 在 BranchService 侧收集
 *   prunedNodeIds，会话写锁释放后调 cleanupZeroReferencedCheckpoints（引用计数重扫 + 全局清理器）；
 * - 未联动路径：rebaseWithRootChange（rebaseActivePathFromHistory 的 allowRootChange 分支）
 *   物理移除旧根专属子树时同样经本函数，但调用方不收集 prunedNodeIds——其绑定存档仅靠周期
 *   refcount 扫描（computeCheckpointReferenceCounts 全量重扫）回收，作为 BCP-08 兜底可接受；
 *   若未来需即时回收，应在 rebase 调用方（如 syncMainHistoryAfterStructuralMutation）收集
 *   prunedNodeIds 并在写锁释放后调用 cleanupZeroReferencedCheckpoints（同 purge 路径模式）。
 */
export function removeNodeSet(
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
    }
    // 尾指针不依赖调用方修补：删除后沿活跃链重算（根节点被移除时 deriveActiveTail 返回 null），
    // 保证「尾指针 = 活跃路径最后一个节点」不变量始终成立（validate 读取侧依赖该不变量）。
    next.activeTailNodeId = deriveActiveTail(next);
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
