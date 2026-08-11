/**
 * 主回合编排（flow 拆分）。
 *
 * 迁移自 ChatFlowService：非流式/流式 Chat 主流程（handleChat / handleChatStream）、
 * 工具确认流程（handleToolConfirmation）、删除到指定消息流程（handleDeleteToMessage），
 * 以及 abort-race 辅助函数 createAbortRacePromise。方法体与拆分前完全一致，
 * 通过共享的 ChatFlowContext 访问依赖与公共辅助逻辑。
 */

import { t } from '../../../../../i18n';
import { randomUUID } from 'node:crypto';
import type {
  ChatRequestData,
  ToolConfirmationResponseData,
  DeleteToMessageRequestData,
  ChatSuccessData,
  ChatErrorData,
  DeleteToMessageSuccessData,
  DeleteToMessageErrorData,
  ChatStreamCheckpointsData,
  ChatStreamToolIterationData,
  ChatStreamToolConfirmationData,
  ChatStreamToolsExecutingData,
  ChatStreamToolStatusData,
} from '../../types';
import { MAIN_LOOP_ABORT_DRAIN_GRACE_MS, drainToolExecutionGeneratorAfterAbort } from '../abortDrain';
import type { ToolExecutionFullResult, ToolExecutionProgressEvent } from '../ToolExecutionService';
import type { Content, ContentPart } from '../../../../conversation/types';
import type { CheckpointRecord } from '../../../../checkpoint';
import { getGlobalBranchService } from '../../../../conversation/branch';
import {
  agentMailbox,
  formatAgentMessagesForModel,
  MAIN_SESSION_RUN_ID
} from '../../../../../core/services/agentMailbox';
import { resolveAndPersistPostToolStopState } from '../postToolStopState';
import { ChatStreamOutput, ChatStreamCancelledData, ChatFlowContext, ChatFlowDeps, isFirstMessageHistory } from './context';

function isInternalMessageSource(source: ChatRequestData['source']): boolean {
  return source === 'background_task' || source === 'agent_message';
}

function isValidAgentMessageClaim(request: ChatRequestData): boolean {
  if (request.source !== 'agent_message') return true;
  const claimId = request.agentMessageClaimId?.trim();
  if (!claimId) return false;
  const claim = agentMailbox.getMessageClaim(request.conversationId, MAIN_SESSION_RUN_ID, claimId);
  return !!claim && formatAgentMessagesForModel(claim.messages) === request.message;
}

/**
 * C-6：创建与 abortSignal race 的 Promise，供 gen.next() 主循环防挂起。
 *
 * - 信号已中止时立即 resolve（避免 listener 注册后信号永不触发、Promise 永不落定）；
 * - 返回 dispose() 在 finally 中移除 listener，防止泄漏。
 */
