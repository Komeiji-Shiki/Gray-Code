/**
 * 检查点管理消息处理器
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { assertSafeId } from '../../backend/core/idValidation';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import { previewExclusions as runExclusionPreview } from '../../backend/modules/checkpoint/CheckpointSnapshotBuilder';
import { createRuntimeWorkspaceRoots } from '../../backend/modules/checkpoint/CheckpointWorkspace';
import {
    DEFAULT_ENABLED_PROFILES,
    DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
    DEFAULT_EXCLUSION_PROFILES
} from '../../backend/modules/checkpoint/CheckpointExclusionProfiles';
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
    const checkpoints = await ctx.checkpointManager.getCheckpoints(assertSafeId(conversationId, 'conversationId'), { withSize });
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
    const { conversationId, checkpointId } = data;
    const result = await ctx.checkpointManager.previewRestore(conversationId, checkpointId);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'PREVIEW_RESTORE_ERROR', error.message || t('webview.errors.previewRestoreFailed'));
  }
};

/**
 * 恢复检查点
 */
export const restoreCheckpoint: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { conversationId, checkpointId, deleteUntrackedFiles } = data;

    // CP-04/CP-12: 恢复前先取消该对话正在运行的流式请求，防止恢复后
    // 迟到的流式 chunk 继续写入已回退的历史；再取消该对话关联的活跃
    // SubAgent（其后续工具调用可能继续写工作区文件，与恢复结果冲突）。
    // streamAbortControllers 实际上是 StreamAbortManager（类型声明为 Map）
    const abortManager = ctx.streamAbortControllers as any;
    if (abortManager?.cancel) {
      abortManager.cancel(conversationId);
    } else if (abortManager?.get) {
      const controller = abortManager.get(conversationId);
      if (controller) {
        controller.abort();
        abortManager.delete(conversationId);
      }
    }

    try {
      const snapshots = subAgentRunEventBus.getSnapshots();
      for (const snapshot of snapshots) {
        if (snapshot.conversationId === conversationId && subAgentRunController.isActive(snapshot.runId)) {
          subAgentRunController.cancel(snapshot.runId, 'checkpoint restore');
        }
      }
    } catch (err) {
      console.warn('[CheckpointHandlers] Failed to cancel subagents before restore:', err);
    }

    const result = await ctx.checkpointManager.restoreCheckpoint(
      assertSafeId(conversationId, 'conversationId'),
      assertSafeId(checkpointId, 'checkpointId'),
      {
        // CP-09: 用户在恢复确认框中确认了待删除文件清单（含快照后新建文件）后才传 true
        deleteUntrackedFiles: deleteUntrackedFiles === true
      }
    );

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
    const success = await ctx.checkpointManager.deleteCheckpoint(
      assertSafeId(conversationId, 'conversationId'),
      assertSafeId(checkpointId, 'checkpointId')
    );
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
    const result = await ctx.checkpointManager.deleteAllCheckpoints(assertSafeId(conversationId, 'conversationId'));
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
    const safeItems = Array.isArray(items)
      ? items.map(item => ({
          ...item,
          conversationId: assertSafeId(item?.conversationId, 'conversationId'),
          checkpointIds: Array.isArray(item?.checkpointIds)
            ? item.checkpointIds.map(id => assertSafeId(id, 'checkpointId'))
            : []
        }))
      : [];
    const results = await ctx.checkpointManager.deleteCheckpointsBatch(safeItems);
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
  try {
    const { checkpointId } = data;
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
    const config = result.config as any;

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
        ...(config.exclusion?.customPatterns ?? [])
      ],
      enabledProfiles: config.exclusion?.enabledProfiles ?? DEFAULT_ENABLED_PROFILES,
      maxFileSizeBytes: config.exclusion?.maxFileSizeBytes ?? DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
      excludeAbsolutePaths: [path.dirname(checkpointsDir)]
    });

    ctx.sendResponse(requestId, preview);
  } catch (error: any) {
    ctx.sendError(requestId, 'PREVIEW_EXCLUSIONS_ERROR', error.message || t('webview.errors.previewExclusionsFailed'));
  }
};

/**
 * 注册检查点管理处理器
 */
export function registerCheckpointHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('checkpoint.getConfig', getCheckpointConfig);
  registry.set('checkpoint.updateConfig', updateCheckpointConfig);
  registry.set('checkpoint.getExclusionProfiles', getExclusionProfiles);
  registry.set('checkpoint.previewExclusions', previewExclusions);
  registry.set('checkpoint.getCheckpoints', getCheckpoints);
  registry.set('checkpoint.previewRestore', previewRestore);
  registry.set('checkpoint.restore', restoreCheckpoint);
  registry.set('checkpoint.delete', deleteCheckpoint);
  registry.set('checkpoint.deleteAll', deleteAllCheckpoints);
  registry.set('checkpoint.deleteBatch', deleteCheckpointsBatch);
  registry.set('checkpoint.getAllConversationsWithCheckpoints', getAllConversationsWithCheckpoints);
  registry.set('checkpoint.getManifest', getManifest);
  registry.set('checkpoint.getOperationProgress', getOperationProgress);
  registry.set('checkpoint.cancelOperation', cancelOperation);
}
