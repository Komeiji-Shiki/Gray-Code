/**
 * 检查点管理消息处理器
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { previewExclusions as runExclusionPreview } from '../../backend/modules/checkpoint';
import { createRuntimeWorkspaceRoots } from '../../backend/modules/checkpoint';
import { cancelStreamAndSubAgents, detectDirtyFilesInWorkspace } from '../utils/WorkspaceRestoreGuard';
import { getGlobalBranchService } from '../../backend/modules/conversation/branch';
import {
    DEFAULT_ENABLED_PROFILES,
    DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
    DEFAULT_EXCLUSION_PROFILES
} from '../../backend/modules/checkpoint';
import type { HandlerContext, MessageHandler } from '../types';
import type { CheckpointConfig } from '../../backend/modules/settings';
import type { CheckpointExclusionConfig } from '../../backend/modules/checkpoint';

interface HandlerError {
  code?: string;
  message?: string;
}

type CheckpointConfigResult =
  | { success: true; config: Readonly<CheckpointConfig> }
  | { success: false; error: HandlerError };

type UpdateCheckpointConfigResult =
  | { success: true; settings: { toolsConfig?: { checkpoint?: CheckpointConfig } } }
  | { success: false; error: HandlerError };

/**
 * 获取检查点配置
 */
export const getCheckpointConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await ctx.settingsHandler.getCheckpointConfig() as CheckpointConfigResult;
    if (result.success) {
      ctx.sendResponse(requestId, { config: result.config });
    } else {
      ctx.sendError(requestId, 'GET_CHECKPOINT_CONFIG_ERROR', result.error?.message || t('webview.errors.getCheckpointConfigFailed'));
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CHECKPOINT_CONFIG_ERROR', error?.message || t('webview.errors.getCheckpointConfigFailed'));
  }
};

/**
 * 更新检查点配置
 */
export const updateCheckpointConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = data?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      ctx.sendError(requestId, 'UPDATE_CHECKPOINT_CONFIG_ERROR', 'Invalid checkpoint config');
      return;
    }
    const result = await ctx.settingsHandler.updateCheckpointConfig({ config }) as UpdateCheckpointConfigResult;
    if (result.success) {
      // 返回后端归一化后的配置，且成功响应必须携带配置，不用 null 掩盖异常返回形状。
      const normalizedConfig = result.settings.toolsConfig?.checkpoint;
      if (!normalizedConfig) {
        ctx.sendError(requestId, 'UPDATE_CHECKPOINT_CONFIG_ERROR', t('webview.errors.updateCheckpointConfigFailed'));
        return;
      }
      ctx.sendResponse(requestId, { success: true, config: normalizedConfig });
    } else {
      ctx.sendError(requestId, 'UPDATE_CHECKPOINT_CONFIG_ERROR', result.error?.message || t('webview.errors.updateCheckpointConfigFailed'));
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_CHECKPOINT_CONFIG_ERROR', error?.message || t('webview.errors.updateCheckpointConfigFailed'));
  }
};

/**
 * 获取检查点列表
 */
export const getCheckpoints: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, withSize } = data ?? {};
    // L-9：入参显式校验（isValidId 为函数声明，可在此处引用）
    if (!isValidId(conversationId)) {
      ctx.sendError(requestId, 'GET_CHECKPOINTS_ERROR', 'Invalid conversationId');
      return;
    }
    const checkpoints = await ctx.checkpointManager.getCheckpoints(conversationId, { withSize });
    ctx.sendResponse(requestId, { checkpoints });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CHECKPOINTS_ERROR', error.message || t('webview.errors.getCheckpointsFailed'));
  }
};

/**
 * 预览恢复（CP-09）：计算恢复计划（待删除文件清单），不执行任何写入。
 */
export const previewRestore: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, checkpointId } = data ?? {};
    // L-9：入参显式校验
    if (!isValidId(conversationId) || !isValidId(checkpointId)) {
      ctx.sendError(requestId, 'PREVIEW_RESTORE_ERROR', 'Invalid conversationId or checkpointId');
      return;
    }
    const result = await ctx.checkpointManager.previewRestore(conversationId, checkpointId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'PREVIEW_RESTORE_ERROR', error.message || t('webview.errors.previewRestoreFailed'));
  }
};

