/**
 * 聊天功能消息处理器
 * 
 * 处理删除消息等非流式操作
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import { t } from '../../backend/i18n';
import { setChatInputFocused } from '../../backend/core/chatFocusGuard';
import {
  agentMailbox,
  formatAgentMessagesForModel,
  MAIN_SESSION_RUN_ID
} from '../../backend/core/services/agentMailbox';
import {
    BranchGraphRepository,
    BranchService,
    getGlobalBranchService,
    setGlobalBranchService,
} from '../../backend/modules/conversation/branch';
import { ErrorType } from '../../backend/modules/channel';
import { StreamChunkProcessor } from '../stream/StreamChunkProcessor';
import {
    isConversationStreaming,
    BRANCH_BUSY_STREAMING_MESSAGE,
} from './streamGuard';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * awaitConversationIdle 总超时（毫秒）。
 * R2-09：waitForIdle 单轮等待上限为 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS（6s）且超时即返回
 * （不再每 6s 重试循环），自身实际上界 ≈6s；外层 10s race 仍保留作兜底（防 waitForIdle
 * 语义未来变化），超时视同空闲返回 {idle:true}（响应形状与调用方语义不变）。
 */
const AWAIT_CONVERSATION_IDLE_TIMEOUT_MS = 10_000;

async function stopConversationStream(ctx: HandlerContext, conversationId: string): Promise<void> {
  // R2-07：HandlerContext 契约已保证 streamAbortControllers 为 StreamAbortManager，
  // 移除恒真的 typeof 分支（死代码）与 Map 鸭子类型 fallback。
  await ctx.streamAbortControllers.abortAndWaitForCompletion(conversationId);
}

/**
 * 懒解析/创建全局 BranchService（与 BranchHandlers 同模式，供 rerollStream 后端流程使用）。
 * chat.rerollStream 是第一个可能不经分支 API 就触达分支服务的入口，必须在此确保服务已注册。
 */
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

/**
 * 删除消息（删除到指定位置）
 */
export const deleteMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex, messageId, preserveCheckpointId } = data || {};

  // 入参校验优先于任何副作用（取消流）：非法参数直接返回明确错误码，不触发取消动作
  // （与 deleteSingleMessage 的校验口径一致）
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || !Number.isInteger(targetIndex) || targetIndex < 0) {
    ctx.sendError(requestId, 'DELETE_MESSAGE_ERROR', 'Invalid conversationId or targetIndex');
    return;
  }

  // 带稳定消息 ID 的请求先做一次只读预检，再中止活跃流。陈旧窗口请求如果已经指向
  // 另一条消息，不应仅仅因为用户点了“删除并重发”就把当前仍在生成的正确请求取消掉。
  // 这里只负责快速拒绝；真正截断时 ConversationManager 仍会在会话写锁内再次核对 ID。
  const expectedMessageId = typeof messageId === 'string' && messageId.trim() !== ''
    ? messageId.trim()
    : undefined;
  if (expectedMessageId) {
    try {
      const currentMessage = await ctx.conversationManager.getMessage(conversationId, targetIndex);
      if (!currentMessage || currentMessage.id !== expectedMessageId) {
        ctx.sendResponse(requestId, {
          success: false,
          error: {
            code: 'MESSAGE_CHANGED',
            message: t('modules.api.chat.errors.messageChanged'),
          },
        });
        return;
      }
    } catch (error: any) {
      ctx.sendError(requestId, 'DELETE_MESSAGE_ERROR', error?.message || t('webview.errors.deleteMessageFailed'));
      return;
    }
  }

  // 先取消该对话的流式请求（如果有）
  // 取消只是“尽力而为”的前置清理：取消失败不应阻断删除主流程，独立 try/catch 仅告警。
  try {
    await stopConversationStream(ctx, conversationId);
  } catch (err) {
    console.warn('[ChatHandlers] Failed to cancel stream before deleteMessage:', err);
  }

  // L-3: handler 自身 try/catch——异常时发送明确错误码 DELETE_MESSAGE_ERROR（响应形状与通用错误一致）
  try {
    const result = await ctx.chatHandler.handleDeleteToMessage({
      conversationId,
      targetIndex,
      // 前端按窗口消息生成稳定 id；后台子代理回执/工具结算可能让绝对索引在 IPC
      // 往返期间漂移。透传 id 让后端在任何删除副作用前拒绝陈旧请求，不能只按 index。
      messageId: expectedMessageId,
      preserveCheckpointId
    });
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_MESSAGE_ERROR', error?.message || t('webview.errors.deleteMessageFailed'));
  }
};

