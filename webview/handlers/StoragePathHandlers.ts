/**
 * 存储路径管理消息处理器
 */

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
 * 迁移存储数据
 */
export const migrateStorage: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { path: newPath } = data;
    const result = await ctx.storagePathManager.migrateData(newPath, (status) => {
      ctx.view?.webview.postMessage({
        type: 'storageMigrationProgress',
        data: status
      });
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
      ctx.view?.webview.postMessage({
        type: 'storageMigrationProgress',
        data: status
      });
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
  registry.set('storagePath.getConfig', getStoragePathConfig);
  registry.set('storagePath.validate', validateStoragePath);
  registry.set('storagePath.migrate', migrateStorage);
  registry.set('storagePath.reset', resetStoragePath);
  registry.set('storagePath.selectFolder', selectFolder);
  registry.set('storagePath.openInExplorer', openInExplorer);
  registry.set('reloadWindow', reloadWindow);
}
