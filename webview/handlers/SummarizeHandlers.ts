/**
 * 上下文总结消息处理器
 *
 * 拆分自 FileHandlers.ts 域 H：summarizeContext（经 streamAbortControllers
 * 创建会话级 summary 控制器 + chatHandler.handleSummarizeContext）与
 * restoreSummarizedMessages（恢复总结覆盖的原文）。
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import { t } from '../../backend/i18n';
import type { MessageHandler } from '../types';
import { isConversationMutationGated, BRANCH_BUSY_STREAMING_MESSAGE } from './streamGuard';

// ========== 上下文总结 ==========

/**
 * 恢复指定总结消息覆盖的原文（逻辑截断的反向操作）
 */
export const restoreSummarizedMessages: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await ctx.chatHandler.handleRestoreSummarizedMessages(
      data.conversationId,
      data.summaryMessageId
    );
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'RESTORE_SUMMARY_ERROR', error?.message || String(error));
  }
};

export const summarizeContext: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'SUMMARIZE_ERROR', 'Invalid conversation ID');
    return;
  }
  if (isConversationMutationGated(conversationId)) {
    ctx.sendError(requestId, 'BRANCH_BUSY', BRANCH_BUSY_STREAMING_MESSAGE);
    return;
  }
  const abortManager = ctx.streamAbortControllers;
  const controller = abortManager.createSummary(conversationId);

  try {
    const result = await ctx.chatHandler.handleSummarizeContext({
      conversationId,
      configId: data?.configId,
      modelOverride: data?.modelOverride,
      abortSignal: controller.signal
    });
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    if (aborted) {
      ctx.sendResponse(requestId, {
        success: false,
        error: {
          code: 'ABORTED',
          message: t('modules.api.chat.errors.summarizeAborted')
        }
      });
      return;
    }

    ctx.sendError(requestId, 'SUMMARIZE_ERROR', error.message || t('webview.errors.summarizeFailed'));
  } finally {
    // 引用校验：同一会话两个 summarize 交叠时，旧者的 finally 不能误删新者的控制器
    // （deleteSummary 仅在传入的引用仍是当前条目时才删除）。
    abortManager.deleteSummary(conversationId, controller);
  }
};

/**
 * 注册上下文总结处理器
 */
export function registerSummarizeHandlers(registry: Map<string, MessageHandler>): void {
  // 上下文总结
  registry.set(MESSAGE_NAMES.summarizeContext, summarizeContext);
  // 恢复总结覆盖的原文（逻辑截断反向操作）
  registry.set(MESSAGE_NAMES.restoreSummarizedMessages, restoreSummarizedMessages);
}