/**
 * 删除单条消息
 */
export const deleteSingleMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex } = data || {};
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || !Number.isInteger(targetIndex) || targetIndex < 0) {
    ctx.sendError(requestId, 'DELETE_SINGLE_MESSAGE_ERROR', 'Invalid conversationId or targetIndex');
    return;
  }
  try {
    await stopConversationStream(ctx, conversationId);
    await ctx.conversationManager.deleteMessage(conversationId, targetIndex);

    // 删除本身已经成功，派生元数据刷新仅是维护动作，失败不能把主操作误报为失败。
    if (ctx.chatHandler) {
      try {
        await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(conversationId);
      } catch (refreshError) {
        console.warn('[ChatHandlers] Failed to refresh derived metadata after deleting a message:', refreshError);
      }
    }

    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_SINGLE_MESSAGE_ERROR', error?.message || t('webview.errors.deleteMessageFailed'));
  }
};

/**
 * 取消总结请求（仅取消总结 API，不中断主对话流）
 */
export const cancelSummarizeRequest: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'CANCEL_SUMMARIZE_INVALID_CONVERSATION', 'Invalid conversation ID');
    return;
  }

  const cancelled = !!ctx.streamAbortControllers?.cancelSummary(conversationId);
  ctx.sendResponse(requestId, { cancelled });
};

export const awaitConversationIdle: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'CONVERSATION_IDLE_INVALID_CONVERSATION', 'Invalid conversation ID');
    return;
  }

  // R2-07 阻塞队列防护：流未结束期间 handler 一直占住串行队列，cancelStream/deleteMessage
  // 等取消类消息全部排队；前端已有 race 超时放弃响应，扩展侧用总超时（10s）兜底。
  // R2-08 注释修正：waitForIdle 单轮等待上限为 OLD_STREAM_EXIT_WAIT_TIMEOUT_MS（6s），
  // 且超时即返回（不再每 6s 重试循环），自身实际上界 ≈6s；外层 10s race 仍保留作兜底
  // （防 waitForIdle 语义未来变化）——超时视同空闲返回 {idle:true}（响应形状与调用方语义不变）。
  const abortManager = ctx.streamAbortControllers;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>(resolve => {
    timer = setTimeout(resolve, AWAIT_CONVERSATION_IDLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([abortManager.waitForIdle(conversationId), timeoutPromise]);
  } finally {
    // waitForIdle 先落定时清理超时定时器，避免残留 open handle
    if (timer) clearTimeout(timer);
  }

  ctx.sendResponse(requestId, { idle: true });
};

/**
 * 用户消息插入（U1：主会话收件）
 *
 * 主会话工具循环/流式进行中，前端把用户消息投递到主会话 inbox
 * （key 为 conversationId，收件人为主会话保留 runId MAIN_SESSION_RUN_ID），
 * 由 ToolExecutionService 注入点在最近一次工具调用完成后带出，让主模型尽快感知。
 *
 * 与 chatStream 路径分离：不创建历史消息、不触发新的流式回合——
 * 用户消息是否落入历史由模型回复时决定（保持最小语义：仅投递）。
 */
export const sendInterruptMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, text } = data || {};

  try {
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      ctx.sendError(requestId, 'INTERRUPT_MESSAGE_INVALID_CONVERSATION', t('webview.errors.interruptMessageInvalidConversation'));
      return;
    }
    if (typeof text !== 'string' || !text.trim()) {
      ctx.sendError(requestId, 'INTERRUPT_MESSAGE_EMPTY_TEXT', t('webview.errors.interruptMessageEmptyText'));
      return;
    }

    // 校验会话存在（只读 ConversationManager，不写历史）
    const metadata = await ctx.conversationManager.getMetadata(conversationId);
    if (!metadata) {
      ctx.sendError(requestId, 'INTERRUPT_MESSAGE_CONVERSATION_NOT_FOUND', t('webview.errors.interruptMessageConversationNotFound'));
      return;
    }

    // 投递到主会话 inbox（含长度上限与每会话频率限制）
    const result = agentMailbox.sendUserMessageToMain(conversationId, text);
    if (!result.success) {
      const code = result.code === 'RATE_LIMITED'
        ? 'INTERRUPT_MESSAGE_RATE_LIMITED'
        : result.code === 'TEXT_TOO_LONG'
          ? 'INTERRUPT_MESSAGE_TEXT_TOO_LONG'
          : 'INTERRUPT_MESSAGE_ERROR';
      const message = result.error
        || (result.code === 'RATE_LIMITED'
          ? t('webview.errors.interruptMessageRateLimited')
          : t('webview.errors.interruptMessageFailed'));
      ctx.sendError(requestId, code, message);
      return;
    }

    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'INTERRUPT_MESSAGE_ERROR', error?.message || t('webview.errors.interruptMessageFailed'));
  }
};

