/**
 * 聊天功能消息处理器
 * 
 * 处理删除消息等非流式操作
 */

import { t } from '../../backend/i18n';
import { setChatInputFocused } from '../../backend/core/chatFocusGuard';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 删除消息（删除到指定位置）
 */
export const deleteMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex, preserveCheckpointId } = data;
  
  // 先取消该对话的流式请求（如果有）
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
  
  const result = await ctx.chatHandler.handleDeleteToMessage({
    conversationId,
    targetIndex,
    preserveCheckpointId
  });
  ctx.sendResponse(requestId, result);
};

/**
 * 删除单条消息
 */
export const deleteSingleMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex } = data;
  try {
    await ctx.conversationManager.deleteMessage(conversationId, targetIndex);

    // 删除单条消息后刷新派生元数据（todoList / activeBuild），
    // 避免删除 todo/create_plan 轨迹后历史会话残留无效 Build 壳。
    if (ctx.chatHandler) {
      await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(conversationId);
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

  const abortManager = ctx.streamAbortControllers as any;
  let cancelled = false;

  if (abortManager?.cancelSummary) {
    cancelled = !!abortManager.cancelSummary(conversationId);
  }

  ctx.sendResponse(requestId, { cancelled });
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
 * 注册聊天处理器
 */
export function registerChatHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('deleteMessage', deleteMessage);
  registry.set('deleteSingleMessage', deleteSingleMessage);
  registry.set('cancelSummarizeRequest', cancelSummarizeRequest);
  registry.set('chatInput.focusState', chatInputFocusState);
}
