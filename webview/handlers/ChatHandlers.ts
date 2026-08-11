/**
 * 聊天功能消息处理器
 * 
 * 处理删除消息等非流式操作
 */

import { t } from '../../backend/i18n';
import { setChatInputFocused } from '../../backend/core/chatFocusGuard';
import { assertSafeId } from '../../backend/core/idValidation';
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
import { StreamChunkProcessor } from '../stream/StreamChunkProcessor';
import {
    isConversationStreaming,
    BRANCH_BUSY_STREAMING_MESSAGE,
} from './streamGuard';
import type { HandlerContext, MessageHandler } from '../types';

async function stopConversationStream(ctx: HandlerContext, conversationId: string): Promise<void> {
  const abortManager = ctx.streamAbortControllers;
  if (typeof abortManager?.abortAndWaitForCompletion === 'function') {
    await abortManager.abortAndWaitForCompletion(conversationId);
    return;
  }
  abortManager?.cancel(conversationId);
  await abortManager?.waitForIdle(conversationId);
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
  const { conversationId: rawConversationId, targetIndex, preserveCheckpointId, messageId } = data || {};
  const conversationId = assertSafeId(rawConversationId, 'conversationId');

  // 入参校验优先于任何副作用（取消流）：非法参数直接返回明确错误码，不触发取消动作
  // （与 deleteSingleMessage 的校验口径一致）
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || !Number.isInteger(targetIndex) || targetIndex < 0) {
    ctx.sendError(requestId, 'DELETE_MESSAGE_ERROR', 'Invalid conversationId or targetIndex');
    return;
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
      preserveCheckpointId,
      // M1：透传消息 id 供后端做防索引漂移校验（可选；旧前端不传时保持旧行为）
      messageId
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
    const safeConversationId = assertSafeId(conversationId, 'conversationId');
    await stopConversationStream(ctx, safeConversationId);
    await ctx.conversationManager.deleteMessage(safeConversationId, targetIndex);

    // 删除本身已经成功，派生元数据刷新仅是维护动作，失败不能把主操作误报为失败。
    if (ctx.chatHandler) {
      try {
        await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(safeConversationId);
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
  const safeConversationId = assertSafeId(conversationId, 'conversationId');

  const cancelled = !!ctx.streamAbortControllers?.cancelSummary(safeConversationId);
  ctx.sendResponse(requestId, { cancelled });
};

export const awaitConversationIdle: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'CONVERSATION_IDLE_INVALID_CONVERSATION', 'Invalid conversation ID');
    return;
  }

  // 等待必须带超时兜底（15s，小于前端 20s 超时）：若后端 waitForIdle 在极端挂死场景
  // 不返回，前端 20s 超时后会摘除 requestId，后端稍后返回的响应会被当作广播误分发。
  // 超时后照常返回 { idle: true, stale: true }，前端不感知差异，响应也不会迟到。
  const IDLE_WAIT_TIMEOUT_MS = 15_000;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stale = true;
      resolve();
    }, IDLE_WAIT_TIMEOUT_MS);
  });

  const abortManager = ctx.streamAbortControllers;
  const idle = abortManager.waitForIdle(conversationId);

  try {
    await Promise.race([idle, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  ctx.sendResponse(requestId, stale ? { idle: true, stale: true } : { idle: true });
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
      return { webview: { postMessage: (message: any) => ctx.postMessage?.(message) } as any };
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
    // 避免残留空占位消息；不按错误处理。
    if (controller.signal.aborted) {
      processor.processChunk({ cancelled: true });
      processor.flush();
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
  const { conversationId, userNodeId, newText, configId, modelOverride, promptModeId, streamId, mode, messageId } = data || {};
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
      return { webview: { postMessage: (message: any) => ctx.postMessage?.(message) } as any };
    }
    return ctx.view as any;
  }, conversationId, resolvedStreamId);
  try {
    const stream = ctx.chatHandler.handleEditBranchStream({
      conversationId,
      userNodeId: typeof userNodeId === 'string' && userNodeId.trim() ? userNodeId : undefined,
      // M1：透传消息 id 供后端做防索引漂移校验（可选；旧前端不传时保持旧行为）
      messageId,
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
    // 用户取消：透出 cancelled 结尾事件（与 StreamRequestHandler.reportCancelled 一致）
    if (controller.signal.aborted) {
      processor.processChunk({ cancelled: true });
      processor.flush();
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
  registry.set('deleteMessage', deleteMessage);
  registry.set('deleteSingleMessage', deleteSingleMessage);
  registry.set('cancelSummarizeRequest', cancelSummarizeRequest);
  registry.set('chatInput.focusState', chatInputFocusState);
  registry.set('chat.awaitConversationIdle', awaitConversationIdle);
  registry.set('chat.sendInterruptMessage', sendInterruptMessage);
  registry.set('chat.claimAgentMessages', claimAgentMessages);
  registry.set('chat.releaseAgentMessages', releaseAgentMessages);
  registry.set('chat.rerollStream', rerollStream);
  registry.set('chat.editBranchStream', editBranchStream);
}