export const claimAgentMessages: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'AGENT_MESSAGE_INVALID_CONVERSATION', 'Invalid conversation ID');
    return;
  }

  const metadata = await ctx.conversationManager.getMetadata(conversationId);
  if (!metadata) {
    ctx.sendError(requestId, 'AGENT_MESSAGE_CONVERSATION_NOT_FOUND', 'Conversation not found');
    return;
  }

  const claim = agentMailbox.claimMainSessionAgentMessages(conversationId);
  ctx.sendResponse(requestId, claim
    ? {
        claimId: claim.claimId,
        conversationId,
        message: formatAgentMessagesForModel(claim.messages),
        messageCount: claim.messages.length
      }
    : { claimId: null, conversationId, message: null, messageCount: 0 });
};

export const releaseAgentMessages: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  const claimId = typeof data?.claimId === 'string' ? data.claimId.trim() : '';
  if (!conversationId || !claimId) {
    ctx.sendError(requestId, 'AGENT_MESSAGE_RELEASE_INVALID_ARGS', 'conversationId and claimId are required');
    return;
  }
  const released = agentMailbox.releaseMessageClaim(conversationId, MAIN_SESSION_RUN_ID, claimId);
  ctx.sendResponse(requestId, { released });
};

/**
 * 聊天输入框焦点状态上报
 *
 * 前端输入框 focus/blur 时调用；扩展端在关闭 diff 标签页前据此判断
 * 是否需要在关闭后把焦点归还给聊天输入框（见 backend/core/chatFocusGuard.ts）。
 */