/**
 * 恢复检查点
 *
 * BCP-05（决策 11）：恢复前检测未保存（dirty）文件——命中且未确认时返回
 * { success: false, dirtyFiles: string[] } 并**不执行恢复**（不再静默丢弃用户未保存内容），
 * 前端弹确认框后带 confirmedDiscardDirty=true 重试。
 * 检测放在「取消流 + SubAgent」之前：用户取消确认时不产生任何副作用（流保持原状）。
 * 入参新增：{ confirmedDiscardDirty?: boolean }
 */
export const restoreCheckpoint: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, checkpointId, deleteUntrackedFiles, confirmedDiscardDirty } = data;

    // L-9：入参显式校验（与 previewRestore / deleteCheckpoint 同口径）——
    // 非法 id 不再流入 cancelStreamAndSubAgents / restoreCheckpoint 后端路径
    if (!isValidId(conversationId) || !isValidId(checkpointId)) {
      ctx.sendError(requestId, 'RESTORE_CHECKPOINT_ERROR', 'Invalid conversationId or checkpointId');
      return;
    }

    // BCP-05（决策 11）：dirty 拦截。命中且未确认 → 返回 dirtyFiles，不做任何写入。
    if (confirmedDiscardDirty !== true) {
      const dirtyFiles = detectDirtyFilesInWorkspace();
      if (dirtyFiles.length > 0) {
        ctx.sendResponse(requestId, {
          success: false,
          restored: 0,
          deleted: 0,
          skipped: 0,
          dirtyFiles,
        });
        return;
      }
    }

    // CP-04/CP-12: 恢复前先取消该对话正在运行的流式请求，防止恢复后
    // 迟到的流式 chunk 继续写入已回退的历史；再取消该对话关联的活跃
    // SubAgent（其后续工具调用可能继续写工作区文件，与恢复结果冲突）。
    // M-11: 取消逻辑独立 try/catch——取消只是“尽力而为”的前置清理，
    // 取消失败不应阻断恢复主流程，更不应误报 RESTORE_CHECKPOINT_ERROR。
    await cancelStreamAndSubAgents(ctx, conversationId);

    const result = await ctx.checkpointManager.restoreCheckpoint(conversationId, checkpointId, {
      // CP-09: 用户在恢复确认框中确认了待删除文件清单（含快照后新建文件）后才传 true
      deleteUntrackedFiles: deleteUntrackedFiles === true
    });

    // 回退本身已经成功，派生元数据刷新失败只记录告警，不能误报恢复失败。
    if (result?.success && ctx.chatHandler) {
      try {
        await ctx.chatHandler.refreshDerivedMetadataAfterHistoryMutation(conversationId);
      } catch (refreshError) {
        console.warn('[CheckpointHandlers] Failed to refresh derived metadata after restore:', refreshError);
      }
    }

    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'RESTORE_CHECKPOINT_ERROR', error.message || t('webview.errors.restoreCheckpointFailed'));
  }
};

/**
 * 校验非空字符串 ID（L-9：各 handler 入参校验）。
 * 非法参数直接返回对应明确错误码，避免落入通用 HANDLER_ERROR 或触发后端异常。
 */
function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 批量删除检查点（支持跨对话，checkpointIds 为空数组表示删除该对话全部）
 */
