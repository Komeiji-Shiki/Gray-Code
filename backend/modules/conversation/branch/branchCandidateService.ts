/**
 * 候选生命周期 / 分支切换 / 工作区存档绑定（BR-07 + TREE-01/03/04/09 + BCP-02，拆分自 BranchService.ts）。
 *
 * createRerollCandidate / editCandidate / startReroll / finishReroll / switchBranchCandidate /
 * deleteBranchCandidate / restoreBranchCandidate / renameBranchCandidate / purgeBranchCandidate /
 * updateActiveNodeParts / updateNodeMetadata / abortEmptyCandidateSetup / bindWorkspaceCheckpoint
 * 是「分支候选与分支流」职责簇。抽到本文件后 BranchService 在同名 public 方法中委托，
 * 方法签名与行为保持不变。跨职责调用（ensureMainHistoryRepresentedInGraph /
 * syncMainHistoryAfterStructuralMutation / getBranchGraph）通过各自拆分后的模块函数完成。
 */

import { Logger } from '../../../core/logger';
import type { ContentPart } from '../types';
import {
    activePath,
    editCandidate as editCandidateGraph,
    extractBranchContentMetadata,
    insertNode,
    isFunctionResponseMessage,
    removeSubtree,
    renameBranchLabel,
    renameNode,
    rerollCandidate,
    restoreNode,
    softDeleteNode,
    switchActivePath,
    updateNodeContent,
    upsertCandidateSummary,
    validate,
} from './BranchGraph';
import {
    assertCandidateLimit,
    assertConversationWritable,
    assertNoMainHistoryRepresentationGaps,
    assertParentOnActivePath,
    buildCandidateNode,
    buildCandidateSummary,
    cleanupZeroReferencedCheckpoints,
    loadGraphForWrite,
    mutateGraph,
    resolveRerollTarget,
    validateAndSave,
    type BranchServiceCoreContext,
} from './branchServiceCore';
import { getBranchGraph } from './branchStoreService';
import {
    ensureMainHistoryRepresentedInGraph,
    syncMainHistoryAfterStructuralMutation,
} from './branchReconcileService';
import type {
    BranchCandidateCreateResult,
    BranchCandidateInput,
    BranchDeleteResult,
    BranchPurgeResult,
    BranchSetupAbortResult,
    BranchSwitchResult,
    RerollFinishResult,
    RerollStartResult,
} from './branchServiceTypes';
import { BranchError } from './types';
import type {
    BranchContentMetadata,
    ConversationBranchGraph,
    ConversationBranchNode,
    WorkspaceState,
} from './types';

const log = Logger.get('BranchService');

/**
 * 创建 reroll 候选（TREE-01 底座）：同一父节点下新增候选并切换 activeChildId，旧候选保留。
 * 无分支图时先以主历史建线性基线图（MIG-01 惰性建图）。
 */
