/**
 * 树状分支消息处理器（第五阶段 BR-06/07 接口层 + TREE-09 扩展）。
 *
 * 注册（规划第七部分 L1687–1698 分支 API 的最小集）：
 * - conversation.getBranchGraph
 * - conversation.getBranchGraphMeta
 * - conversation.createRerollCandidate
 * - conversation.switchBranchCandidate
 * - conversation.deleteBranchCandidate
 * - conversation.restoreBranchCandidate（TREE-09：恢复软删候选）
 * - conversation.renameBranchCandidate（TREE-09：重命名分支标签）
 * - conversation.purgeBranchCandidate（TREE-09：彻底删除）
 * - conversation.getDeletedBranchCount（TREE-09：软删分支数量）
 * - conversation.pruneDeletedBranches（TREE-09：过期软删物理清理）
 * - conversation.getBranchRetentionConfig / updateBranchRetentionConfig（TREE-09：保留期配置）
 *
 * 错误码使用 backend/modules/conversation/branch/types.ts 的 BranchErrorCode。
 *
 * BranchService 懒初始化（模块级单例，与 DiffStorageManager 同模式）：
 * 以 StoragePathManager 的有效数据路径为 BranchGraphRepository 的 baseDir，
 * 与 FileSystemStorageAdapter 使用同一存储布局（conversations/{id}/branches.json）。
 */

import {
    BranchGraphRepository,
    BranchService,
    getGlobalBranchService,
    isFunctionResponseMessage,
    setGlobalBranchService,
} from '../../backend/modules/conversation/branch';
import {
    BranchError,
    ConversationBranchGraph,
    ConversationBranchNode,
} from '../../backend/modules/conversation/branch/types';
import type { ContentPart } from '../../backend/modules/conversation/types';
import { CheckpointService } from '../../backend/modules/api/chat/services/CheckpointService';
import { DEFAULT_CHECKPOINT_CONFIG } from '../../backend/modules/settings/checkpointTypes';
import {
    cancelStreamAndSubAgents,
    detectDirtyFilesInWorkspace,
} from '../utils/WorkspaceRestoreGuard';
import type { StreamAbortManager } from '../stream/StreamAbortManager';
import type { HandlerContext, MessageHandler } from '../types';

// ==================== BCP-04：写工具判据（决策 1） ====================

/**
 * 写工具名集合（BCP-04 判据来源）：默认 checkpoint 配置 beforeTools ∪ afterTools。
 * 与 ToolExecutionService 的「真实工具名 ∩ 配置集合」判定同源，保证
 * 「该分支是否可能产生存档」与「是否命中写工具」口径一致（配置缺失时回退默认列表）。
 * 注意：运行时 checkpoint 配置（settingsHandler.getCheckpointConfig）可能覆盖默认值，
 * 此处以默认列表为准（handler 读配置成本高且本判据只用于提示，见研究报告 R6）。
 */
const WRITE_TOOL_NAMES = new Set<string>([
    ...(DEFAULT_CHECKPOINT_CONFIG.beforeTools ?? []),
    ...(DEFAULT_CHECKPOINT_CONFIG.afterTools ?? []),
]);

/**
 * 从节点 parts 提取工具名（与 BranchService.buildCandidateSummary 的提取口径一致）。
 * 抽公共纯函数（如 collectToolNamesFromParts 入 branch/BranchGraph）留待 BCP-02 批次
 * 完成后再做，本批次在 handler 层实现（BranchService 只读，禁止写）。
 */
function collectToolNamesFromParts(parts: ContentPart[] | undefined): string[] {
    return (parts ?? [])
        .map(part => part.functionCall?.name)
        .filter((name): name is string => typeof name === 'string');
}

