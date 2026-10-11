/** 读取侧图完整性检查，与图变更分开，保留原有问题代码和检查顺序。 */
import { BRANCH_GRAPH_VERSION } from './types';
import type { ConversationBranchGraph, ConversationBranchNode } from './types';

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
    const parentChainLoops = parentChainLoopStates(nodes);

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
        // parentId 链无环（缺失父节点已在上方报告，按链终止处理）
        if (parentChainLoops.get(current.id)) {
            push('INVALID_BRANCH_RELATION', 'cycle detected in parentId chain', current.id);
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

/**
 * 每个节点沿 parentId 向上是否会进入环（节点自身在环上，或祖先链进入环）。
 * 共享祖先的判定结果复用，整体线性；逐节点重走到根在长历史上是平方复杂度。
 */
function parentChainLoopStates(nodes: ConversationBranchGraph['nodes']): Map<string, boolean> {
    const loops = new Map<string, boolean>();
    for (const start of Object.keys(nodes)) {
        if (loops.has(start)) {
            continue;
        }
        const path: string[] = [];
        const inPath = new Set<string>();
        let cursor: string | null = start;
        let result = false;
        while (true) {
            const node: ConversationBranchNode | undefined = cursor === null ? undefined : nodes[cursor];
            if (cursor === null || !node) {
                break;
            }
            const known = loops.get(cursor);
            if (known !== undefined) {
                result = known;
                break;
            }
            if (inPath.has(cursor)) {
                result = true;
                break;
            }
            path.push(cursor);
            inPath.add(cursor);
            cursor = node.parentId;
        }
        for (const id of path) {
            loops.set(id, result);
        }
    }
    return loops;
}