export async function createRerollCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    parentNodeId: string,
    input: BranchCandidateInput
): Promise<BranchCandidateCreateResult> {
    return await mutateGraph(ctx, conversationId, graph => {
        // BS-3：父节点必须在当前活跃路径上（不能从非活跃分支节点再分支）
        assertParentOnActivePath(graph, parentNodeId);
        // TREE-02（决策 4）：每父节点候选上限，超限明确报错（提示清理，不自动删）
        assertCandidateLimit(graph, parentNodeId);
        const node = buildCandidateNode(input, parentNodeId, 'model');
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
 * 原地更新活跃路径上指定节点的 parts（保持分支的编辑，TREE-03 keep 模式底座）。
 *
 * 与 editCandidate 的区别：不创建新候选、不切换分支——直接改写节点内容并同步候选摘要，
 * 保证分支图与主历史一致（BR-01：节点 id == Content.id；之后切回该分支时展示编辑后的文本）。
 *
 * @param nodeId 目标节点（须在当前活跃路径上）
 * @param parts 新的消息内容
 */
export async function updateActiveNodeParts(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string,
    parts: ContentPart[]
): Promise<{ nodeId: string }> {
    return await mutateGraph(ctx, conversationId, graph => {
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
 * 原地更新指定节点的 contentMetadata（保留分支的编辑的往返元数据）。
 *
 * 用途：edit 流程的 branch 模式——editCandidate 新建用户节点时拿不到主历史侧元数据
 * （isUserInput / tokenCountByChannel 等），待 addContent 落盘后按持久化内容补写；
 * 不补写则切分支重写主历史时这些字段丢失（动态提示词插入点、前端用户图标、裁剪统计口径）。
 */
export async function updateNodeMetadata(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string,
    contentMetadata: BranchContentMetadata | undefined
): Promise<void> {
    return await mutateGraph(ctx, conversationId, graph => {
        const node = graph.nodes[nodeId];
        if (!node) {
            throw new BranchError('NODE_NOT_FOUND', `node not found: ${nodeId}`);
        }
        const next = updateNodeContent(graph, nodeId, { contentMetadata });
        return { next, result: undefined };
    });
}

/**
 * 创建编辑分支候选（TREE-03 底座）：在旧用户节点的父节点下新增 edit 候选并切换 activeChildId，
 * 旧子树完整保留。无分支图时同样先建线性基线图。
 */
export async function editCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    parentNodeId: string,
    input: BranchCandidateInput
): Promise<BranchCandidateCreateResult> {
    return await mutateGraph(ctx, conversationId, graph => {
        // BS-3：父节点必须在当前活跃路径上（不能从非活跃分支节点再分支）
        assertParentOnActivePath(graph, parentNodeId);
        // TREE-02（决策 4）：编辑候选同样计入每父节点候选上限
        assertCandidateLimit(graph, parentNodeId);
        const node = buildCandidateNode(input, parentNodeId, 'user');
        const next = editCandidateGraph(graph, parentNodeId, node, { updateTail: true });
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
export async function startReroll(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    assistantNodeId?: string
): Promise<RerollStartResult> {
    // 破坏性截断前先把当前主历史完整归档进图；旧 sidecar 落后时备份并修复。
    await ensureMainHistoryRepresentedInGraph(ctx, conversationId);
    // 1. 图状态变更（会话写锁内）：验证 + 创建候选 + 激活 + 摘要
    const created = await mutateGraph(ctx, conversationId, graph => {
        const targetId = resolveRerollTarget(graph, assistantNodeId);
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
        assertCandidateLimit(graph, parentNodeId);
        const node = buildCandidateNode({ parts: [] }, parentNodeId, 'model');
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
    try {
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        const targetIndex = history.findIndex(message => message.id === created.previousNodeId);
        if (targetIndex < 0) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `reroll target ${created.previousNodeId} is not present in main history`
            );
        }
        await ctx.conversationManager.deleteMessagesInRange(
            conversationId,
            targetIndex,
            history.length - 1
        );
        return { ...created, historyLengthAfterTruncate: targetIndex };
    } catch (error) {
        // 图候选先落盘、主历史后截断，两处无法共用同一把仓储锁。截断前后任一异常都要
        // 移除本次空占位，否则调用方拿不到 candidateNodeId，finishReroll 也无从收敛。
        // 若截断已经成功（极少数“提交后抛错”），旧回答已不在主历史，活跃尾回退父节点；
        // 否则恢复旧回答路径。回滚失败只记录，不覆盖原始异常。
        let fallbackNodeId = created.previousNodeId;
        try {
            const currentHistory = await ctx.conversationManager.getMessagesRaw(conversationId);
            if (!currentHistory.some(message => message.id === created.previousNodeId)) {
                fallbackNodeId = created.parentNodeId;
            }
        } catch {
            // 首次 getMessagesRaw 失败意味着尚未尝试截断，恢复旧回答是最保守选择。
        }
        try {
            await abortEmptyCandidateSetup(ctx, conversationId, {
                setupRootNodeId: created.candidateNodeId,
                emptyCandidateNodeId: created.candidateNodeId,
                fallbackNodeId,
            });
        } catch (rollbackError) {
            log.error('branch_reroll_setup_rollback_failed', {
                conversationId,
                candidateNodeId: created.candidateNodeId,
                error: (rollbackError as Error)?.message ?? String(rollbackError),
            });
        }
        throw error;
    }
}

/**
 * 分支流尚未开始写模型输出时，回滚本次启动阶段创建的临时子树。
 *
 * 这是故障恢复入口，不是通用删除 API。为避免误删真实内容，只接受两种精确形态：
 * 1. 单个空 reroll 模型占位；
 * 2. 一个 edit 用户节点及其唯一子节点（空 reroll 模型占位）。
 * 两种形态都必须仍是活跃尾，且 fallback 不得位于待删子树内。
 */
export async function abortEmptyCandidateSetup(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    input: {
        setupRootNodeId: string;
        emptyCandidateNodeId: string;
        fallbackNodeId: string;
    }
): Promise<BranchSetupAbortResult> {
    return await mutateGraph<BranchSetupAbortResult>(ctx, conversationId, graph => {
        const root = graph.nodes[input.setupRootNodeId];
        const candidate = graph.nodes[input.emptyCandidateNodeId];
        const fallback = graph.nodes[input.fallbackNodeId];
        if (!root || !candidate || !fallback) {
            throw new BranchError(
                'NODE_NOT_FOUND',
                'cannot abort branch setup: setup root, empty candidate, or fallback node is missing'
            );
        }
        const subtreeIds = new Set<string>();
        const stack = [root.id];
        while (stack.length > 0) {
            const nodeId = stack.pop()!;
            if (subtreeIds.has(nodeId)) {
                continue;
            }
            subtreeIds.add(nodeId);
            for (const node of Object.values(graph.nodes)) {
                if (node.parentId === nodeId) {
                    stack.push(node.id);
                }
            }
        }
        const singleReroll = root.id === candidate.id
            && root.kind === 'reroll'
            && root.role === 'model'
            && subtreeIds.size === 1;
        const editWithEmptyModel = root.id !== candidate.id
            && root.kind === 'edit'
            && root.role === 'user'
            && candidate.parentId === root.id
            && candidate.kind === 'reroll'
            && candidate.role === 'model'
            && subtreeIds.size === 2;
        if ((!singleReroll && !editWithEmptyModel)
            || candidate.parts.length !== 0
            || graph.activeTailNodeId !== candidate.id
            || subtreeIds.has(fallback.id)) {
            throw new BranchError(
                'BRANCH_OPERATION_CONFLICT',
                `refusing to abort non-empty, non-active, or unexpected branch setup ${root.id}`
            );
        }

        const removed = removeSubtree(graph, root.id);
        const next = switchActivePath(removed.graph, fallback.id);
        return {
            next,
            result: {
                removedNodeIds: removed.prunedNodeIds,
                activeTailNodeId: next.activeTailNodeId,
                activePathIds: activePath(next),
            },
        };
    });
}

/**
 * 完成 reroll（TREE-01）：把工具循环写入主历史的流式结果回填进新候选节点（含续接节点），
 * 并更新候选摘要。失败时也会调用：已有部分内容则保留供切回查看；完全无输出时移除空占位，
 * 并把活跃尾回退到父节点，避免后续普通消息被永久判定为“仍在流式窗口”而停止同步。
 *
 * 回填规则（与 importLinearHistory 一致，决策 8）：
 * - 主历史父节点之后第一条 model 消息 → 候选节点内容写入；若其 id 与候选占位节点 id
 *   不同（工具循环生成新 UUID），候选节点重命名对齐（BR-01 同源）；
 * - 后续 model 消息 → 在上一节点下插入 kind='continue' 续接节点并激活；
 * - functionResponse 消息 → parts 并入前一个模型节点（不独立成节点）。
 * - 后台回执/总结等其它角色消息 → 不冒充模型候选，候选结束后按完整主历史重建路径。
 */
export async function finishReroll(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    candidateNodeId: string
): Promise<RerollFinishResult> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    let requiresStructuralSync = false;
    const result = await mutateGraph<RerollFinishResult>(ctx, conversationId, async graph => {
        // 历史快照在会话写锁内读取（mutator 在 runExclusive 回调内执行）：与图变更原子化，
        // 避免锁外快照与锁内图状态不一致（getMessagesRaw 只读、不取锁，无重入风险）。
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
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
            if (message.role !== 'model') {
                // SubAgent 后台回执、总结等结构消息可能在分支流期间并发追加。它们不是本次
                // 模型候选，绝不能因“位于 parent 之后”就被改写成 model 节点。先跳过，候选
                // 收敛后再按完整主历史 rebase，把这些消息按真实角色/顺序补进活跃路径。
                requiresStructuralSync = true;
                cursorNodeId = null;
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
                    contentMetadata: extractBranchContentMetadata(message),
                    timestamp: message.timestamp,
                });
                firstMessageId = targetId;
                cursorNodeId = targetId;
                synced += 1;
            } else {
                // 后续模型消息 → 续接节点（kind='continue'，激活并更新尾指针）
                if (cursorNodeId === null) {
                    // 链已被 SubAgent 回执/总结等非 model 消息打断（requiresStructuralSync 已置位）：
                    // 此时续接父节点未知，若用 null 挂载会让 insertNode 误判为新根。跳过本次候选回填，
                    // 候选收敛后按完整主历史 rebase，回执与后续模型消息按真实顺序重建进活跃路径。
                    continue;
                }
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
                    contentMetadata: extractBranchContentMetadata(message),
                };
                next = insertNode(next, continuation, { setActive: true, updateTail: true });
                cursorNodeId = id;
                synced += 1;
            }
        }

        if (synced === 0) {
            // 空占位没有任何可恢复内容。它只在流式窗口内有意义；若作为活跃尾持久保留，
            // ConversationManager.appendContents 会把之后的每次普通追加都误判为仍在 reroll/edit
            // 流式窗口并跳过图同步，最终让 branches.json 永久冻结。
            //
            // 物理移除前严格限定为“初始空叶子且仍是活跃尾”，防止并发异常下误删真实子树。
            const currentCandidate = next.nodes[candidateNodeId];
            const hasChildren = Object.values(next.nodes).some(node => node.parentId === candidateNodeId);
            if (!currentCandidate
                || currentCandidate.parts.length !== 0
                || hasChildren
                || next.activeTailNodeId !== candidateNodeId
                || next.nodes[parentNodeId]?.activeChildId !== candidateNodeId) {
                throw new BranchError(
                    'BRANCH_OPERATION_CONFLICT',
                    `refusing to discard non-leaf or non-active empty candidate ${candidateNodeId}`
                );
            }
            const removed = removeSubtree(next, candidateNodeId).graph;
            // removeNodeSet 内部已用 deriveActiveTail 重算尾指针（空占位删除后活跃尾=父节点），
            // 不再需要调用方手工修补。
            next = removed;
            return {
                next,
                result: {
                    candidateNodeId,
                    parentNodeId,
                    activeTailNodeId: parentNodeId,
                    activePathIds: activePath(next),
                    syncedMessageCount: 0,
                    discardedEmptyCandidate: true,
                },
            };
        }

        // 更新候选摘要（preview 从最终节点内容生成）
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
                discardedEmptyCandidate: false,
            },
        };
    });

    // 自动总结可能在 reroll/edit 的模型请求前发生。总结同步会在空占位活跃期间主动延迟，
    // 因此候选终结后再用主历史收敛一次完整路径，把新总结节点及 isSummarized 元数据补入图。
    if (requiresStructuralSync || ctx.state.deferredStructuralSyncConversationIds.has(conversationId)) {
        try {
            const sync = await syncMainHistoryAfterStructuralMutation(ctx, conversationId, 'branch_finished');
            if (sync.synced) {
                const graph = (await getBranchGraph(ctx, conversationId)).graph;
                if (graph) {
                    result.activeTailNodeId = graph.activeTailNodeId;
                    result.activePathIds = activePath(graph);
                }
            }
        } catch (error) {
            // 候选内容与主历史均已成功落盘，不把补充对账失败伪装成模型生成失败；下次破坏性
            // 分支操作前的 ensureMainHistoryRepresentedInGraph 仍会备份并修复。
            log.warn('branch_finish_structural_sync_failed', {
                conversationId,
                candidateNodeId,
                error: (error as Error)?.message ?? String(error),
            });
        }
    }
    return result;
}

/**
 * 切换候选（TREE-04/06 底座）：把活跃路径切换到目标节点（祖先 activeChildId 沿 parentId 链重指，
 * 尾指针 = 目标子树活跃尾），并持久化。
 *
 * 注意（本阶段边界）：只切换图状态，**不重写主历史**（TREE-06 才执行 replaceContents 全量重写），
 * 因此切换后主历史与图活跃路径会暂时不一致，直到 TREE-06 落地。
 *
 * @param options.recordRewriteExpectation 默认 true：切换后记录「切图 → 重写」预期状态供
 *        rewriteHistoryFromBranchGraph 消费校验。回滚式切换（主历史重写失败后切回旧活跃尾）
 *        传 false——该切换没有对应的重写会消费预期，残留预期会被下一次重写误校验而误拒。
 */
export async function switchBranchCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string,
    options: { recordRewriteExpectation?: boolean } = {}
): Promise<BranchSwitchResult> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        const graph = await loadGraphForWrite(ctx, conversationId);
        const history = await ctx.conversationManager.getMessagesRaw(conversationId);
        // 在修改 activeChildId/activeTailNodeId 之前拒绝未归档历史，避免先切图再回滚的危险窗口。
        assertNoMainHistoryRepresentationGaps(history, graph);
        const next = switchActivePath(graph, nodeId);
        await validateAndSave(ctx, conversationId, next);
        // 记录「切图 → 主历史重写」非原子窗口的预期状态：重写时锁内校验主历史尾 id /
        // 图活跃尾未变化，避免窗口期内并发追加/其它切换让重写基于陈旧快照覆盖并发写入。
        // recordRewriteExpectation=false（回滚式切换：主历史重写失败后切回旧活跃尾）不记录——
        // 该切换没有对应的重写会消费预期，残留预期会被下一次重写误校验（陈旧快照下的尾 id
        // 与当下不符 → 合法切换被误拒，分支切换整体不可用）。
        if (options.recordRewriteExpectation !== false) {
            const mainHistoryTailId = history.length > 0 ? (history[history.length - 1]?.id ?? null) : null;
            ctx.state.pendingRewriteExpectations.set(conversationId, {
                mainHistoryTailId,
                graphActiveTailNodeId: next.activeTailNodeId,
            });
        }
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
export async function deleteBranchCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string
): Promise<BranchDeleteResult> {
    return await mutateGraph(ctx, conversationId, graph => {
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
export async function restoreBranchCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string
): Promise<{ nodeId: string; restored: boolean }> {
    return await mutateGraph<{ nodeId: string; restored: boolean }>(ctx, conversationId, graph => {
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
export async function renameBranchCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string,
    label: string
): Promise<{ nodeId: string; label: string }> {
    return await mutateGraph(ctx, conversationId, graph => {
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
 * TREE-09：彻底删除（硬删）单个候选——物理移除节点及其整棵子树（purgeBranchCandidate）。
 * 仅允许对已软删节点执行（先软删再彻底删；未软删抛 BRANCH_OPERATION_CONFLICT，避免误删）；
 * 节点不存在（已被 prune 清理 / 从未来过）→ R8c-P7 幂等返回 purged:false（不再抛
 * NODE_NOT_FOUND，与注释承诺的幂等语义一致；图未变化不落盘）。
 */
export async function purgeBranchCandidate(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string
): Promise<BranchPurgeResult> {
    // 注：显式泛型（与 restoreBranchCandidate 的 mutateGraph<{...}> 同模式），
    // 使回调两种返回形态（purged:false / purged:true）可被推断为 BranchPurgeResult。
    // BCP-06: 闭包收集被物理移除节点的 workspaceCheckpointId（图侧绑定随节点消失）
    let prunedNodeIds: string[] = [];
    return await mutateGraph<BranchPurgeResult>(ctx, conversationId, graph => {
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
            await cleanupZeroReferencedCheckpoints(ctx.repository, conversationId, prunedNodeIds);
        }
        return result;
    });
}

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
export async function bindWorkspaceCheckpoint(
    ctx: BranchServiceCoreContext,
    conversationId: string,
    nodeId: string,
    checkpointId: string,
    workspaceState: WorkspaceState = 'checkpointed'
): Promise<boolean> {
    await ctx.conversationManager.ensureHistoryNodeIds(conversationId);
    return await ctx.conversationManager.runExclusive(conversationId, async () => {
        // BS-4：已删除会话拒绝写（防删除后迟到写重建 sidecar）
        await assertConversationWritable(ctx, conversationId);
        const loaded = await ctx.repository.load(conversationId);
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
        await validateAndSave(ctx, conversationId, next);
        return true;
    });
}
