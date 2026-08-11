/**
 * Edit / Edit-Branch 流程编排（flow 拆分）。
 *
 * 迁移自 ChatFlowService：非流式/流式 EditAndRetry（handleEditAndRetry /
 * handleEditAndRetryStream）、编辑分支流（handleEditBranchStream）、编辑目标解析
 * 纯函数 resolveEditTargetNode 及其类型（EditBranchRequestData / EditTargetResolution）。
 * 方法体与拆分前完全一致，通过共享的 ChatFlowContext 访问依赖与公共辅助逻辑。
 */

import { t } from '../../../../../i18n';
import type {
  EditAndRetryRequestData,
  ChatSuccessData,
  ChatErrorData,
  ChatStreamCheckpointsData,
  ChatStreamCompleteData,
} from '../../types';
import type { Content } from '../../../../conversation/types';
import {
  BranchError,
  activePath,
  extractBranchContentMetadata,
  getGlobalBranchService,
  isFunctionResponseMessage,
} from '../../../../conversation/branch';
import type { BranchService, ConversationBranchGraph } from '../../../../conversation/branch';
import { ChatStreamOutput, ChatFlowContext, ChatFlowDeps, isFirstMessageHistory } from './context';

/**
 * 编辑用户消息分支（TREE-03）请求数据。
 * 与 EditAndRetryRequestData 的区别：不覆盖原消息——后端在 BranchGraph 中把旧用户节点及其子树
 * 保留为候选（进 sidecar），创建编辑候选（新 user 节点，kind='edit'）并切换主历史到编辑后路径；
 * 失败时旧候选始终保留；新模型候选完全无输出时移除空占位。
 */
export interface EditBranchRequestData {
  /** 对话 ID */
  conversationId: string;
  /**
   * 要编辑的用户节点 ID（须在当前活跃路径上，且 role==='user'，且不是根节点）；
   * 省略时取活跃路径上最后一条可编辑用户消息（前端「编辑最后一条用户消息」默认行为）。
   */
  userNodeId?: string;
  /** 新文本（替换用户消息的文本 parts） */
  newText: string;
  /** 配置 ID */
  configId: string;
  /** 模型覆盖（可选） */
  modelOverride?: string;
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** 总结请求专用取消信号 */
  summarizeAbortSignal?: AbortSignal;
  /** Prompt 模式 ID（可选） */
  promptModeId?: string;
  /**
   * 编辑模式（可选，默认 'branch'）：
   * - 'branch'：创建编辑候选（新 user 节点）并切换分支，旧节点及其子树保留进 sidecar；
   * - 'keep'：直接改写活跃路径上的原用户消息并截断其后内容（保持当前分支，不产生新候选）。
   */
  mode?: 'branch' | 'keep';
}

/** TREE-03：编辑目标解析结果 */
export interface EditTargetResolution {
  /** 被编辑的旧用户节点 id */
  nodeId: string;
  /**
   * 新编辑候选的父节点 id（旧用户节点的父节点）。
   * 根节点（无父节点）时为 null：keep 模式原地改写根节点（不创建候选、不使用父节点）；
   * branch 模式按 TREE-03-R 同样原地改写根节点 + 截断其后 + 新建模型候选重新生成
   * （也无父节点可挂「新 user 编辑节点」，parentNodeId 同为 null）。
   */
  parentNodeId: string | null;
}

/**
 * TREE-03：解析并校验编辑目标（纯函数，可单测）。
 *
 * - 显式 userNodeId：图模式校验「存在 + 在活跃路径 + role==='user' + 非根节点」；
 *   线性模式（graph 为 null）以主历史为活跃路径，父节点取前一个非 functionResponse 消息
 *   （与 importLinearHistory 的线性链接规则一致，决策 8）；
 * - keep 模式（mode='keep'，原地改写）放行根节点：不创建候选、不需要父节点；
 *   branch 模式（默认）编辑根节点同样放行（TREE-03-R）：根节点无父节点可挂「新 user 编辑节点」，
 *   改为原地改写根节点文本 + 截断其后 + 新建模型候选重新生成（parentNodeId 同为 null）。
 * - 省略 userNodeId：取活跃路径上最后一条可编辑用户消息；
 * - 错误码：节点缺失 NODE_NOT_FOUND；非 user / 不在活跃路径 → INVALID_BRANCH_RELATION（根节点不拒绝，见上）。
 */
