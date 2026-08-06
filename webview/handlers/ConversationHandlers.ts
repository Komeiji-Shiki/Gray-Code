/**
 * 对话管理消息处理器
 */

import { t } from '../../backend/i18n';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../stream/StreamAbortManager';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 创建对话
 */
export const createConversation: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, title, workspaceUri } = data;
  // 两者皆空时归一为 undefined（不要传 null）：后端元数据 workspaceUri 类型是 string | undefined，
  // 传 null 会被 JSON.stringify 持久化为字面 null，破坏记忆隔离的工作区判定（L-2）。
  const wsUri = workspaceUri || ctx.getCurrentWorkspaceUri() || undefined;
  await ctx.conversationManager.createConversation(conversationId, title, wsUri);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 列出所有对话
 */
export const listConversations: MessageHandler = async (data, requestId, ctx) => {
  const ids = await ctx.conversationManager.listConversations();
  ctx.sendResponse(requestId, ids);
};

/**
 * 获取对话元数据
 */
export const getConversationMetadata: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId } = data;
  const metadata = await ctx.conversationManager.getMetadata(conversationId);
  ctx.sendResponse(requestId, metadata);
};

/**
 * 批量获取对话摘要元数据（HIS-10）：对话列表一次 IPC 拉一页摘要，避免每对话一次 IPC。
 */
export const getConversationMetadataBatch: MessageHandler = async (data, requestId, ctx) => {
  const { conversationIds } = data || {};
  const ids = Array.isArray(conversationIds) ? conversationIds : [];
  const summaries = await ctx.conversationManager.getConversationMetadataBatch(ids);
  ctx.sendResponse(requestId, summaries);
};

/**
 * 一次性更新对话摘要元数据（HIS-09）：messageCount/preview 合并为一次写入；updatedAt 由后端维护。
 */
export const updateSummary: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, messageCount, preview } = data || {};
  await ctx.conversationManager.updateSummary(conversationId, {
    messageCount: typeof messageCount === 'number' ? messageCount : undefined,
    preview: typeof preview === 'string' ? preview : undefined
  });
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 设置对话标题
 */
export const setTitle: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, title } = data;
  await ctx.conversationManager.setTitle(conversationId, title);
  ctx.sendResponse(requestId, { success: true });
};

export const setWorkspaceUri: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, workspaceUri } = data;
  await ctx.conversationManager.setWorkspaceUri(conversationId, workspaceUri);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 设置自定义元数据
 */
export const setCustomMetadata: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, key, value } = data;
  await ctx.conversationManager.setCustomMetadata(conversationId, key, value);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 删除对话
 */
export const deleteConversation: MessageHandler = async (data, requestId, ctx) => {
  const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!conversationId) {
    ctx.sendError(requestId, 'DELETE_CONVERSATION_INVALID_ID', 'Invalid conversation ID');
    return;
  }

  // 先停止主流并等 finally/工具结算完成，不能让迟到写入跨过删除边界。
  const abortManager = ctx.streamAbortControllers as any;
  if (typeof abortManager?.abortAndWaitForCompletion === 'function') {
    await abortManager.abortAndWaitForCompletion(conversationId, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
  } else {
    abortManager?.get?.(conversationId)?.abort?.();
  }

  // 前台和后台 SubAgent 都属于该会话；删除时全部退出，并有界等待 executor 注销。
  const runIds = subAgentRunEventBus.getSnapshots()
    .filter(snapshot => snapshot.conversationId === conversationId && subAgentRunController.isActive(snapshot.runId))
    .map(snapshot => snapshot.runId);
  for (const runId of runIds) {
    subAgentRunController.exit(runId, 'Conversation deleted');
  }
  await subAgentRunController.waitForInactive(runIds, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);
  await subAgentRunEventBus.flushConversation(conversationId);

  const checkpointDeleteResult = await ctx.checkpointManager.deleteAllCheckpoints(conversationId);
  if (!checkpointDeleteResult?.success) {
    ctx.sendError(
      requestId,
      'DELETE_CONVERSATION_CHECKPOINT_CLEANUP_FAILED',
      t('webview.errors.deleteAllCheckpointsFailed')
    );
    return;
  }
  await ctx.conversationManager.deleteConversation(conversationId);
  // E-2：删除会话时同步清理 ToolExecutionService 的 mailbox drain epoch 条目，
  // 防止会话 ID 复用后残留 epoch 影响新会话的 drain 权收敛（尽力而为，失败不影响删除结果）。
  ctx.chatHandler?.getToolExecutionService?.().clearMailboxDrainEpochsForConversation(conversationId);
  subAgentRunEventBus.forgetConversation(conversationId);
  ctx.sendResponse(requestId, { success: true });
};