/** 沿 parentId 链收集 root→node 路径上全部节点的工具名（防御环 / 悬空指针） */
function collectPathToolNames(
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
 * 仅改写内存中的响应对象（repository.load 的返回），不落盘。
 */
function enrichGraphWorkspaceInfo(graph: ConversationBranchGraph): void {
    for (const node of Object.values(graph.nodes)) {
        if (!node) {
            continue;
        }
        const enriched = node as ConversationBranchNode & {
            hasWorkspaceState?: boolean;
            wroteToWorkspace?: boolean;
        };
        enriched.hasWorkspaceState =
            typeof node.workspaceCheckpointId === 'string' && node.workspaceCheckpointId.length > 0;
        enriched.wroteToWorkspace = collectPathToolNames(graph, node.id).some(name => WRITE_TOOL_NAMES.has(name));
    }
}

/** TREE-13：流式生成期间变更类分支操作被拒时的固定文案 */
export const BRANCH_BUSY_STREAMING_MESSAGE = '会话正在流式生成中，请等待完成后再操作';

/**
 * TREE-13：判断会话是否处于流式生成中。
 *
 * ctx.streamAbortControllers 类型声明为 Map<string, AbortController>，实际注入的是
 * StreamAbortManager 实例（ChatViewProvider L580/803：
 * `streamAbortControllers: this.messageRouter.getAbortManager() as any`）。
 * 优先走 StreamAbortManager.isActive（研究文档 TREE-13 行：L111–113 既有语义，
 * 只统计主流请求，summary 请求不拦截）；若注入的是纯 Map，则按「存在 controller」兜底判定。
 */
export function isConversationStreaming(ctx: HandlerContext, conversationId: string): boolean {
    const controllers = ctx.streamAbortControllers;
    if (!controllers) {
        return false;
    }
    const abortManager = controllers as unknown as StreamAbortManager;
    if (typeof abortManager.isActive === 'function') {
        return abortManager.isActive(conversationId);
    }
    return controllers.has(conversationId);
}

/**
 * TREE-13：变更类分支操作的统一流式互斥前置检查。
 * 会话流式生成中返回 true（已发送 BRANCH_BUSY 错误），否则 false（放行）。
 * 互斥与主会话工具循环的关系：BranchService 全部写操作已在
 * conversationManager.runExclusive() 会话写锁内（BR-07，见 BranchService.mutateGraph），
 * handler 层只需此 isActive 前置检查即可。
 */
function rejectIfStreaming(ctx: HandlerContext, conversationId: string, requestId: string): boolean {
    if (isConversationStreaming(ctx, conversationId)) {
        ctx.sendError(requestId, 'BRANCH_BUSY', BRANCH_BUSY_STREAMING_MESSAGE);
        return true;
    }
    return false;
}

/** 懒解析/创建全局 BranchService（首次调用时用 ctx 中的数据路径构造） */
function resolveBranchService(ctx: HandlerContext): BranchService {
    const existing = getGlobalBranchService();
    if (existing) {
        return existing;
    }
    const dataPath = ctx.storagePathManager.getEffectiveDataPath();
    const service = new BranchService(ctx.conversationManager, new BranchGraphRepository(dataPath));
    setGlobalBranchService(service);
    return service;
}

/** 分支错误统一映射：BranchErrorCode 直接作为 IPC 错误码透出 */
function sendBranchError(requestId: string, ctx: HandlerContext, error: unknown): void {
    if (error instanceof BranchError) {
        ctx.sendError(requestId, error.code, error.message);
        return;
    }
    // L-6（R4 复查）：未知异常不再伪装成 BRANCH_OPERATION_CONFLICT（会误导前端以为
    // 是业务冲突而重试），改用 INTERNAL_ERROR 透出原始错误信息，便于定位服务端缺陷。
    ctx.sendError(requestId, 'INTERNAL_ERROR', (error as Error)?.message || 'Branch operation failed');
}

/**
 * 获取分支图（BR-06）。
 * 响应：{ graph, errorCode?, errorMessage? }（graph 为 null 表示无图/线性模式/损坏降级）
 */
export const getBranchGraph: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId } = data || {};
    // L-7（R4 复查）：入参显式类型校验——非 string（数字/对象等）一律按缺失处理
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId is required');
      return;
    }
    const result = await resolveBranchService(ctx).getBranchGraph(conversationId);
    // BCP-04：响应富化——每节点补充 hasWorkspaceState / wroteToWorkspace（决策 1 判据）
    if (result.graph) {
      enrichGraphWorkspaceInfo(result.graph);
    }
    ctx.sendResponse(requestId, result);
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 获取分支图元信息（BR-06）：{ exists, rootNodeId, activeTailNodeId, nodeCount,
 * candidateCount, activePathLength, exportedFrom, exportedRefs }——免整图下发。
 */