export const chatInputFocusState: MessageHandler = async (data, requestId, ctx) => {
  setChatInputFocused(data?.focused === true);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * reroll 流（TREE-01：重新生成并保留旧回答）。
 *
 * 入参：{ conversationId, assistantNodeId?, configId, modelOverride?, promptModeId?, streamId? }
 * - 后端创建新候选并把主历史切换到新候选路径，复用工具循环生成内容；
 * - 旧回答保留在分支图 sidecar 中（失败可切回，决策 10）；
 * - chunk 通过 streamChunk / streamChunkBatch 协议转发给前端（TREE-10 前端接入）。
 *
 * 本 handler 已按 StreamRequestHandler 模式接线（R6a-FIX）：
 * - H1：abortManager.create 注册取消控制器 + 透传 abortSignal + finally 注销（停止按钮/扩展关闭
 *   可取消 reroll 流，工具循环可中断；isActive 生效 → TREE-13 BRANCH_BUSY 互斥可覆盖 reroll）；
 * - L1：chunk 转发走 clientId 路由（ctx.postMessage，monitor 面板发起回 monitor，缺省回退主视图）。
 * 由 MessageRouter 以 fire-and-forget 方式调用（STREAM_MESSAGE_TYPES 含 chat.rerollStream，H2）。
 */
export const rerollStream: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, assistantNodeId, configId, modelOverride, promptModeId, streamId } = data || {};
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || typeof configId !== 'string' || !configId.trim()) {
    ctx.sendError(requestId, 'REROLL_INVALID_ARGS', 'conversationId and configId are required');
    return;
  }

  // TREE-13 互斥：主流仍在生成时拒绝创建 reroll 候选（BRANCH_BUSY）。
  // 不加此检查时 abortManager.create() 会静默中止主流，基于被截断的历史创建候选，
  // 与 BranchHandlers 全部变更操作的流式互斥口径不一致。
  if (isConversationStreaming(ctx, conversationId)) {
    ctx.sendError(requestId, 'BRANCH_BUSY', BRANCH_BUSY_STREAMING_MESSAGE);
    return;
  }

  // 确保分支服务已注册（懒初始化，与 BranchHandlers 同模式）
  try {
    resolveBranchService(ctx);
  } catch (error: any) {
    ctx.sendError(requestId, 'REROLL_ERROR', error?.message || 'branch service unavailable');
    return;
  }

  // H1：注册主流与总结流的取消控制器。HandlerContext 的契约已经明确为
  // StreamAbortManager，不再保留会掩盖注入错误的 Map 鸭子类型兼容分支。
  const abortManager = ctx.streamAbortControllers;
  let controller: AbortController;
  let summarizeController: AbortController;
  try {
    controller = abortManager.create(conversationId);
    summarizeController = abortManager.createSummary(conversationId);
  } catch (error: any) {
    ctx.sendError(requestId, 'REROLL_ERROR', error?.message || 'failed to initialize stream cancellation');
    return;
  }

  const resolvedStreamId = typeof streamId === 'string' && streamId.trim() ? streamId : requestId;
  // L1：chunk 转发复用 clientId 路由——ctx.postMessage 由 MessageRouter.createRoutedContext 注入，
  // 按 clientId 路由到发起端 webview（目标失效回退主视图），与 StreamRequestHandler.getClientView 同语义；
  // 未走路由（直接调用/测试）时回退 ctx.view。
  const processor = new StreamChunkProcessor(() => {
    if (ctx.postMessage) {
      // R2-07：包装 postMessage 透出路由投递结果（true=已投递/已回退，false=投递失败），
      // 不再吞掉 clientRegistry.postMessage 的返回值（投递无留痕）
      return { webview: { postMessage: (message: any): boolean => ctx.postMessage?.(message) ?? false } as any };
    }
    return ctx.view as any;
  }, conversationId, resolvedStreamId);
  try {
    const stream = ctx.chatHandler.handleRerollStream({
      conversationId,
      assistantNodeId: typeof assistantNodeId === 'string' && assistantNodeId.trim() ? assistantNodeId : undefined,
      configId,
      modelOverride,
      promptModeId,
      abortSignal: controller.signal,
      summarizeAbortSignal: summarizeController.signal,
    });
    // 发送响应，通知前端请求已接收并开始（与 StreamRequestHandler 协议一致）
    ctx.sendResponse(requestId, { started: true });
    for await (const chunk of stream) {
      const isError = processor.processChunk(chunk);
      if (isError) break;
    }
    processor.flush();
  } catch (error: any) {
    // 用户取消：透出 cancelled 结尾事件（与 StreamRequestHandler.reportCancelled 一致），
    // 避免残留空占位消息；不按错误处理。判定口径与 StreamRequestHandler.handleStreamError
    // 统一（R2-07）：signal.aborted 或底层 CANCELLED_ERROR 任一命中即视为取消。
    if (controller.signal.aborted || error?.type === ErrorType.CANCELLED_ERROR) {
      processor.processChunk({ cancelled: true });
      processor.flush();
      // 补 cancelled 请求响应（R2-07）：前端 await sendToExtension 需要明确的结尾响应，
      // 幂等，与 StreamRequestHandler.reportCancelled 的 sendResponse({cancelled:true}) 一致
      ctx.sendResponse(requestId, { cancelled: true });
      return;
    }
    const message = error?.message || 'reroll failed';
    // 方案 B：底层流错误（ChannelError）携带 type（API_ERROR/NETWORK_ERROR/TIMEOUT_ERROR/
    // PARSE_ERROR 等），透传给前端用于判断错误条可重试性；非底层流错误（无 type）保持 undefined。
    const type = typeof error?.type === 'string' ? error.type : undefined;
    processor.sendError('REROLL_ERROR', message, type);
    ctx.sendError(requestId, 'REROLL_ERROR', message);
  } finally {
    // 流结束/取消/异常统一注销控制器（delete 带引用校验，不会误删新流控制器）
    try {
      abortManager.delete(conversationId, controller);
      abortManager.deleteSummary(conversationId, summarizeController);
    } catch (err) {
      console.warn('[ChatHandlers] Failed to cleanup abort controller for rerollStream:', err);
    }
  }
};