/**
 * 从指定消息创建分支对话
 */
export const createBranchConversation: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { sourceConversationId, branchAtIndex, title, conversationId, workspaceUri } = data || {};
    // 不在此兜底激活工作区：分支对话的 workspaceUri 由后端继承源对话（传入 undefined 时），
    // 用激活工作区兜底会把分支错误绑定到当前活动项目
    const resolvedWorkspaceUri = workspaceUri || undefined;
    const result = await ctx.conversationManager.createBranchConversation(
      sourceConversationId,
      Number(branchAtIndex),
      {
        conversationId,
        title,
        workspaceUri: resolvedWorkspaceUri
      }
    );
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error: any) {
    ctx.sendError(requestId, 'CREATE_BRANCH_CONVERSATION_ERROR', error.message || 'Failed to create branch conversation');
  }
};

/**
 * 获取对话消息
 */
export const getMessages: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId } = data;
  // 记忆隔离（H4）：读取可能触发后端 loadHistory 按需自动创建会话，
  // 补传当前工作区 URI，让自动创建的新会话在创建时就绑定工作区，避免记忆工具回退全局。
  const messages = await ctx.conversationManager.getMessages(
    conversationId,
    ctx.getCurrentWorkspaceUri() || undefined
  );
  ctx.sendResponse(requestId, messages);
};

/**
 * 分页获取对话消息
 */
export const getMessagesPaged: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, beforeIndex, offset, limit } = data || {};
  // 记忆隔离（H4）：分页读取可能触发后端 loadHistory 按需自动创建会话，补传当前工作区 URI。
  const result = await ctx.conversationManager.getMessagesPaged(
    conversationId,
    { beforeIndex, offset, limit },
    ctx.getCurrentWorkspaceUri() || undefined
  );
  ctx.sendResponse(requestId, result);
};

/**
 * 获取对话视图所需数据
 *
 * 用于切换对话时一次性加载 metadata、最后一页消息和 checkpoints，减少重复 IPC。
 */
export const loadConversationForView: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, beforeIndex, offset, limit } = data || {};
  // 记忆隔离（H4）：getMessagesPaged 可能触发后端 loadHistory 按需自动创建会话，
  // 补传当前工作区 URI，让自动创建的新会话在创建时就绑定工作区。
  const [metadata, result] = await Promise.all([
    ctx.conversationManager.getMetadata(conversationId),
    ctx.conversationManager.getMessagesPaged(
      conversationId,
      { beforeIndex, offset, limit },
      ctx.getCurrentWorkspaceUri() || undefined
    )
  ]);

  const custom = (metadata?.custom || {}) as Record<string, unknown>;
  // CPF-04: 不再从元数据原样下发完整存档记录（可能含 fileHashes/fileStats），
  // 改为返回轻量 CheckpointSummary（getCheckpoints 内部按需从 manifest 补全摘要字段）
  let checkpoints: unknown[] = [];
  try {
    checkpoints = await ctx.checkpointManager.getCheckpoints(conversationId);
  } catch (err) {
    console.warn('[ConversationHandlers] Failed to load checkpoint summaries:', err);
  }
  ctx.sendResponse(requestId, {
    metadata,
    totalMessages: result.total,
    messages: result.messages,
    checkpoints,
    modelConfig: custom.inputModelConfig,
    promptMode: custom.promptModeConfig,
    activeBuild: custom.activeBuild ?? null
  });
};

/**
 * 拒绝工具调用
 */
export const rejectToolCalls: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, messageIndex, toolCallIds } = data;
  try {
    await ctx.conversationManager.rejectToolCalls(conversationId, messageIndex, toolCallIds);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'REJECT_TOOL_CALLS_ERROR', error.message || t('webview.errors.rejectToolCallsFailed'));
  }
};

/**
 * 注册对话管理处理器
 */
export function registerConversationHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('conversation.createConversation', createConversation);
  registry.set('conversation.listConversations', listConversations);
  registry.set('conversation.getConversationMetadata', getConversationMetadata);
  registry.set('conversation.getConversationMetadataBatch', getConversationMetadataBatch);
  registry.set('conversation.updateSummary', updateSummary);
  registry.set('conversation.setTitle', setTitle);
  registry.set('conversation.setWorkspaceUri', setWorkspaceUri);
  registry.set('conversation.setCustomMetadata', setCustomMetadata);
  registry.set('conversation.deleteConversation', deleteConversation);
  registry.set('conversation.createBranchConversation', createBranchConversation);

  registry.set('conversation.getMessages', getMessages);
  registry.set('conversation.getMessagesPaged', getMessagesPaged);
  registry.set('conversation.loadConversationForView', loadConversationForView);
  registry.set('conversation.rejectToolCalls', rejectToolCalls);
}