export const getBranchGraphMeta: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId } = data || {};
    // L-7（R4 复查）：入参显式类型校验
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId is required');
      return;
    }
    const result = await resolveBranchService(ctx).getBranchGraphMeta(conversationId);
    ctx.sendResponse(requestId, result);
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 创建 reroll 候选（TREE-01 底座）：同一父节点下新增候选并切换 activeChildId，旧候选保留。
 * 入参：{ conversationId, parentNodeId, parts, modelVersion?, usageMetadata?, createdAt? }
 */
export const createRerollCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, parentNodeId, parts, modelVersion, usageMetadata, createdAt } = data || {};
    // L-7（R4 复查）：入参显式类型校验——非 string 的 ID 一律按缺失处理
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof parentNodeId !== 'string' || !parentNodeId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId and parentNodeId are required');
      return;
    }
    // TREE-13：流式生成期间拒绝变更类分支操作（BRANCH_BUSY）
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const result = await resolveBranchService(ctx).createRerollCandidate(conversationId, parentNodeId, {
      parts: Array.isArray(parts) ? parts : [],
      modelVersion,
      usageMetadata,
      createdAt: typeof createdAt === 'number' ? createdAt : undefined
    });
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 切换候选（TREE-04/06 全链编排）：
 *   1. 切图（BranchService.switchBranchCandidate，会话写锁内）——祖先 activeChildId 重指 + 尾指针；
 *   2. 主历史重写（ConversationManager.rewriteHistoryFromBranchGraph，会话写锁内）——
 *      「切换后主历史 = 新活跃路径」的唯一真源操作；
 *   3. 检查点清理（CheckpointService.deleteCheckpointsFromIndex，**会话锁之外**）——
 *      从分歧索引起删除索引错位的旧检查点（与 handleEditAndRetryStream / handleRerollStream 语义一致）。
 *
 * 锁序（M-3 强约束）：存档操作锁只能在会话写锁之外获取（CheckpointService 内部持
 * checkpointOperationLock），因此步骤 3 在步骤 1/2 的会话锁释放后执行；
 * 全局顺序：会话锁（图+历史）→ 存档锁（检查点），无锁序反转。
 *
 * 失败语义：主历史重写失败时尽力回滚图状态（切回切换前的活跃尾：有图取图尾，
 * 线性模式取旧历史尾），再透出原始错误码（BRANCH_STORAGE_CORRUPT / INTERNAL_ERROR 等）；
 * 回滚失败仅告警（图状态仍有效，主历史保持旧值，下次读图/切换自校验兜底）。
 *
 * 响应：{ success, nodeId, activeTailNodeId, activePathIds, rewritten: true,
 *         activePathLength, historyLength, branchGraph }；chat-and-workspace 额外返回
 *         workspaceRestored / restoredSummary。
 * 入参：{ conversationId, nodeId, mode?: 'chat-only' | 'chat-and-workspace'（缺省 chat-only，决策 1）,
 *         confirmedDiscardDirty?: boolean }
 *
 * BCP-03/04/05（本批次扩展）：mode='chat-and-workspace' 时先执行工作区恢复再切换——
 *   ① 安全校验（目标节点 workspaceCheckpointId 存在，不存在 → WORKSPACE_STATE_UNAVAILABLE）；
 *   ② dirty 检测（决策 11：未确认时返回 dirtyFiles，前端先确认，零副作用）；
 *   ③ 取消流 + SubAgent（复用 WorkspaceRestoreGuard.cancelStreamAndSubAgents）；
 *   ④ previewRestore（存档不可恢复 → WORKSPACE_CHECKPOINT_BROKEN）；
 *   ⑤ restoreCheckpoint（失败 → WORKSPACE_STATE_UNAVAILABLE，**不切分支**）；
 *   ⑥ 切换（切图 → 主历史重写 → 锁外检查点清理）。
 * 锁序（M-3 强约束）：恢复（工作区/存档锁）在切图（会话写锁）**之前**完成，锁不嵌套；
 * 存档操作锁仍只在会话写锁之外获取。
 */
