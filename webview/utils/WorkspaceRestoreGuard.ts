/**
 * 工作区恢复安全闸（BCP-05 / 决策 11）：dirty 检测 + 恢复/切换前取消流与 SubAgent 的公共前置。
 *
 * - detectDirtyFilesInWorkspace：遍历 vscode.workspace.textDocuments，找出
 *   isDirty 且位于任一工作区根内的 file 文档。普通恢复（checkpoint.restore）与
 *   分支切换恢复（switchBranchCandidate mode=chat-and-workspace）共用——
 *   恢复不再静默丢弃用户未保存内容，先拦截并提示确认（决策 11）。
 * - cancelStreamAndSubAgents：从 CheckpointHandlers.restoreCheckpoint 原样抽取的
 *   「取消会话流式请求 + 取消该会话关联的活跃 SubAgent」逻辑（CP-04/CP-12），
 *   普通恢复与分支切换恢复共用（BCP-03 复用，避免 handler 间复制）。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { subAgentRunController } from '../../backend/tools/subagents/runController';
import { subAgentRunEventBus } from '../../backend/tools/subagents/runEventBus';
import type { HandlerContext } from '../types';

/**
 * 检测工作区内未保存（dirty）的打开文档。
 * 返回文档绝对路径列表（fsPath）；无工作区根 / 无 dirty 文档返回 []。
 * 与 WorkspaceEditorRefresher 的过滤口径一致（只处理 uri.scheme === 'file'）。
 */
export function detectDirtyFilesInWorkspace(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return [];
    }
    const roots = folders
        .map(folder => folder.uri.fsPath)
        .filter((root): root is string => typeof root === 'string' && root.length > 0);
    if (roots.length === 0) {
        return [];
    }

    const dirty: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'file' || !doc.isDirty) {
            continue;
        }
        const fsPath = doc.uri.fsPath;
        if (typeof fsPath === 'string' && fsPath.length > 0 && isPathInsideRoots(fsPath, roots)) {
            dirty.push(fsPath);
        }
    }
    return dirty;
}

/** 路径是否位于任一工作区根内（大小写不敏感前缀匹配，兼容 Windows） */
function isPathInsideRoots(fsPath: string, roots: string[]): boolean {
    const normalized = path.normalize(fsPath).toLowerCase();
    return roots.some(root => {
        const normalizedRoot = path.normalize(root).toLowerCase();
        return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
    });
}

/**
 * 取消指定会话的流式请求 + 取消该会话关联的活跃 SubAgent。
 *
 * 恢复 / 分支切换恢复的前置清理（CP-04/CP-12）：取消只是「尽力而为」，
 * 取消失败不应阻断主流程，独立 try/catch 仅告警。
 */
export async function cancelStreamAndSubAgents(ctx: HandlerContext, conversationId: string): Promise<void> {
    try {
        // 等旧流完全退出（工具结算落盘、finally 注销控制器）再返回：
        // 恢复/切换写入历史若与旧流结算 addContent 交错，会产生半截回答/错位结算。
        // 与主流入口（StreamRequestHandler）的写序保护同一口径；超时兜底防挂死。
        await ctx.streamAbortControllers.abortAndWaitForCompletion(conversationId);
    } catch (err) {
        console.warn('[WorkspaceRestoreGuard] Failed to cancel stream before restore:', err);
    }

    try {
        const snapshots = subAgentRunEventBus.getSnapshots();
        for (const snapshot of snapshots) {
            if (snapshot.conversationId === conversationId && subAgentRunController.isActive(snapshot.runId)) {
                subAgentRunController.cancel(snapshot.runId, 'checkpoint restore');
            }
        }
    } catch (err) {
        console.warn('[WorkspaceRestoreGuard] Failed to cancel subagents before restore:', err);
    }
}
