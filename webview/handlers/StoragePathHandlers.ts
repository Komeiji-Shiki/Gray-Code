/**
 * 存储路径管理消息处理器
 */

import { MESSAGE_NAMES, PUSH_MESSAGE_NAMES } from '../../shared/protocol';
import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 获取存储路径配置
 */
export const getStoragePathConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getStoragePathConfig();
    const defaultPath = ctx.storagePathManager.getDefaultDataPath();
    const effectivePath = ctx.storagePathManager.getEffectiveDataPath();
    ctx.sendResponse(requestId, {
      config,
      defaultPath,
      effectivePath
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_STORAGE_PATH_CONFIG_ERROR', error.message || t('webview.errors.getStoragePathConfigFailed'));
  }
};

/**
 * 获取存储统计数据（大目录统计可达数十秒，属 UNBOUNDED 请求）
 */
export const getStorageStats: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: targetPath } = data;
    const stats = await ctx.storagePathManager.getStorageStats(targetPath);
    ctx.sendResponse(requestId, { stats });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_STORAGE_STATS_ERROR', error.message || t('webview.errors.getStorageStatsFailed'));
  }
};

/**
 * 验证存储路径
 */
export const validateStoragePath: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: targetPath } = data;
    const result = await ctx.storagePathManager.validatePath(targetPath);
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'VALIDATE_STORAGE_PATH_ERROR', error.message || t('webview.errors.validateStoragePathFailed'));
  }
};

/**
 * 推送存储迁移进度：优先直推 ctx.view（主聊天 webview）；view 为 undefined
 * （Monitor 路由上下文显式置空，见 ChatViewProvider.routeSubAgentMonitorMessage）时
 * 降级走 ctx.postMessage 按 clientId 路由回发起方，避免进度静默丢失。
 */
function pushMigrationProgress(ctx: HandlerContext, status: unknown): void {
  const message = { type: PUSH_MESSAGE_NAMES.storageMigrationProgress, data: status };
  if (ctx.view) {
    ctx.view.webview.postMessage(message);
  } else {
    ctx.postMessage?.(message);
  }
}

/**
 * 迁移存储数据
 */
export const migrateStorage: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: newPath } = data;
    const result = await ctx.storagePathManager.migrateData(newPath, (status) => {
      pushMigrationProgress(ctx, status);
    });
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'MIGRATE_STORAGE_ERROR', error.message || t('webview.errors.migrateStorageFailed'));
  }
};

/**
 * 重置存储路径到默认
 */
export const resetStoragePath: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await ctx.storagePathManager.resetToDefault((status) => {
      pushMigrationProgress(ctx, status);
    });
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'RESET_STORAGE_PATH_ERROR', error.message || t('webview.errors.resetStoragePathFailed'));
  }
};

/**
 * 选择文件夹
 */
export const selectFolder: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: t('webview.dialogs.selectStorageFolder'),
      openLabel: t('webview.dialogs.selectFolder')
    });
    
    if (result && result.length > 0) {
      ctx.sendResponse(requestId, { path: result[0].fsPath });
    } else {
      ctx.sendResponse(requestId, { path: null });
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'SELECT_FOLDER_ERROR', error.message || t('webview.errors.selectFolderFailed'));
  }
};

/**
 * 在文件管理器中打开
 */
export const openInExplorer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: targetPath } = data;
    const pathToOpen = targetPath || ctx.storagePathManager.getEffectiveDataPath();
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pathToOpen));
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_IN_EXPLORER_ERROR', error.message || t('webview.errors.openInExplorerFailed'));
  }
};

/**
 * 重新加载窗口
 */
export const reloadWindow: MessageHandler = async (_data, requestId, ctx) => {
  try {
    // reload 会销毁当前 webview，必须先结束 IPC 请求，再触发窗口重载。
    ctx.sendResponse(requestId, { success: true });
    void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, error => {
      console.error('[StoragePathHandlers] Failed to reload window:', error);
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'RELOAD_WINDOW_ERROR', error?.message || 'Failed to reload window');
  }
};

/**
 * 注册存储路径处理器
 */
export function registerStoragePathHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES['storagePath.getConfig'], getStoragePathConfig);
  registry.set(MESSAGE_NAMES['storagePath.getStats'], getStorageStats);
  registry.set(MESSAGE_NAMES['storagePath.validate'], validateStoragePath);
  registry.set(MESSAGE_NAMES['storagePath.migrate'], migrateStorage);
  registry.set(MESSAGE_NAMES['storagePath.reset'], resetStoragePath);
  registry.set(MESSAGE_NAMES['storagePath.selectFolder'], selectFolder);
  registry.set(MESSAGE_NAMES['storagePath.openInExplorer'], openInExplorer);
  registry.set(MESSAGE_NAMES.reloadWindow, reloadWindow);
}
