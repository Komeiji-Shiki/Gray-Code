/**
 * BranchService 对外导出的结果/入参类型与常量（拆分自 BranchService.ts）。
 *
 * BranchService.ts 通过 `export type { ... } from './branchServiceTypes'` 与
 * `export { MAX_CANDIDATES_PER_PARENT } from './branchServiceTypes'` 再导出，
 * 保证 `import { BranchCandidateCreateResult } from '../branch/BranchService'` 等
 * 既有引用与 `export * from './BranchService'` 的再导出口径完全不变。
 */

import type { ContentPart, UsageMetadata } from '../types';
import type { BranchExportRecord, BranchNodeKind } from './types';

/** createRerollCandidate / editCandidate 的返回值（轻量，不下发整图） */
export interface BranchCandidateCreateResult {
    nodeId: string;
    parentNodeId: string;
    kind: BranchNodeKind;
    activeTailNodeId: string | null;
    activePathIds: string[];
}

/** switchBranchCandidate 的返回值（本阶段只切图状态，不重写主历史） */
export interface BranchSwitchResult {
    nodeId: string;
    activeTailNodeId: string | null;
    activePathIds: string[];
    /** 本阶段恒为 false：主历史全量重写是 TREE-06 的职责 */
    mainHistoryRewrite: false;
}

/** deleteBranchCandidate 的返回值 */
export interface BranchDeleteResult {
    nodeId: string;
    deleted: boolean;
    /** 若删除的是父节点的当前活跃子，父节点 activeChildId 被清空（不影响活跃路径） */
    clearedParentActiveChild: boolean;
}

/** BR-05 校验结果：主历史消息 id 链（不含 functionResponse）vs 图活跃路径 */
export interface BranchPathConsistencyResult {
    valid: boolean;
    issues: string[];
    graphMissing: boolean;
    historyIds: string[];
    activePathIds: string[];
}

/** 主历史补入/修复分支图的结果。 */
export interface BranchHistoryReconcileResult {
    /** 原先没有 sidecar，本次从主历史新建。 */
    created: boolean;
    /** sidecar 已存在但落后，本次保留旧候选并重建活跃路径。 */
    reconciled: boolean;
    /** 覆盖旧 sidecar 前生成的逐字节备份；未发生覆盖时为空。 */
    backupPath?: string;
    missingMessageCount: number;
    unsyncedFunctionResponseCount: number;
}

/** 预期内结构变更（总结插入/恢复等）的分支图同步结果。 */
export interface BranchStructuralSyncResult {
    synced: boolean;
    /** 正在生成的空 reroll/edit 占位仍处于活跃尾时不抢占其路径，留给 finishReroll 收敛。 */
    deferred: boolean;
}

/** getBranchGraphMeta 的返回值（前端列表/徽标用，避免整图下发） */
export interface BranchGraphMetaResult {
    conversationId: string;
    exists: boolean;
    /**
     * BS-1：损坏标记——sidecar 存在但不可用（JSON 解析失败 / 结构不符 / 读取侧语义校验失败），
     * 与「无图（exists:false 且无 errorCode）」区分；为 true 时 errorCode 恒为
     * 'BRANCH_STORAGE_CORRUPT'。前端三态：无图 / 损坏 / 存在可用。
     */
    corrupted?: boolean;
    /** 损坏时携带（M-1）：调用方可按无图处理，或提示 sidecar 需修复（MIG-05 完整性工具） */
    errorCode?: 'BRANCH_STORAGE_CORRUPT';
    rootNodeId: string | null;
    activeTailNodeId: string | null;
    nodeCount: number;
    candidateCount: number;
    /** TREE-09：软删节点数（含子树节点；设置页「软删分支数量」展示用） */
    deletedCount: number;
    activePathLength: number;
    exportedFrom?: { conversationId: string; nodeId: string };
    exportedRefs: BranchExportRecord[];
}

/** 候选/编辑节点的创建入参 */
export interface BranchCandidateInput {
    parts: ContentPart[];
    role?: 'user' | 'model' | 'system';
    modelVersion?: string;
    usageMetadata?: UsageMetadata;
    createdAt?: number;
}

/** TREE-02（决策 4）：同一父节点下候选数量上限；超限拒绝创建并提示清理，不自动删除 */
export const MAX_CANDIDATES_PER_PARENT = 10;

/** TREE-09：软删分支数量统计结果 */
export interface BranchDeletedCountResult {
    /** 统计的会话数（全量扫描时为带 sidecar 的会话数） */
    conversationCount: number;
    /** 软删节点总数（含子树节点） */
    deletedNodeCount: number;
}

/** TREE-09：pruneDeletedBranches 的返回结果 */
export interface BranchPruneResult {
    /** 扫描的会话数 */
    conversationsScanned: number;
    /** 实际发生了物理清理的会话数 */
    conversationsChanged: number;
    /** 物理移除的节点总数（含子树） */
    prunedNodeCount: number;
    /** sidecar 损坏被跳过的会话（不覆盖，留给 MIG-05 完整性工具） */
    corruptConversations: string[];
    /** 会话已不存在/已删除被跳过的会话（迟到清理） */
    skippedConversations: string[];
}

/** TREE-09：purgeBranchCandidate 的返回结果（单个候选彻底删除） */
export interface BranchPurgeResult {
    nodeId: string;
    /** 是否实际执行了物理移除（false = 节点不存在/未软删，幂等） */
    purged: boolean;
    /** 本次物理移除的节点数（含子树） */
    prunedNodeCount: number;
}

/** 决策 6：主历史删除（deleteToMessage / deleteMessage）后的分支图同步结果 */
export interface BranchHistoryDeleteSyncResult {
    /** 图是否发生变更并落盘（无图 / 锚点缺失 / 幂等时为 false） */
    graphUpdated: boolean;
    /** 本次新标记软删的节点 id（整体重置为空图时为全部旧节点 id） */
    deletedNodeIds: string[];
    /** 是否整体重置为空图（删除到对话开头，锚定根节点） */
    resetToEmpty: boolean;
    /** 活跃尾是否被回退（被删集合包含原活跃尾） */
    activeTailAdjusted: boolean;
}

/** TREE-01：startReroll 的返回值（reroll 开始：旧候选保留进 sidecar，新候选激活） */
export interface RerollStartResult {
    /** 新候选节点 ID（流式期间内容为空，完成后由 finishReroll 回填） */
    candidateNodeId: string;
    /** 父用户节点 ID */
    parentNodeId: string;
    /** 被 reroll 的旧助手节点 ID（仍保留在图中，可切回） */
    previousNodeId: string;
    /** 截断后主历史消息数（= 父节点索引 + 1；主历史已切换到新候选路径） */
    historyLengthAfterTruncate: number;
}

/** TREE-01：finishReroll 的返回值（流式结果写入新节点 + 摘要更新后的图状态） */
export interface RerollFinishResult {
    /** 最终候选节点 ID；无输出时为已丢弃的空占位节点 ID。 */
    candidateNodeId: string;
    parentNodeId: string;
    activeTailNodeId: string | null;
    activePathIds: string[];
    /** 写入图的模型消息数（0 = 流式未产生内容，空占位会被移除） */
    syncedMessageCount: number;
    /** 流式没有产生任何消息时，空占位节点已被安全移除。 */
    discardedEmptyCandidate: boolean;
}

/** 分支流启动阶段失败后的受限回滚结果。 */
export interface BranchSetupAbortResult {
    removedNodeIds: string[];
    activeTailNodeId: string | null;
    activePathIds: string[];
}