export function resolveEditTargetNode(
  graph: ConversationBranchGraph | null,
  history: ReadonlyArray<Content>,
  userNodeId?: string,
  mode: 'branch' | 'keep' = 'branch',
): EditTargetResolution {
  if (userNodeId !== undefined && userNodeId.trim() !== '') {
    if (graph) {
      const node = graph.nodes[userNodeId];
      if (!node) {
        throw new BranchError('NODE_NOT_FOUND', `node not found: ${userNodeId}`);
      }
      if (node.role !== 'user') {
        throw new BranchError(
          'INVALID_BRANCH_RELATION',
          `edit target ${userNodeId} is not a user node`
        );
      }
      const path = activePath(graph);
      if (!path.includes(userNodeId)) {
        throw new BranchError(
          'INVALID_BRANCH_RELATION',
          `node ${userNodeId} is not on the active path; cannot edit it`
        );
      }
      if (node.parentId === null) {
        // 根节点（无父节点可挂「新 user 编辑节点」）：keep 原地改写；
        // branch（TREE-03-R）原地改写根节点 + 截断其后 + 新建模型候选重新生成。
        return { nodeId: userNodeId, parentNodeId: null };
      }
      return { nodeId: userNodeId, parentNodeId: node.parentId };
    }
    // 线性模式（无分支图）：主历史即活跃路径
    const idx = history.findIndex(message => message.id === userNodeId);
    if (idx < 0) {
      throw new BranchError('NODE_NOT_FOUND', `node not found: ${userNodeId}`);
    }
    if (history[idx].role !== 'user') {
      throw new BranchError(
        'INVALID_BRANCH_RELATION',
        `edit target ${userNodeId} is not a user node`
      );
    }
    const parentId = findLinearParentId(history, idx);
    if (parentId === null) {
      // 线性模式根节点（首条消息）：语义同上方图模式根节点分支
      return { nodeId: userNodeId, parentNodeId: null };
    }
    return { nodeId: userNodeId, parentNodeId: parentId };
  }
  // 缺省：活跃路径上最后一条可编辑用户消息
  if (graph) {
    const path = activePath(graph);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const node = graph.nodes[path[i]];
      if (node && node.role === 'user' && node.parentId !== null) {
        return { nodeId: node.id, parentNodeId: node.parentId };
      }
    }
  } else {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'user' && !isFunctionResponseMessage(history[i])) {
        const parentId = findLinearParentId(history, i);
        if (parentId !== null) {
          return { nodeId: history[i].id!, parentNodeId: parentId };
        }
      }
    }
  }
  throw new BranchError(
    'INVALID_BRANCH_RELATION',
    'no editable user node found on the active path'
  );
}

/** 线性模式父节点解析：向前跳过 functionResponse（决策 8：FR 不独立成节点） */
function findLinearParentId(history: ReadonlyArray<Content>, index: number): string | null {
  for (let j = index - 1; j >= 0; j -= 1) {
    if (!isFunctionResponseMessage(history[j])) {
      return history[j].id ?? null;
    }
  }
  return null;
}

export class ChatFlowEditBranch extends ChatFlowContext {
  constructor(deps: ChatFlowDeps) {
    super(deps);
  }

  /**
   * M1：可选的消息 id 防索引漂移校验。
   *
   * 请求携带 messageId 时，校验索引处消息 id 与之一致；不一致说明索引已漂移（并发
   * 插入/删除/上下文压缩等），返回 MESSAGE_CHANGED 错误。不带 messageId 时返回 null，
   * 保持旧行为（兼容旧前端）。
   */
  private validateMessageIdForEdit(
    message: Content | undefined,
    messageId?: string,
  ): { code: string; message: string } | null {
    if (typeof messageId !== 'string' || messageId.trim() === '') {
      return null;
    }
    if (!message || message.id !== messageId.trim()) {
      return {
        code: 'MESSAGE_CHANGED',
        message: t('modules.api.chat.errors.messageChanged'),
      };
    }
    return null;
  }