export const deleteCheckpointsBatch: MessageHandler = async (data, requestId, ctx) => {
  const { items } = data ?? {};
  // 与后端 BatchCheckpointDeleteItem 对齐：{ conversationId, checkpointIds: string[] }（空数组 = 删除该对话全部）
  const isValidBatchItem = (item: any): boolean =>
    !!item && typeof item === 'object'
    && isValidId(item.conversationId)
    && Array.isArray(item.checkpointIds)
    && item.checkpointIds.every(isValidId);
  if (!Array.isArray(items) || !items.every(isValidBatchItem)) {
    ctx.sendError(requestId, 'DELETE_CHECKPOINTS_BATCH_ERROR', 'Invalid items: expected [{ conversationId, checkpointIds: string[] }]');
    return;
  }
  try {
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
 * 获取存档完整 manifest（CPF-03）：前端按需取完整存档数据（哈希/排除清单/规则快照）。
 *
 * L6 差异说明：本接口不带 fallbackRecord，旧版存档（无 manifest 文件）返回
 * { manifest: null }（迁移由 getCheckpoints/restore 路径在拿到记录后触发）。
 * 调用方（设置页查看某存档排除清单等）应先确认存档为新格式
 * （summary.manifestVersion > 0）再调用，避免 null 歧义。
 */
export const getManifest: MessageHandler = async (data, requestId, ctx) => {
  const { checkpointId } = data ?? {};
  if (!isValidId(checkpointId)) {
    ctx.sendError(requestId, 'GET_CHECKPOINT_MANIFEST_ERROR', 'Invalid checkpointId');
    return;
  }
  try {
    const manifest = await ctx.checkpointManager.getManifest(checkpointId);
    ctx.sendResponse(requestId, { manifest });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CHECKPOINT_MANIFEST_ERROR', error.message || t('webview.errors.getCheckpointManifestFailed'));
  }
};

/**
 * 查询进行中存档操作的进度（CPF-11）。
 * operationId 缺省时返回最近更新的进行中操作。
 */
export const getOperationProgress: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { operationId } = data || {};
    const progress = ctx.checkpointManager.getOperationProgress(operationId);
    ctx.sendResponse(requestId, { progress });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CHECKPOINT_OPERATION_PROGRESS_ERROR', error.message || t('webview.errors.getCheckpointOperationProgressFailed'));
  }
};

/**
 * 取消进行中的存档操作（CPF-11）。
 */
export const cancelOperation: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { operationId } = data;
    const cancelled = ctx.checkpointManager.cancelOperation(operationId);
    ctx.sendResponse(requestId, { cancelled });
  } catch (error: any) {
    ctx.sendError(requestId, 'CANCEL_CHECKPOINT_OPERATION_ERROR', error.message || t('webview.errors.cancelCheckpointOperationFailed'));
  }
};

/**
 * 获取默认排除类别元数据（EX-03~EX-06）：id / 显示名 / 默认模式清单 / 默认启用状态。
 * 设置页据此展示类别开关与规则预览。
 */
export const getExclusionProfiles: MessageHandler = async (data, requestId, ctx) => {
  ctx.sendResponse(requestId, { profiles: DEFAULT_EXCLUSION_PROFILES });
};

/**
 * 预览排除结果（EX-09）：按当前排除配置扫描工作区，返回按类别聚合的排除统计。
 *
 * 只收集“会被排除的路径”并统计大小，不哈希大文件；
 * 返回结构为 CheckpointExclusionPreviewResult（summary / byProfile / ignoreSnapshot / complete）。
 */
export const previewExclusions: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await ctx.settingsHandler.getCheckpointConfig();
    if (!result.success || !result.config) {
      ctx.sendError(requestId, 'PREVIEW_EXCLUSIONS_ERROR', t('webview.errors.previewExclusionsFailed'));
      return;
    }
    const config = result.config as CheckpointConfig;
    const exclusion = config.exclusion as CheckpointExclusionConfig | undefined;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = createRuntimeWorkspaceRoots(
      folders.map(folder => ({
        name: folder.name,
        uri: `${folder.uri.scheme}://${folder.uri.authority}${folder.uri.path}`,
        fsPath: folder.uri.fsPath
      }))
    );
    if (roots.length === 0) {
      ctx.sendError(requestId, 'PREVIEW_EXCLUSIONS_ERROR', t('webview.errors.previewExclusionsNoWorkspace'));
      return;
    }

    // 与 CheckpointManager 一致的强制排除边界：扩展存储根（含 checkpoints/ 等）
    const checkpointsDir = ctx.storagePathManager.getCheckpointsPath();
    const preview = await runExclusionPreview({
      roots,
      customIgnorePatterns: [
        ...(config.customIgnorePatterns ?? []),
        ...(exclusion?.customPatterns ?? [])
      ],
      enabledProfiles: exclusion?.enabledProfiles ?? DEFAULT_ENABLED_PROFILES,
      maxFileSizeBytes: exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
      excludeAbsolutePaths: [path.dirname(checkpointsDir)]
    });

    ctx.sendResponse(requestId, preview);
  } catch (error: any) {
    ctx.sendError(requestId, 'PREVIEW_EXCLUSIONS_ERROR', error.message || t('webview.errors.previewExclusionsFailed'));
  }
};

