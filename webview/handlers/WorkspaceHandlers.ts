/**
 * 工作区处理器（多工作区支持）
 *
 * - getWorkspaceList：一次性返回激活工作区 + 全部工作区列表（初始化时替代两次 IPC）
 * - workspace.setActive：用户显式切换/固定激活工作区（传 null 恢复跟随活动编辑器）
 * - workspace.getSaved：读取收藏工作区列表（globalState 持久化，跨窗口/重启保留）
 * - workspace.removeSaved：从收藏列表移除指定文件夹
 * - workspace.openFolder：打开工作区文件夹（弹窗选择或指定 fsPath），
 *   自动加入收藏并设为活动工作区；文件夹已在当前窗口打开时直接固定
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';
import { getWorkspaceManager } from '../utils/WorkspaceManager';
import type { WorkspaceFolderInfo } from '../utils/WorkspaceManager';

/** globalState 中收藏工作区列表的键 */
const SAVED_WORKSPACES_KEY = 'graycode.savedWorkspaces';

function isDirectory(fsPath: string): boolean {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

function loadSavedFsPaths(ctx: HandlerContext): string[] {
  try {
    const raw = ctx.context?.globalState?.get<string[]>(SAVED_WORKSPACES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

function persistSavedFsPaths(ctx: HandlerContext, fsPaths: string[]): void {
  try {
    void ctx.context?.globalState?.update(SAVED_WORKSPACES_KEY, fsPaths);
  } catch {
    // 持久化失败不影响本次会话
  }
}

/** 把收藏的 fsPath 列表转换为前端可用的工作区信息（index = -1 表示不在当前窗口打开） */
function buildSavedInfos(fsPaths: string[]): WorkspaceFolderInfo[] {
  return fsPaths.map((fsPath) => ({
    name: path.basename(fsPath) || fsPath,
    uri: vscode.Uri.file(fsPath).toString(),
    fsPath,
    index: -1
  }));
}

/** 加入收藏（去重）并持久化，返回更新后的列表 */
function addSavedFsPath(ctx: HandlerContext, fsPath: string): string[] {
  const next = loadSavedFsPaths(ctx);
  if (!next.includes(fsPath)) {
    next.push(fsPath);
    persistSavedFsPaths(ctx, next);
  }
  return next;
}

export const getWorkspaceList: MessageHandler = async (data, requestId, ctx) => {
    const manager = getWorkspaceManager();
    ctx.sendResponse(requestId, {
        activeWorkspaceUri: ctx.getCurrentWorkspaceUri(),
        workspaces: manager ? manager.getWorkspaceList() : []
    });
};

export const setActiveWorkspace: MessageHandler = async (data, requestId, ctx) => {
    const manager = getWorkspaceManager();
    if (!manager) {
        ctx.sendError(requestId, 'WORKSPACE_MANAGER_NOT_INITIALIZED', 'WorkspaceManager is not initialized.');
        return;
    }
    const rawUri = typeof data?.workspaceUri === 'string' ? data.workspaceUri : null;
    manager.setActiveWorkspaceUri(rawUri);
    ctx.sendResponse(requestId, {
        success: true,
        activeWorkspaceUri: manager.getActiveWorkspaceUri(),
        isAutoFollow: manager.isAutoFollow()
    });
};

/** 获取收藏工作区列表 */
export const getSavedWorkspaces: MessageHandler = async (data, requestId, ctx) => {
    try {
        ctx.sendResponse(requestId, {
            saved: buildSavedInfos(loadSavedFsPaths(ctx))
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'GET_SAVED_WORKSPACES_ERROR', error?.message || t('webview.errors.unknown'));
    }
};

/** 从收藏列表移除工作区（不影响已打开的工作区） */
export const removeSavedWorkspace: MessageHandler = async (data, requestId, ctx) => {
    try {
        const fsPath = typeof data?.fsPath === 'string' ? data.fsPath : '';
        const next = loadSavedFsPaths(ctx).filter((p) => p !== fsPath);
        persistSavedFsPaths(ctx, next);
        ctx.sendResponse(requestId, {
            success: true,
            saved: buildSavedInfos(next)
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'REMOVE_SAVED_WORKSPACE_ERROR', error?.message || t('webview.errors.unknown'));
    }
};

/**
 * 打开工作区文件夹
 *
 * - 不传 fsPath 时弹出文件夹选择对话框
 * - 选中的文件夹自动加入收藏
 * - 已在当前窗口打开：直接固定为活动工作区
 * - 未打开：通过宿主打开（Electron 走 vscode.openFolder shim，VS Code 走原生命令）
 */
export const openWorkspaceFolder: MessageHandler = async (data, requestId, ctx) => {
    const manager = getWorkspaceManager();
    if (!manager) {
        ctx.sendError(requestId, 'WORKSPACE_MANAGER_NOT_INITIALIZED', 'WorkspaceManager is not initialized.');
        return;
    }
    try {
        let fsPath = typeof data?.fsPath === 'string' && data.fsPath ? data.fsPath : '';
        if (!fsPath) {
            const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                title: t('webview.dialogs.openWorkspaceFolder'),
                openLabel: t('webview.dialogs.selectFolder')
            });
            fsPath = result && result.length > 0 ? result[0].fsPath : '';
        }
        if (!fsPath) {
            ctx.sendResponse(requestId, { success: false, canceled: true });
            return;
        }
        if (!isDirectory(fsPath)) {
            ctx.sendError(requestId, 'WORKSPACE_FOLDER_NOT_FOUND', t('webview.errors.workspaceFolderNotFound'));
            return;
        }

        addSavedFsPath(ctx, fsPath);

        const uri = vscode.Uri.file(fsPath).toString();
        if (manager.getWorkspaceList().some((w) => w.uri === uri)) {
            // 已打开：直接固定，不重复触发宿主打开
            manager.setActiveWorkspaceUri(uri);
        } else {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fsPath));
        }

        ctx.sendResponse(requestId, {
            success: true,
            activeWorkspaceUri: manager.getActiveWorkspaceUri(),
            workspaces: manager.getWorkspaceList(),
            saved: buildSavedInfos(loadSavedFsPaths(ctx))
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'OPEN_WORKSPACE_FOLDER_ERROR', error?.message || t('webview.errors.unknown'));
    }
};

export function registerWorkspaceHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('getWorkspaceList', getWorkspaceList);
    registry.set('workspace.setActive', setActiveWorkspace);
    registry.set('workspace.getSaved', getSavedWorkspaces);
    registry.set('workspace.removeSaved', removeSavedWorkspace);
    registry.set('workspace.openFolder', openWorkspaceFolder);
}
