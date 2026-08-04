/**
 * 聊天功能消息处理器
 * 
 * 处理删除消息等非流式操作
 */

import { t } from '../../backend/i18n';
import { setChatInputFocused } from '../../backend/core/chatFocusGuard';
import { assertSafeId } from '../../backend/core/idValidation';
import { agentMailbox } from '../../backend/tools/subagents/agentMailbox';
import {
    BranchGraphRepository,
    BranchService,
    getGlobalBranchService,
    setGlobalBranchService,
} from '../../backend/modules/conversation/branch';
import { StreamChunkProcessor } from '../stream/StreamChunkProcessor';
import type { HandlerContext, MessageHandler } from '../types';

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
  const { conversationId: rawConversationId, targetIndex, preserveCheckpointId } = data || {};
  const conversationId = assertSafeId(rawConversationId, 'conversationId');

  // 先取消该对话的流式请求（如果有）
  // 取消只是“尽力而为”的前置清理：取消失败不应阻断删除主流程，独立 try/catch 仅告警。
  try {
    // streamAbortControllers 实际上是 StreamAbortManager，但类型定义为 Map
    const abortManager = ctx.streamAbortControllers as any;
    if (abortManager.cancel) {
      abortManager.cancel(conversationId);
    } else if (abortManager.get) {
      // 如果是纯 Map，手动取消
      const controller = abortManager.get(conversationId);
      if (controller) {
        controller.abort();
        abortManager.delete(conversationId);
      }
    }
  } catch (err) {
    console.warn('[ChatHandlers] Failed to cancel stream before deleteMessage:', err);
  }

  // L-3: handler 自身 try/catch——异常时发送明确错误码 DELETE_MESSAGE_ERROR（响应形状与通用错误一致）
  try {
    const result = await ctx.chatHandler.handleDeleteToMessage({
      conversationId,
      targetIndex,
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
  const { conversationId, targetIndex } = data;
  try {
    const safeConversationId = assertSafeId(conversationId, 'conversationId');
    await ctx.conversationManager.deleteMessage(safeConversationId, targetIndex);

    // 删除单条消息后刷新派生元数据（todoList / activeBuild），
    // 避免删除 todo/create_plan 轨迹后历史会话残留无效 Build 壳。
    if (ctx.chatHandler) {
      await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(safeConversationId);
    }

    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_SINGLE_MESSAGE_ERROR', error.message || t('webview.errors.deleteMessageFailed'));
  }
};

/**
 * 取消总结请求（仅取消总结 API，不中断主对话流）
 */
export const cancelSummarizeRequest: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId } = data;
  const safeConversationId = assertSafeId(conversationId, 'conversationId');

  const abortManager = ctx.streamAbortControllers as any;
  let cancelled = false;

  if (abortManager?.cancelSummary) {
    cancelled = !!abortManager.cancelSummary(safeConversationId);
  }

  ctx.sendResponse(requestId, { cancelled });
};

