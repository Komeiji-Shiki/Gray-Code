/**
 * 树状分支业务编排服务（第五阶段 BR-06/07 + BR-05/09 接线）。
 *
 * 职责（原 BranchService 单文件已按职责拆分到同目录服务模块）：
 * - branchGraphCache.ts：分支图内存缓存；
 * - branchServiceTypes.ts：对外导出的结果/入参类型与常量；
 * - branchServiceCore.ts：共享核心（写锁/读图/校验/保存/候选摘要等）；
 * - branchStoreService.ts：BR-06 读写删接口（getBranchGraph / getBranchGraphMeta /
 *   saveBranchGraph / deleteConversationBranch）；
 * - branchReconcileService.ts：主历史 ↔ 分支图对账（ensureBranchGraph /
 *   ensureMainHistoryRepresentedInGraph / syncMainHistoryAfterStructuralMutation /
 *   assertMainHistoryRepresentedInGraph / validateActivePathMatchesHistory）；
 * - branchCandidateService.ts：候选生命周期 / 分支切换 / 工作区存档绑定（BR-07 + TREE + BCP-02）；
 * - branchRetentionService.ts：软删统计 / 修剪 / 保留期配置（TREE-09）；
 * - branchHistorySyncService.ts：跨对话分支建模 / 主历史追加与删除同步（BR-09 + BS-2 + 决策 6）。
 *
 * 本文件只保留 BranchService 类（对外委托入口）、全局实例注册与对外导出符号，
 * 方法签名与运行时行为与拆分前完全一致。
 *
 * 锁序（BR-07 + M-3 复查修正，强约束）：
 *   「会话锁内严禁获取存档锁；存档锁只能在会话锁之外获取」。
 *   全局实际获取顺序是 存档锁 → 会话锁（CheckpointManager 的 restore/create 路径先取
 *   checkpointOperationLockManager 存档操作锁，再在锁内获取会话写锁），因此会话写锁是
 *   存档锁的内层：任何在会话写锁内再去获取存档锁的调用，都会与 restore/create 的
 *   「存档锁 → 会话锁」路径构成锁序反转（互相等待）而死锁。
 */