export const switchBranchCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, nodeId, mode, confirmedDiscardDirty } = data || {};
    // L-7（R4 复查）：入参显式类型校验
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof nodeId !== 'string' || !nodeId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId and nodeId are required');
      return;
    }
    // TREE-13：流式生成期间拒绝变更类分支操作（BRANCH_BUSY）
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const service = resolveBranchService(ctx);

    // BCP-03/04：切换模式（决策 1：缺省仅切聊天）。chat-and-workspace 先恢复目标分支
    // 绑定的工作区存档，再执行切换——恢复失败**不切分支**（「不静默切换」硬约束）。
    const workspaceMode = mode === 'chat-and-workspace';
    let workspaceRestored = false;
    let restoredSummary: { restored: number; deleted: number; skipped: number } | undefined;

    if (workspaceMode) {
      // 1. 安全校验：目标节点必须绑定工作区存档（BCP-02 字段，只读；不存在 → WORKSPACE_STATE_UNAVAILABLE）
      const graphResult = await service.getBranchGraph(conversationId);
      const targetGraph = graphResult.graph;
      if (!targetGraph) {
        throw new BranchError('WORKSPACE_STATE_UNAVAILABLE',
          '该对话没有分支图，无法联动恢复工作区（仅可切聊天）');
      }
      const targetNode = targetGraph.nodes[nodeId];
      if (!targetNode) {
        throw new BranchError('NODE_NOT_FOUND', `branch node not found: ${nodeId}`);
      }
      const checkpointId = targetNode.workspaceCheckpointId;
      if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
        throw new BranchError('WORKSPACE_STATE_UNAVAILABLE',
          '目标分支没有可用的工作区存档（workspaceCheckpointId 未绑定），无法连工作区一起恢复（仅可切聊天）');
      }

      // 2. dirty 检测（决策 11）：有未保存文件且未确认 → 返回 dirtyFiles，前端先确认；
      //    不取消流、不恢复、不切分支（零副作用，用户取消确认时一切保持原状）。
      if (confirmedDiscardDirty !== true) {
        const dirtyFiles = detectDirtyFilesInWorkspace();
        if (dirtyFiles.length > 0) {
          ctx.sendResponse(requestId, { success: false, mode: 'chat-and-workspace', dirtyFiles });
          return;
        }
      }

      // 3. 取消该对话流式请求 + 关联活跃 SubAgent（复用 CheckpointHandlers 既有前置，BCP-03）
      await cancelStreamAndSubAgents(ctx, conversationId);

      // 4. previewRestore：存档不可恢复（链断裂 / 备份缺失 / 身份不符）→ 明确错误，不切分支
      const preview = await ctx.checkpointManager.previewRestore(conversationId, checkpointId);
      if (!preview.success
          || (preview.failures && preview.failures.length > 0)
          || (preview.missingBackupDirs && preview.missingBackupDirs.length > 0)) {
        const reason = preview.error
          ?? (preview.failures ?? []).map(f => `${f.path}: ${f.reason}`).join('; ')
          ?? (preview.missingBackupDirs ?? []).join(', ')
          ?? 'unknown';
        throw new BranchError('WORKSPACE_CHECKPOINT_BROKEN', `工作区存档无法安全恢复：${reason}`);
      }

      // 5. 恢复（BCP-03：恢复可安全省略——目标存档与当前工作区一致/无变化时跳过实际恢复；
      //    legacy 存档 preview.restored === -1，不命中省略条件，仍执行恢复）
      if (preview.restored !== 0 || preview.deletedIfUnconfirmed !== 0) {
        let restored;
        try {
          restored = await ctx.checkpointManager.restoreCheckpoint(conversationId, checkpointId, {
            // 分支切换恢复不删除快照后新建文件（deleteUntrackedFiles=false，#29 保护）
            deleteUntrackedFiles: false,
          });
        } catch (restoreError) {
          throw new BranchError('WORKSPACE_STATE_UNAVAILABLE',
            `工作区恢复失败：${(restoreError as Error)?.message ?? String(restoreError)}`);
        }
        if (!restored.success) {
          throw new BranchError('WORKSPACE_STATE_UNAVAILABLE',
            `工作区恢复失败：${restored.error ?? 'unknown error'}`);
        }
        workspaceRestored = true;
        restoredSummary = {
          restored: restored.restored,
          deleted: restored.deleted ?? 0,
          skipped: restored.skipped ?? 0,
        };
      } else {
        // 省略实际恢复：工作区与目标存档一致，直接标记恢复完成（无文件变更）
        workspaceRestored = true;
        restoredSummary = { restored: 0, deleted: 0, skipped: preview.skipped ?? 0 };
      }
    }

    // 切换前的活跃尾（主历史重写失败时回滚图状态的锚点）：有图取图活跃尾，
    // 线性模式（无图）取主历史尾部最后一条非 functionResponse 消息（旧路径尾）。
    let previousActiveTail: string | null = null;
    const before = await service.getBranchGraph(conversationId);
    if (before.graph) {
      previousActiveTail = before.graph.activeTailNodeId;
    } else {
      const historyBefore = await ctx.conversationManager.getMessagesRaw(conversationId);
      for (let i = historyBefore.length - 1; i >= 0; i -= 1) {
        if (!isFunctionResponseMessage(historyBefore[i]!)) {
          previousActiveTail = historyBefore[i]!.id ?? null;
          break;
        }
      }
    }

    // 6. 图状态切换（BranchService，会话写锁内）——恢复（工作区锁）已完成，锁不嵌套
    const switched = await service.switchBranchCandidate(conversationId, nodeId);

    // 7. 主历史重写（ConversationManager，会话写锁内）
    let rewrite;
    try {
      rewrite = await ctx.conversationManager.rewriteHistoryFromBranchGraph(conversationId);
    } catch (error) {
      // 失败回滚图状态（尽力而为）：切回切换前的活跃尾，保持图/历史一致
      if (previousActiveTail) {
        try {
          await service.switchBranchCandidate(conversationId, previousActiveTail);
        } catch (rollbackError) {
          console.warn('[BranchHandlers] Failed to roll back branch graph after history rewrite failure:', rollbackError);
        }
      }
      throw error;
    }

    // 8. 检查点清理（会话锁之外）：删除从分歧索引起的旧检查点（索引错位清理）。
    //    CheckpointService.deleteCheckpointsFromIndex 内部持存档操作锁——必须在会话写锁外调用。
    //    divergenceIndex 为 null 表示主历史与活跃路径完全一致，无需清理。
    if (rewrite.divergenceIndex !== null) {
      const checkpointService = new CheckpointService(
        ctx.conversationManager,
        ctx.checkpointManager,
        ctx.settingsManager
      );
      await checkpointService.deleteCheckpointsFromIndex(conversationId, rewrite.divergenceIndex);
    }

    // 9. 响应：切图 + 主历史重写后的图与活跃路径信息（branchGraph 供前端刷新候选摘要）；
    //    BCP-03：chat-and-workspace 额外返回 workspaceRestored / restoredSummary
    const branchGraph = await service.getBranchGraph(conversationId);
    if (branchGraph.graph) {
      enrichGraphWorkspaceInfo(branchGraph.graph);
    }
    ctx.sendResponse(requestId, {
      success: true,
      nodeId,
      activeTailNodeId: switched.activeTailNodeId,
      activePathIds: switched.activePathIds,
      rewritten: true,
      activePathLength: rewrite.activePathLength,
      historyLength: rewrite.historyLength,
      branchGraph,
      ...(workspaceMode ? { workspaceRestored, restoredSummary } : {}),
    });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 软删除分支候选（TREE-09 底座）：节点标记 deleted + 候选摘要标记 deleted。
 * 活跃路径上的节点拒绝删除（BRANCH_OPERATION_CONFLICT）。
 * 入参：{ conversationId, nodeId }
 */
