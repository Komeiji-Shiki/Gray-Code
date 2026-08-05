/**
 * 对话管理消息处理器
 */

import { t } from '../../backend/i18n';
import { assertSafeId } from '../../backend/core/idValidation';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../stream/StreamAbortManager';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 内部元数据键：只能由后端写入，webview 不可覆盖。
 * 这些键控制检查点链、审批门等安全敏感状态。
 */
const PROTECTED_METADATA_KEYS = new Set([
  'checkpoints',
  'pendingApprovalGate',
  'trimState'
]);

function validateConversationId(conversationId: unknown): string {
  return assertSafeId(conversationId, 'conversationId');
}

function validateCustomMetadataKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
    throw new Error('Invalid metadata key format');
  }
  if (PROTECTED_METADATA_KEYS.has(key) || key.startsWith('_')) {
    throw new Error(`Metadata key "${key}" is reserved for internal use`);
  }
  return key;
}

/**
 * 创建对话
 */
export const createConversation: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, title, workspaceUri } = data;
  validateConversationId(conversationId);
  const wsUri = workspaceUri || ctx.getCurrentWorkspaceUri();
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
  const metadata = await ctx.conversationManager.getMetadata(validateConversationId(conversationId));
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
  await ctx.conversationManager.setTitle(validateConversationId(conversationId), title);
  ctx.sendResponse(requestId, { success: true });
};

export const setWorkspaceUri: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, workspaceUri } = data;
  await ctx.conversationManager.setWorkspaceUri(validateConversationId(conversationId), workspaceUri);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 设置自定义元数据
 */
export const setCustomMetadata: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, key, value } = data;
  const safeKey = validateCustomMetadataKey(key);
  await ctx.conversationManager.setCustomMetadata(validateConversationId(conversationId), safeKey, value);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 删除对话
 */
export const deleteConversation: MessageHandler = async (data, requestId, ctx) => {
  let conversationId: string;
  try {
    conversationId = validateConversationId(data?.conversationId);
  } catch (error: any) {
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

  // 先删除该对话的所有检查点（包括备份目录）
  await ctx.checkpointManager.deleteAllCheckpoints(conversationId);
  await ctx.conversationManager.deleteConversation(conversationId);
  subAgentRunEventBus.forgetConversation(conversationId);
  ctx.sendResponse(requestId, { success: true });
};


/**
 * 从指定消息创建分支对话
 */
export const createBranchConversation: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { sourceConversationId, branchAtIndex, title, conversationId, workspaceUri } = data || {};
    validateConversationId(sourceConversationId);
    if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
      validateConversationId(conversationId);
    }
    const resolvedWorkspaceUri = workspaceUri || ctx.getCurrentWorkspaceUri() || undefined;
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
  const messages = await ctx.conversationManager.getMessages(validateConversationId(conversationId));
  ctx.sendResponse(requestId, messages);
};

/**
 * 分页获取对话消息
 */
export const getMessagesPaged: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, beforeIndex, offset, limit } = data || {};
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Number(limit), 1), 500) : undefined;
  const safeOffset = Number.isFinite(offset) ? Math.max(Number(offset), 0) : undefined;
  const result = await ctx.conversationManager.getMessagesPaged(validateConversationId(conversationId), { beforeIndex, offset: safeOffset, limit: safeLimit });
  ctx.sendResponse(requestId, result);
};

/**
 * 获取对话视图所需数据
 *
 * 用于切换对话时一次性加载 metadata、最后一页消息和 checkpoints，减少重复 IPC。
 */
export const loadConversationForView: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, beforeIndex, offset, limit } = data || {};
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Number(limit), 1), 500) : undefined;
  const safeOffset = Number.isFinite(offset) ? Math.max(Number(offset), 0) : undefined;
  const [metadata, result] = await Promise.all([
    ctx.conversationManager.getMetadata(validateConversationId(conversationId)),
    ctx.conversationManager.getMessagesPaged(validateConversationId(conversationId), { beforeIndex, offset: safeOffset, limit: safeLimit })
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
    await ctx.conversationManager.rejectToolCalls(validateConversationId(conversationId), messageIndex, toolCallIds);
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