function createAbortRacePromise(signal: AbortSignal | undefined): {
  abortPromise: Promise<void> | undefined;
  dispose: () => void;
} {
  if (!signal) {
    return { abortPromise: undefined, dispose: () => {} };
  }
  if (signal.aborted) {
    return { abortPromise: Promise.resolve(), dispose: () => {} };
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    abortPromise,
    dispose: () => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

export class ChatFlowOrchestrator extends ChatFlowContext {
  constructor(deps: ChatFlowDeps) {
    super(deps);
  }

  /**
   * 非流式 Chat 流程
   */
  async handleChat(request: ChatRequestData): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, configId, message, messageId, modelOverride, hiddenFunctionResponse } = request;

    // 1. 确保对话存在（自动创建）
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

    if (!isValidAgentMessageClaim(request)) {
      return {
        success: false,
        error: {
          code: 'INVALID_AGENT_MESSAGE_CLAIM',
          message: 'The agent message claim is missing, stale, or does not match the mailbox payload.',
        },
      };
    }

    const approvalValidationError = await this.validateHiddenContinuationApproval(conversationId, hiddenFunctionResponse);
    if (approvalValidationError) {
      return approvalValidationError;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot, request.dynamicContextStrategyOverride);

    if (!hiddenFunctionResponse) {
      await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
    }

    // 2.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与流式 handleChatStream 对齐，避免悬空 functionCall/pending diff 跨回合残留）
    // H1：先等旧流完全退出，再执行清理与写入用户消息（避免旧流结算落在新用户消息之后）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 3. 添加输入到历史；真实用户消息在创建时一次性携带动态上下文快照。
    if (hiddenFunctionResponse) {
      await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
    } else {
      const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
      const persistedMessageId = messageId || randomUUID();
      const internalMessage = isInternalMessageSource(request.source);
      const turnDynamicContext = internalMessage
        ? undefined
        : await this.toolIterationLoopService.createTurnDynamicContext(
            conversationId,
            persistedMessageId,
            promptModeSnapshot,
            dynamicContextStrategy
          );
      await this.conversationManager.addMessage(conversationId, 'user', userParts, {
        isUserInput: !internalMessage,
        source: request.source,
        ...(turnDynamicContext
          ? { turnDynamicContext, turnDynamicContextStrategy: dynamicContextStrategy }
          : {})
      }, persistedMessageId);
      if (request.source === 'agent_message' && request.agentMessageClaimId) {
        agentMailbox.acknowledgeMessageClaim(conversationId, MAIN_SESSION_RUN_ID, request.agentMessageClaimId);
      }
    }

    // 4. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
      !hiddenFunctionResponse && !isInternalMessageSource(request.source),
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        // maxToolIterations=-1 无限制模式的硬性兜底保障触发时，优先透出明确的
        // 硬性保障错误（迭代硬上限/墙钟时间上限）；否则走通用最大迭代次数错误。
        error: loopResult.guardError ?? {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义——abort 后若返回 success:true + content:undefined，
    // 前端会把取消当成功处理；流式路径已有 cancelled 输出，这里与之一致。
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
   * 流式 Chat 流程
   */
  async *handleChatStream(
    request: ChatRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, message, messageId, modelOverride, hiddenFunctionResponse } = request;

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

    if (!isValidAgentMessageClaim(request)) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_AGENT_MESSAGE_CLAIM',
          message: 'The agent message claim is missing, stale, or does not match the mailbox payload.'
        }
      };
      return;
    }

    const approvalValidationError = await this.validateHiddenContinuationApproval(conversationId, hiddenFunctionResponse);
    if (approvalValidationError) {
      yield {
        conversationId,
        error: approvalValidationError.error
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot, request.dynamicContextStrategyOverride);

    if (!hiddenFunctionResponse) {
      await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
    }


    // 3. 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器、
    //    拒绝所有未响应的工具调用（在添加用户消息之前，确保 functionResponse
    //    会被插入到工具调用消息之后、用户消息之前）
    // H1：先等旧流完全退出（webview 层已等待过一遍，这里对直接调用入口兜底），
    // 避免旧流取消结算落在新用户消息之后（半截旧回答/错位结算）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    try {
      // 4/5/6. 写入输入到历史：
      // - 普通模式：用户文本消息 + before/after checkpoint
      // - 隐藏模式：写入（或替换）functionResponse，不创建可见 user 文本消息，也不创建用户消息 checkpoint
      if (!hiddenFunctionResponse) {
        // 4. 为用户消息创建存档点（如果配置了执行前）
        const beforeUserCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
          conversationId,
          'before',
        );
        if (beforeUserCheckpoint) {
          // 立即发送用户消息前存档点到前端
          yield {
            conversationId,
            checkpoints: [beforeUserCheckpoint],
            checkpointOnly: true as const,
          } satisfies ChatStreamCheckpointsData;
        }

        // 5. 添加用户消息到历史（包含附件）；携带前端稳定节点 id（BR-01 对齐）
        const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
        const persistedMessageId = messageId || randomUUID();
        const internalMessage = isInternalMessageSource(request.source);
        const turnDynamicContext = internalMessage
          ? undefined
          : await this.toolIterationLoopService.createTurnDynamicContext(
              conversationId,
              persistedMessageId,
              promptModeSnapshot,
              dynamicContextStrategy
            );
        await this.conversationManager.addMessage(conversationId, 'user', userParts, {
          isUserInput: !internalMessage,
          source: request.source,
          ...(turnDynamicContext
            ? { turnDynamicContext, turnDynamicContextStrategy: dynamicContextStrategy }
            : {})
        }, persistedMessageId);

        if (request.source === 'agent_message' && request.agentMessageClaimId) {
          agentMailbox.acknowledgeMessageClaim(conversationId, MAIN_SESSION_RUN_ID, request.agentMessageClaimId);
        }

        // 注：用户消息的 token 计数将在 ContextTrimService.getHistoryWithContextTrimInfo 中
        // 与系统提示词、动态上下文一起并行计算，节省时间

        // 6. 为用户消息创建存档点（如果配置了执行后）
        const afterUserCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
          conversationId,
          'after',
        );
        if (afterUserCheckpoint) {
          yield {
            conversationId,
            checkpoints: [afterUserCheckpoint],
            checkpointOnly: true as const,
          } satisfies ChatStreamCheckpointsData;
        }
      } else {
        await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
      }
    } finally {
      // 7. 重置中断标记：中途任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消（对照 delete 路径的 finally 用法）。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }

    // 8. 判断是否是首条消息（需要刷新动态系统提示词）
    const currentHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    // 只有首条真实用户消息（逻辑截断下排除 isSummarized 残留）
    const isFirstMessage = isFirstMessageHistory(currentHistoryCheck);

    // 9. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage,
      maxIterations: maxToolIterations,
      isNewTurn: !hiddenFunctionResponse && !isInternalMessageSource(request.source),
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 工具确认流程
   */
  async *handleToolConfirmation(
    request: ToolConfirmationResponseData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, toolResponses, modelOverride } = request;

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

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    // 3. 寻找最后一条包含工具调用的 model 消息及其索引
    const history = await this.conversationManager.getHistoryRef(conversationId);
    if (history.length === 0) {
      yield {
        conversationId,
        error: {
          code: 'NO_HISTORY',
          message: t('modules.api.chat.errors.noHistory'),
        },
      };
      return;
    }

    // 从后往前找最近的一个 model 消息，它必须包含函数调用
    let modelMessageIndex = -1;
    let lastMessage: Content | undefined;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'model') {
        const calls = this.toolCallParserService.extractFunctionCalls(history[i]);
        if (calls.length > 0) {
          modelMessageIndex = i;
          lastMessage = history[i];
          break;
        }
      }
    }

    if (!lastMessage || modelMessageIndex === -1) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_STATE',
          message: t('modules.api.chat.errors.lastMessageNotModel'),
        },
      };
      return;
    }

    const allFunctionCalls = this.toolCallParserService.extractFunctionCalls(lastMessage);
    
    // 收集所有已经存在的函数响应 ID
    const respondedToolIds = new Set<string>();
    for (let i = modelMessageIndex + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg.parts) {
        for (const part of msg.parts) {
          if (part.functionResponse?.id) {
            respondedToolIds.add(part.functionResponse.id);
          }
        }
      }
    }

    // 过滤掉已经有响应的工具调用（比如已经自动执行过的）
    const pendingCalls = allFunctionCalls.filter(call => !respondedToolIds.has(call.id));

    if (pendingCalls.length === 0) {
      // 如果没有待确认的工具，可能是已经被其他操作处理了，直接继续循环
      for await (const output of this.toolIterationLoopService.runToolLoop({
        conversationId,
        configId,
        config,
        modelOverride,
        abortSignal: request.abortSignal,
        summarizeAbortSignal: request.summarizeAbortSignal,
        isFirstMessage: false,
        maxIterations: this.getMaxToolIterations(),
        createBeforeModelCheckpoint: false,
        isNewTurn: false,
        promptModeSnapshot,
        dynamicContextStrategy,
      })) {
        yield output as ChatStreamOutput;
      }
      return;
    }

    // 4. 按“队列顺序”处理工具：一次只允许推进到下一个需要批准的工具。
    // 目标：工具之间解耦，但严格保证顺序（后一个必须等前一个成功/失败后才开始）。

    const messageIndex = modelMessageIndex;

    // 队首待处理工具（按 AI 输出顺序）。
    // 走到这里时 pendingCalls.length > 0（为空则在 2311 已提前返回），相同谓词的
    // find 必命中——原不可达的「继续循环」分支（旧 2339-2358）已删除，这里非空断言。
    const nextCall = allFunctionCalls.find(call => !respondedToolIds.has(call.id))!;

    const nextDecision = toolResponses.find(r => r.id === nextCall.id);
    if (!nextDecision) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_TOOL_CONFIRMATION',
          message: `Invalid tool confirmation. Expected toolId=${nextCall.id}, got=${toolResponses.map(r => r.id).join(',')}`,
        },
      };
      return;
    }

    const toolResultsThisTurn: Array<{ id: string; name: string; result: Record<string, unknown> }> = [];
    const checkpointsThisTurn: CheckpointRecord[] = [];

    let responseParts: ContentPart[] = [];
    let multimodalAttachments: ContentPart[] = [];

    const mergeExecutionResult = (res: ToolExecutionFullResult) => {
      toolResultsThisTurn.push(...res.toolResults);
      checkpointsThisTurn.push(...res.checkpoints);
      responseParts.push(...res.responseParts);
      if (res.multimodalAttachments && res.multimodalAttachments.length > 0) {
        multimodalAttachments.push(...res.multimodalAttachments);
      }
    };

    const resolvedIdsThisTurn = new Set<string>();

    // 4.1 先处理队首工具（该工具一定是“当前等待批准”的那个）
    if (nextDecision.confirmed) {
      const gen = this.toolExecutionService.executeFunctionCallsWithProgress(
        [nextCall],
        conversationId,
        messageIndex,
        config,
        request.abortSignal,
        promptModeSnapshot,
        new Set([nextCall.id]),
        undefined,
        undefined,
        // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
        conversationId,
        MAIN_SESSION_RUN_ID,
        // 主会话路径无嵌套深度、无工作区 URI（General Worker 模型继承见下）
        undefined,
        undefined,
        // General Worker 模型继承：把主会话当前模型透传给工具上下文
        modelOverride
      );

      while (true) {
        // gen.next() 与 abort race（复用 ToolIterationLoopService 857-870 行 abort-race 模式）：
        // 若当前工具不响应 abortSignal 且永不结束，单独的 await gen.next() 会让整个请求
        // （含停止按钮）永久挂起。abort 先到时先给生成器一个短暂收尾窗口：响应 abort 的
        // 工具会快速返回已完成部分的真实结果（不能丢，否则历史只剩“用户拒绝”占位），
        // 窗口结束仍未返回则放弃，随后由下方 abort 检查输出 cancelled 可读信号。
        const { abortPromise, dispose } = createAbortRacePromise(request.abortSignal);
        try {
          const nextPromise = gen.next();
          const winner = abortPromise
            ? await Promise.race([nextPromise, abortPromise])
            : await nextPromise;
          if (winner === undefined) {
            // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果
            const drainedResult = await drainToolExecutionGeneratorAfterAbort(
              gen,
              nextPromise,
              MAIN_LOOP_ABORT_DRAIN_GRACE_MS,
            );
            if (drainedResult) {
              mergeExecutionResult(drainedResult);
            }
            break;
          }
          const { value, done } = winner;
          if (done) {
            mergeExecutionResult(value as ToolExecutionFullResult);
            break;
          }

          const event = value as ToolExecutionProgressEvent;

          if (event.type === 'start') {
            yield {
              conversationId,
              content: lastMessage,
              toolsExecuting: true as const,
              pendingToolCalls: [{
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
              }],
            } satisfies ChatStreamToolsExecutingData;
            continue;
          }

          if (event.type === 'end') {
            // C-19：工具结果按宽松形状窄化访问（unknown 收窄），替代裸 as any
            const r = event.toolResult.result as {
              success?: boolean;
              error?: string;
              cancelled?: boolean;
              rejected?: boolean;
              data?: { partial?: boolean; status?: string; appliedCount?: number; failedCount?: number };
            } | null | undefined;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && (r.data.partial === true || r.data.status === 'partial' || ((r.data.appliedCount ?? 0) > 0 && (r.data.failedCount ?? 0) > 0))) {
              status = 'warning';
            }

            yield {
              conversationId,
              toolStatus: true as const,
              tool: {
                id: event.call.id,
                name: event.call.name,
                status,
                result: event.toolResult.result,
              },
            } satisfies ChatStreamToolStatusData;
          }
        } finally {
          dispose();
        }
      }

      resolvedIdsThisTurn.add(nextCall.id);
    } else {
      await this.conversationManager.rejectToolCalls(conversationId, messageIndex, [nextCall.id]);

      const rejectedResult = {
        success: false,
        error: t('modules.api.chat.errors.userRejectedTool'),
        rejected: true,
      };

      toolResultsThisTurn.push({
        id: nextCall.id,
        name: nextCall.name,
        result: rejectedResult,
      });

      yield {
        conversationId,
        toolStatus: true as const,
        tool: {
          id: nextCall.id,
          name: nextCall.name,
          status: 'error',
          result: rejectedResult,
        },
      } satisfies ChatStreamToolStatusData;

      resolvedIdsThisTurn.add(nextCall.id);
    }

    // 4.2 继续自动执行“紧随其后、且无需批准”的工具，直到遇到下一个需要批准的工具
    const nextIndex = allFunctionCalls.findIndex(c => c.id === nextCall.id);
    const autoSuffix: typeof allFunctionCalls = [];
    let nextConfirmTool: (typeof allFunctionCalls)[number] | null = null;

    for (let i = nextIndex + 1; i < allFunctionCalls.length; i++) {
      const c = allFunctionCalls[i];
      if (respondedToolIds.has(c.id) || resolvedIdsThisTurn.has(c.id)) {
        continue;
      }
      if (this.toolExecutionService.toolNeedsConfirmation(c.name, c.args, promptModeSnapshot)) {
        nextConfirmTool = c;
        break;
      }
      autoSuffix.push(c);
    }

    if (autoSuffix.length > 0) {
      const gen = this.toolExecutionService.executeFunctionCallsWithProgress(
        autoSuffix,
        conversationId,
        messageIndex,
        config,
        request.abortSignal,
        promptModeSnapshot,
        undefined,
        undefined,
        undefined,
        // A-COMM：主会话信箱按 conversationId + 主会话保留 runId 挂载
        conversationId,
        MAIN_SESSION_RUN_ID,
        // 主会话路径无嵌套深度、无工作区 URI（General Worker 模型继承见下）
        undefined,
        undefined,
        // General Worker 模型继承：把主会话当前模型透传给工具上下文
        modelOverride
      );

      while (true) {
        // 与上方队首工具循环相同的 abort-race + 收尾窗口模式：
        // 不响应 abort 且永不结束的工具不再让请求（含停止按钮）永久挂起；
        // abort 后由下方 abort 检查输出 cancelled 可读信号。
        const { abortPromise, dispose } = createAbortRacePromise(request.abortSignal);
        try {
          const nextPromise = gen.next();
          const winner = abortPromise
            ? await Promise.race([nextPromise, abortPromise])
            : await nextPromise;
          if (winner === undefined) {
            // abort 先到：收尾窗口内等生成器返回已完成部分的真实结果
            const drainedResult = await drainToolExecutionGeneratorAfterAbort(
              gen,
              nextPromise,
              MAIN_LOOP_ABORT_DRAIN_GRACE_MS,
            );
            if (drainedResult) {
              mergeExecutionResult(drainedResult);
            }
            break;
          }
          const { value, done } = winner;
          if (done) {
            mergeExecutionResult(value as ToolExecutionFullResult);
            break;
          }

          const event = value as ToolExecutionProgressEvent;

          if (event.type === 'start') {
            yield {
              conversationId,
              content: lastMessage,
              toolsExecuting: true as const,
              pendingToolCalls: [{
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
              }],
            } satisfies ChatStreamToolsExecutingData;
            continue;
          }

          if (event.type === 'end') {
            // C-19：工具结果按宽松形状窄化访问（unknown 收窄），替代裸 as any
            const r = event.toolResult.result as {
              success?: boolean;
              error?: string;
              cancelled?: boolean;
              rejected?: boolean;
              data?: { partial?: boolean; status?: string; appliedCount?: number; failedCount?: number };
            } | null | undefined;
            let status: ChatStreamToolStatusData['tool']['status'] = 'success';
            if (r?.success === false || r?.error || r?.cancelled || r?.rejected) {
              status = 'error';
            } else if (r?.data && (r.data.partial === true || r.data.status === 'partial' || ((r.data.appliedCount ?? 0) > 0 && (r.data.failedCount ?? 0) > 0))) {
              status = 'warning';
            }

            yield {
              conversationId,
              toolStatus: true as const,
              tool: {
                id: event.call.id,
                name: event.call.name,
                status,
                result: event.toolResult.result,
              },
            } satisfies ChatStreamToolStatusData;
          }
        } finally {
          dispose();
        }
      }

      for (const c of autoSuffix) {
        resolvedIdsThisTurn.add(c.id);
      }
    }

    // 5. 持久化本轮已执行工具的真实结果。
    // 必须在 abort 检查之前执行：cancelStream 的 rejectAllPendingToolCalls
    // 会抢先写入「用户拒绝」占位，若等 abort 检查后再写，addContent 的去重
    // 会把真实结果丢弃（副作用已发生：文件已写、命令已跑、检查点已建）。
    // settleFunctionResponses 会用真实结果就地覆盖占位，同时清除 functionCall.rejected 标记。
    if (responseParts.length > 0 || multimodalAttachments.length > 0) {
      const settleParts = multimodalAttachments.length > 0
        ? [...multimodalAttachments, ...responseParts]
        : responseParts;

      await this.conversationManager.settleFunctionResponses(conversationId, settleParts);
    }

    // 5. 检查是否已被中断。持久化（上方的 settleFunctionResponses）
    // 必须在 abort 检查之前执行，否则真实执行产生的工具结果会被丢弃，
    // 历史里只剩 rejectAllPendingToolCalls 写下的「用户拒绝」占位。
    if (request.abortSignal?.aborted) {
      yield {
        conversationId,
        cancelled: true as const,
      } satisfies ChatStreamCancelledData;
      return;
    }

    const postToolStopState = await resolveAndPersistPostToolStopState(
      this.conversationManager,
      conversationId,
      allFunctionCalls,
      toolResultsThisTurn,
      {
        logger: this.log,
        logContext: { executionPath: 'tool_confirmation' }
      }
    );

    if (postToolStopState.shouldStop) {
      yield {
        conversationId,
        content: lastMessage,
        toolIteration: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolIterationData;
      return;
    }

    // 如果本轮存在 cancelled，则不再继续推进，也不再等待下一次确认
    const hasCancelledTools = toolResultsThisTurn.some(r => {
      const result = r.result as { cancelled?: boolean } | null | undefined;
      return result?.cancelled === true;
    });
    if (hasCancelledTools) {
      yield {
        conversationId,
        content: lastMessage,
        toolIteration: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolIterationData;
      return;
    }

    // 6. 如果还有需要批准的工具，进入等待确认阶段（不触发 toolIteration，也不继续 AI）
    if (nextConfirmTool) {
      yield {
        conversationId,
        pendingToolCalls: [{
          id: nextConfirmTool.id,
          name: nextConfirmTool.name,
          args: nextConfirmTool.args,
        }],
        content: lastMessage,
        awaitingConfirmation: true as const,
        toolResults: toolResultsThisTurn,
        checkpoints: checkpointsThisTurn,
      } satisfies ChatStreamToolConfirmationData;
      return;
    }

    // 7. 工具队列已全部完成，发送 toolIteration，并继续 AI 对话
    yield {
      conversationId,
      content: lastMessage,
      toolIteration: true as const,
      toolResults: toolResultsThisTurn,
      checkpoints: checkpointsThisTurn,
    } satisfies ChatStreamToolIterationData;

    // 注：工具响应和批注消息的 token 计数将在 getHistoryWithContextTrimInfo 中
    // 与系统提示词、动态上下文一起并行计算

    // 8. 继续 AI 对话（让 AI 处理工具结果）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      // 工具确认后的继续对话不视为首条消息
      isFirstMessage: false,
      maxIterations: maxToolIterations,
      // 原逻辑未在确认后的循环中创建模型消息前检查点，这里保持一致
      createBeforeModelCheckpoint: false,
      isNewTurn: false,
      promptModeSnapshot,
      dynamicContextStrategy,
    })) {
      yield output as ChatStreamOutput;
    }
  }

  /**
   * 删除到指定消息的流程
   */
  async handleDeleteToMessage(
    request: DeleteToMessageRequestData,
  ): Promise<DeleteToMessageSuccessData | DeleteToMessageErrorData> {
    const { conversationId, targetIndex, preserveCheckpointId } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // H1：先等旧流完全退出，再执行删除（旧流取消结算若落在删除之后会把已删内容追加回来）
    await this.waitForOldStreamExit(conversationId);

    // 2. 中断之前未完成的 diff 等待
    this.diffInterruptService.markUserInterrupt(conversationId);

    try {
      // M1：请求带 messageId 时校验索引处消息 id 一致，防止索引漂移误删其他消息。
      // 旧前端不传时保持旧行为。
      const requestMessageId = request.messageId;
      // 决策 6：删除前捕获锚点（第一个被删消息 id）与最后保留消息 id，供删除后同步软删分支图子树。
      // 必须同时用于 M1 校验：在校验与删除之间不得有其他写入（rejectAllPendingToolCalls 只追加）。
      const historyBeforeDelete = await this.conversationManager.getMessagesRaw(conversationId);
      // C-3：校验 targetIndex 边界。负数/越界此前会让 deletedFromMessageId 变 null、删除语义错误，
      // 这里在删除动作前显式拒绝，返回明确的 INVALID_TARGET_INDEX。
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= historyBeforeDelete.length) {
        return {
          success: false,
          error: {
            code: 'INVALID_TARGET_INDEX',
            message: t('modules.api.chat.errors.invalidTargetIndex', { targetIndex }),
          },
        };
      }
      if (typeof requestMessageId === 'string' && requestMessageId.trim() !== '') {
        const targetMessage = historyBeforeDelete[targetIndex];
        if (!targetMessage || targetMessage.id !== requestMessageId.trim()) {
          return {
            success: false,
            error: {
              code: 'MESSAGE_CHANGED',
              message: t('modules.api.chat.errors.messageChanged'),
            },
          };
        }
      }

      // 3. 取消所有待处理的 diff（关闭编辑器并恢复文件）
      await this.diffInterruptService.cancelAllPending(conversationId);
      
      // 4. 拒绝所有未响应的工具调用并持久化
      await this.conversationManager.rejectAllPendingToolCalls(conversationId);

      await this.clearPendingApprovalGateIfPresent(conversationId, 'delete_to_message');

      // 5. 删除关联的检查点（回档场景下保留刚用于恢复的存档点，支持反复回档）
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, targetIndex, preserveCheckpointId);

      // 6. 删除消息
      const deletedFromMessageId = historyBeforeDelete[targetIndex]?.id ?? null;
      const lastKeptMessageId = targetIndex > 0 ? (historyBeforeDelete[targetIndex - 1]?.id ?? null) : null;
      const deletedCount = await this.conversationManager.deleteToMessage(conversationId, targetIndex);

      // 6.2 决策 6：删除成功后同步软删分支图「该点之后」的整棵子树（TREE-09 软删语义：
      // 节点标记 deleted + deletedAt，不物理移除 sidecar；活跃尾同步回退到保留锚点）。
      // 锁取舍：deleteToMessage 的仓储互斥（会话写锁）已随方法返回释放，此处再取会话写锁
      // 是顺序获取（非嵌套），故同步 await 而非 fire-and-forget——删除响应返回前保证分支图一致
      // （避免响应后立即续写新消息时 appendHistoryToGraph 挂在已被硬删除的旧尾上）。
      // 失败仅告警不阻断：主历史为唯一真源，硬删除已提交，图侧由下次读图/写图自校验兜底。
      try {
        const branchService = getGlobalBranchService();
        if (branchService) {
          // 截断区间内含总结消息：原文的 isSummarized 标记已恢复，必须按当前主历史重建
          // 活跃路径与消息元数据（summary_deleted），否则切分支后已恢复的原文会被图中
          // 陈旧的 isSummarized 元数据重新压缩；否则走常规「软删被删节点及其后续子树」。
          const deletedWasSummary = historyBeforeDelete
            .slice(targetIndex)
            .some(message => message.isSummary === true);
          if (deletedWasSummary) {
            await branchService.syncMainHistoryAfterStructuralMutation(conversationId, 'summary_deleted');
          } else {
            await branchService.syncGraphAfterHistoryDelete(conversationId, deletedFromMessageId, {
              lastKeptMessageId,
            });
          }
        }
      } catch (error) {
        this.log.warn('branch_delete_to_sync_failed', {
          conversationId,
          targetIndex,
          error: (error as Error)?.message ?? String(error),
        });
      }

      // 6.5 根据剩余历史重放 todo 工具，修正 ConversationMetadata.custom.todoList
      await this.rebuildTodoListMetadataFromHistory(conversationId);
      
      // 7. 清除裁剪状态（回退后应重新计算裁剪）
      await this.toolIterationLoopService.clearTrimState(conversationId);

      return {
        success: true,
        deletedCount,
      };
    } finally {
      // 8. 重置 diff 中断标记：mark 之后的任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消。
      this.diffInterruptService.resetUserInterrupt(conversationId);
    }
  }
}