import type { Content, ContentPart } from '../types';
import type { ConversationManager } from '../ConversationManager';
import type { BranchGraphReadResult, BranchGraphRepository } from './BranchGraphRepository';
import {
    getChildrenIndex,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import {
    deleteConversationBranch,
    getBranchGraph,
    getBranchGraphMeta,
    saveBranchGraph,
} from './branchStoreService';
import {
    assertMainHistoryRepresentedInGraph,
    ensureBranchGraph,
    ensureMainHistoryRepresentedInGraph,
    syncMainHistoryAfterStructuralMutation,
    validateActivePathMatchesHistory,
} from './branchReconcileService';
import {
    abortEmptyCandidateSetup,
    bindWorkspaceCheckpoint,
    createRerollCandidate,
    deleteBranchCandidate,
    editCandidate,
    finishReroll,
    purgeBranchCandidate,
    renameBranchCandidate,
    restoreBranchCandidate,
    startReroll,
    switchBranchCandidate,
    updateActiveNodeParts,
    updateNodeMetadata,
} from './branchCandidateService';
import {
    getBranchRetentionConfig,
    getDeletedBranchCount,
    pruneDeletedBranches,
    updateBranchRetentionConfig,
} from './branchRetentionService';
import {
    appendHistoryToGraph,
    initializeBranchConversation,
    recordExport,
    syncGraphAfterHistoryDelete,
} from './branchHistorySyncService';
import { invalidateBranchGraphCache } from './branchGraphCache';
import { MAX_CANDIDATES_PER_PARENT } from './branchServiceTypes';
import type {
    BranchCandidateCreateResult,
    BranchCandidateInput,
    BranchDeleteResult,
    BranchDeletedCountResult,
    BranchGraphMetaResult,
    BranchHistoryDeleteSyncResult,
    BranchHistoryReconcileResult,
    BranchPathConsistencyResult,
    BranchPruneResult,
    BranchPurgeResult,
    BranchSetupAbortResult,
    BranchStructuralSyncResult,
    BranchSwitchResult,
    RerollFinishResult,
    RerollStartResult,
} from './branchServiceTypes';
import { DEFAULT_BRANCH_RETENTION_DAYS } from './types';
import type {
    BranchContentMetadata,
    BranchRetentionConfig,
    ConversationBranchGraph,
    WorkspaceState,
} from './types';

export { invalidateBranchGraphCache };
export { MAX_CANDIDATES_PER_PARENT };
export type {
    BranchCandidateCreateResult,
    BranchCandidateInput,
    BranchDeleteResult,
    BranchDeletedCountResult,
    BranchGraphMetaResult,
    BranchHistoryDeleteSyncResult,
    BranchHistoryReconcileResult,
    BranchPathConsistencyResult,
    BranchPruneResult,
    BranchPurgeResult,
    BranchSetupAbortResult,
    BranchStructuralSyncResult,
    BranchSwitchResult,
    RerollFinishResult,
    RerollStartResult,
};

/** 模块级单例（与 DiffStorageManager 同模式）：由 webview BranchHandlers 懒初始化后注册。 */
let globalBranchService: BranchService | undefined;

/** 注册全局分支服务实例（测试可用 undefined 重置） */
export function setGlobalBranchService(service: BranchService | undefined): void {
    globalBranchService = service;
}

/** 获取全局分支服务实例（未注册返回 undefined；ConversationManager 的 BR-09/清理接线用它） */
export function getGlobalBranchService(): BranchService | undefined {
    return globalBranchService;
}

export class BranchService {
    /**
     * TREE-09：软删节点保留天数（默认 DEFAULT_BRANCH_RETENTION_DAYS=30）。
     * 优先级：pruneDeletedBranches 显式入参 > branches.config.json 持久化配置 > 本构造默认值。
     */
    private readonly retentionDays: number;
    /** 各职责服务共享的核心上下文（conversationManager / repository / 实例状态）。 */
    private readonly ctx: BranchServiceCoreContext;

    constructor(
        conversationManager: ConversationManager,
        repository: BranchGraphRepository,
        options: { retentionDays?: number } = {}
    ) {
        this.retentionDays = options.retentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS;
        this.ctx = {
            conversationManager,
            repository,
            state: {
                deferredStructuralSyncConversationIds: new Set<string>(),
                pendingRewriteExpectations: new Map<
                    string,
                    { mainHistoryTailId: string | null; graphActiveTailNodeId: string | null }
                >(),
            },
        };
    }

    /** 取走（并清除）pending 的「切图→重写」预期状态；无预期返回 null（重写可独立调用） */
    consumeRewriteExpectation(conversationId: string): { mainHistoryTailId: string | null; graphActiveTailNodeId: string | null } | null {
        const expectation = this.ctx.state.pendingRewriteExpectations.get(conversationId);
        if (expectation) {
            this.ctx.state.pendingRewriteExpectations.delete(conversationId);
        }
        return expectation ?? null;
    }

    // ==================== BR-06：读写删接口 ====================

    async getBranchGraph(conversationId: string): Promise<BranchGraphReadResult> {
        return getBranchGraph(this.ctx, conversationId);
    }

    async getBranchGraphMeta(conversationId: string): Promise<BranchGraphMetaResult> {
        return getBranchGraphMeta(this.ctx, conversationId);
    }

    async saveBranchGraph(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        return saveBranchGraph(this.ctx, conversationId, graph);
    }

    async deleteConversationBranch(conversationId: string): Promise<void> {
        return deleteConversationBranch(this.ctx, conversationId);
    }

    // ==================== BR-07：候选创建 / 编辑 / 切换 / 删除（全部在会话写锁内） ====================

    async createRerollCandidate(
        conversationId: string,
        parentNodeId: string,
        input: BranchCandidateInput
    ): Promise<BranchCandidateCreateResult> {
        return createRerollCandidate(this.ctx, conversationId, parentNodeId, input);
    }

    async ensureBranchGraph(conversationId: string): Promise<boolean> {
        return ensureBranchGraph(this.ctx, conversationId);
    }

    async ensureMainHistoryRepresentedInGraph(conversationId: string): Promise<BranchHistoryReconcileResult> {
        return ensureMainHistoryRepresentedInGraph(this.ctx, conversationId);
    }

    async syncMainHistoryAfterStructuralMutation(
        conversationId: string,
        reason: 'summary_inserted' | 'summary_restored' | 'summary_deleted' | 'message_deleted_middle' | 'branch_finished' | 'message_inserted' | 'tool_calls_rejected'
    ): Promise<BranchStructuralSyncResult> {
        return syncMainHistoryAfterStructuralMutation(this.ctx, conversationId, reason);
    }

    async assertMainHistoryRepresentedInGraph(conversationId: string): Promise<void> {
        return assertMainHistoryRepresentedInGraph(this.ctx, conversationId);
    }

    async updateActiveNodeParts(
        conversationId: string,
        nodeId: string,
        parts: ContentPart[]
    ): Promise<{ nodeId: string }> {
        return updateActiveNodeParts(this.ctx, conversationId, nodeId, parts);
    }

    async updateNodeMetadata(
        conversationId: string,
        nodeId: string,
        contentMetadata: BranchContentMetadata | undefined
    ): Promise<void> {
        return updateNodeMetadata(this.ctx, conversationId, nodeId, contentMetadata);
    }

    async editCandidate(
        conversationId: string,
        parentNodeId: string,
        input: BranchCandidateInput
    ): Promise<BranchCandidateCreateResult> {
        return editCandidate(this.ctx, conversationId, parentNodeId, input);
    }

    async startReroll(conversationId: string, assistantNodeId?: string): Promise<RerollStartResult> {
        return startReroll(this.ctx, conversationId, assistantNodeId);
    }

    async abortEmptyCandidateSetup(
        conversationId: string,
        input: {
            setupRootNodeId: string;
            emptyCandidateNodeId: string;
            fallbackNodeId: string;
        }
    ): Promise<BranchSetupAbortResult> {
        return abortEmptyCandidateSetup(this.ctx, conversationId, input);
    }

    async finishReroll(conversationId: string, candidateNodeId: string): Promise<RerollFinishResult> {
        return finishReroll(this.ctx, conversationId, candidateNodeId);
    }

    async switchBranchCandidate(
        conversationId: string,
        nodeId: string,
        options: { recordRewriteExpectation?: boolean } = {}
    ): Promise<BranchSwitchResult> {
        return switchBranchCandidate(this.ctx, conversationId, nodeId, options);
    }

    async deleteBranchCandidate(conversationId: string, nodeId: string): Promise<BranchDeleteResult> {
        return deleteBranchCandidate(this.ctx, conversationId, nodeId);
    }

    async restoreBranchCandidate(conversationId: string, nodeId: string): Promise<{ nodeId: string; restored: boolean }> {
        return restoreBranchCandidate(this.ctx, conversationId, nodeId);
    }

    async renameBranchCandidate(
        conversationId: string,
        nodeId: string,
        label: string
    ): Promise<{ nodeId: string; label: string }> {
        return renameBranchCandidate(this.ctx, conversationId, nodeId, label);
    }

    async purgeBranchCandidate(conversationId: string, nodeId: string): Promise<BranchPurgeResult> {
        return purgeBranchCandidate(this.ctx, conversationId, nodeId);
    }

    // ==================== BCP-02：工作区存档绑定 ====================

    async bindWorkspaceCheckpoint(
        conversationId: string,
        nodeId: string,
        checkpointId: string,
        workspaceState: WorkspaceState = 'checkpointed'
    ): Promise<boolean> {
        return bindWorkspaceCheckpoint(this.ctx, conversationId, nodeId, checkpointId, workspaceState);
    }

    // ==================== TREE-09：软删统计 / 修剪 / 保留期配置 ====================

    async getDeletedBranchCount(options: { conversationId?: string } = {}): Promise<BranchDeletedCountResult> {
        return getDeletedBranchCount(this.ctx, options);
    }

    async pruneDeletedBranches(options: {
        conversationId?: string;
        retentionDays?: number;
        now?: number;
    } = {}): Promise<BranchPruneResult> {
        return pruneDeletedBranches(this.ctx, this.retentionDays, options);
    }

    async getBranchRetentionConfig(): Promise<BranchRetentionConfig> {
        return getBranchRetentionConfig(this.ctx, this.retentionDays);
    }

    async updateBranchRetentionConfig(retentionDays: number): Promise<BranchRetentionConfig> {
        return updateBranchRetentionConfig(this.ctx, retentionDays);
    }

    // ==================== BR-05：主历史 = 活跃路径 调试校验 ====================

    async validateActivePathMatchesHistory(conversationId: string): Promise<BranchPathConsistencyResult> {
        return validateActivePathMatchesHistory(this.ctx, conversationId);
    }

    // ==================== BR-09：跨对话「复制为新对话」建模 ====================

    async initializeBranchConversation(
        targetConversationId: string,
        sourceConversationId: string,
        sourceNodeId: string
    ): Promise<void> {
        return initializeBranchConversation(this.ctx, targetConversationId, sourceConversationId, sourceNodeId);
    }

    async recordExport(
        sourceConversationId: string,
        targetConversationId: string,
        nodeId: string
    ): Promise<void> {
        return recordExport(this.ctx, sourceConversationId, targetConversationId, nodeId);
    }

    // ==================== BS-2：主历史追加 → 分支图 / 决策 6：主历史删除同步 ====================

    async appendHistoryToGraph(conversationId: string, newMessages: ReadonlyArray<Content>): Promise<boolean> {
        return appendHistoryToGraph(this.ctx, conversationId, newMessages);
    }

    async syncGraphAfterHistoryDelete(
        conversationId: string,
        deletedFromMessageId: string | null,
        options: { deletedAt?: number; lastKeptMessageId?: string | null; forceResetToEmpty?: boolean } = {}
    ): Promise<BranchHistoryDeleteSyncResult> {
        return syncGraphAfterHistoryDelete(this.ctx, conversationId, deletedFromMessageId, options);
    }

    /** childrenIndex 便捷透出（供外部/测试检查候选顺序） */
    getChildrenIndex(graph: ConversationBranchGraph): Map<string, string[]> {
        return getChildrenIndex(graph);
    }
}
