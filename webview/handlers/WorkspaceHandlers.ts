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
export const SAVED_WORKSPACES_KEY = 'graycode.savedWorkspaces';

/** 桌面版 File 菜单等宿主侧入口复用收藏键时，与主进程共享的常量 */
const WIN32 = process.platform === 'win32';

function normalizeFsPath(p: string): string {
  return WIN32 ? p.replace(/\\/g, '/').toLowerCase() : p;
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

/** 判断收藏中是否已存在某路径（Windows 大小写不敏感） */
function isSavedFsPath(ctx: HandlerContext, fsPath: string): boolean {
  const norm = normalizeFsPath(fsPath);
  return loadSavedFsPaths(ctx).some((p) => normalizeFsPath(p) === norm);
}

/** 等待工作区列表出现指定文件夹（vscode.openFolder 在宿主侧异步生效，最多等 3s） */
async function waitForWorkspaceOpened(uriString: string, manager: { getWorkspaceList(): WorkspaceFolderInfo[] }): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (manager.getWorkspaceList().some((w) => w.uri === uriString)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return manager.getWorkspaceList().some((w) => w.uri === uriString);
}

export const getWorkspaceList: MessageHandler = async (data, requestId, ctx) => {
    const manager = getWorkspaceManager();
    ctx.sendResponse(requestId, {
        activeWorkspaceUri: ctx.getCurrentWorkspaceUri(),
        workspaces: manager ? manager.getWorkspaceList() : [],
        // 文件系统大小写敏感性（Windows 大小写不敏感）：前端工作区 URI 匹配口径与
        // 扩展端 WorkspaceManager 保持一致——仅 win32 允许大小写漂移归一。
        fsCaseSensitive: process.platform !== 'win32'
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
 * 把当前激活的工作区保存到收藏（显式「保存工作区」入口）
 *
 * - 无激活工作区：报错（前端提示先打开工作区）
 * - 已在收藏：幂等返回
 * - 持久化完成（await 写队列）后才响应，避免立即退出丢收藏
 */
export const saveCurrentWorkspace: MessageHandler = async (data, requestId, ctx) => {
    try {
        const manager = getWorkspaceManager();
        if (!manager) {
            ctx.sendError(requestId, 'WORKSPACE_MANAGER_NOT_INITIALIZED', 'WorkspaceManager is not initialized.');
            return;
        }
        const activeUri = manager.getActiveWorkspaceUri();
        if (!activeUri) {
            ctx.sendError(requestId, 'NO_ACTIVE_WORKSPACE', t('errors.noActiveWorkspace'));
            return;
        }
        // 激活工作区 URI 可能来自 shim（file:/// 编码形式），与收藏存储口径（纯路径）不同：
        // 先按 URI 反解出 fsPath，取不到时回退为列表项里的 fsPath。
        const list = manager.getWorkspaceList();
        const entry = list.find((w) => w.uri === activeUri);
        const fsPath = entry?.fsPath || (activeUri.startsWith('file://') ? vscode.Uri.parse(activeUri).fsPath : '');
        if (!fsPath || !isDirectory(fsPath)) {
            ctx.sendError(requestId, 'WORKSPACE_FOLDER_NOT_FOUND', t('errors.workspaceFolderNotFound'));
            return;
        }
        const next = await addSavedFsPath(ctx, fsPath);
        ctx.sendResponse(requestId, {
            success: true,
            saved: buildSavedInfos(next)
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'SAVE_CURRENT_WORKSPACE_ERROR', error?.message || t('errors.unknown'));
    }
};

/**
 * 打开工作区文件夹
 *
 * - 不传 fsPath 时弹出文件夹选择对话框
 * - 选中的文件夹自动加入收藏（await 持久化完成）
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
                title: t('dialogs.openWorkspaceFolder'),
                openLabel: t('dialogs.selectFolder')
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
        // Windows 大小写不敏感：同一目录以不同大小写路径打开时不再重复触发宿主替换，
        // 且固定时用列表里已存在的 URI（Uri.file 保留路径大小写，用新串会匹配失败静默解除固定）
        const existing = manager.getWorkspaceList().find((w) => {
            if (w.uri === uri) return true;
            return WIN32 && normalizeFsPath(w.fsPath) === normalizeFsPath(fsPath);
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
    registry.set('workspace.saveCurrent', saveCurrentWorkspace);
    registry.set('workspace.openFolder', openWorkspaceFolder);
}