export const deleteBranchCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, nodeId } = data || {};
    // L-7（R4 复查）：入参显式类型校验
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof nodeId !== 'string' || !nodeId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId and nodeId are required');
      return;
    }
    // TREE-13：流式生成期间拒绝变更类分支操作（BRANCH_BUSY）
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const result = await resolveBranchService(ctx).deleteBranchCandidate(conversationId, nodeId);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 恢复软删候选（TREE-09）：清除节点与候选摘要的 deleted / deletedAt，不自动重新激活。
 * 入参：{ conversationId, nodeId }
 */
export const restoreBranchCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, nodeId } = data || {};
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof nodeId !== 'string' || !nodeId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId and nodeId are required');
      return;
    }
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const result = await resolveBranchService(ctx).restoreBranchCandidate(conversationId, nodeId);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 重命名分支候选（TREE-09）：只改 label（节点 + 候选摘要同步），不动 contents。
 * 入参：{ conversationId, nodeId, label }
 */
export const renameBranchCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, nodeId, label } = data || {};
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof nodeId !== 'string' || !nodeId.trim()
        || typeof label !== 'string') {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId, nodeId and label are required');
      return;
    }
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const result = await resolveBranchService(ctx).renameBranchCandidate(conversationId, nodeId, label);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 彻底删除单个软删候选（TREE-09）：物理移除节点及其整棵子树（先软删后彻底删）。
 * 入参：{ conversationId, nodeId }
 */
