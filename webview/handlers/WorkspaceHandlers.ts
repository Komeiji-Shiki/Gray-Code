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
import type { WorkspaceManager as WorkspaceManagerType } from '../utils/WorkspaceManager';
import type { WorkspaceFolderInfo } from '../utils/WorkspaceManager';
import { getFsCaseSensitivity } from '../utils/fsCaseSensitivity';

/** globalState 中收藏工作区列表的键 */
export const SAVED_WORKSPACES_KEY = 'graycode.savedWorkspaces';

/**
 * 收藏/路径去重的归一化口径：与工作区 URI 匹配一致，采用进程级探测的大小写
 * 敏感性（仅 win32 的静态判断会把 macOS APFS / WSL drvfs 误判为大小写敏感，
 * 同一目录大小写漂移的收藏/已打开路径无法去重或重复触发宿主打开）。
 */
function normalizeFsPath(p: string): string {
  return getFsCaseSensitivity(undefined) ? p : p.replace(/\\/g, '/').toLowerCase();
}

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

async function persistSavedFsPaths(ctx: HandlerContext, fsPaths: string[]): Promise<void> {
  try {
    // 收藏写入不能 fire-and-forget：打开工作区后立即退出时写队列未排空会丢收藏。
    // 与 VS Code 契约一致（Memento.update 返回 Thenable），await 后响应才返回。
    await ctx.context?.globalState?.update(SAVED_WORKSPACES_KEY, fsPaths);
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

/** 加入收藏（去重，Windows 下按大小写不敏感）并持久化，返回更新后的列表 */
async function addSavedFsPath(ctx: HandlerContext, fsPath: string): Promise<string[]> {
  const next = loadSavedFsPaths(ctx);
  if (!next.some((p) => normalizeFsPath(p) === normalizeFsPath(fsPath))) {
    next.push(fsPath);
    await persistSavedFsPaths(ctx, next);
  }
  return next;
}

/** 把 fsPath 转成与 WorkspaceManager 列表同口径的 URI 字符串（Uri.file().toString()） */
function fsPathToUriString(fsPath: string): string {
  return vscode.Uri.file(fsPath).toString();
}

/** 等待工作区列表出现指定文件夹（vscode.openFolder 在宿主侧异步生效，最多等 3s） */
async function waitForWorkspaceOpened(uriString: string, manager: WorkspaceManagerType): Promise<boolean> {
  // 大小写不敏感文件系统上宿主可能以不同大小写的路径生效（路径大小写漂移），
  // 按探测口径（与 WorkspaceManager 匹配一致）归一后比对，避免误超时返回过期状态
  const caseSensitive = manager.getFsCaseSensitivity();
  const norm = (u: string) => (caseSensitive ? u : u.toLowerCase());
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (manager.getWorkspaceList().some((w) => norm(w.uri) === norm(uriString))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return manager.getWorkspaceList().some((w) => norm(w.uri) === norm(uriString));
}

export const getWorkspaceList: MessageHandler = async (data, requestId, ctx) => {
    const manager = getWorkspaceManager();
    ctx.sendResponse(requestId, {
        activeWorkspaceUri: ctx.getCurrentWorkspaceUri(),
        workspaces: manager ? manager.getWorkspaceList() : [],
        // 文件系统大小写敏感性（前端工作区 URI 匹配口径）：运行时探测，而非
        // 仅按平台判断——macOS APFS 默认不敏感、Linux 的 WSL drvfs 挂载不敏感，
        // 按平台粗判会把 macOS 误判为大小写敏感（固定匹配静默失败）。
        fsCaseSensitive: getFsCaseSensitivity(manager?.getWorkspaceList()[0]?.fsPath)
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
        ctx.sendError(requestId, 'GET_SAVED_WORKSPACES_ERROR', error?.message || t('errors.unknown'));
    }
};

/** 从收藏列表移除工作区（不影响已打开的工作区） */
export const removeSavedWorkspace: MessageHandler = async (data, requestId, ctx) => {
    try {
        const fsPath = typeof data?.fsPath === 'string' ? data.fsPath : '';
        const next = loadSavedFsPaths(ctx).filter((p) => normalizeFsPath(p) !== normalizeFsPath(fsPath));
        await persistSavedFsPaths(ctx, next);
        ctx.sendResponse(requestId, {
            success: true,
            saved: buildSavedInfos(next)
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'REMOVE_SAVED_WORKSPACE_ERROR', error?.message || t('errors.unknown'));
    }
};

/**
 * 打开工作区文件夹
 *
 * - 不传 fsPath 时弹出文件夹选择对话框
 * - 选中的文件夹自动加入收藏（await 持久化完成；「打开即保存」，无需显式保存入口）
 * - 已在当前窗口打开：直接固定为活动工作区
 * - 未打开：通过宿主打开（Electron 走 vscode.openFolder shim，VS Code 走原生命令），
 *   等待列表生效后再响应，避免返回过期的工作区状态
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
            ctx.sendError(requestId, 'WORKSPACE_FOLDER_NOT_FOUND', t('errors.workspaceFolderNotFound'));
            return;
        }

        await addSavedFsPath(ctx, fsPath);

        const uri = fsPathToUriString(fsPath);
        // 大小写不敏感文件系统：同一目录以不同大小写路径打开时不再重复触发宿主替换，
        // 且固定时用列表里已存在的 URI（Uri.file 保留路径大小写，用新串会匹配失败静默解除固定）
        const existing = manager.getWorkspaceList().find((w) => {
            if (w.uri === uri) return true;
            return normalizeFsPath(w.fsPath) === normalizeFsPath(fsPath);
        });
        if (existing) {
            // 已打开：直接固定，不重复触发宿主打开
            manager.setActiveWorkspaceUri(existing.uri);
        } else {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(fsPath));
            await waitForWorkspaceOpened(uri, manager);
        }

        ctx.sendResponse(requestId, {
            success: true,
            activeWorkspaceUri: manager.getActiveWorkspaceUri(),
            workspaces: manager.getWorkspaceList(),
            saved: buildSavedInfos(loadSavedFsPaths(ctx))
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'OPEN_WORKSPACE_FOLDER_ERROR', error?.message || t('errors.unknown'));
    }
};

export function registerWorkspaceHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('getWorkspaceList', getWorkspaceList);
    registry.set('workspace.setActive', setActiveWorkspace);
    registry.set('workspace.getSaved', getSavedWorkspaces);
    registry.set('workspace.removeSaved', removeSavedWorkspace);
    registry.set('workspace.openFolder', openWorkspaceFolder);
}
