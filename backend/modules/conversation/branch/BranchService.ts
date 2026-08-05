/**
 * 树状分支业务编排服务（第五阶段 BR-06/07 + BR-05/09 接线）。
 *
 * 职责：
 * - BR-06：分支图读写删接口（getBranchGraph / getBranchGraphMeta / saveBranchGraph /
 *   deleteConversationBranch / createRerollCandidate / editCandidate / switchBranchCandidate /
 *   deleteBranchCandidate）；
 * - BR-07：所有分支图写操作统一进入会话写锁（ConversationManager.runExclusive）；
 * - BR-05：validateActivePathMatchesHistory 调试校验（主历史消息 id 链 == 图活跃路径）；
 * - BR-09：initializeBranchConversation / recordExport（跨对话「复制为新对话」建模）；
 * - BS-2：appendHistoryToGraph（主历史尾部新增消息并入分支图；方法级实现，调用点后续接线）；
 * - TREE-09：deleteBranchCandidate（软删 + deletedAt）/ restoreBranchCandidate（恢复）/
 *   renameBranchCandidate（重命名 label）/ purgeBranchCandidate（彻底删除）/
 *   getDeletedBranchCount（软删统计）/ pruneDeletedBranches（过期物理清理）/
 *   getBranchRetentionConfig / updateBranchRetentionConfig（保留期配置，默认 30 天）；
 * - BCP-02：bindWorkspaceCheckpoint（工具执行存档点 fire-and-forget 绑定工作区存档头节点
 *   到分支节点，写入 workspaceCheckpointId + workspaceState；无图不建图、软删节点拒绝）。
 * - BCP-06：purgeBranchCandidate / pruneDeletedBranches 物理清理后，经全局清理器
 *   （CheckpointManager 自注册）触发引用归零存档清理（computeCheckpointReferenceCounts
 *   重扫全量 BranchGraph + deleteCheckpointsByNodeIds 引用计数/CP-05 闸门；软删不触发）。
 *
 * 本阶段范围边界（与 TREE 阶段的分界）：
 * - switchBranchCandidate 只做「图状态切换 + 持久化」，不重写主历史、不重建派生状态
 *   （TODO / Build / 用量索引 / 上下文裁剪），那是 TREE-06 的职责；
 * - createRerollCandidate / editCandidate 只建候选节点并切换 activeChildId，不启动模型流
 *   （chat.rerollStream / chat.editBranchAndRetryStream 在 TREE-01/03）；
 * - deleteBranchCandidate 为软删除（TREE-09），且拒绝删除活跃路径上的节点；
 * - sidecar 损坏（解析失败或读取侧语义校验失败）时：读取降级线性模式（仓储层 +
 *   读取侧 validate/activePath 语义校验）；写入拒绝（BRANCH_STORAGE_CORRUPT），
 *   不静默覆盖可能可恢复的数据（MIG-05 完整性工具负责修复）。
 *
 * 锁序（BR-07 + M-3 复查修正，强约束）：
 *   「会话锁内严禁获取存档锁；存档锁只能在会话锁之外获取」。
 *   全局实际获取顺序是 存档锁 → 会话锁（CheckpointManager 的 restore/create 路径先取
 *   checkpointOperationLockManager 存档操作锁，再在锁内获取会话写锁），因此会话写锁是
 *   存档锁的内层：任何在会话写锁内再去获取存档锁的调用，都会与 restore/create 的
 *   「存档锁 → 会话锁」路径构成锁序反转（互相等待）而死锁。
 *   TREE-06（切换重写主历史）/ BCP（工作区存档绑定与恢复）设计必须遵守本约束：
 *   需要存档锁的操作只能从会话锁之外发起；分支图读改写只允许持有会话写锁。
 *   文件写锁（FileWriteLockManager.acquire）仍在最外层，获取方向为
 *   文件写锁 → 存档锁 → 会话锁（存档操作内部需要会话锁时按此方向获取）。
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '../../../core/logger';
import type { Content, ContentPart, UsageMetadata } from '../types';
import {
    activePath,
    childrenIndex,
    collectDeletedNodes,
    editCandidate,
    importLinearHistory,
    insertNode,
    isFunctionResponseMessage,
    pruneDeletedNodes,
    removeSubtree,
    renameBranchLabel,
    renameNode,
    rerollCandidate,
    restoreNode,
    softDeleteNode,
    softDeleteSubtreeFrom,
    switchActivePath,
    updateNodeContent,
    upsertCandidateSummary,
    validate,
} from './BranchGraph';
import { BranchGraphRepository, type BranchGraphReadResult } from './BranchGraphRepository';
import {
    BranchError,
    BranchNodeKind,
    BranchExportRecord,
    BranchRetentionConfig,
    ConversationBranchGraph,
    ConversationBranchNode,
    DEFAULT_BRANCH_RETENTION_DAYS,
    WorkspaceState,
} from './types';
import type { ConversationManager } from '../ConversationManager';
// BCP-06: 引用计数扫描 + 全局清理器（CheckpointManager 构造时自注册；
// 仅依赖 checkpointRefCounts 模块，不反向依赖 CheckpointManager，避免模块环）。
import {
    computeCheckpointReferenceCounts,
    getGlobalCheckpointRefCountCleaner,
} from '../../checkpoint/checkpointRefCounts';

const log = Logger.get('BranchService');

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
    /** 最终候选节点 ID（必要时已重命名对齐主历史首条新消息 ID） */
    candidateNodeId: string;
    parentNodeId: string;
    activeTailNodeId: string | null;
    activePathIds: string[];
    /** 写入图的模型消息数（0 = 流式失败未产生内容，候选保留为空） */
    syncedMessageCount: number;
}

/** 从节点 parts 生成候选摘要 preview（首段文本，无文本用工具名/空） */
function buildCandidateSummary(node: ConversationBranchNode): { preview: string } {
    const texts: string[] = [];
    for (const part of node.parts ?? []) {
        if (typeof part.text === 'string' && part.text.trim()) {
            texts.push(part.text.trim());
        }
    }
    if (texts.length > 0) {
        return { preview: texts.join(' ').slice(0, 120) };
    }
    const toolNames = (node.parts ?? [])
        .map(part => part.functionCall?.name)
        .filter((name): name is string => typeof name === 'string');
    return { preview: toolNames.length > 0 ? `[tool: ${toolNames.join(', ')}]` : '' };
}

export class BranchService {
    /**
     * TREE-09：软删节点保留天数（默认 DEFAULT_BRANCH_RETENTION_DAYS=30）。
     * 优先级：pruneDeletedBranches 显式入参 > branches.config.json 持久化配置 > 本构造默认值。
     */
    private readonly retentionDays: number;

    constructor(
        private readonly conversationManager: ConversationManager,
        private readonly repository: BranchGraphRepository,
        options: { retentionDays?: number } = {}
    ) {
        this.retentionDays = options.retentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS;
    }

    // ==================== BR-06：读写删接口 ====================