export const purgeBranchCandidate: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, nodeId } = data || {};
    if (typeof conversationId !== 'string' || !conversationId.trim()
        || typeof nodeId !== 'string' || !nodeId.trim()) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId and nodeId are required');
      return;
    }
    if (rejectIfStreaming(ctx, conversationId, requestId)) {
      return;
    }
    const result = await resolveBranchService(ctx).purgeBranchCandidate(conversationId, nodeId);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 软删分支数量统计（TREE-09）：缺省全量扫描；可指定 conversationId 只统计单会话。
 * 入参：{ conversationId? }
 */
export const getDeletedBranchCount: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId } = data || {};
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId.trim())) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId must be a non-empty string when provided');
      return;
    }
    const result = await resolveBranchService(ctx).getDeletedBranchCount(
      conversationId ? { conversationId } : {}
    );
    ctx.sendResponse(requestId, result);
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 物理清理过期软删分支（TREE-09）：缺省全量清理；可指定 conversationId 只清理单会话。
 * 入参：{ conversationId?, retentionDays? }
 */
export const pruneDeletedBranches: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, retentionDays } = data || {};
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId.trim())) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'conversationId must be a non-empty string when provided');
      return;
    }
    if (retentionDays !== undefined && (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 0)) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'retentionDays must be a non-negative integer');
      return;
    }
    const result = await resolveBranchService(ctx).pruneDeletedBranches({
      ...(conversationId ? { conversationId } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
    });
    ctx.sendResponse(requestId, result);
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 读取分支保留期配置（TREE-09）：{ retentionDays }
 */
export const getBranchRetentionConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await resolveBranchService(ctx).getBranchRetentionConfig();
    ctx.sendResponse(requestId, result);
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 更新分支保留期配置（TREE-09）：入参 { retentionDays }（0 = 不自动清理）
 */
export const updateBranchRetentionConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { retentionDays } = data || {};
    if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 0) {
      ctx.sendError(requestId, 'BRANCH_OPERATION_CONFLICT', 'retentionDays must be a non-negative integer');
      return;
    }
    const result = await resolveBranchService(ctx).updateBranchRetentionConfig(retentionDays);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error) {
    sendBranchError(requestId, ctx, error);
  }
};

/**
 * 注册分支处理器
 */
export function registerBranchHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('conversation.getBranchGraph', getBranchGraph);
  registry.set('conversation.getBranchGraphMeta', getBranchGraphMeta);
  registry.set('conversation.createRerollCandidate', createRerollCandidate);
  registry.set('conversation.switchBranchCandidate', switchBranchCandidate);
  registry.set('conversation.deleteBranchCandidate', deleteBranchCandidate);
  registry.set('conversation.restoreBranchCandidate', restoreBranchCandidate);
  registry.set('conversation.renameBranchCandidate', renameBranchCandidate);
  registry.set('conversation.purgeBranchCandidate', purgeBranchCandidate);
  registry.set('conversation.getDeletedBranchCount', getDeletedBranchCount);
  registry.set('conversation.pruneDeletedBranches', pruneDeletedBranches);
  registry.set('conversation.getBranchRetentionConfig', getBranchRetentionConfig);
  registry.set('conversation.updateBranchRetentionConfig', updateBranchRetentionConfig);
}
