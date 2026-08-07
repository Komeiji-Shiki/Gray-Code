/**
 * UpdateHandlers - 更新检查/安装的 webview 消息处理器
 *
 * 消息：
 * - getUpdateStatus  查询当前检查状态（不触发新检查；前端挂载时轮询一次）
 * - checkUpdateNow   手动立即检查（忽略 24h 节流）
 * - installUpdate    下载并安装指定更新（用户确认后调用；完成后由后端提示 reload）
 * - openUpdatePage   打开 GitHub Releases 页面（安装失败/无安装包资产时的兜底入口）
 */

import * as vscode from 'vscode';
import type { MessageHandler, HandlerContext } from '../types';
import { UpdateChecker, type UpdateInfo } from '../../backend/modules/update';

function getChecker(ctx: HandlerContext): UpdateChecker {
    if (!ctx.updateChecker) {
        throw new Error('UpdateChecker is not initialized.');
    }
    return ctx.updateChecker;
}

function getCurrentVersion(): string {
    const ext = vscode.extensions.getExtension('czocelot.graycode');
    return ext?.packageJSON?.version || '';
}

/** 查询当前检查状态（不触发新检查） */
export const getUpdateStatus: MessageHandler = async (data, requestId, ctx) => {
    try {
        const checker = getChecker(ctx);
        ctx.sendResponse(requestId, {
            status: checker.getStatus(),
            currentVersion: getCurrentVersion(),
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'GET_UPDATE_STATUS_ERROR', error?.message || 'Failed to get update status');
    }
};

/** 手动立即检查（忽略 24h 节流） */
export const checkUpdateNow: MessageHandler = async (data, requestId, ctx) => {
    try {
        const checker = getChecker(ctx);
        const status = await checker.check(true);
        ctx.sendResponse(requestId, { status });
    } catch (error: any) {
        ctx.sendError(requestId, 'CHECK_UPDATE_ERROR', error?.message || 'Failed to check update');
    }
};

/** 下载安装包并交给系统打开，成功后提示用户完成安装（installUpdate / updateNow 共用） */
async function downloadAndInstallAndNotify(checker: UpdateChecker, update: UpdateInfo): Promise<string> {
    const localPath = await checker.downloadAndInstall(update);
    // 桌面版：安装包已交给系统打开，由用户完成安装后重启应用生效
    await vscode.window.showInformationMessage(
        `GrayCode v${update.version} 安装包已下载并打开，请完成安装后重启应用。`,
        '确定'
    );
    return localPath;
}

/** 下载并安装更新（用户确认后调用） */
export const installUpdate: MessageHandler = async (data, requestId, ctx) => {
    try {
        const checker = getChecker(ctx);
        const update = data?.update as UpdateInfo | undefined;
        if (!update || !update.installerAssetUrl) {
            ctx.sendError(requestId, 'INSTALL_UPDATE_ERROR', '该 Release 未附带安装包');
            return;
        }
        const localPath = await downloadAndInstallAndNotify(checker, update);
        ctx.sendResponse(requestId, { success: true, version: update.version, localPath });
    } catch (error: any) {
        ctx.sendError(requestId, 'INSTALL_UPDATE_ERROR', error?.message || 'Failed to install update');
    }
};

/**
 * 一键更新：立即检查（忽略 24h 节流），有新版本则自动下载并交给系统打开，
 * 用户完成安装后重启应用即可生效。
 */
export const updateNow: MessageHandler = async (data, requestId, ctx) => {
    try {
        const checker = getChecker(ctx);
        const status = await checker.check(true);
        if (status.state === 'updateAvailable') {
            const localPath = await downloadAndInstallAndNotify(checker, status.update);
            ctx.sendResponse(requestId, { success: true, version: status.update.version, localPath });
            return;
        }
        if (status.state === 'upToDate') {
            ctx.sendResponse(requestId, { success: true, alreadyUpToDate: true });
            return;
        }
        if (status.state === 'disabled') {
            ctx.sendError(requestId, 'UPDATE_NOW_ERROR', '自动更新检查已关闭');
            return;
        }
        ctx.sendError(requestId, 'UPDATE_NOW_ERROR', status.state === 'error' ? status.message : '检查更新失败');
    } catch (error: any) {
        ctx.sendError(requestId, 'UPDATE_NOW_ERROR', error?.message || 'Failed to update');
    }
};

/** 打开 GitHub Releases 页面（安装失败/无安装包资产时的兜底入口） */
export const openUpdatePage: MessageHandler = async (data, requestId, ctx) => {
    try {
        await UpdateChecker.openReleasePage();
        ctx.sendResponse(requestId, { success: true });
    } catch (error: any) {
        ctx.sendError(requestId, 'OPEN_UPDATE_PAGE_ERROR', error?.message || 'Failed to open release page');
    }
};

/** 注册更新处理器 */
export function registerUpdateHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('getUpdateStatus', getUpdateStatus);
    registry.set('checkUpdateNow', checkUpdateNow);
    registry.set('installUpdate', installUpdate);
    registry.set('updateNow', updateNow);
    registry.set('openUpdatePage', openUpdatePage);
}
