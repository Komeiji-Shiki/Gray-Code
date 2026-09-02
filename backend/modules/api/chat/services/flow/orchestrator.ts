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
import { RepeatedCallGuard } from '../repeatedCallGuard';
import type { ToolExecutionFullResult, ToolExecutionProgressEvent } from '../ToolExecutionService';
import type { Content, ContentPart } from '../../../../conversation/types';
import { ConversationMessageChangedError } from '../../../../conversation/ConversationManager';
import type { CheckpointRecord } from '../../../../checkpoint';
import {
  agentMailbox,
  formatAgentMessagesForModel,
  MAIN_SESSION_RUN_ID
} from '../../../../../core/services/agentMailbox';
import { resolveAndPersistPostToolStopState } from '../postToolStopState';
import { ChatStreamOutput, ChatStreamCancelledData, ChatFlowContext, ChatFlowDeps, isFirstMessageHistory } from './context';
import { extractAffectedPaths, workspaceUriToFsPath } from '../../../../checkpoint/affectedPaths';
import { normalizeForegroundWorkTransition } from '../../../../conversation/foregroundWorkTransition';

function isInternalMessageSource(source: ChatRequestData['source']): boolean {
  return source === 'background_task' || source === 'agent_message';
}

/** 最近真实用户消息持久化的 Vision 模式；工具确认续跑不再依赖前端临时状态。 */
function resolvePersistedDeepSeekVisionMode(history: ReadonlyArray<Content>, fallback = true): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === 'user' && message.isUserInput === true
        && typeof message.deepSeekVisionTileSplit === 'boolean') {
      return message.deepSeekVisionTileSplit;
    }
  }
  return fallback;
}

function isValidAgentMessageClaim(request: ChatRequestData): boolean {
  if (request.source !== 'agent_message') return true;
  const claimId = request.agentMessageClaimId?.trim();
  if (!claimId) return false;
  const claim = agentMailbox.getMessageClaim(request.conversationId, MAIN_SESSION_RUN_ID, claimId);
  return !!claim && formatAgentMessagesForModel(claim.messages) === request.message;
}

/**
 * 在真正准备写入会话记录前独占本批后台结果。
 *
 * 单纯“再检查一次领取是否存在”仍有检查后被另一页面退回、随后重复领取的竞态；
 * beginMessageClaimDelivery 会把检查与占用合并为一个同步操作，并让写入期间的 release 失败。
 */
function beginAgentMessageClaimDelivery(request: ChatRequestData): boolean {
  if (request.source !== 'agent_message') return true;
  const claimId = request.agentMessageClaimId?.trim();
  if (!claimId || !isValidAgentMessageClaim(request)) return false;
  return agentMailbox.beginMessageClaimDelivery(request.conversationId, MAIN_SESSION_RUN_ID, claimId);
}