export const awaitConversationIdle: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'CONVERSATION_IDLE_INVALID_CONVERSATION', 'Invalid conversation ID');
    return;
  }

  const abortManager = ctx.streamAbortControllers as any;
  if (typeof abortManager?.waitForIdle === 'function') {
    await abortManager.waitForIdle(conversationId);
  } else {
    // HandlerContext 仍允许测试/旧调用点传普通 Map；没有活跃控制器时可直接视为空闲。
    const controller = abortManager?.get?.(conversationId);
    if (controller) {
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
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

  // 确保分支服务已注册（懒初始化，与 BranchHandlers 同模式）
  try {
    resolveBranchService(ctx);
  } catch (error: any) {
    ctx.sendError(requestId, 'REROLL_ERROR', error?.message || 'branch service unavailable');
    return;
  }

  // H1：注册取消控制器（与 StreamRequestHandler.handleRetryStream 同模式：create + 传 signal + finally delete）。
  // create 会中止该会话旧流（含正在运行的 chat/retry 流）并登记新控制器；
  // 纯 Map 注入路径（测试/旧路径）退化为手动 abort 旧流 + set 新控制器。
  const abortManager = ctx.streamAbortControllers as any;
  let controller: AbortController | undefined;
  let summarizeController: AbortController | undefined;
  try {
    if (abortManager?.create) {
      controller = abortManager.create(conversationId);
    } else if (abortManager?.get) {
      const existing = abortManager.get(conversationId);
      if (existing) {
        existing.abort();
      }
      controller = new AbortController();
      abortManager.set(conversationId, controller);
    }
    if (abortManager?.createSummary) {
      summarizeController = abortManager.createSummary(conversationId);
    }
  } catch (err) {
    console.warn('[ChatHandlers] Failed to register abort controller for rerollStream:', err);
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
      abortSignal: controller?.signal,
      summarizeAbortSignal: summarizeController?.signal,
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
    if (controller?.signal.aborted) {
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
      if (controller && abortManager?.delete) {
        abortManager.delete(conversationId, controller);
      }
      if (summarizeController && abortManager?.deleteSummary) {
        abortManager.deleteSummary(conversationId, summarizeController);
      }
    } catch (err) {
      console.warn('[ChatHandlers] Failed to cleanup abort controller for rerollStream:', err);
    }
  }
};

/**
 * 编辑用户消息分支流（TREE-03：编辑用户消息时创建新的用户消息分支，不覆盖原消息）。
 *
 * 入参：{ conversationId, userNodeId?, newText, configId, modelOverride?, promptModeId?, streamId? }
 * - 后端创建编辑候选（新 user 节点 kind='edit' + 模型候选），主历史切换到编辑后路径并复用工具循环生成；
 * - 旧用户节点及其子树保留在分支图 sidecar 中（失败可切回，决策 10 精神）；
 * - chunk 通过 streamChunk / streamChunkBatch 协议转发给前端（TREE-10 前端接入）。
 *
 * 本 handler 已按 StreamRequestHandler 模式接线（R6a-FIX）：
 * - H1：abortManager.create 注册取消控制器 + 透传 abortSignal + finally 注销（与 rerollStream 同）；
 * - L1：chunk 转发走 clientId 路由（ctx.postMessage，与 rerollStream 同）。
 * 由 MessageRouter 以 fire-and-forget 方式调用（STREAM_MESSAGE_TYPES 含 chat.editBranchStream，H2）。
 */
export const editBranchStream: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, userNodeId, newText, configId, modelOverride, promptModeId, streamId } = data || {};
  if (typeof conversationId !== 'string' || !conversationId.trim()
      || typeof configId !== 'string' || !configId.trim()
      || typeof newText !== 'string' || !newText.trim()) {
    ctx.sendError(requestId, 'EDIT_BRANCH_INVALID_ARGS', 'conversationId, configId and newText are required');
    return;
  }

  // 确保分支服务已注册（懒初始化，与 BranchHandlers 同模式）
  try {
    resolveBranchService(ctx);
  } catch (error: any) {
    ctx.sendError(requestId, 'EDIT_BRANCH_ERROR', error?.message || 'branch service unavailable');
    return;
  }

  // H1：注册取消控制器（与 rerollStream 同模式：create + 传 signal + finally delete）
  const abortManager = ctx.streamAbortControllers as any;
  let controller: AbortController | undefined;
  let summarizeController: AbortController | undefined;
  try {
    if (abortManager?.create) {
      controller = abortManager.create(conversationId);
    } else if (abortManager?.get) {
      const existing = abortManager.get(conversationId);
      if (existing) {
        existing.abort();
      }
      controller = new AbortController();
      abortManager.set(conversationId, controller);
    }
    if (abortManager?.createSummary) {
      summarizeController = abortManager.createSummary(conversationId);
    }
  } catch (err) {
    console.warn('[ChatHandlers] Failed to register abort controller for editBranchStream:', err);
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
      newText,
      configId,
      modelOverride,
      promptModeId,
      abortSignal: controller?.signal,
      summarizeAbortSignal: summarizeController?.signal,
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
    if (controller?.signal.aborted) {
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
      if (controller && abortManager?.delete) {
        abortManager.delete(conversationId, controller);
      }
      if (summarizeController && abortManager?.deleteSummary) {
        abortManager.deleteSummary(conversationId, summarizeController);
      }
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
  registry.set('chat.rerollStream', rerollStream);
  registry.set('chat.editBranchStream', editBranchStream);
}
