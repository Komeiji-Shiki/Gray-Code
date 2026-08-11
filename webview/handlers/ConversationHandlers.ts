/**
 * 对话管理消息处理器
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import { subAgentRunController } from '../../backend/tools/subagents';
import { subAgentRunEventBus } from '../../backend/tools/subagents';
import { OLD_STREAM_EXIT_WAIT_TIMEOUT_MS } from '../stream/StreamAbortManager';
import type { HandlerContext, MessageHandler } from '../types';

function withConversationBoundary(name: string, handler: MessageHandler): MessageHandler {
  return async (data, requestId, ctx) => {
    if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data))) {
      ctx.sendError(requestId, 'CONVERSATION_INVALID_PARAMS', `Invalid parameters for ${name}`);
      return;
    }
    try {
      await handler(data || {}, requestId, ctx);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : `Failed to handle ${name}`;
      ctx.sendError(requestId, 'CONVERSATION_HANDLER_ERROR', message);
    }
  };
}

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

  try {
    // 先停止主流并等 finally/工具结算完成，不能让迟到写入跨过删除边界。
    const abortManager = ctx.streamAbortControllers;
    await abortManager.abortAndWaitForCompletion(conversationId, OLD_STREAM_EXIT_WAIT_TIMEOUT_MS);

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

    // 删除后的附属内存清理由各模块尽力完成，失败不能把已经完成的持久删除误报为失败。
    try {
      ctx.chatHandler?.getToolExecutionService().clearMailboxDrainEpochsForConversation(conversationId);
    } catch (cleanupError) {
      console.warn('[ConversationHandlers] Failed to clear mailbox drain epochs:', cleanupError);
    }
    try {
      subAgentRunEventBus.forgetConversation(conversationId);
    } catch (cleanupError) {
      console.warn('[ConversationHandlers] Failed to forget sub-agent conversation:', cleanupError);
    }
    try {
      // R2-07：清理取消注册表中的会话级残留（cancelEpochs 等），防止 Map 条目随会话增删无界增长
      ctx.streamAbortControllers.removeConversation(conversationId);
    } catch (cleanupError) {
      console.warn('[ConversationHandlers] Failed to clear stream abort registry:', cleanupError);
    }
    ctx.sendResponse(requestId, { success: true });
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : 'Failed to delete conversation';
    ctx.sendError(requestId, 'DELETE_CONVERSATION_ERROR', message);
  }
};


/**
 * 从指定消息创建分支对话
 */
export const createBranchConversation: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { sourceConversationId, branchAtIndex, title, conversationId, workspaceUri } = data || {};
    // 显式校验：Number() 强转会把 undefined/非数字变成 NaN 无校验传入后端（R2-08 复查）
    if (typeof sourceConversationId !== 'string' || !sourceConversationId.trim()
        || !Number.isInteger(branchAtIndex) || branchAtIndex < 0) {
      ctx.sendError(requestId, 'CREATE_BRANCH_CONVERSATION_ERROR',
        'sourceConversationId and branchAtIndex (non-negative integer) are required');
      return;
    }
    // 不在此兜底激活工作区：分支对话的 workspaceUri 由后端继承源对话（传入 undefined 时），
    // 用激活工作区兜底会把分支错误绑定到当前活动项目
    const resolvedWorkspaceUri = workspaceUri || undefined;
    const result = await ctx.conversationManager.createBranchConversation(
      sourceConversationId,
      branchAtIndex,
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

// ========== 对话文件管理 ==========

/**
 * 在系统文件管理器中定位并显示对话文件（拆分自 FileHandlers.ts 域 G）
 */
export const revealConversationInExplorer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId } = data;
    // 修改原因：segmented 存储格式下对话是 {id}/ 目录而非 {id}.json 单文件，
    // 旧实现硬编码拼接 {id}.json 并 stat 校验，正常对话全部报“对话文件不存在”，
    // 无法在文件管理器中显示。
    // 修改方式：委托 ConversationManager → 存储适配器的 getConversationStorageLocation，
    // 由适配器按 segmented index → legacy history → metadata 优先级返回真实存在的 URI。
    // 修改目的：存储布局规则保持单一来源，handler 不再复制路径规则。
    const location = await ctx.conversationManager.getConversationStorageLocation(conversationId);

    if (!location || !location.revealUri) {
      // 非文件系统存储（内存 / globalState）或无法定位：回退打开 conversations 根目录
      const conversationsDir = ctx.storagePathManager.getConversationsPath();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(conversationsDir));
      ctx.sendResponse(requestId, { success: true, fallback: true });
      return;
    }

    await vscode.commands.executeCommand('revealFileInOS', location.revealUri);
    ctx.sendResponse(requestId, {
      success: true,
      exists: location.exists,
      path: location.displayPath,
      warning: location.warning
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'REVEAL_IN_EXPLORER_ERROR', error.message || t('webview.errors.cannotRevealInExplorer'));
  }
};

/**
 * 注册对话管理处理器
 */
export function registerConversationHandlers(registry: Map<string, MessageHandler>): void {
  const register = (name: string, handler: MessageHandler): void => {
    registry.set(name, withConversationBoundary(name, handler));
  };
  register(MESSAGE_NAMES['conversation.createConversation'], createConversation);
  register(MESSAGE_NAMES['conversation.listConversations'], listConversations);
  register(MESSAGE_NAMES['conversation.getConversationMetadata'], getConversationMetadata);
  register(MESSAGE_NAMES['conversation.getConversationMetadataBatch'], getConversationMetadataBatch);
  register(MESSAGE_NAMES['conversation.updateSummary'], updateSummary);
  register(MESSAGE_NAMES['conversation.setWorkspaceUri'], setWorkspaceUri);
  register(MESSAGE_NAMES['conversation.setCustomMetadata'], setCustomMetadata);
  register(MESSAGE_NAMES['conversation.deleteConversation'], deleteConversation);
  register(MESSAGE_NAMES['conversation.createBranchConversation'], createBranchConversation);
  register(MESSAGE_NAMES['conversation.getMessagesPaged'], getMessagesPaged);
  register(MESSAGE_NAMES['conversation.loadConversationForView'], loadConversationForView);
  register(MESSAGE_NAMES['conversation.rejectToolCalls'], rejectToolCalls);
  // 直接注册（不经 withConversationBoundary）：保持拆分前（FileHandlers.ts 域 G）的
  // 错误码 REVEAL_IN_EXPLORER_ERROR 与参数校验行为不变。
  registry.set(MESSAGE_NAMES['conversation.revealInExplorer'], revealConversationInExplorer);
}