/** 写入未成功确认时解除独占，保留原领取供后续重试。 */
function endAgentMessageClaimDelivery(request: ChatRequestData): void {
  if (request.source !== 'agent_message') return;
  const claimId = request.agentMessageClaimId?.trim();
  if (!claimId) return;
  agentMailbox.endMessageClaimDelivery(request.conversationId, MAIN_SESSION_RUN_ID, claimId);
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

    // 2.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与流式 handleChatStream 对齐，避免悬空 functionCall/pending diff 跨回合残留）
    // H1：先等旧流完全退出，再执行清理与写入用户消息（避免旧流结算落在新用户消息之后）
    await this.waitForOldStreamExit(conversationId);
    if (!beginAgentMessageClaimDelivery(request)) {
      return {
        success: false,
        error: {
          code: 'INVALID_AGENT_MESSAGE_CLAIM',
          message: 'The agent message claim is missing, stale, or does not match the mailbox payload.',
        },
      };
    }

    try {
      // 最终领取校验/独占之后才执行会改变会话状态的清理。若同一批结果已经被另一请求
      // 写入并确认，本请求会在上面直接结束，不会误清审批状态或拒绝工具调用。
      if (!hiddenFunctionResponse) {
        await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
      }
      await this.prepareConversationForRequest(conversationId);

      // 3. 添加输入到历史；真实用户消息在创建时一次性携带动态上下文快照。
      if (hiddenFunctionResponse) {
        await this.upsertHiddenFunctionResponse(conversationId, hiddenFunctionResponse);
      } else {
        const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
        const persistedMessageId = messageId || randomUUID();
        const internalMessage = isInternalMessageSource(request.source);
        const foregroundWorkTransition = internalMessage
          ? undefined
          : normalizeForegroundWorkTransition(request.foregroundWorkTransition);
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
          ...(!internalMessage
            ? { deepSeekVisionTileSplit: request.deepSeekVisionTileSplit ?? true }
            : {}),
          ...(foregroundWorkTransition ? { foregroundWorkTransition } : {}),
          ...(turnDynamicContext
            ? { turnDynamicContext, turnDynamicContextStrategy: dynamicContextStrategy }
            : {})
        }, persistedMessageId);
        if (request.source === 'agent_message' && request.agentMessageClaimId) {
          agentMailbox.acknowledgeMessageClaim(conversationId, MAIN_SESSION_RUN_ID, request.agentMessageClaimId);
        }
      }
    } finally {
      // acknowledge 已成功时会同时清掉独占状态；此前任一步抛错则只解除独占，
      // 领取内容仍在，下一次空闲调度可以原样重试。
      endAgentMessageClaimDelivery(request);
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
      request.deepSeekVisionTileSplit,
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

    // C-1：非流式路径透传取消语义——abort 后若返回 success:true + content:undefined，
    // 前端会把取消当成功处理；流式路径已有 cancelled 输出，这里与之一致。
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.channel.errors.requestCancelled'),
        },
      };
    }

    // content 为空（工具循环异常路径未产出内容）或 parts 为空时显式返回错误，
    // 不再用非空断言透传 success:true + content:undefined（前端会把空响应当成功处理）。
    // EMPTY_RESPONSE 使用独立文案（模型返回了空内容），不复用 requestCancelled 的
    // 「请求已取消」——正常空输出与取消语义不同，避免误导用户。
    if (!loopResult.content?.parts?.length) {
      return {
        success: false,
        error: {
          code: 'EMPTY_RESPONSE',
          message: t('modules.channel.errors.emptyResponse'),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content,
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

    // 3. 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器、
    //    拒绝所有未响应的工具调用（在添加用户消息之前，确保 functionResponse
    //    会被插入到工具调用消息之后、用户消息之前）
    // H1：先等旧流完全退出（webview 层已等待过一遍，这里对直接调用入口兜底），
    // 避免旧流取消结算落在新用户消息之后（半截旧回答/错位结算）
    await this.waitForOldStreamExit(conversationId);
    // claim 在等待旧流期间可能已被另一条同会话重试写入历史并 ack。初始校验只能
    // 拦截请求进入时的陈旧 claim；真正做 prepare/addMessage 前必须再验一次，避免
    // “后端已启动、前端因切会话返回 false 后重试”把同一后台结果写入两遍。
    if (!beginAgentMessageClaimDelivery(request)) {
      yield {
        conversationId,
        error: {
          code: 'INVALID_AGENT_MESSAGE_CLAIM',
          message: 'The agent message claim is missing, stale, or does not match the mailbox payload.'
        }
      };
      return;
    }

    try {
      // 只有成功独占这批后台结果的请求才允许修改审批/工具状态。
      if (!hiddenFunctionResponse) {
        await this.clearPendingApprovalGateIfPresent(conversationId, 'visible_user_message');
      }
      await this.prepareConversationForRequest(conversationId);

      // 4/5/6. 写入输入到历史：
      // - 普通模式：用户文本消息 + before/after checkpoint
      // - 隐藏模式：写入（或替换）functionResponse，不创建可见 user 文本消息，也不创建用户消息 checkpoint
      if (!hiddenFunctionResponse) {
        // 4. 为用户消息创建存档点（如果配置了执行前）。仅创建快照，**不在此 yield**：
        //    ★ 关键修复：任何 yield 都必须发生在用户消息落库之后。消费端（
        //    StreamChunkProcessor.consume）在视图关闭/重载时 break 会触发生成器 return()——
        //    若在 addMessage 之前 yield，生成器被 return 后 addMessage 永远不会执行：
        //    主历史缺消息，但前端窗口仍保留乐观插入的消息，随后编辑/重试按 id 定位
        //    必然报 NODE_NOT_FOUND（新对话首条消息即必现，用户实测）。
        const beforeUserCheckpoint = await this.checkpointService.createUserMessageCheckpoint(
          conversationId,
          'before',
        );

        // 5. 添加用户消息到历史（包含附件）；携带前端稳定节点 id（BR-01 对齐）
        const userParts = this.messageBuilderService.buildUserMessageParts(message, request.attachments);
        const persistedMessageId = messageId || randomUUID();
        const internalMessage = isInternalMessageSource(request.source);
        const foregroundWorkTransition = internalMessage
          ? undefined
          : normalizeForegroundWorkTransition(request.foregroundWorkTransition);
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
          ...(!internalMessage
            ? { deepSeekVisionTileSplit: request.deepSeekVisionTileSplit ?? true }
            : {}),
          ...(foregroundWorkTransition ? { foregroundWorkTransition } : {}),
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
        // 6.5 统一在此 yield 存档点（先 before 后 after）。before 快照的创建时机仍在
        //     addMessage 之前（快照语义不变），仅 yield 延迟到消息落库之后，
        //     保证生成器在落库前后的任何终止点都不会留下「窗口有消息、历史无消息」的幽灵。
        if (beforeUserCheckpoint) {
          yield {
            conversationId,
            checkpoints: [beforeUserCheckpoint],
            checkpointOnly: true as const,
          } satisfies ChatStreamCheckpointsData;
        }
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
      // 写入前失败或生成器被取消时允许后续重试；写入成功后 acknowledge 已经消费领取，
      // 此调用为幂等 no-op。
      endAgentMessageClaimDelivery(request);
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
      deepSeekVisionTileSplit: request.deepSeekVisionTileSplit,
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

    // 同参数重复失败护栏（与主循环 runToolLoop 对齐）：本次确认回合内跨队首工具与
    // autoSuffix 执行存活，拦截模型用相同参数反复调用失败工具；被替换的调用由
    // ToolExecutionService 检测合成参数后直接返回短路错误结果，不进入真实执行。
    const repeatedCallGuard = new RepeatedCallGuard();

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
    const deepSeekVisionTileSplit = resolvePersistedDeepSeekVisionMode(history);
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
        deepSeekVisionTileSplit,
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
    /** M3：本回合（及之前确认回合）被用户拒绝的工具 ID——补建批次 after 时排除 */
    const rejectedToolIdsThisTurn = new Set<string>();

    let responseParts: ContentPart[] = [];
    let multimodalAttachments: ContentPart[] = [];

    const mergeExecutionResult = (res: ToolExecutionFullResult) => {
      toolResultsThisTurn.push(...res.toolResults);
      // 与主循环一致：真实执行结果回灌护栏（rejected:true 的结果不计失败也不中断序列）
      repeatedCallGuard.recordResults(res.toolResults);
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
        repeatedCallGuard.guardCalls([nextCall]),
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
        modelOverride,
        // CPF-07：确认路径执行属于流式批次的一部分——批次 before/after 由批次维度统一管理
        // （before 已在确认事件前下发、after 在队列全部完成后补建），此处跳过工具级检查点，
        // 避免「批次存档 + 工具级存档」重复（此前每个确认工具会再自建一组 before/after）。
        'skip'
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
      // M3：记录被拒绝的工具——补建批次 after 时排除（未执行的工具不参与 afterTools 判定）
      rejectedToolIdsThisTurn.add(nextCall.id);

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
        repeatedCallGuard.guardCalls(autoSuffix),
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
        modelOverride,
        // CPF-07：与队首工具一致——确认回合内执行的工具统一跳过工具级检查点，
        // 批次 after 在队列全部完成后补建（见下方「队列已全部完成」分支）。
        'skip'
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

    // CPF-07：确认路径工具队列已全部完成（无下一个待确认工具）——补建批次 after。
    // 批次 before 已在流式阶段（确认事件下发前）创建；after 挂模型消息索引，
    // CheckpointManager 按批内工具与 afterTools 的交集精确判定（批内无配置 after 的工具则跳过）。
    // 多个确认回合时只在最后一个回合（队列耗尽）补建一次；取消/中断路径不补（与流式语义一致）。
    // M3：本回合被用户拒绝的工具从未执行，不计入批内工具名——
    // 否则「批内唯一工具被拒」也会因该工具的 afterTools 配置产生一对空批次存档。
    // 已知风险（保持现状，不改）：modelMessageIndex 来自「从后往前找最近一个含函数调用的 model 消息」，
    // 若该消息已被总结/裁剪，索引可能偏移——架构性改动超出本次范围，存档挂载位置不影响内容正确性。
    // checkpointService 未注入（测试 harness/降级环境）时跳过补建。
    if (this.checkpointService) {
      const executedBatchToolNames = allFunctionCalls
        .filter(c => !rejectedToolIdsThisTurn.has(c.id))
        .map(c => c.name);
      // CP-PARTIAL-1：确认路径补建批次 after 同样按受影响路径构建部分快照（不再全量扫描工作区）——
      // 仅当批内全部已执行工具都能确定受影响路径时透传，任一无法确定（execute_command 等）则回退全量。
      // 工作区根 fsPath 从会话元数据解析（getMetadata 防御性探测：测试替身可能未实现，缺失时回退全量）。
      let affectedPaths: string[] | undefined;
      let workspaceRootFsPath: string | undefined;
      try {
        const meta = await this.conversationManager.getMetadata(conversationId);
        workspaceRootFsPath = meta?.workspaceUri ? (workspaceUriToFsPath(meta.workspaceUri) ?? undefined) : undefined;
      } catch {
        // 元数据读取失败：回退全量
      }
      if (workspaceRootFsPath) {
        const accumulated: string[] = [];
        const seen = new Set<string>();
        for (const c of allFunctionCalls) {
          if (rejectedToolIdsThisTurn.has(c.id)) continue;
          const paths = extractAffectedPaths(c.name, c.args, workspaceRootFsPath);
          if (paths === null) {
            accumulated.length = 0;
            break;
          }
          for (const p of paths) {
            if (!seen.has(p)) {
              seen.add(p);
              accumulated.push(p);
            }
          }
        }
        if (accumulated.length > 0) {
          affectedPaths = accumulated;
        }
      }
      const batchAfterCheckpoint = await this.checkpointService.createToolExecutionCheckpoint(
        conversationId,
        modelMessageIndex,
        'tool_batch',
        'after',
        undefined,
        {
          batchToolNames: executedBatchToolNames,
          ...(affectedPaths ? { affectedPaths } : {}),
        }
      );
      if (batchAfterCheckpoint) {
        checkpointsThisTurn.push(batchAfterCheckpoint);
      }
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
      deepSeekVisionTileSplit,
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

    let diffInterruptMarked = false;
    try {
      // M1：请求带 messageId 时校验索引处消息 id 一致，防止后台子代理回执等并发写入
      // 让旧索引误删其他消息。旧前端不传时保持旧行为。
      const requestMessageId = request.messageId;
      const expectedMessageId = typeof requestMessageId === 'string' && requestMessageId.trim() !== ''
        ? requestMessageId.trim()
        : undefined;
      // 决策 6：分支图同步已收敛进 ConversationManager.deleteToMessage（锁内捕获锚点、
      // 锁外经 graphSyncQueues 串行队列执行，与 deleteMessage/clearHistory 同模式）；
      // 这里读取的历史只用于边界提示和 M1 快速预检。后续 diff/tool/checkpoint 清理均有
      // await，期间允许其他写入，所以并发正确性由 manager 的锁内最终校验保证。
      const historyBeforeDelete = await this.conversationManager.getMessagesRaw(conversationId);
      // C-3：校验 targetIndex 边界。负数/越界此前会让删除语义错误（deleteToMessage 锁内
      // 会重新校验并抛错），这里在删除动作前显式拒绝，返回明确的 INVALID_TARGET_INDEX。
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= historyBeforeDelete.length) {
        return {
          success: false,
          error: {
            code: 'INVALID_TARGET_INDEX',
            message: t('modules.api.chat.errors.invalidTargetIndex', { targetIndex }),
          },
        };
      }
      if (expectedMessageId) {
        const targetMessage = historyBeforeDelete[targetIndex];
        if (!targetMessage || targetMessage.id !== expectedMessageId) {
          return {
            success: false,
            error: {
              code: 'MESSAGE_CHANGED',
              message: t('modules.api.chat.errors.messageChanged'),
            },
          };
        }
      }

      // 3. 先原子删除消息（决策 6 分支图同步已收敛进 ConversationManager.deleteToMessage：锁内捕获
      // deletedFromMessageId / lastKeptMessageId / deletedWasSummary，锁外经 withGraphSyncQueue
      // 会话级串行队列同步软删「该点之后」的整棵子树，删除响应返回前图一致；失败仅告警不阻断，
      // 主历史为唯一真源。此处不再直接调用 BranchService——避免与 manager 侧双同步，且与
      // deleteMessage/clearHistory/restoreSnapshot 的队列互斥语义统一（先入队的 append 图同步
      // 必须先完成，再执行本次软删）。权威 messageId 校验必须是预检后的第一个持久化动作；
      // 否则陈旧请求虽然最终返回 MESSAGE_CHANGED，却已经取消 diff、拒绝工具调用或清掉审批门。
      let deletedCount = 0;
      const deletionCapture = { deletedMessageIds: [] as string[] };
      try {
        // expectedMessageId 会在 ConversationManager 的 mutateContents 写锁内再次校验；
      // 上面的预检只负责尽早失败，不能作为并发正确性的依据。
        const runPostDeleteCleanup = async (label: string, action: () => Promise<unknown>): Promise<void> => {
          try {
            await action();
          } catch (error) {
            console.warn(`[ChatFlow] Post-delete cleanup failed (${label})`, error);
          }
        };

        // 检查点操作锁必须覆盖 transcript 截断到检查点删除的完整窗口，锁序为
        // checkpoint → conversation。否则截断提交后、按旧 index 清理前，并发创建的
        // before 检查点可能落到相同 index 并被本次旧请求误删。
        await this.checkpointService.runWithCheckpointDeletionLock(
          conversationId,
          async deleteCheckpointsFromIndexLocked => {
            deletedCount = await this.conversationManager.deleteToMessage(
              conversationId,
              targetIndex,
              expectedMessageId,
              deletionCapture,
            );

            // 权威删除已经提交后才广播用户中断；陈旧 messageId 请求若在这里之前被拒绝，
            // 不应让仍在工作的 diff 观察到一次虚假的中断。
            this.diffInterruptService.markUserInterrupt(conversationId);
            diffInterruptMarked = true;

            // lineage 使用 manager 在截断锁内捕获的被删消息 ID；检查点删除失败属于派生清理
            // 失败，记录告警但不把已成功的 transcript 截断伪装成失败。
            await runPostDeleteCleanup('checkpoints', () => deleteCheckpointsFromIndexLocked(
              targetIndex,
              preserveCheckpointId,
              new Set(deletionCapture.deletedMessageIds),
            ));
          }
        );
      } catch (error) {
        if (error instanceof ConversationMessageChangedError) {
          return {
            success: false,
            error: {
              code: 'MESSAGE_CHANGED',
              message: t('modules.api.chat.errors.messageChanged'),
            },
          };
        }
        throw error;
      }

      // 4. 历史原子截断成功后再删除关联检查点。预检后的 await 若发生索引漂移，
      // 上面的锁内校验会先返回 MESSAGE_CHANGED，不能提前提交不可回滚的 checkpoint 删除。
      // lineage 必须使用 manager 在截断写锁内捕获的被删消息 ID；此时主历史已截断，
      // 若重新从 history.slice(targetIndex) 推导会得到空集合并错误保留分支检查点。
      // 从这里开始主历史已经提交，所有派生清理都降级为 best effort：其中任一失败若再向
      // 调用方报“删除失败”，用户按旧 index 重试只会得到 MESSAGE_CHANGED，并永久跳过其余清理。
      const runPostDeleteCleanup = async (label: string, action: () => Promise<unknown>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          console.warn(`[ChatFlow] Post-delete cleanup failed (${label})`, error);
        }
      };

      // 5. 删除已提交后，再清理本会话仍悬挂的编辑器、工具调用与审批状态。
      await runPostDeleteCleanup('pending diffs', () => this.diffInterruptService.cancelAllPending(conversationId));
      await runPostDeleteCleanup('pending tool calls', () => this.conversationManager.rejectAllPendingToolCalls(conversationId));
      await runPostDeleteCleanup('approval gate', () => this.clearPendingApprovalGateIfPresent(conversationId, 'delete_to_message'));

      // 6. 根据剩余历史重放 todo，并清除裁剪状态（回退后应重新计算裁剪）。
      await runPostDeleteCleanup('todo metadata', () => this.rebuildTodoListMetadataFromHistory(conversationId));
      await runPostDeleteCleanup('trim state', () => this.toolIterationLoopService.clearTrimState(conversationId));

      return {
        success: true,
        deletedCount,
      };
    } finally {
      // 8. 重置 diff 中断标记：mark 之后的任何 await 抛错都必须清理，
      // 否则全局中断标记残留，无会话 diff 被误取消。
      if (diffInterruptMarked) {
        this.diffInterruptService.resetUserInterrupt(conversationId);
      }
    }
  }
}
