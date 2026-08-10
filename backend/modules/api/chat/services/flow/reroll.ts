/**
 * Reroll 流程编排（flow 拆分）。
 *
 * 迁移自 ChatFlowService：流式 handleRerollStream、请求类型 RerollRequestData 以及
 * reroll 截断索引解析纯函数 resolveRerollTruncateIndex。方法体与拆分前完全一致，
 * 通过共享的 ChatFlowContext 访问依赖与公共辅助逻辑。
 */

import { t } from '../../../../../i18n';
import type { Content } from '../../../../conversation/types';
import {
  getGlobalBranchService,
  isFunctionResponseMessage,
} from '../../../../conversation/branch';
import { ChatStreamOutput, ChatFlowContext, ChatFlowDeps, isFirstMessageHistory } from './context';

/**
 * reroll（重新生成并保留旧回答）请求数据（TREE-01）。
 * 与 RetryRequestData 的区别：不删除旧回答——后端在 BranchGraph 中把旧助手节点及其子树
 * 保留为候选（进 sidecar），新建候选并切换主历史到新候选路径；失败时旧候选始终保留，
 * 新候选已有部分输出则保留，完全无输出则移除空占位。
 */
export interface RerollRequestData {
  /** 对话 ID */
  conversationId: string;
  /**
   * 要重新生成的助手节点 ID（须在当前活跃路径上，且父节点为用户消息）；
   * 省略时取活跃路径上最后一条助手消息（前端「重新生成」默认行为）。
   */
  assistantNodeId?: string;
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
}

/**
 * 解析 reroll 主历史截断起始索引。
 *
 * reroll 是“单条助手消息重新生成”：显式 assistantNodeId 或最后一条 model 消息就是截断点。
 * 目标之前的所有历史均保留，包括工具调用模型消息与其后的 functionResponse；因此工具续接回答
 * 重新生成时不会退回最近的用户消息，也不会重复执行已经完成的工具。
 *
 * 无法定位目标或目标位于首条消息时返回 -1（startReroll 会负责正式的关系校验；
 * 此函数只用于流启动前清理目标消息及其后续检查点）。
 */
export function resolveRerollTruncateIndex(
  history: ReadonlyArray<Content>,
  assistantNodeId?: string,
): number {
  let targetIndex = -1;
  if (assistantNodeId !== undefined && assistantNodeId.trim() !== '') {
    targetIndex = history.findIndex(message => message.id === assistantNodeId);
  } else {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'model' && !isFunctionResponseMessage(history[i])) {
        targetIndex = i;
        break;
      }
    }
  }
  return targetIndex > 0 ? targetIndex : -1;
}

export class ChatFlowReroll extends ChatFlowContext {
  constructor(deps: ChatFlowDeps) {
    super(deps);
  }