/**
 * 手动创建存档点（用户显式请求，绕过自动检查点开关与工具/消息类型过滤）。
 *
 * 用途：AI 执行一系列改动后（或任意时刻），用户主动保存当前工作区/对话状态，
 * 之后可放心回档检查点 / 切换分支（恢复旧状态后，随时可恢复本存档回来）。
 *
 * 语义：
 * - 绑定到当前最后一条消息（恢复时“回档到该消息前”= 回到现在）；
 * - 额外绑定当前分支活跃尾节点（BCP-02，fire-and-forget）：分支切换
 *   （chat-and-workspace）切走再切回时也能恢复本存档，往返无损。
 */
export const createManualCheckpoint: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId } = data ?? {};
  if (!isValidId(conversationId)) {
    ctx.sendError(requestId, 'CREATE_CHECKPOINT_ERROR', 'Invalid conversationId');
    return;
  }
  try {
    // 绑定当前最后一条消息：回档到该消息前 = 回到现在
    const history = await ctx.conversationManager.getMessagesRaw(conversationId);
    const messageIndex = Math.max(0, history.length - 1);
    const checkpoint = await ctx.checkpointManager.createCheckpoint(
      conversationId,
      messageIndex,
      'manual',
      'before',
      { forceCreate: true }
    );
    if (!checkpoint) {
      ctx.sendError(requestId, 'CREATE_CHECKPOINT_ERROR', t('webview.errors.createCheckpointFailed'));
      return;
    }

    // BCP-02：绑定当前分支活跃尾节点（fire-and-forget；失败不影响主流程，
    // 存档本身已可在检查点列表恢复）
    try {
      const branchService = getGlobalBranchService();
      const graphResult = branchService
        ? await branchService.getBranchGraph(conversationId)
        : null;
      const activeTailNodeId = graphResult?.graph?.activeTailNodeId;
      if (branchService && activeTailNodeId) {
        await branchService.bindWorkspaceCheckpoint(conversationId, activeTailNodeId, checkpoint.id);
      }
    } catch (bindError) {
      console.warn('[CheckpointHandlers] Failed to bind manual checkpoint to branch node:', bindError);
    }

    ctx.sendResponse(requestId, { success: true, checkpoint });
  } catch (error: any) {
    ctx.sendError(requestId, 'CREATE_CHECKPOINT_ERROR', error.message || t('webview.errors.createCheckpointFailed'));
  }
};

/**
 * 注册检查点管理处理器
 */
export function registerCheckpointHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES['checkpoint.getConfig'], getCheckpointConfig);
  registry.set(MESSAGE_NAMES['checkpoint.updateConfig'], updateCheckpointConfig);
  registry.set(MESSAGE_NAMES['checkpoint.getExclusionProfiles'], getExclusionProfiles);
  registry.set(MESSAGE_NAMES['checkpoint.previewExclusions'], previewExclusions);
  registry.set(MESSAGE_NAMES['checkpoint.getCheckpoints'], getCheckpoints);
  registry.set(MESSAGE_NAMES['checkpoint.createManual'], createManualCheckpoint);
  registry.set(MESSAGE_NAMES['checkpoint.previewRestore'], previewRestore);
  registry.set(MESSAGE_NAMES['checkpoint.restore'], restoreCheckpoint);
  registry.set(MESSAGE_NAMES['checkpoint.deleteBatch'], deleteCheckpointsBatch);
  registry.set(MESSAGE_NAMES['checkpoint.getAllConversationsWithCheckpoints'], getAllConversationsWithCheckpoints);
  registry.set(MESSAGE_NAMES['checkpoint.getManifest'], getManifest);
  registry.set(MESSAGE_NAMES['checkpoint.getOperationProgress'], getOperationProgress);
  registry.set(MESSAGE_NAMES['checkpoint.cancelOperation'], cancelOperation);
}
