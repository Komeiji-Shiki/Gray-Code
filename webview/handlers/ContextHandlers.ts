/**
 * 上下文感知和诊断信息消息处理器
 */

import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';
import { shouldIgnorePath } from '../utils/WorkspaceUtils';

/**
 * 获取上下文感知配置
 */
export const getContextAwarenessConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getContextAwarenessConfig();
    ctx.sendResponse(requestId, config);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_CONTEXT_AWARENESS_CONFIG_ERROR', error.message || t('webview.errors.getContextAwarenessConfigFailed'));
  }
};

/**
 * 更新上下文感知配置
 */
export const updateContextAwarenessConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { config } = data;
    await ctx.settingsManager.updateContextAwarenessConfig(config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_CONTEXT_AWARENESS_CONFIG_ERROR', error.message || t('webview.errors.updateContextAwarenessConfigFailed'));
  }
};

/**
 * 获取打开的标签页
 */
export const getOpenTabs: MessageHandler = async (data, requestId, ctx) => {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      ctx.sendResponse(requestId, { tabs: [] });
      return;
    }
    
    const tabs: string[] = [];
    const ignorePatterns = ctx.settingsManager.getContextIgnorePatterns();
    
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri;
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          if (workspaceFolder) {
            const relativePath = vscode.workspace.asRelativePath(uri, false);
            if (!shouldIgnorePath(relativePath, ignorePatterns)) {
              tabs.push(relativePath);
            }
          }
        }
      }
    }
    
    ctx.sendResponse(requestId, { tabs: [...new Set(tabs)] });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_OPEN_TABS_ERROR', error.message || t('webview.errors.getOpenTabsFailed'));
  }
};

/**
 * 获取活动编辑器
 */
export const getActiveEditor: MessageHandler = async (data, requestId, ctx) => {
  try {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      ctx.sendResponse(requestId, { path: null });
      return;
    }
    
    const uri = activeEditor.document.uri;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    
    if (!workspaceFolder) {
      ctx.sendResponse(requestId, { path: null });
      return;
    }
    
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const ignorePatterns = ctx.settingsManager.getContextIgnorePatterns();
    
    if (shouldIgnorePath(relativePath, ignorePatterns)) {
      ctx.sendResponse(requestId, { path: null });
      return;
    }
    
    ctx.sendResponse(requestId, { path: relativePath });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_ACTIVE_EDITOR_ERROR', error.message || t('webview.errors.getActiveEditorFailed'));
  }
};

/**
 * 注册上下文处理器
 */
export function registerContextHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('getContextAwarenessConfig', getContextAwarenessConfig);
  registry.set('updateContextAwarenessConfig', updateContextAwarenessConfig);
  registry.set('getOpenTabs', getOpenTabs);
  registry.set('getActiveEditor', getActiveEditor);
}