/**
 * 编辑用户消息分支流（TREE-03：编辑用户消息时创建新的用户消息分支，不覆盖原消息）。
 *
 * 入参：{ conversationId, userNodeId?, newText, configId, modelOverride?, promptModeId?, streamId?, mode? }
 * - mode='branch'（默认）：后端创建编辑候选（新 user 节点 kind='edit' + 模型候选），主历史切换到编辑后路径并复用工具循环生成；
 * - mode='keep'：后端原地改写原用户消息并截断其后内容（保持当前分支）；
 * - 旧用户节点及其子树保留在分支图 sidecar 中（branch 模式，失败可切回，决策 10 精神）；
 * - chunk 通过 streamChunk / streamChunkBatch 协议转发给前端（TREE-10 前端接入）。
 *
 * 本 handler 已按 StreamRequestHandler 模式接线（R6a-FIX）：
 * - H1：abortManager.create 注册取消控制器 + 透传 abortSignal + finally 注销（与 rerollStream 同）；
 * - L1：chunk 转发走 clientId 路由（ctx.postMessage，与 rerollStream 同）。
 * 由 MessageRouter 以 fire-and-forget 方式调用（STREAM_MESSAGE_TYPES 含 chat.editBranchStream，H2）。
 */
export const editBranchStream: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, userNodeId, newText, configId, modelOverride, promptModeId, streamId, mode } = data || {};
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || typeof configId !== 'string' || !configId.trim()
      || typeof newText !== 'string' || !newText.trim()) {
    ctx.sendError(requestId, 'EDIT_BRANCH_INVALID_ARGS', 'conversationId, configId and newText are required');
    return;
  }
  const resolvedMode = mode === 'keep' ? 'keep' : 'branch';

  // TREE-13 互斥：主流仍在生成时拒绝创建编辑候选（BRANCH_BUSY），
  // 避免 abortManager.create() 静默中止主流并基于被截断的历史创建候选。
  if (isConversationStreaming(ctx, conversationId)) {
    ctx.sendError(requestId, 'BRANCH_BUSY', BRANCH_BUSY_STREAMING_MESSAGE);
    return;
  }

  // 确保分支服务已注册（懒初始化，与 BranchHandlers 同模式）
  try {
    resolveBranchService(ctx);
  } catch (error: any) {
    ctx.sendError(requestId, 'EDIT_BRANCH_ERROR', error?.message || 'branch service unavailable');
    return;
  }

  // H1：HandlerContext 已保证注入 StreamAbortManager，直接使用明确契约。
  const abortManager = ctx.streamAbortControllers;
  let controller: AbortController;
  let summarizeController: AbortController;
  try {
    controller = abortManager.create(conversationId);
    summarizeController = abortManager.createSummary(conversationId);
  } catch (error: any) {
    ctx.sendError(requestId, 'EDIT_BRANCH_ERROR', error?.message || 'failed to initialize stream cancellation');
    return;
  }

  const resolvedStreamId = typeof streamId === 'string' && streamId.trim() ? streamId : requestId;
  // L1：chunk 转发复用 clientId 路由（与 rerollStream 同）
  const processor = new StreamChunkProcessor(() => {
    if (ctx.postMessage) {
      // R2-07：包装 postMessage 透出路由投递结果（与 rerollStream 同）
      return { webview: { postMessage: (message: any): boolean => ctx.postMessage?.(message) ?? false } as any };
    }
    return ctx.view as any;
  }, conversationId, resolvedStreamId);
  try {
    const stream = ctx.chatHandler.handleEditBranchStream({
      conversationId,
      userNodeId: typeof userNodeId === 'string' && userNodeId.trim() ? userNodeId : undefined,
      newText,
      configId,
      modelOverride,
      promptModeId,
      mode: resolvedMode,
      abortSignal: controller.signal,
      summarizeAbortSignal: summarizeController.signal,
    });
    // 发送响应，通知前端请求已接收并开始（与 StreamRequestHandler 协议一致）
    ctx.sendResponse(requestId, { started: true });
    for await (const chunk of stream) {
      const isError = processor.processChunk(chunk);
      if (isError) break;
    }
    processor.flush();
  } catch (error: any) {
    // 用户取消：透出 cancelled 结尾事件（与 StreamRequestHandler.reportCancelled 一致）；
    // 判定口径统一（R2-07）：signal.aborted 或底层 CANCELLED_ERROR 任一命中即视为取消。
    if (controller.signal.aborted || error?.type === ErrorType.CANCELLED_ERROR) {
      processor.processChunk({ cancelled: true });
      processor.flush();
      // 补 cancelled 请求响应（R2-07）：与 rerollStream / StreamRequestHandler 一致
      ctx.sendResponse(requestId, { cancelled: true });
      return;
    }
    const message = error?.message || 'edit branch failed';
    // 方案 B：底层流错误（ChannelError）携带 type（API_ERROR/NETWORK_ERROR/TIMEOUT_ERROR/
    // PARSE_ERROR 等），透传给前端用于判断错误条可重试性；非底层流错误（无 type）保持 undefined。
    const type = typeof error?.type === 'string' ? error.type : undefined;
    processor.sendError('EDIT_BRANCH_ERROR', message, type);
    ctx.sendError(requestId, 'EDIT_BRANCH_ERROR', message);
  } finally {
    // 流结束/取消/异常统一注销控制器（delete 带引用校验，不会误删新流控制器）
    try {
      abortManager.delete(conversationId, controller);
      abortManager.deleteSummary(conversationId, summarizeController);
    } catch (err) {
      console.warn('[ChatHandlers] Failed to cleanup abort controller for editBranchStream:', err);
    }
  }
};

/**
 * 注册聊天处理器
 */
export function registerChatHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES.deleteMessage, deleteMessage);
  registry.set(MESSAGE_NAMES.deleteSingleMessage, deleteSingleMessage);
  registry.set(MESSAGE_NAMES.cancelSummarizeRequest, cancelSummarizeRequest);
  registry.set(MESSAGE_NAMES['chatInput.focusState'], chatInputFocusState);
  registry.set(MESSAGE_NAMES['chat.awaitConversationIdle'], awaitConversationIdle);
  registry.set(MESSAGE_NAMES['chat.sendInterruptMessage'], sendInterruptMessage);
  registry.set(MESSAGE_NAMES['chat.claimAgentMessages'], claimAgentMessages);
  registry.set(MESSAGE_NAMES['chat.releaseAgentMessages'], releaseAgentMessages);
  registry.set(MESSAGE_NAMES['chat.rerollStream'], rerollStream);
  registry.set(MESSAGE_NAMES['chat.editBranchStream'], editBranchStream);
}