  /**
   * 非流式 EditAndRetry 流程
   */
  async handleEditAndRetry(
    request: EditAndRetryRequestData,
  ): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, messageIndex, newMessage, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      return {
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
    }

    if (!config.enabled) {
      return {
        success: false,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
    }

    // 3. 验证消息索引和角色
    const message = await this.conversationManager.getMessage(conversationId, messageIndex);
    if (!message) {
      return {
        success: false,
        error: {
          code: 'MESSAGE_NOT_FOUND',
          message: t('modules.api.chat.errors.messageNotFound', { messageIndex }),
        },
      };
    }

    if (message.role !== 'user' || isFunctionResponseMessage(message)) {
      return {
        success: false,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
    }

    // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移导致编辑错消息
    const messageIdError = this.validateMessageIdForEdit(message, request.messageId);
    if (messageIdError) {
      return {
        success: false,
        error: messageIdError,
      };
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_and_retry');

    // 3.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与 handleChat/handleRetry 一致，避免悬空 functionCall/pending diff 跨回合残留）
    // H1：先等旧流完全退出，再执行清理与截断（避免旧流结算落在编辑截断之后）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 4. 更新消息内容（包含附件），并标记为动态提示词插入点
    await this.conversationManager.updateMessage(conversationId, messageIndex, {
      // 与流式路径（handleEditAndRetryStream 2165）一致：保留 request.attachments
      parts: this.messageBuilderService.buildUserMessageParts(newMessage, request.attachments),
      isUserInput: true,
      // 清除旧的 token 计数，强制重新计算
      tokenCountByChannel: {}
    });
    
    // 注：编辑后消息的 token 计数将在 getHistoryWithContextTrimInfo 中
    // 与系统提示词、动态上下文一起并行计算

    // 5. 删除后续所有消息（messageIndex+1 及之后）和关联的检查点
    const historyRef = await this.conversationManager.getHistoryRef(conversationId);
    if (messageIndex + 1 < historyRef.length) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, messageIndex + 1);
      await this.conversationManager.deleteToMessage(conversationId, messageIndex + 1);
      await this.rebuildTodoListMetadataFromHistory(conversationId);
    }
    
    // 5.5 清除裁剪状态（编辑后应重新计算裁剪）
    await this.toolIterationLoopService.clearTrimState(conversationId);

    // 6. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
      // 编辑后的用户消息内容变化 → 新回合语义（与流式 editAndRetryStream 一致）
      true,
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        error: {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义（与 handleChat 一致）
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.api.chat.errors.requestCancelled'),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content!,
    };
  }