    /**
     * 读取分支图（BR-06）。
     * - 文件不存在 → { graph: null }（线性模式）；
     * - 损坏（解析失败 / 结构不符 / 读取侧语义校验失败）→
     *   { graph: null, errorCode: 'BRANCH_STORAGE_CORRUPT' }（读取降级，不抛错）。
     * 只读操作不进入会话写锁（sidecar 为原子替换，读不参与写串行）。
     *
     * M-2：仓储层只做浅层 shape 检查，可解析但语义损坏（环 / 悬空 parentId /
     * activeChildId 指向非子节点 / 版本不符 / 尾指针非终端等）的图不得原样下发——
     * 此处对 loaded.graph 做 validate() + activePath() 语义校验，损坏同样返回 errorCode。
     */
    async getBranchGraph(conversationId: string): Promise<BranchGraphReadResult> {
        const loaded = await this.repository.load(conversationId);
        if (loaded.graph) {
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                return {
                    graph: null,
                    errorCode: 'BRANCH_STORAGE_CORRUPT',
                    errorMessage: `semantic validation failed: ${validation.issues.map(i => i.message).join('; ')}`,
                };
            }
            try {
                activePath(loaded.graph);
            } catch (error) {
                return {
                    graph: null,
                    errorCode: 'BRANCH_STORAGE_CORRUPT',
                    errorMessage: `active path resolution failed: ${(error as Error)?.message ?? String(error)}`,
                };
            }
        }
        return loaded;
    }

    /**
     * 分支图元信息（BR-06）：轻量摘要，避免整图下发。
     * 三态语义（BS-1）：
     * - 无图：exists=false，无 errorCode；
     * - 损坏（仓储解析失败 / 结构不符 / 读取侧语义校验失败）：exists=false +
     *   corrupted=true + errorCode='BRANCH_STORAGE_CORRUPT'（M-1/M-2 兑现注释承诺）；
     * - 存在可用：exists=true。
     */
    async getBranchGraphMeta(conversationId: string): Promise<BranchGraphMetaResult> {
        const loaded = await this.repository.load(conversationId);
        const base: BranchGraphMetaResult = {
            conversationId,
            exists: false,
            rootNodeId: null,
            activeTailNodeId: null,
            nodeCount: 0,
            candidateCount: 0,
            deletedCount: 0,
            activePathLength: 0,
            exportedRefs: [],
        };
        if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            // 仓储损坏（JSON 解析失败 / 结构不符）：M-1 透出 errorCode
            return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
        }
        if (!loaded.graph) {
            return { ...base, exists: false };
        }
        const graph = loaded.graph;
        // M-2：读取侧语义校验（validate + activePath），语义损坏同样降级为损坏态
        const validation = validate(graph);
        if (!validation.valid) {
            log.warn('branch_graph_meta_semantic_corrupt', {
                conversationId,
                issues: validation.issues.map(i => i.message),
            });
            return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
        }
        try {
            return {
                conversationId,
                exists: true,
                rootNodeId: graph.rootNodeId,
                activeTailNodeId: graph.activeTailNodeId,
                nodeCount: Object.keys(graph.nodes).length,
                candidateCount: (graph.candidateSummaries ?? []).filter(s => !s.deleted).length,
                deletedCount: collectDeletedNodes(graph).length,
                activePathLength: activePath(graph).length,
                exportedFrom: graph.exportedFrom,
                exportedRefs: graph.exportedRefs ?? [],
            };
        } catch (error) {
            // 图结构自相矛盾（环等）：与仓储损坏统一为 exists:false + corrupted + errorCode（M-2/BS-1）
            log.warn('branch_graph_meta_unavailable', { conversationId, error: (error as Error)?.message ?? String(error) });
            return { ...base, corrupted: true, errorCode: 'BRANCH_STORAGE_CORRUPT' };
        }
    }

    /**
     * 保存分支图（BR-06）。先 validate 再持久化；结构无效抛 BRANCH_STORAGE_CORRUPT。
     * 写入进入会话写锁（BR-07），保证与主历史写入串行。
     */
    async saveBranchGraph(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        const validation = validate(graph);
        if (!validation.valid) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `refusing to persist invalid branch graph: ${validation.issues.map(i => i.message).join('; ')}`
            );
        }
        await this.conversationManager.runExclusive(conversationId, async () => {
            // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）
            await this.assertConversationWritable(conversationId);
            await this.repository.save(conversationId, graph);
        });
    }

    /**
     * 删除会话的分支图 sidecar（BR-06；级联清理，幂等）。
     * 对话删除时由 ConversationManager.deleteConversation 接线调用（BR-04 清理要求；
     * 该调用点在会话写锁之外，不会重入死锁）。
     *
     * M-5：删除与 sidecar 写入共用会话写锁，保证并发「写→删」先写后删（无残留）、
     * 「删→写」删除后不再重建（迟到写由 assertConversationWritable 在锁内拒绝）。
     * 本方法是级联清理路径，不做已删除会话检查（删除进行中/刚完成时正是它被调用的时机）。
     */
    async deleteConversationBranch(conversationId: string): Promise<void> {
        await this.conversationManager.runExclusive(conversationId, async () => {
            await this.repository.deleteConversation(conversationId);
        });
    }

    // ==================== BR-07：候选创建 / 编辑 / 切换 / 删除（全部在会话写锁内） ====================

    /**
     * 创建 reroll 候选（TREE-01 底座）：同一父节点下新增候选并切换 activeChildId，旧候选保留。
     * 无分支图时先以主历史建线性基线图（MIG-01 惰性建图）。
     */
    async createRerollCandidate(
        conversationId: string,
        parentNodeId: string,
        input: BranchCandidateInput
    ): Promise<BranchCandidateCreateResult> {
        return await this.mutateGraph(conversationId, graph => {
            // BS-3：父节点必须在当前活跃路径上（不能从非活跃分支节点再分支）
            this.assertParentOnActivePath(graph, parentNodeId);
            // TREE-02（决策 4）：每父节点候选上限，超限明确报错（提示清理，不自动删）
            this.assertCandidateLimit(graph, parentNodeId);
            const node = this.buildCandidateNode(input, parentNodeId, 'model');
            const next = rerollCandidate(graph, parentNodeId, node, { updateTail: true });
            const summary = buildCandidateSummary(node);
            const withSummary = upsertCandidateSummary(next, {
                nodeId: node.id,
                parentId: parentNodeId,
                kind: 'reroll',
                createdAt: node.createdAt,
                timestamp: node.timestamp,
                modelVersion: node.modelVersion,
                label: node.label,
                preview: summary.preview,
            });
            return {
                next: withSummary,
                result: {
                    nodeId: node.id,
                    parentNodeId,
                    kind: 'reroll',
                    activeTailNodeId: withSummary.activeTailNodeId,
                    activePathIds: activePath(withSummary),
                },
            };
        });
    }

    /**
     * 确保分支图 sidecar 存在（TREE-03 keep 模式前置）：无图时以主历史建线性基线图。
     *
     * 用于「先建图后截断」——让截断前的完整旧历史先进图，截断后再软删被移除的子树，
     * 保证旧版本可回看（与 branch 模式 editCandidate 的惰性建图时机对齐，MIG-01）。
     * 已有图 / sidecar 损坏（抛 BRANCH_STORAGE_CORRUPT，不覆盖）→ 幂等。
     *
     * @returns true 表示本次新建了图；false 表示图已存在或无需建图
     */
    async ensureBranchGraph(conversationId: string): Promise<boolean> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            await this.assertConversationWritable(conversationId);
            const loaded = await this.repository.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is corrupt for ${conversationId}; refusing to ensure branch graph (${loaded.errorMessage ?? 'unknown error'})`
                );
            }
            if (loaded.graph) {
                return false; // 已有图：无需重建
            }
            const history = await this.conversationManager.getMessagesRaw(conversationId);
            const graph = importLinearHistory(history);
            await this.validateAndSave(conversationId, graph);
            return true;
        });
    }

    /**
     * 原地更新活跃路径上指定节点的 parts（保持分支的编辑，TREE-03 keep 模式底座）。
     *
     * 与 editCandidate 的区别：不创建新候选、不切换分支——直接改写节点内容并同步候选摘要，
     * 保证分支图与主历史一致（BR-01：节点 id == Content.id；之后切回该分支时展示编辑后的文本）。
     *
     * @param nodeId 目标节点（须在当前活跃路径上）
     * @param parts 新的消息内容
     */
    async updateActiveNodeParts(
        conversationId: string,
        nodeId: string,
        parts: ContentPart[]
    ): Promise<{ nodeId: string }> {
        return await this.mutateGraph(conversationId, graph => {
            const node = graph.nodes[nodeId];
            if (!node) {
                throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
            }
            if (!activePath(graph).includes(nodeId)) {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `node ${nodeId} is not on the active path`
                );
            }
            const next = updateNodeContent(graph, nodeId, { parts });
            const summary = buildCandidateSummary({ ...node, parts });
            const withSummary = upsertCandidateSummary(next, {
                nodeId,
                parentId: node.parentId,
                kind: node.kind,
                createdAt: node.createdAt,
                timestamp: node.timestamp,
                modelVersion: node.modelVersion,
                label: node.label,
                preview: summary.preview,
            });
            return { next: withSummary, result: { nodeId } };
        });
    }

    /**
     * 创建编辑分支候选（TREE-03 底座）：在旧用户节点的父节点下新增 edit 候选并切换 activeChildId，
     * 旧子树完整保留。无分支图时同样先建线性基线图。
     */
    async editCandidate(
        conversationId: string,
        parentNodeId: string,
        input: BranchCandidateInput
    ): Promise<BranchCandidateCreateResult> {
        return await this.mutateGraph(conversationId, graph => {
            // BS-3：父节点必须在当前活跃路径上（不能从非活跃分支节点再分支）
            this.assertParentOnActivePath(graph, parentNodeId);
            // TREE-02（决策 4）：编辑候选同样计入每父节点候选上限
            this.assertCandidateLimit(graph, parentNodeId);
            const node = this.buildCandidateNode(input, parentNodeId, 'user');
            const next = editCandidate(graph, parentNodeId, node, { updateTail: true });
            const summary = buildCandidateSummary(node);
            const withSummary = upsertCandidateSummary(next, {
                nodeId: node.id,
                parentId: parentNodeId,
                kind: 'edit',
                createdAt: node.createdAt,
                timestamp: node.timestamp,
                modelVersion: node.modelVersion,
                label: node.label,
                preview: summary.preview,
            });
            return {
                next: withSummary,
                result: {
                    nodeId: node.id,
                    parentNodeId,
                    kind: 'edit',
                    activeTailNodeId: withSummary.activeTailNodeId,
                    activePathIds: activePath(withSummary),
                },
            };
        });
    }

    /**
     * 开始 reroll（TREE-01）：验证目标助手节点在活跃路径 → 找到其直接父节点 →
     * 保留目标助手节点及其子树（进 sidecar）→ 在同一父节点下创建新候选并激活 →
     * 主历史从目标助手消息开始截断。
     *
     * 父节点既可以是 user，也可以是 model：工具调用后的续接回答在分支图中直接挂在
     * 前一个 model 节点下（functionResponse 合并进该父节点），重生成续接回答时必须保留
     * 前面的模型工具调用与工具结果，只替换被点中的单条回答。
     *
     * 顺序说明：先建图后截断主历史。线性模式首次建图时，旧助手节点必须先进入 sidecar，
     * 否则截断主历史会把它永久删除（丢失旧回答）。
     *
     * 锁边界：图变更在会话写锁内（mutateGraph）；主历史截断走 ConversationManager 的
     * deleteMessagesInRange（仓储内部自带会话写锁），不能嵌套在 runExclusive 内（防死锁），
     * 因此两处不原子——中间窗由 finishReroll 的主历史→图回填兜底（TREE-13 将加流式互斥）。
     *
     * @param assistantNodeId 目标助手节点；省略时取活跃路径上最后一条助手消息（前端「重新生成」默认行为）
     */
    async startReroll(conversationId: string, assistantNodeId?: string): Promise<RerollStartResult> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        // 1. 图状态变更（会话写锁内）：验证 + 创建候选 + 激活 + 摘要
        const created = await this.mutateGraph(conversationId, graph => {
            const targetId = this.resolveRerollTarget(graph, assistantNodeId);
            const target = graph.nodes[targetId]!;
            if (target.role !== 'model') {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `reroll target ${targetId} is not a model node`
                );
            }
            const parentNodeId = target.parentId;
            if (parentNodeId === null) {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `reroll target ${targetId} has no parent node`
                );
            }
            const parent = graph.nodes[parentNodeId];
            if (!parent || (parent.role !== 'user' && parent.role !== 'model')) {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `reroll target ${targetId} must have a user or model parent node`
                );
            }
            // TREE-02（决策 4）：每父节点候选上限
            this.assertCandidateLimit(graph, parentNodeId);
            const node = this.buildCandidateNode({ parts: [] }, parentNodeId, 'model');
            const next = rerollCandidate(graph, parentNodeId, node, { updateTail: true });
            const withSummary = upsertCandidateSummary(next, {
                nodeId: node.id,
                parentId: parentNodeId,
                kind: 'reroll',
                createdAt: node.createdAt,
                timestamp: node.timestamp,
                modelVersion: node.modelVersion,
                label: node.label,
                preview: '',
            });
            return {
                next: withSummary,
                result: {
                    candidateNodeId: node.id,
                    parentNodeId,
                    previousNodeId: targetId,
                },
            };
        });
        // 2. 主历史从目标助手消息开始截断。直接回复场景等价于“父 user 后截断”；
        // 工具续接场景则保留目标前的 model + functionResponse，只移除被点回答及其后续消息。
        const history = await this.conversationManager.getMessagesRaw(conversationId);
        const targetIndex = history.findIndex(message => message.id === created.previousNodeId);
        if (targetIndex >= 0 && targetIndex < history.length) {
            await this.conversationManager.deleteMessagesInRange(conversationId, targetIndex, history.length - 1);
        }
        return { ...created, historyLengthAfterTruncate: targetIndex };
    }

    /**
     * 完成 reroll（TREE-01）：把工具循环写入主历史的流式结果回填进新候选节点（含续接节点），
     * 并更新候选摘要。失败时也会调用（决策 10：失败保留旧候选，新候选保留部分内容可切回查看）。
     *
     * 回填规则（与 importLinearHistory 一致，决策 8）：
     * - 主历史父节点之后第一条非 functionResponse 消息 → 候选节点内容写入；
     *   若其 id 与候选占位节点 id 不同（工具循环生成新 UUID），候选节点重命名对齐（BR-01 同源）；
     * - 后续非 functionResponse 消息 → 在上一节点下插入 kind='continue' 续接节点并激活；
     * - functionResponse 消息 → parts 并入前一个模型节点（不独立成节点）。
     */
    async finishReroll(conversationId: string, candidateNodeId: string): Promise<RerollFinishResult> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        // 工具循环已结束，历史在此之后基本稳定；在锁外读一次快照供同步用（getMessagesRaw 只读）
        const history = await this.conversationManager.getMessagesRaw(conversationId);
        return await this.mutateGraph(conversationId, graph => {
            const candidate = graph.nodes[candidateNodeId];
            if (!candidate) {
                throw new BranchError('NODE_NOT_FOUND', `reroll candidate node not found: ${candidateNodeId}`);
            }
            const parentNodeId = candidate.parentId;
            if (parentNodeId === null) {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `reroll candidate ${candidateNodeId} cannot be the root node`
                );
            }

            const parentIndex = history.findIndex(message => message.id === parentNodeId);
            const tail = parentIndex >= 0 ? history.slice(parentIndex + 1) : [];

            let next = graph;
            let cursorNodeId: string | null = null; // 当前模型节点（functionResponse 合并目标）
            let firstMessageId: string | null = null;
            let synced = 0;
            for (const message of tail) {
                if (isFunctionResponseMessage(message)) {
                    // 决策 8：functionResponse 并入前一个模型节点
                    if (cursorNodeId !== null) {
                        const current = next.nodes[cursorNodeId]!;
                        next = updateNodeContent(next, cursorNodeId, {
                            parts: [...current.parts, ...(message.parts ?? [])],
                        });
                    }
                    continue;
                }
                if (firstMessageId === null) {
                    // 首条模型消息 → 候选节点内容写入（必要时重命名对齐消息 id）
                    const targetId = typeof message.id === 'string' && message.id.length > 0
                        ? message.id
                        : candidateNodeId;
                    if (targetId !== candidateNodeId) {
                        next = renameNode(next, candidateNodeId, targetId);
                    }
                    next = updateNodeContent(next, targetId, {
                        parts: message.parts ?? [],
                        modelVersion: message.modelVersion,
                        usageMetadata: message.usageMetadata,
                        // R8b-M2：中断/取消流的截断用量标记随 usageMetadata 一起拷贝
                        // （否则中断 reroll 候选按截断原值计入，统计低估）
                        usageMetadataPartial: message.usageMetadataPartial,
                        timestamp: message.timestamp,
                    });
                    firstMessageId = targetId;
                    cursorNodeId = targetId;
                    synced += 1;
                } else {
                    // 后续模型消息 → 续接节点（kind='continue'，激活并更新尾指针）
                    const id = typeof message.id === 'string' && message.id.length > 0
                        ? message.id
                        : `continue-${synced}`;
                    const continuation: ConversationBranchNode = {
                        id,
                        parentId: cursorNodeId,
                        role: 'model',
                        parts: JSON.parse(JSON.stringify(message.parts ?? [])),
                        kind: 'continue',
                        createdAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
                        timestamp: message.timestamp,
                        modelVersion: message.modelVersion,
                        usageMetadata: message.usageMetadata,
                        // R8b-M2：续接节点同样携带中断标记（截断用量统计端回退估算）
                        usageMetadataPartial: message.usageMetadataPartial,
                    };
                    next = insertNode(next, continuation, { setActive: true, updateTail: true });
                    cursorNodeId = id;
                    synced += 1;
                }
            }

            // 更新候选摘要（preview 从最终节点内容生成；流式失败时 preview 为空）
            const finalCandidateId = firstMessageId ?? candidateNodeId;
            const finalNode = next.nodes[finalCandidateId]!;
            const summary = buildCandidateSummary(finalNode);
            next = upsertCandidateSummary(next, {
                nodeId: finalCandidateId,
                parentId: parentNodeId,
                kind: 'reroll',
                createdAt: finalNode.createdAt,
                timestamp: finalNode.timestamp,
                modelVersion: finalNode.modelVersion,
                label: finalNode.label,
                preview: summary.preview,
            });

            return {
                next,
                result: {
                    candidateNodeId: finalCandidateId,
                    parentNodeId,
                    activeTailNodeId: next.activeTailNodeId,
                    activePathIds: activePath(next),
                    syncedMessageCount: synced,
                },
            };
        });
    }

    /**
     * 切换候选（TREE-04/06 底座）：把活跃路径切换到目标节点（祖先 activeChildId 沿 parentId 链重指，
     * 尾指针 = 目标子树活跃尾），并持久化。
     *
     * 注意（本阶段边界）：只切换图状态，**不重写主历史**（TREE-06 才执行 replaceContents 全量重写），
     * 因此切换后主历史与图活跃路径会暂时不一致，直到 TREE-06 落地。
     */
    async switchBranchCandidate(conversationId: string, nodeId: string): Promise<BranchSwitchResult> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            const graph = await this.loadGraphForWrite(conversationId);
            const next = switchActivePath(graph, nodeId);
            await this.validateAndSave(conversationId, next);
            return {
                nodeId,
                activeTailNodeId: next.activeTailNodeId,
                activePathIds: activePath(next),
                mainHistoryRewrite: false,
            };
        });
    }

    /**
     * 软删除分支候选（TREE-09）：节点标记 deleted + deletedAt，候选摘要同步软删。
     * - 活跃路径上的节点拒绝删除（BRANCH_OPERATION_CONFLICT，需先切换走）；
     * - 若被删节点是其父节点的当前活跃子（仅可能发生在非活跃分支上），同步清空父节点 activeChildId；
     * - R8c-P1：级联软删整棵子树（softDeleteNode 沿 children 递归标记 deleted + deletedAt），
     *   prune 物理清理前子树整体可恢复（restoreBranchCandidate 对称级联恢复）；
     * - 重复删除幂等（deletedAt 保持首次删除时间），且幂等路径不落盘（R8c-P6：图未变化）。
     *
     * 既有语义确认（读代码后的取舍）：TREE-09 之前的 deleteBranchCandidate 已实现为软删除
     * （deleted 标记 + 摘要同步），本批次保留该语义并补充 deletedAt；「恢复」走 restoreBranchCandidate，
     * 「彻底删除」走 purgeBranchCandidate / pruneDeletedBranches（物理清理），不把 delete 改回硬删。
     */
    async deleteBranchCandidate(conversationId: string, nodeId: string): Promise<BranchDeleteResult> {
        return await this.mutateGraph(conversationId, graph => {
            const node = graph.nodes[nodeId];
            if (!node) {
                throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
            }
            if (node.deleted) {
                // R8c-P6：幂等路径——图未变化，mutateGraph 据此跳过 validateAndSave 不落盘
                return { next: graph, result: { nodeId, deleted: true, clearedParentActiveChild: false } };
            }
            const currentActivePath = activePath(graph);
            if (currentActivePath.includes(nodeId)) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    `cannot delete node ${nodeId}: it is on the active path; switch away first`
                );
            }
            const clearedParentActiveChild =
                node.parentId !== null && graph.nodes[node.parentId]?.activeChildId === nodeId;
            const next = softDeleteNode(graph, nodeId, { deletedAt: Date.now() });
            return {
                next,
                result: { nodeId, deleted: true, clearedParentActiveChild },
            };
        });
    }

    /**
     * TREE-09：恢复软删候选——清除节点与候选摘要的 deleted / deletedAt。
     * 不自动重新激活（恢复后仍是普通非活跃节点，由 switchBranchCandidate 显式切换）。
     * 节点不存在 → NODE_NOT_FOUND；未删除节点幂等返回 restored:false。
     */
    async restoreBranchCandidate(conversationId: string, nodeId: string): Promise<{ nodeId: string; restored: boolean }> {
        return await this.mutateGraph<{ nodeId: string; restored: boolean }>(conversationId, graph => {
            const node = graph.nodes[nodeId];
            if (!node) {
                throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
            }
            if (!node.deleted) {
                return { next: graph, result: { nodeId, restored: false } };
            }
            return { next: restoreNode(graph, nodeId), result: { nodeId, restored: true } };
        });
    }

    /**
     * TREE-09：重命名分支候选——只改 label（节点 + 候选摘要同步），不动 contents。
     * label 非空、≤200 字符（trim 后）；节点不存在 → NODE_NOT_FOUND。
     */
    async renameBranchCandidate(
        conversationId: string,
        nodeId: string,
        label: string
    ): Promise<{ nodeId: string; label: string }> {
        return await this.mutateGraph(conversationId, graph => {
            const trimmed = typeof label === 'string' ? label.trim() : '';
            if (trimmed.length === 0) {
                throw new BranchError('INVALID_BRANCH_RELATION', 'branch label must not be empty');
            }
            if (trimmed.length > 200) {
                throw new BranchError('INVALID_BRANCH_RELATION', `branch label is too long (max 200 chars, got ${trimmed.length})`);
            }
            const next = renameBranchLabel(graph, nodeId, trimmed);
            return { next, result: { nodeId, label: trimmed } };
        });
    }

    /**
     * BCP-06：purge/prune 物理清理后触发「引用归零存档清理」。
     *
     * 流程（研究 §5.3）：
     * 1. 被移除节点已在图中消失（调用方先 validateAndSave 落盘）；
     * 2. 重扫全部 sidecar 计算引用计数（软删节点不计数）——被移除节点绑定的存档
     *    若仍被存活节点引用则 refCount>0 → 拒绝删除；归零才进入待删候选；
     * 3. 调全局清理器 deleteCheckpointsByNodeIds（nodeIds = 被移除节点，候选 = messageNodeId
     *    匹配的存档；refCount>0 拒绝 + CP-05 祖先闭包合并 + backupDir 安全校验）；
     * 4. 失败仅 log.warn（清理是派生态，不阻塞分支删除主流程；BCP-05 恢复前仍校验存档存在性）。
     *
     * 时序取舍（同步 await 而非 fire-and-forget）：
     * - purge/prune 均为低频显式清理操作，确定性结果（deleted/rejected 落日志）价值更高；
     * - 同步等待可避免多个 prune 并发时扫描交错；失败已内部捕获，不延长用户可见错误。
     * 锁序：本方法在会话写锁之外调用（cleanupZeroReferencedCheckpoints 自身只取存档锁）。
     */
    private async cleanupZeroReferencedCheckpoints(
        conversationId: string,
        removedNodeIds: string[]
    ): Promise<void> {
        if (removedNodeIds.length === 0) {
            return;
        }
        const cleaner = getGlobalCheckpointRefCountCleaner();
        if (!cleaner) {
            // 未注册（无 CheckpointManager / 测试环境）：跳过，图侧清理已完成
            return;
        }
        try {
            const referenceCounts = await computeCheckpointReferenceCounts(this.repository);
            const outcome = await cleaner.deleteCheckpointsByNodeIds(conversationId, removedNodeIds, {
                referenceCounts,
            });
            if (outcome.deletedIds.length > 0 || outcome.rejectedIds.length > 0) {
                log.info('branch_checkpoint_cleanup', {
                    conversationId,
                    nodeIds: removedNodeIds,
                    deletedIds: outcome.deletedIds,
                    rejectedIds: outcome.rejectedIds,
                });
            }
        } catch (err) {
            log.warn('branch_checkpoint_cleanup_failed', {
                conversationId,
                error: (err as Error)?.message ?? String(err),
            });
        }
    }

    /**
     * TREE-09：彻底删除（硬删）单个候选——物理移除节点及其整棵子树（purgeBranchCandidate）。
     * 仅允许对已软删节点执行（先软删再彻底删；未软删抛 BRANCH_OPERATION_CONFLICT，避免误删）；
     * 节点不存在（已被 prune 清理 / 从未来过）→ R8c-P7 幂等返回 purged:false（不再抛
     * NODE_NOT_FOUND，与注释承诺的幂等语义一致；图未变化不落盘）。
     */
    async purgeBranchCandidate(conversationId: string, nodeId: string): Promise<BranchPurgeResult> {
        // 注：显式泛型（与 restoreBranchCandidate 的 mutateGraph<{...}> 同模式），
        // 使回调两种返回形态（purged:false / purged:true）可被推断为 BranchPurgeResult。
        // BCP-06: 闭包收集被物理移除节点的 workspaceCheckpointId（图侧绑定随节点消失）
        let prunedNodeIds: string[] = [];
        return await this.mutateGraph<BranchPurgeResult>(conversationId, graph => {
            const node = graph.nodes[nodeId];
            if (!node) {
                // R8c-P7：幂等——节点已不存在（被 prune 清理等）视为“无可清理”，返回 purged:false
                return {
                    next: graph,
                    result: { nodeId, purged: false, prunedNodeCount: 0 },
                };
            }
            if (!node.deleted) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    `cannot purge node ${nodeId}: it is not soft-deleted; delete it first`
                );
            }
            const { graph: next, prunedNodeIds: removed } = removeSubtree(graph, nodeId);
            prunedNodeIds = removed;
            return {
                next,
                result: { nodeId, purged: true, prunedNodeCount: prunedNodeIds.length },
            };
        }).then(async result => {
            // BCP-06：物理移除后（会话写锁已释放），引用归零的存档清理（同步；失败仅 warn）
            if (result.purged && prunedNodeIds.length > 0) {
                await this.cleanupZeroReferencedCheckpoints(conversationId, prunedNodeIds);
            }
            return result;
        });
    }

    // ==================== BCP-02：工作区存档绑定 ====================

    /**
     * BCP-02：把工作区存档 id 绑定到分支节点（写入 workspaceCheckpointId + workspaceState）。
     *
     * 语义：
     * - 会话写锁内执行（与 mutateGraph 同锁；但**不强制建图**——无 sidecar 的线性对话直接
     *   返回 false，绑定是派生态，不因绑定创建分支图）；
     * - 节点不存在 → NODE_NOT_FOUND；软删节点 → BRANCH_OPERATION_CONFLICT；
     * - 重复绑定直接覆盖（最新存档为准）；同 id 且同 state 幂等返回 false（图未变化不落盘）；
     * - workspaceState 缺省 'checkpointed'（绑定成功即视为「工作区已存档」）；
     * - sidecar 损坏（解析/语义/活跃路径不可解）→ BRANCH_STORAGE_CORRUPT
     *   （与其它写路径一致：拒绝覆盖可能可恢复的数据）。
     *
     * 调用方约定：工具执行存档点（ToolExecutionService）在 createCheckpoint 返回后以
     * fire-and-forget 方式调用（不阻塞工具循环）；失败由调用方 log.warn。锁序约束：
     * createCheckpoint 持工作区存档锁，本方法只取会话写锁，二者无嵌套（R1）。
     *
     * @returns true = 已绑定并落盘；false = 无图跳过或同 id 幂等（图未变化）。
     */
    async bindWorkspaceCheckpoint(
        conversationId: string,
        nodeId: string,
        checkpointId: string,
        workspaceState: WorkspaceState = 'checkpointed'
    ): Promise<boolean> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）
            await this.assertConversationWritable(conversationId);
            const loaded = await this.repository.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is corrupt for ${conversationId}; refusing to bind workspace checkpoint (${loaded.errorMessage ?? 'unknown error'})`
                );
            }
            if (!loaded.graph) {
                // 无图（线性对话）：跳过绑定、不强制建图
                return false;
            }
            // M-2：读取侧语义校验（与 loadGraphForWrite 同策略：语义损坏拒绝覆盖）
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is semantically corrupt for ${conversationId}; refusing to bind workspace checkpoint (${validation.issues.map(i => i.message).join('; ')})`
                );
            }
            try {
                activePath(loaded.graph);
            } catch (error) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json active path is unresolvable for ${conversationId}; refusing to bind workspace checkpoint (${(error as Error)?.message ?? String(error)})`
                );
            }
            const node = loaded.graph.nodes[nodeId];
            if (!node) {
                throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
            }
            if (node.deleted) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    `cannot bind workspace checkpoint to soft-deleted node: ${nodeId}`
                );
            }
            // 幂等：同 id 且同 state 已绑定 → 图未变化，不落盘
            if (node.workspaceCheckpointId === checkpointId && node.workspaceState === workspaceState) {
                return false;
            }
            const next: ConversationBranchGraph = {
                ...loaded.graph,
                nodes: {
                    ...loaded.graph.nodes,
                    [nodeId]: {
                        ...node,
                        workspaceCheckpointId: checkpointId,
                        workspaceState,
                    },
                },
            };
            await this.validateAndSave(conversationId, next);
            return true;
        });
    }

    // ==================== TREE-09：软删统计 / 修剪 / 保留期配置 ====================

    /**
     * TREE-09：统计软删分支数量。
     * - 指定 conversationId：只统计该会话（无图/损坏 → 0，不抛错）；
     * - 缺省：扫描全部带 sidecar 的会话（设置页「软删分支数量」展示用）；
     * - R8c-P4：与 pruneDeletedBranches 同口径——会话元数据不存在（孤儿 sidecar，会话已删除/不存在）
     *   不计数也不计入 conversationCount，保证设置页清理后数量归零（此前孤儿 sidecar 照常计数，
     *   prune 却跳过它们，数量清理后不归零）。
     * 只读操作，不进入会话写锁。
     */
    async getDeletedBranchCount(options: { conversationId?: string } = {}): Promise<BranchDeletedCountResult> {
        const conversationIds = options.conversationId
            ? [options.conversationId]
            : await this.repository.listConversationIds();
        let deletedNodeCount = 0;
        let conversationCount = 0;
        for (const conversationId of conversationIds) {
            const metadata = await this.conversationManager.getMetadata(conversationId);
            if (!metadata) {
                continue; // 孤儿 sidecar：会话已不存在，不计数（与 prune 的 skippedConversations 同口径）
            }
            conversationCount += 1;
            const loaded = await this.repository.load(conversationId);
            if (!loaded.graph || loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                continue;
            }
            if (!validate(loaded.graph).valid) {
                continue; // 语义损坏图不计数（读取侧同样降级）
            }
            deletedNodeCount += collectDeletedNodes(loaded.graph).length;
        }
        return { conversationCount, deletedNodeCount };
    }

    /**
     * TREE-09：物理清理过期软删分支（prune）。
     * - 指定 conversationId：只清理该会话；缺省：全量扫描所有带 sidecar 的会话；
     * - 过期判定：deletedAt（缺失兜底 createdAt）+ retentionDays；
     * - retentionDays 优先级：显式入参 > branches.config.json 持久化配置 > 构造默认值；
     * - 过期节点连同整棵子树物理移除，同步清理候选摘要与 exportedFrom/exportedRefs 引用；
     * - 每个会话在会话写锁内执行（BR-07）；损坏 sidecar 跳过不覆盖（MIG-05 完整性工具负责修复）；
     *   会话已删除/不存在跳过（assertConversationWritable 冲突）。
     * - 工作区存档的引用计数清理属 BCP-06，本批只做图侧清理。
     */
    async pruneDeletedBranches(options: {
        conversationId?: string;
        retentionDays?: number;
        now?: number;
    } = {}): Promise<BranchPruneResult> {
        const persisted = await this.repository.loadBranchRetentionConfig();
        const retentionDays = options.retentionDays ?? persisted.retentionDays ?? this.retentionDays;
        const conversationIds = options.conversationId
            ? [options.conversationId]
            : await this.repository.listConversationIds();

        const result: BranchPruneResult = {
            conversationsScanned: conversationIds.length,
            conversationsChanged: 0,
            prunedNodeCount: 0,
            corruptConversations: [],
            skippedConversations: [],
        };
        // BCP-06: 记录每个会话本次物理移除的节点 id（清理存档引用归零用；图侧绑定随节点消失）
        const prunedNodeIdsByConversation = new Map<string, string[]>();
        for (const conversationId of conversationIds) {
            const outcome = await this.conversationManager.runExclusive(conversationId, async () => {
                // BS-4：会话已删除/不存在 → 跳过（迟到清理不重建 sidecar）
                const metadata = await this.conversationManager.getMetadata(conversationId);
                if (!metadata) {
                    return { corrupt: false, skipped: true, changed: false, pruned: 0 };
                }
                const loaded = await this.repository.load(conversationId);
                if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT' || !loaded.graph) {
                    return { corrupt: loaded.errorCode === 'BRANCH_STORAGE_CORRUPT', skipped: false, changed: false, pruned: 0 };
                }
                const validation = validate(loaded.graph);
                if (!validation.valid) {
                    return { corrupt: true, skipped: false, changed: false, pruned: 0 };
                }
                try {
                    activePath(loaded.graph);
                } catch {
                    return { corrupt: true, skipped: false, changed: false, pruned: 0 };
                }
                const { graph: next, prunedNodeIds } = pruneDeletedNodes(loaded.graph, {
                    now: options.now,
                    retentionDays,
                });
                if (prunedNodeIds.length === 0) {
                    return { corrupt: false, skipped: false, changed: false, pruned: 0 };
                }
                await this.validateAndSave(conversationId, next);
                prunedNodeIdsByConversation.set(conversationId, prunedNodeIds);
                return { corrupt: false, skipped: false, changed: true, pruned: prunedNodeIds.length };
            });
            if (outcome.corrupt) {
                result.corruptConversations.push(conversationId);
            }
            if (outcome.skipped) {
                result.skippedConversations.push(conversationId);
            }
            if (outcome.changed) {
                result.conversationsChanged += 1;
                result.prunedNodeCount += outcome.pruned;
            }
            // BCP-06：本会话物理清理完成后（会话写锁已释放），引用归零存档清理（同步；失败仅 warn）
            const removedNodeIds = prunedNodeIdsByConversation.get(conversationId);
            if (removedNodeIds && removedNodeIds.length > 0) {
                await this.cleanupZeroReferencedCheckpoints(conversationId, removedNodeIds);
            }
        }
        return result;
    }

    /**
     * TREE-09：读取分支保留期配置（持久化 branches.config.json；缺失/损坏返回默认 30 天）。
     */
    async getBranchRetentionConfig(): Promise<BranchRetentionConfig> {
        const persisted = await this.repository.loadBranchRetentionConfig();
        return { retentionDays: persisted.retentionDays ?? this.retentionDays };
    }

    /**
     * TREE-09：更新分支保留期配置（持久化 branches.config.json；非法值抛 INVALID_BRANCH_RELATION）。
     * 0 = 不自动清理（永不过期）。
     */
    async updateBranchRetentionConfig(retentionDays: number): Promise<BranchRetentionConfig> {
        if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays)
            || !Number.isInteger(retentionDays) || retentionDays < 0) {
            throw new BranchError(
                'INVALID_BRANCH_RELATION',
                `invalid retentionDays: ${String(retentionDays)} (must be a non-negative integer, 0 = never auto-prune)`
            );
        }
        const config: BranchRetentionConfig = { retentionDays };
        await this.repository.saveBranchRetentionConfig(config);
        return config;
    }

    // ==================== BR-05：主历史 = 活跃路径 调试校验 ====================

    /**
     * BR-05 调试校验：主历史消息 id 链（不含 functionResponse，决策 8）== 图活跃路径。
     * 无分支图时：主历史为空 → valid；主历史非空 → 报「图缺失」。
     * 同时报告图结构校验（validate）问题。
     *
     * 用途：BranchService 的调试/完整性检查入口（MIG-05 完整性工具的前身），
     * 不强制重写主历史（BR-05 本阶段只建立不变量文档与校验函数）。
     */
    async validateActivePathMatchesHistory(conversationId: string): Promise<BranchPathConsistencyResult> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            const loaded = await this.repository.load(conversationId);
            const history = await this.conversationManager.getMessagesRaw(conversationId);
            const historyIds = history
                .filter(message => !isFunctionResponseMessage(message))
                .map(message => message.id ?? '');

            if (!loaded.graph) {
                const issues = historyIds.length > 0
                    ? ['branch graph is missing while main history has messages (first branch op will build baseline)']
                    : [];
                return {
                    valid: issues.length === 0,
                    issues,
                    graphMissing: true,
                    historyIds,
                    activePathIds: [],
                };
            }

            const issues: string[] = [];
            const graphValidation = validate(loaded.graph);
            if (!graphValidation.valid) {
                issues.push(...graphValidation.issues.map(issue => `graph[${issue.code}]: ${issue.message}`));
            }

            let graphPathIds: string[];
            try {
                graphPathIds = activePath(loaded.graph);
            } catch (error) {
                graphPathIds = [];
                issues.push(`activePath resolution failed: ${(error as Error)?.message ?? String(error)}`);
            }

            if (historyIds.length !== graphPathIds.length) {
                issues.push(`length mismatch: main history ${historyIds.length} vs graph active path ${graphPathIds.length}`);
            }
            const commonLength = Math.min(historyIds.length, graphPathIds.length);
            for (let i = 0; i < commonLength; i++) {
                if (historyIds[i] !== graphPathIds[i]) {
                    issues.push(`id mismatch at position ${i}: main history ${historyIds[i] ?? '(missing)'} vs graph ${graphPathIds[i] ?? '(missing)'}`);
                }
            }

            return {
                valid: issues.length === 0,
                issues,
                graphMissing: false,
                historyIds,
                activePathIds: graphPathIds,
            };
        });
    }

    // ==================== BR-09：跨对话「复制为新对话」建模 ====================

    /**
     * BR-09：为新创建的分支对话初始化 BranchGraph。
     * - 把目标对话主历史全量导入为节点（kind='imported'，functionResponse 合并进模型节点）；
     * - 图元数据记录 exportedFrom: { conversationId: 源头对话, nodeId: 来源节点 }。
     * 由 ConversationManager.createBranchConversation 接线调用。
     */
    async initializeBranchConversation(
        targetConversationId: string,
        sourceConversationId: string,
        sourceNodeId: string
    ): Promise<void> {
        await this.conversationManager.ensureHistoryNodeIds(targetConversationId);
        await this.conversationManager.runExclusive(targetConversationId, async () => {
            const history = await this.conversationManager.getMessagesRaw(targetConversationId);
            const graph = importLinearHistory(history);
            const withMeta: ConversationBranchGraph = {
                ...graph,
                exportedFrom: { conversationId: sourceConversationId, nodeId: sourceNodeId },
            };
            await this.validateAndSave(targetConversationId, withMeta);
        });
    }

    /**
     * BR-09：在源头对话的分支图中记录导出关系（exportedRefs 列表，最小实现——不新增
     * 'exported' 标注节点，避免制造无消息内容的假节点干扰活跃路径/校验）。
     * 源头对话尚无分支图时先以主历史建线性基线图。
     */
    async recordExport(
        sourceConversationId: string,
        targetConversationId: string,
        nodeId: string
    ): Promise<void> {
        await this.conversationManager.ensureHistoryNodeIds(sourceConversationId);
        await this.conversationManager.runExclusive(sourceConversationId, async () => {
            const graph = await this.loadGraphForWrite(sourceConversationId);
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
            await this.validateAndSave(sourceConversationId, next);
        });
    }

    // ==================== BS-2：主历史追加 → 分支图（方法级，调用点后续接线） ====================

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
    async appendHistoryToGraph(conversationId: string, newMessages: ReadonlyArray<Content>): Promise<boolean> {
        if (newMessages.length === 0) {
            return false;
        }
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            await this.assertConversationWritable(conversationId);
            const loaded = await this.repository.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is corrupt for ${conversationId}; refusing to append (${loaded.errorMessage ?? 'unknown error'})`
                );
            }
            if (!loaded.graph) {
                // 线性对话未建图：不强制建（图只在首次分支/导入时建立）
                return false;
            }
            // M-2：语义损坏图不追加（与写路径拒绝覆盖一致）
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is semantically corrupt for ${conversationId}; refusing to append (${validation.issues.map(i => i.message).join('; ')})`
                );
            }

            let graph = loaded.graph;
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
                };
                graph = insertNode(graph, node, { setActive: true, updateTail: true });
                cursor = id;
                changed = true;
            }
            if (!changed) {
                return false; // 全部消息被丢弃（异常输入），图未变化则不落盘
            }
            await this.validateAndSave(conversationId, graph);
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
     */
    async syncGraphAfterHistoryDelete(
        conversationId: string,
        deletedFromMessageId: string | null,
        options: { deletedAt?: number; lastKeptMessageId?: string | null } = {}
    ): Promise<BranchHistoryDeleteSyncResult> {
        const empty: BranchHistoryDeleteSyncResult = {
            graphUpdated: false,
            deletedNodeIds: [],
            resetToEmpty: false,
            activeTailAdjusted: false,
        };
        if (!deletedFromMessageId) {
            // 无锚点（历史消息缺 id 的防御路径）：不做任何图变更（不臆测删除范围）
            return empty;
        }
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            await this.assertConversationWritable(conversationId);
            const loaded = await this.repository.load(conversationId);
            if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is corrupt for ${conversationId}; refusing to sync delete (${loaded.errorMessage ?? 'unknown error'})`
                );
            }
            if (!loaded.graph) {
                // 线性对话未建图：删除不同步（主历史为唯一真源，不强制建图）
                return empty;
            }
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is semantically corrupt for ${conversationId}; refusing to sync delete (${validation.issues.map(i => i.message).join('; ')})`
                );
            }
            const graph = loaded.graph;
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
            await this.validateAndSave(conversationId, outcome.graph);
            return {
                graphUpdated: true,
                deletedNodeIds: outcome.deletedNodeIds,
                resetToEmpty: outcome.resetToEmpty,
                activeTailAdjusted: outcome.activeTailAdjusted,
            };
        });
    }
    // ==================== 内部工具 ====================

    /**
     * TREE-02（决策 4）：每父节点候选数量上限校验（不含软删除节点）。
     * 超限抛 BRANCH_OPERATION_CONFLICT，提示用户清理，不自动删除。
     */
    private assertCandidateLimit(graph: ConversationBranchGraph, parentNodeId: string): void {
        const children = (childrenIndex(graph).get(parentNodeId) ?? [])
            .filter(childId => !graph.nodes[childId]?.deleted);
        if (children.length >= MAX_CANDIDATES_PER_PARENT) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `candidate limit reached: parent ${parentNodeId} already has ${children.length} `
                    + `candidates (max ${MAX_CANDIDATES_PER_PARENT}); please clean up old candidates first`
            );
        }
    }

    /**
     * BS-3：候选创建的父节点必须在当前活跃路径上。缺失 → NODE_NOT_FOUND；
     * 存在但不在活跃路径（非活跃分支上的节点）→ BRANCH_OPERATION_CONFLICT
     * （与 deleteBranchCandidate 的活跃路径冲突语义一致，拒绝从非活跃分支再分支）。
     */
    private assertParentOnActivePath(graph: ConversationBranchGraph, parentNodeId: string): void {
        if (!graph.nodes[parentNodeId]) {
            throw new BranchError('NODE_NOT_FOUND', `parent node not found: ${parentNodeId}`);
        }
        if (!activePath(graph).includes(parentNodeId)) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `parent node ${parentNodeId} is not on the active path; cannot create a candidate under an inactive branch`
            );
        }
    }

    /**
     * BS-4：写路径入口的「会话存在性」检查。ConversationManager 的 deletedConversationIds
     * 为私有集合（且会随上限淘汰），BranchService 通过 getMetadata() === null 判定
     * 「会话不存在（从未创建或已被删除）」，在会话写锁内拒绝分支图写入——防止删除后
     * 迟到的写重建 sidecar（与 ConversationManager 的 append/mutate 短路同一目标）。
     * 说明：deleteConversationBranch（级联清理路径，删除进行中正是其调用时机）与
     * initializeBranchConversation（目标对话刚创建）不经过此检查。
     */
    private async assertConversationWritable(conversationId: string): Promise<void> {
        const metadata = await this.conversationManager.getMetadata(conversationId);
        if (!metadata) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `conversation ${conversationId} does not exist or has been deleted; refusing to write branch graph`
            );
        }
    }

    /**
     * TREE-01：解析 reroll 目标节点。显式传入时校验节点存在且在当前活跃路径上；
     * 省略时取活跃路径上最后一条助手消息（前端「重新生成」默认行为）。
     */
    private resolveRerollTarget(graph: ConversationBranchGraph, assistantNodeId?: string): string {
        if (assistantNodeId !== undefined) {
            if (!graph.nodes[assistantNodeId]) {
                throw new BranchError('NODE_NOT_FOUND', `node not found: ${assistantNodeId}`);
            }
            const path = activePath(graph);
            if (!path.includes(assistantNodeId)) {
                throw new BranchError(
                    'INVALID_BRANCH_RELATION',
                    `node ${assistantNodeId} is not on the active path; cannot reroll it`
                );
            }
            return assistantNodeId;
        }
        const path = activePath(graph);
        for (let i = path.length - 1; i >= 0; i -= 1) {
            if (graph.nodes[path[i]]!.role === 'model') {
                return path[i];
            }
        }
        throw new BranchError(
            'INVALID_BRANCH_RELATION',
            'no assistant node found on the active path to reroll'
        );
    }

    /** 构建候选节点（kind 由 pure 函数 rerollCandidate/editCandidate 覆盖） */
    private buildCandidateNode(
        input: BranchCandidateInput,
        parentNodeId: string,
        defaultRole: 'user' | 'model' | 'system'
    ): ConversationBranchNode {
        const now = Date.now();
        return {
            id: randomUUID(),
            parentId: parentNodeId,
            role: input.role ?? defaultRole,
            parts: JSON.parse(JSON.stringify(input.parts ?? [])),
            kind: 'normal',
            createdAt: input.createdAt ?? now,
            timestamp: input.createdAt ?? now,
            modelVersion: input.modelVersion,
            usageMetadata: input.usageMetadata,
        };
    }

    /**
     * 分支图变更通用执行器（BR-07）：
     * 1. 锁外先确保主历史带稳定 id（ensureHistoryNodeIds 自身在会话写锁内完成，避免重入死锁）；
     * 2. 进入会话写锁：读 sidecar → 无图/损坏处理 → mutator 变更 → validate → 原子保存。
     *
     * 无图：以主历史建线性基线图（首次分支惰性建图，MIG-01）；
     * 损坏：抛 BRANCH_STORAGE_CORRUPT（不静默覆盖，读取侧已降级线性模式）。
     */
    private async mutateGraph<T>(
        conversationId: string,
        mutator: (graph: ConversationBranchGraph) => { next: ConversationBranchGraph; result: T }
    ): Promise<T> {
        await this.conversationManager.ensureHistoryNodeIds(conversationId);
        return await this.conversationManager.runExclusive(conversationId, async () => {
            const graph = await this.loadGraphForWrite(conversationId);
            const { next, result } = mutator(graph);
            // R8c-P6：幂等路径（mutator 原样返回读到的图，如重复软删/恢复/清理不存在的节点）
            // 图未发生变化，跳过 validateAndSave——避免无意义的 sidecar 重写。
            if (next !== graph) {
                await this.validateAndSave(conversationId, next);
            }
            return result;
        });
    }

    /** 读图用于写入：无图 → 主历史建线性基线；损坏（解析或语义）→ 抛 BRANCH_STORAGE_CORRUPT（不覆盖） */
    private async loadGraphForWrite(conversationId: string): Promise<ConversationBranchGraph> {
        // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）。检查在会话写锁内进行，
        // 与 deleteConversation 的锁序一致：delete 先入已删除集合 → 锁内删文件 → 释放锁，
        // 迟到写入锁后在此被拒，不会与删除交错产生幽灵 sidecar。
        await this.assertConversationWritable(conversationId);
        const loaded = await this.repository.load(conversationId);
        if (loaded.errorCode === 'BRANCH_STORAGE_CORRUPT') {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `branches.json is corrupt for ${conversationId}; refusing to overwrite (${loaded.errorMessage ?? 'unknown error'})`
            );
        }
        if (loaded.graph) {
            // M-2：读取侧语义校验——语义损坏同样拒绝覆盖（与解析损坏同策略：
            // 不静默覆盖可能可恢复的数据，MIG-05 完整性工具负责修复）
            const validation = validate(loaded.graph);
            if (!validation.valid) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json is semantically corrupt for ${conversationId}; refusing to overwrite (${validation.issues.map(i => i.message).join('; ')})`
                );
            }
            try {
                activePath(loaded.graph);
            } catch (error) {
                throw new BranchError(
                    'BRANCH_STORAGE_CORRUPT',
                    `branches.json active path is unresolvable for ${conversationId}; refusing to overwrite (${(error as Error)?.message ?? String(error)})`
                );
            }
            return loaded.graph;
        }
        // 无 sidecar：以主历史建线性基线图（主历史是活跃路径的唯一真源）
        const history = await this.conversationManager.getMessagesRaw(conversationId);
        return importLinearHistory(history);
    }

    /** validate 通过后原子保存；无效抛 BRANCH_STORAGE_CORRUPT */
    private async validateAndSave(conversationId: string, graph: ConversationBranchGraph): Promise<void> {
        const validation = validate(graph);
        if (!validation.valid) {
            throw new BranchError(
                'BRANCH_STORAGE_CORRUPT',
                `refusing to persist invalid branch graph for ${conversationId}: ${validation.issues.map(i => i.message).join('; ')}`
            );
        }
        await this.repository.save(conversationId, graph);
    }

    /** childrenIndex 便捷透出（供外部/测试检查候选顺序） */
    getChildrenIndex(graph: ConversationBranchGraph): Map<string, string[]> {
        return childrenIndex(graph);
    }
}
