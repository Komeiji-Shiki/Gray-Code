/**
 * 分支写工具判据（BCP-04 决策 1）：纯图遍历辅助，从 BranchHandlers 外移。
 *
 * 判断「该分支节点是否可能产生工作区存档」（hasWorkspaceState / wroteToWorkspace），
 * 供前端弹「是否连工作区一起恢复」确认框。判据与 ToolExecutionService 的
 * 「真实工具名 ∩ 配置集合」判定同源（配置缺失时回退默认列表）。
 */

import { DEFAULT_CHECKPOINT_CONFIG } from '../../backend/modules/settings';
import type { ContentPart } from '../../backend/modules/conversation';
import type {
    ConversationBranchGraph,
    ConversationBranchNode,
} from '../../backend/modules/conversation/branch';

// ==================== BCP-04：写工具判据（决策 1） ====================

/**
 * 写工具名集合（BCP-04 判据来源）：默认 checkpoint 配置 beforeTools ∪ afterTools。
 * 与 ToolExecutionService 的「真实工具名 ∩ 配置集合」判定同源，保证
 * 「该分支是否可能产生存档」与「是否命中写工具」口径一致（配置缺失时回退默认列表）。
 * 注意：运行时 checkpoint 配置（settingsHandler.getCheckpointConfig）可能覆盖默认值，
 * 此处以默认列表为准（handler 读配置成本高且本判据只用于提示，见研究报告 R6）。
 */
export const WRITE_TOOL_NAMES = new Set<string>([
    ...(DEFAULT_CHECKPOINT_CONFIG.beforeTools ?? []),
    ...(DEFAULT_CHECKPOINT_CONFIG.afterTools ?? []),
]);

/**
 * 从节点 parts 提取工具名（与 BranchService.buildCandidateSummary 的提取口径一致）。
 */
export function collectToolNamesFromParts(parts: ContentPart[] | undefined): string[] {
    return (parts ?? [])
        .map(part => part.functionCall?.name)
        .filter((name): name is string => typeof name === 'string');
}

/** 沿 parentId 链收集 root→node 路径上全部节点的工具名（防御环 / 悬空指针） */
export function collectPathToolNames(
    graph: ConversationBranchGraph,
    nodeId: string
): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = nodeId;
    while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const node = graph.nodes[cursor];
        if (!node) {
            break;
        }
        names.push(...collectToolNamesFromParts(node.parts));
        cursor = node.parentId;
    }
    return names;
}

/**
 * BCP-04：为 getBranchGraph / switchBranchCandidate 响应的每个节点补充
 * hasWorkspaceState（workspaceCheckpointId 存在）与 wroteToWorkspace
 * （root→该节点路径上工具名 ∩ 写工具集非空），供前端弹「是否连工作区一起恢复」确认框。
 * 先浅拷贝（图 + 节点对象，parts 共享）再富化：BranchService 读路径现在返回缓存条目的
 * 共享引用（只读契约），原地富化会把富化字段写进缓存快照，并随下一次写盘持久化进 sidecar。
 * 返回富化后的新图（调用方用它替换响应中的 graph）。
 */
export function enrichGraphWorkspaceInfo(graph: ConversationBranchGraph): ConversationBranchGraph {
    const nodes: Record<string, ConversationBranchNode> = {};
    for (const [id, node] of Object.entries(graph.nodes)) {
        nodes[id] = node ? { ...node } : node;
    }
    const target: ConversationBranchGraph = { ...graph, nodes };
    // 自顶向下单次 DFS 累积 root→节点路径上的工具名集合（O(n)），
    // 替代原实现对每个节点沿 parentId 链回溯到 root 的 O(n²) 方案。
    // 预构建 parentId → 子节点 id 邻接表，避免 DFS 过程中反复全表扫描（保持整体 O(n)）。
    const childrenByParent = new Map<string, string[]>();
    for (const [id, node] of Object.entries(target.nodes)) {
        if (!node?.parentId) continue;
        const siblings = childrenByParent.get(node.parentId);
        if (siblings) {
            siblings.push(id);
        } else {
            childrenByParent.set(node.parentId, [id]);
        }
    }

    const visited = new Set<string>();

    const visit = (nodeId: string, pathToolNames: Set<string>): void => {
        if (visited.has(nodeId)) {
            return;
        }
        visited.add(nodeId);
        const node = target.nodes[nodeId];
        if (!node) {
            return;
        }
        const enriched = node as ConversationBranchNode & {
            hasWorkspaceState?: boolean;
            wroteToWorkspace?: boolean;
        };
        enriched.hasWorkspaceState =
            typeof node.workspaceCheckpointId === 'string' && node.workspaceCheckpointId.length > 0;
        const ownToolNames = collectToolNamesFromParts(node.parts);
        for (const name of ownToolNames) {
            pathToolNames.add(name);
        }
        enriched.wroteToWorkspace = Array.from(pathToolNames).some(name => WRITE_TOOL_NAMES.has(name));
        for (const childId of childrenByParent.get(nodeId) ?? []) {
            visit(childId, pathToolNames);
        }
        // 回溯：移除本节点贡献的工具名，避免兄弟分支的路径集合互相污染
        for (const name of ownToolNames) {
            pathToolNames.delete(name);
        }
    };

    // 根节点：无 parentId 或 parentId 悬空（父节点不存在）。一次 DFS 覆盖整棵正常树。
    for (const [id, node] of Object.entries(target.nodes)) {
        if (node && (!node.parentId || !target.nodes[node.parentId])) {
            visit(id, new Set<string>());
        }
    }

    // 兜底：环等异常结构下 DFS 覆盖不到的节点，沿用原回溯路径收集，保证全部被充实。
    for (const [id, node] of Object.entries(target.nodes)) {
        if (!node || visited.has(id)) {
            continue;
        }
        const enriched = node as ConversationBranchNode & {
            hasWorkspaceState?: boolean;
            wroteToWorkspace?: boolean;
        };
        enriched.hasWorkspaceState =
            typeof node.workspaceCheckpointId === 'string' && node.workspaceCheckpointId.length > 0;
        enriched.wroteToWorkspace = collectPathToolNames(target, node.id).some(name => WRITE_TOOL_NAMES.has(name));
    }
    return target;
}