  /**
   * 流式编辑用户消息（TREE-03：编辑用户消息时默认创建新的用户消息分支，不覆盖原消息；
   * request.mode === 'keep' 时改为原地改写原消息，保持当前分支）。
   *
   * 与 handleEditAndRetryStream（破坏性覆盖 + 截断）并存（决策 5 精神）：旧路径保留为内部兼容，
   * 主流程切编辑分支；本方法不覆盖原消息——旧用户节点及其子树由分支图 sidecar 保留。
   *
   * 流程（复用 reroll 底座编排结构，TREE-01/02 同款锁与验证结构）：
   * 1. 确保对话 / 验证配置（与 reroll 一致）；
   * 2. 中断未完成的 diff 等待 + 拒绝所有未响应工具调用（与 reroll 一致）；
   * 3. 解析并校验编辑目标（活跃路径 + role==='user' + 非根节点）；
   * 4. mode='branch'（默认）：BranchService.editCandidate——在旧用户节点父节点下创建编辑候选
   *    （新 user 节点 kind='edit'，文本=编辑后内容）并激活（旧子树保留进 sidecar）；
   *    mode='keep'：直接改写活跃路径上的原用户消息（updateMessage + 截断其后内容），
   *    BranchService.updateActiveNodeParts 同步分支图节点内容（保持当前分支，不产生新候选）；
   * 5. mode='branch'：BranchService.createRerollCandidate——在新用户节点下创建模型候选占位
   *    （流式结果写入此节点；缺少 startEditBranch 公共方法，见设计说明）；
   * 6. 主历史截断（branch：截断到旧用户节点之前并追加编辑后的用户消息，id 对齐新用户节点 BR-01；
   *    keep：截断到目标消息之后）
   * 7. 复用现有工具循环生成内容（编辑后用户消息内容变化 → 新回合语义，与 editAndRetryStream 一致）；
   * 8. finally 中（仅 branch）BranchService.finishReroll：把流式结果回填进模型候选节点（含续接节点）
   *    + 更新摘要；失败也回填：保留旧候选，新候选有部分内容则保留，无输出则移除空占位。
   */
  async *handleEditBranchStream(
    request: EditBranchRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

    // 0. 新文本校验
    if (typeof request.newText !== 'string' || request.newText.trim() === '') {
      yield {
        conversationId,
        error: {
          code: 'EDIT_BRANCH_INVALID_ARGS',
          message: 'newText is required',
        },
      };
      return;
    }

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_branch_stream');

    // H1：先等旧流完全退出，再截断主历史并创建编辑候选（与 reroll 同理，此处后端兜底）
    await this.waitForOldStreamExit(conversationId);

    // 3. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    let editStarted: { modelCandidateNodeId: string; parentNodeId: string | null } | undefined;
    let editSetup: {
      branchService: BranchService;
      oldUserNodeId: string;
      newUserNodeId: string;
      modelCandidateNodeId: string;
      parentNodeId: string | null; // 根节点编辑（TREE-03-R）为 null
    } | undefined;
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 3.5 拒绝所有未响应的工具调用（与 reroll 一致；悬空 functionCall 会被标记 rejected 并补
      // functionResponse，随后由主历史截断一并移除——它们属于被编辑的旧子树）
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 3.6 编辑分支底座需要启动期注册的全局 BranchService
      const branchService = getGlobalBranchService();
      if (!branchService) {
        yield {
          conversationId,
          error: {
            code: 'BRANCH_SERVICE_UNAVAILABLE',
            message: 'branch service is not registered; open the branch panel first',
          },
        };
        return;
      }

      // 3.7 解析并校验编辑目标（活跃路径 + user 角色 + 非根节点）；sidecar 损坏时快速失败
      // 旧版本可能把已结束的空 reroll/edit 占位留在活跃尾，导致主历史继续增长而
      // branches.json 停更。编辑会截断/改写历史，必须先把当前路径安全归档；修复前先备份旧图。
      await branchService.ensureMainHistoryRepresentedInGraph(conversationId);
      const graphResult = await branchService.getBranchGraph(conversationId);
      if (graphResult.errorCode === 'BRANCH_STORAGE_CORRUPT') {
        throw new BranchError(
          'BRANCH_STORAGE_CORRUPT',
          `branches.json is corrupt for ${conversationId}; refusing to edit`
        );
      }
      const historyBefore = await this.conversationManager.getMessagesRaw(conversationId);
      // mode：keep 原地改写（不重新生成）；branch 根节点（TREE-03-R）原地改写 + 截断重生成
      const target = resolveEditTargetNode(graphResult.graph, historyBefore, request.userNodeId, request.mode);

      // 3.8 按编辑模式分流：
      // - 'keep'：真·原地保存——只改写目标消息文本，后续消息与分支全部保留，不重新生成；
      // - 'branch'（默认）：创建编辑候选（新 user 节点 kind='edit'，文本=编辑后内容）+ 激活 + 摘要
      //   （旧用户节点及其子树完整保留进 sidecar——先建图后截断，线性模式首次建图不丢旧消息）
      if (request.mode === 'keep') {
        // —— keep 模式：只改写目标消息，后续内容全部保留 ——
        const targetIndex = historyBefore.findIndex(message => message.id === target.nodeId);
        if (targetIndex === -1) {
          yield {
            conversationId,
            error: {
              code: 'NODE_NOT_FOUND',
              // C-16：旧数据消息可能无 id，findIndex 恒返回 -1——报错里说明可能原因，避免笼统的 not found
              message: `target user node ${target.nodeId} not found in main history (the message may lack an id or have been removed by context compaction)`,
            },
          };
          return;
        }

        // 3.8.1 建图（图节点内容同步需要；无图时建线性基线图）
        await branchService.ensureBranchGraph(conversationId);

        // 3.8.2 改写目标消息（清除 token 计数，强制在裁剪评估中重新计算）
        await this.conversationManager.updateMessage(conversationId, targetIndex, {
          parts: [{ text: request.newText }],
          isUserInput: true,
          tokenCountByChannel: {},
        });

        // 3.8.3 同步分支图节点内容 + 更新候选摘要（BR-01 同源：节点 id == Content.id）
        await branchService.updateActiveNodeParts(conversationId, target.nodeId, [{ text: request.newText }]);

        // 3.8.4 清除裁剪状态（编辑后应重新计算裁剪起点）
        await this.toolIterationLoopService.clearTrimState(conversationId);
        // 真·原地保存语义：不截断后续消息、不软删图子树、不删除检查点、不创建候选、不重新生成。
        // 后续 AI 回复与分支树保持原样，只有这条消息的文本被更新。
        // editStarted 保持 undefined：无候选节点，流结束后无需 finishReroll
      } else {
        // —— branch 模式：创建编辑候选并切换分支 ——
        // 根节点（TREE-03-R，parentNodeId === null）：无父节点可挂「新 user 编辑节点」，
        // 改为原地改写根节点文本 + 截断其后消息 + 新建模型候选重新生成（旧回答保留为
        // 可切换候选，与 reroll 同语义）；非根节点走常规 editCandidate 流程。
        const isRootEdit = target.parentNodeId === null;

        if (isRootEdit) {
          // 3.8R 根节点编辑重生成：改写根节点（同 keep 3.8.2/3.8.3）+ 模型候选 + 截断
          const targetIndex = historyBefore.findIndex(message => message.id === target.nodeId);
          if (targetIndex === -1) {
            yield {
              conversationId,
              error: {
                code: 'NODE_NOT_FOUND',
                // C-16：旧数据消息可能无 id，findIndex 恒返回 -1——报错里说明可能原因，避免笼统的 not found
                message: `target user node ${target.nodeId} not found in main history (the message may lack an id or have been removed by context compaction)`,
              },
            };
            return;
          }

          // 建图（图节点内容同步需要；无图时建线性基线图）
          await branchService.ensureBranchGraph(conversationId);

          // 改写根节点（清除 token 计数，强制在裁剪评估中重新计算）
          await this.conversationManager.updateMessage(conversationId, targetIndex, {
            parts: [{ text: request.newText }],
            isUserInput: true,
            tokenCountByChannel: {},
          });
          await branchService.updateActiveNodeParts(conversationId, target.nodeId, [{ text: request.newText }]);

          // 创建模型候选占位（流式结果写入此节点；根节点下挂候选与 reroll 同语义）
          const modelCreated = await branchService.createRerollCandidate(conversationId, target.nodeId, {
            parts: [],
          });
          const modelCandidateNodeId = modelCreated.nodeId;
          editSetup = {
            branchService,
            oldUserNodeId: target.nodeId,
            newUserNodeId: target.nodeId,
            modelCandidateNodeId,
            parentNodeId: null,
          };

          // 截断根节点之后的主历史（旧消息已由 3.7 ensureMainHistoryRepresentedInGraph 归档进图）
          await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex + 1);
          if (targetIndex < historyBefore.length - 1) {
            await this.conversationManager.deleteMessagesInRange(
              conversationId,
              targetIndex + 1,
              historyBefore.length - 1,
            );
          }

          editStarted = { modelCandidateNodeId, parentNodeId: null };
        } else {
          // —— 非根节点：创建新 user 编辑候选（旧子树保留进 sidecar） ——
          const created = await branchService.editCandidate(conversationId, target.parentNodeId!, {
            role: 'user',
            parts: [{ text: request.newText }],
          });
          const newUserNodeId = created.nodeId;

          // 3.9 创建模型候选占位（流式结果将写入此节点；createRerollCandidate 是当前唯一可用的
          //     模型节点创建入口，kind 固定为 'reroll'——缺少 startEditBranch 公共方法，见设计说明）
          const modelCreated = await branchService.createRerollCandidate(conversationId, newUserNodeId, {
            parts: [],
          });
          const modelCandidateNodeId = modelCreated.nodeId;
          editSetup = {
            branchService,
            oldUserNodeId: target.nodeId,
            newUserNodeId,
            modelCandidateNodeId,
            parentNodeId: target.parentNodeId!,
          };

          // 3.10 主历史截断到旧用户节点之前（父节点保留，旧子树整体移出主历史；图侧已保留）
          const historyAfterGraph = await this.conversationManager.getMessagesRaw(conversationId);
          const parentIndex = historyAfterGraph.findIndex(message => message.id === target.parentNodeId);
          // H3：父节点不在主历史时快速失败——继续追加消息会让主历史与分支图分叉（静默降级
          // 产生"幽灵"编辑候选：图侧激活了它，主历史却停在无关节点上）。父节点缺失通常意味着
          // 它已被上下文压缩移除，给出可读错误让用户刷新。
          if (parentIndex < 0) {
            throw new BranchError(
              'INVALID_BRANCH_RELATION',
              t('modules.api.chat.errors.editTargetNotInHistory'),
            );
          }
          // M1（R6a-FIX）：截断前清理截断点之后的旧检查点（与 handleEditAndRetryStream 对齐）——
          // 旧回合检查点原样保留在相同索引会让新候选消息命中旧检查点（索引错位，回档/恢复错状态）
          await this.checkpointService.deleteCheckpointsFromIndex(conversationId, parentIndex + 1);
          if (parentIndex < historyAfterGraph.length - 1) {
            await this.conversationManager.deleteMessagesInRange(
              conversationId,
              parentIndex + 1,
              historyAfterGraph.length - 1,
            );
          }

          // 3.11 追加编辑后的用户消息（id 对齐新用户节点，BR-01 同源：节点 id == Content.id）
          await this.conversationManager.addContent(conversationId, {
            role: 'user',
            parts: [{ text: request.newText }],
            id: newUserNodeId,
            isUserInput: true,
          });

          // 3.11b 把持久化后的用户消息元数据补写进图节点——editCandidate 建节点时只有
          // parts/role/kind，没有主历史侧元数据（isUserInput/tokenCountByChannel 等）；
          // 不补写则切分支重写主历史时这些字段丢失（动态提示词插入点、前端用户图标、裁剪统计口径）。
          try {
            const persistedHistory = await this.conversationManager.getMessagesRaw(conversationId);
            const persistedUserMessage = persistedHistory.find(message => message.id === newUserNodeId);
            if (persistedUserMessage) {
              await branchService.updateNodeMetadata(
                conversationId,
                newUserNodeId,
                extractBranchContentMetadata(persistedUserMessage),
              );
            }
          } catch (metadataError) {
            // 元数据补写失败不阻断编辑主流程：切分支时的完整对账（rewriteHistoryFromBranchGraph）
            // 会按图节点内容重建，缺少数个非拓扑字段只影响展示/裁剪口径，下次分支操作可再修复。
            this.log.warn('edit_node_metadata_sync_failed', {
              conversationId,
              newUserNodeId,
              error: (metadataError as Error)?.message ?? String(metadataError),
            });
          }

          // branch 模式：非根节点 parentNodeId 必非 null
          editStarted = { modelCandidateNodeId, parentNodeId: target.parentNodeId! };
        }
      }
    } catch (error) {
      if (editSetup && !editStarted) {
        try {
          const currentHistory = await this.conversationManager.getMessagesRaw(conversationId);
          if (currentHistory.some(message => message.id === editSetup!.newUserNodeId)) {
            // addContent 可能已提交后才抛错；此时保留已落盘的编辑用户节点，只移除空模型占位。
            await editSetup.branchService.finishReroll(conversationId, editSetup.modelCandidateNodeId);
          } else {
            // 截断前失败则恢复旧用户路径；截断已落盘则回退其父节点。两种情况都只允许
            // 删除本次 edit + 空 reroll 的精确临时子树。
            // 根节点编辑（TREE-03-R）：parentNodeId 为 null，回退到根节点自身
            // （newUserNodeId === oldUserNodeId === 根节点，此时必然命中 oldUserNodeId 分支）
            const fallbackNodeId = currentHistory.some(message => message.id === editSetup!.oldUserNodeId)
              ? editSetup.oldUserNodeId
              : (editSetup!.parentNodeId ?? editSetup!.oldUserNodeId);
            await editSetup.branchService.abortEmptyCandidateSetup(conversationId, {
              setupRootNodeId: editSetup.newUserNodeId,
              emptyCandidateNodeId: editSetup.modelCandidateNodeId,
              fallbackNodeId,
            });
          }
        } catch (rollbackError) {
          this.log.error('edit_branch_setup_rollback_failed', {
            conversationId,
            newUserNodeId: editSetup.newUserNodeId,
            modelCandidateNodeId: editSetup.modelCandidateNodeId,
            error: (rollbackError as Error)?.message ?? String(rollbackError),
          });
        }
      }
      throw error;
    } finally {
      // 4. 重置中断标记：中途任何 await 抛错都必须清理（与 handleRerollStream 的 finally 用法一致）
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 4.5 切分支重写主历史成功后重建 todoList 元数据（与 edit 路径 1229/2180 对齐）；
    // keep 模式不重写历史（仅原地改写一条消息），无需重建。
    if (request.mode !== 'keep') {
      await this.refreshDerivedMetadataAfterHistoryMutation(conversationId);
    }

    // 5. 工具调用循环（branch 模式：编辑后用户消息内容变化 → 新回合语义；
    //    keep 模式为真·原地保存：不重新生成，流直接完成）
    if (request.mode !== 'keep') {
      let finishError: { code: string; message: string } | undefined;
      try {
        // 迭代上限解析同样必须位于最终回填保护区，避免异常时遗留空模型占位。
        const maxToolIterations = this.getMaxToolIterations();
        for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        // 根节点编辑（TREE-03-R）后主历史只剩首条消息：动态判断 isFirstMessage 以刷新
        // 系统提示词（与 send/retry/reroll 同口径）；非根节点编辑后必非首条，判断自然为 false
        isFirstMessage: isFirstMessageHistory(await this.conversationManager.getHistoryRef(conversationId)),
        maxIterations: maxToolIterations,
        isNewTurn: true,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
    } finally {
      // 6. 流式结果写入模型候选节点 + 更新摘要；失败也回填（部分输出保留，无输出移除空占位）
      if (editStarted) {
        try {
          const branchService = getGlobalBranchService();
          if (branchService) {
            await branchService.finishReroll(conversationId, editStarted.modelCandidateNodeId);
          }
        } catch (error) {
          // M2（R6a-FIX）：不再只 log.warn 吞掉——记录结构化事件，并在下方透出 error chunk
          this.log.warn('edit_branch_finish_sync_failed', {
            conversationId,
            candidateNodeId: editStarted.modelCandidateNodeId,
            error: (error as Error)?.message ?? String(error),
          });
          finishError = {
            code: 'EDIT_BRANCH_FINISH_SYNC_FAILED',
            message: `edit branch result sync to branch graph failed: ${(error as Error)?.message ?? String(error)}`,
          };
        }
      }
    }
    // 6.5 M2：主历史已显示新内容但图回填失败 → 透出结构化 error chunk（前端错误条可见）
    if (finishError) {
      yield {
        conversationId,
        error: finishError,
      };
    }
    } else {
      // keep 模式：不重新生成——直接结束流。complete **不带 content**：
      // 前端 handleStreamChunk 对无 content 的终结 chunk 走 resetTerminalStreamState
      // （纯状态复位，不替换消息）。此前携带 tail 最后一条消息（可能是 user 角色），
      // 若前端残留 streamingMessageId（旧流占位未清理），handleComplete 会用 user
      // 内容替换 assistant 消息，造成内容错乱；无 content 语义与 resetTerminalStreamState
      // 的设计注释（后端可能发送 content 为 null/undefined 的终结 chunk）一致。
      yield {
        conversationId,
      } satisfies ChatStreamCompleteData;
    }
  }

  /**
   * 流式 EditAndRetry 流程
   */
  async *handleEditAndRetryStream(
    request: EditAndRetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, messageIndex, newMessage, configId, modelOverride, preserveCheckpointId } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'edit_and_retry');

    // 3. 验证消息索引和角色
    const message = await this.conversationManager.getMessage(conversationId, messageIndex);
    if (!message) {
      yield {
        conversationId,
        error: {
          code: 'MESSAGE_NOT_FOUND',
          message: t('modules.api.chat.errors.messageNotFound', { messageIndex }),
        },
      };
      return;
    }

    if (message.role !== 'user' || isFunctionResponseMessage(message)) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_MESSAGE_ROLE',
          message: t('modules.api.chat.errors.canOnlyEditUserMessage', { role: message.role }),
        },
      };
      return;
    }

    // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移导致编辑错消息
    const messageIdError = this.validateMessageIdForEdit(message, request.messageId);
    if (messageIdError) {
      yield {
        conversationId,
        error: messageIdError,
      };
      return;
    }

    // H1：先等旧流完全退出，再执行截断与更新（避免旧流结算落在编辑截断之后）
    await this.waitForOldStreamExit(conversationId);

    // 4. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);
      
      // 4.5 拒绝所有未响应的工具调用
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 5. 删除该消息及后续所有消息的检查点（回档场景下保留刚用于恢复的存档点）
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, messageIndex, preserveCheckpointId);

      // 6. 为编辑后的用户消息创建存档点（执行前）
      const beforeEditCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
        conversationId,
        'before',
        messageIndex,
      );
      if (beforeEditCheckpoint) {
        yield {
          conversationId,
          checkpoints: [beforeEditCheckpoint],
          checkpointOnly: true as const,
        } satisfies ChatStreamCheckpointsData;
      }

      // 7. 更新消息内容（包含附件），并标记为动态提示词插入点
      const editParts = this.messageBuilderService.buildUserMessageParts(newMessage, request.attachments);
      await this.conversationManager.updateMessage(conversationId, messageIndex, {
        parts: editParts,
        isUserInput: true,
        // 清除旧的 token 计数，强制重新计算
        tokenCountByChannel: {}
      });
      
      // 注：编辑后消息的 token 计数将在 getHistoryWithContextTrimInfo 中
      // 与系统提示词、动态上下文一起并行计算

      // 8. 删除后续所有消息
      const historyRef = await this.conversationManager.getHistoryRef(conversationId);
      if (messageIndex + 1 < historyRef.length) {
        await this.conversationManager.deleteToMessage(conversationId, messageIndex + 1);
        await this.rebuildTodoListMetadataFromHistory(conversationId);
      }
      
      // 8.5 清除裁剪状态（编辑后应重新计算裁剪）
      await this.toolIterationLoopService.clearTrimState(conversationId);

      // 9. 为编辑后的用户消息创建存档点（执行后）
      const afterEditCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
        conversationId,
        'after',
        messageIndex,
      );
      if (afterEditCheckpoint) {
        yield {
          conversationId,
          checkpoints: [afterEditCheckpoint],
          checkpointOnly: true as const,
        } satisfies ChatStreamCheckpointsData;
      }
    } finally {
      // 10. 重置中断标记：中途任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 11. 判断是否是编辑首条消息（需要刷新动态系统提示词）
    const isEditFirstMessage = messageIndex === 0;

    // 12. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage: isEditFirstMessage,
      maxIterations: maxToolIterations,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }
}