  /**
   * 流式 Reroll 流程（TREE-01：重新生成并保留旧回答）。
   *
   * 与 handleRetryStream 并存（决策 5）：retryStream 保留为内部兼容路径（错误条重试等），
   * 主流程切 reroll；本方法不再调用破坏性 deleteMessage，旧回答由分支图 sidecar 保留。
   *
   * 流程：
   * 1. 确保对话 / 验证配置（与 retry 一致）；
   * 2. 中断未完成的 diff 等待 + 拒绝所有未响应工具调用（与 retry 一致）；
   * 3. BranchService.startReroll：验证目标在活跃路径 → 旧助手节点及子树保留进 sidecar →
   *    创建新候选并激活 → 主历史截断到父用户节点之后（切换到新候选路径）；
   * 4. 复用现有工具循环生成内容（写入主历史尾部，functionResponse 走主历史正常路径，决策 8）；
   * 5. finally 中 BranchService.finishReroll：把流式结果回填进新候选节点（含续接节点）+ 更新摘要；
   *    失败也回填：保留旧候选；新候选有部分内容则保留，无输出则移除空占位。
   */
  async *handleRerollStream(
    request: RerollRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

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

    await this.clearPendingApprovalGateIfPresent(conversationId, 'reroll_stream');

    // H1：先等旧流完全退出，再截断主历史并创建新候选——旧流取消结算若落在截断之后，
    // 半截旧回答会残留进新候选路径（reroll/editBranch 不经 StreamRequestHandler 的 create
    // 前置等待，此处在后端兜底）。
    await this.waitForOldStreamExit(conversationId);

    // 3. 中断之前未完成的 diff 等待并关闭编辑器
    this.diffInterruptService.markUserInterrupt(conversationId);
    let rerollStarted: { candidateNodeId: string } | undefined;
    try {
      await this.diffInterruptService.cancelAllPending(conversationId);

      // 3.5 拒绝所有未响应的工具调用（与 retry 一致；悬空 functionCall 会被标记 rejected 并补
      // functionResponse，随后由 startReroll 的主历史截断一并移除——它们属于被 reroll 的旧子树）
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      // 3.6 reroll 底座：验证节点 → 旧候选进 sidecar → 创建新候选并激活 → 主历史切到新候选路径
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

      // startReroll 会从目标助手消息自身开始截断；截断前先清理同一起点及之后的旧检查点。
      // 对工具续接回答，目标前的模型工具调用与 functionResponse 都会保留。
      const historyBeforeTruncate = await this.conversationManager.getMessagesRaw(conversationId);
      const truncateIndex = resolveRerollTruncateIndex(historyBeforeTruncate, request.assistantNodeId);
      if (truncateIndex > 0) {
        await this.checkpointService.deleteCheckpointsFromIndex(conversationId, truncateIndex);
      }

      rerollStarted = await branchService.startReroll(conversationId, request.assistantNodeId);

      // 与 edit 路径对齐：startReroll 已截断主历史，重建 todoList 元数据并清除裁剪状态
      await this.rebuildTodoListMetadataFromHistory(conversationId);
      await this.toolIterationLoopService.clearTrimState(conversationId);
    } finally {
      // 4. 重置中断标记：中途任何 await 抛错都必须清理（与 handleRetryStream 的 finally 用法一致）
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    let finishError: { code: string; message: string } | undefined;
    try {
      // 5. 判断是否需要刷新动态系统提示词。放进最终回填保护区：即使读取历史或解析
      // 迭代上限意外失败，也不能把刚创建的空 reroll 占位永久留在活跃尾。
      const rerollHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
      const isRerollFirstMessage = isFirstMessageHistory(rerollHistoryCheck);

      // 6. 工具调用循环（复用现有循环；functionResponse 走主历史正常路径，决策 8）
      const maxToolIterations = this.getMaxToolIterations();
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        isFirstMessage: isRerollFirstMessage,
        maxIterations: maxToolIterations,
        // reroll 的是 AI 回复，回合起始用户消息不变，复用其上缓存的动态上下文
        createBeforeModelCheckpoint: false,
        isNewTurn: false,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
    } finally {
      // 7. 流式结果写入新节点 + 更新摘要；失败也回填（部分输出保留，无输出移除空占位）
      if (rerollStarted) {
        try {
          const branchService = getGlobalBranchService();
          if (branchService) {
            await branchService.finishReroll(conversationId, rerollStarted.candidateNodeId);
          }
        } catch (error) {
          // M2（R6a-FIX）：不再只 log.warn 吞掉——记录结构化事件，并在下方透出 error chunk
          this.log.warn('reroll_finish_sync_failed', {
            conversationId,
            candidateNodeId: rerollStarted.candidateNodeId,
            error: (error as Error)?.message ?? String(error),
          });
          finishError = {
            code: 'REROLL_FINISH_SYNC_FAILED',
            message: `reroll result sync to branch graph failed: ${(error as Error)?.message ?? String(error)}`,
          };
        }
      }
    }
    // 7.5 M2：主历史已显示新内容但图回填失败 → 透出结构化 error chunk（前端错误条可见），
    // 新候选可能已保留部分输出，也可能已移除空占位；旧候选始终可切回查看。
    // 注：工具循环自身抛错时此处不可达（异常直接传播，由 ChatHandler 转 error chunk）。
    if (finishError) {
      yield {
        conversationId,
        error: finishError,
      };
    }
  }
}
