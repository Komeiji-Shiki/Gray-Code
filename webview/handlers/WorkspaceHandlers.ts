/**
 * 工作区处理器（多工作区支持）
 *
 * - getWorkspaceList：一次性返回激活工作区 + 全部工作区列表（初始化时替代两次 IPC）
 * - workspace.setActive：用户显式切换/固定激活工作区（传 null 恢复跟随活动编辑器）
 */

import type { MessageHandler } from '../types';
import { getWorkspaceManager } from '../utils/WorkspaceManager';

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

export function registerWorkspaceHandlers(registry: Map<string, MessageHandler>): void {
    registry.set('getWorkspaceList', getWorkspaceList);
    registry.set('workspace.setActive', setActiveWorkspace);
}
