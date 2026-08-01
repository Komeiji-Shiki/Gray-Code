/**
 * 检查点管理消息处理器
 */

import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 获取检查点配置
 */
export const getCheckpointConfig: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.getCheckpointConfig();
  if (result.success) {
    ctx.sendResponse(requestId, { config: result.config });
  } else {
    const errorResult = result as { success: false; error: { code: string; message: string } };
    ctx.sendError(requestId, 'GET_CHECKPOINT_CONFIG_ERROR', errorResult.error?.message || t('webview.errors.getCheckpointConfigFailed'));
  }
};

/**
 * 更新检查点配置
 */
export const updateCheckpointConfig: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.updateCheckpointConfig({ config: data.config });
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    const errorResult = result as { success: false; error: { code: string; message: string } };
    ctx.sendError(requestId, 'UPDATE_CHECKPOINT_CONFIG_ERROR', errorResult.error?.message || t('webview.errors.updateCheckpointConfigFailed'));
  }
};

/**
 * 获取检查点列表
 */
export const getCheckpoints: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, withSize } = data;
    const checkpoints = await ctx.checkpointManager.getCheckpoints(conversationId, { withSize });
    ctx.sendResponse(requestId, { checkpoints });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CHECKPOINTS_ERROR', error.message || t('webview.errors.getCheckpointsFailed'));
  }
};

/**
 * 恢复检查点
 */
export const restoreCheckpoint: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, checkpointId } = data;
    const result = await ctx.checkpointManager.restoreCheckpoint(conversationId, checkpointId);

    // 回退后刷新派生元数据（todoList / activeBuild），确保后续发给模型的 TODO_LIST 不过期。
    if (result?.success && ctx.chatHandler) {
      await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(conversationId);
    }

    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'RESTORE_CHECKPOINT_ERROR', error.message || t('webview.errors.restoreCheckpointFailed'));
  }
};

/**
 * 删除检查点
 */
export const deleteCheckpoint: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, checkpointId } = data;
    const success = await ctx.checkpointManager.deleteCheckpoint(conversationId, checkpointId);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_CHECKPOINT_ERROR', error.message || t('webview.errors.deleteCheckpointFailed'));
  }
};

/**
 * 删除所有检查点
 */
export const deleteAllCheckpoints: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId } = data;
    const result = await ctx.checkpointManager.deleteAllCheckpoints(conversationId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_ALL_CHECKPOINTS_ERROR', error.message || t('webview.errors.deleteAllCheckpointsFailed'));
  }
};

/**
 * 批量删除检查点（支持跨对话，checkpointIds 为空数组表示删除该对话全部）
 */
export const deleteCheckpointsBatch: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { items } = data;
    const results = await ctx.checkpointManager.deleteCheckpointsBatch(items);
    ctx.sendResponse(requestId, { results });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_CHECKPOINTS_BATCH_ERROR', error.message || t('webview.errors.deleteCheckpointsBatchFailed'));
  }
};

/**
 * 获取所有包含检查点的对话
 */
export const getAllConversationsWithCheckpoints: MessageHandler = async (data, requestId, ctx) => {
  try {
    const conversations = await ctx.checkpointManager.getAllConversationsWithCheckpoints();
    ctx.sendResponse(requestId, { conversations });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CONVERSATIONS_WITH_CHECKPOINTS_ERROR', error.message || t('webview.errors.getConversationsWithCheckpointsFailed'));
  }
};

/**
 * 注册检查点管理处理器
 */
export function registerCheckpointHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('checkpoint.getConfig', getCheckpointConfig);
  registry.set('checkpoint.updateConfig', updateCheckpointConfig);
  registry.set('checkpoint.getCheckpoints', getCheckpoints);
  registry.set('checkpoint.restore', restoreCheckpoint);
  registry.set('checkpoint.delete', deleteCheckpoint);
  registry.set('checkpoint.deleteAll', deleteAllCheckpoints);
  registry.set('checkpoint.deleteBatch', deleteCheckpointsBatch);
  registry.set('checkpoint.getAllConversationsWithCheckpoints', getAllConversationsWithCheckpoints);
}
