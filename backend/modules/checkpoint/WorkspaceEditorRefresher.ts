/**
 * GrayCode - 工作区文档刷新器（CPF-12：从 CheckpointManager 拆分）
 *
 * 恢复检查点后刷新 VSCode 中被修改/删除的打开文档（交给 VS Code 原生 revert 处理编码与 dirty buffer，
 * 避免把非 UTF-8 文件按 UTF-8 重编码），并关闭涉及受影响文件的 diff 视图
 * （关闭前采样聊天输入框焦点，关闭后按需归还焦点）。
 *
 * 采用 VS Code 原生 revert，保证文档自身编码探测与 dirty buffer 丢弃语义。
 */

import * as vscode from 'vscode';
import { restoreChatInputFocus, shouldRestoreChatInputFocus } from '../../core/chatFocusGuard';
import { Logger } from '../../core/logger';

const log = Logger.get('WorkspaceEditorRefresher');

/**
 * 只刷新受影响的文档
 *
 * 相比刷新所有文档，这种方式更高效，只处理实际被修改或删除的文件
 *
 * @param modifiedFiles 被修改或新增的文件路径列表
 * @param deletedFiles 被删除的文件路径列表
 */
export async function refreshAffectedDocuments(modifiedFiles: string[], deletedFiles: string[]): Promise<void> {
    // C-10: 大小写策略按平台决定——win32/darwin 默认大小写不敏感卷折叠小写比较；
    // 大小写敏感文件系统（Linux 等）按原样比较，避免误刷新大小写不同的另一个文件。
    const caseFold = process.platform === 'win32' || process.platform === 'darwin'
        ? (p: string) => p.toLowerCase()
        : (p: string) => p;
    // 创建快速查找集合
    const modifiedSet = new Set(modifiedFiles.map(f => caseFold(f)));
    const deletedSet = new Set(deletedFiles.map(f => caseFold(f)));
    
    try {
        // 获取所有已打开的文本文档
        const openDocuments = vscode.workspace.textDocuments;
        
        for (const doc of openDocuments) {
            if (doc.uri.scheme !== 'file') continue;
            
            const docPath = caseFold(doc.uri.fsPath);
            
            // 直接交给 VS Code 的 revert 命令丢弃 buffer：它会沿用文档自身的编码检测，
            // 避免把 GBK/UTF-16 等非 UTF-8 文件先按 UTF-8 解码再保存造成内容损坏。
            // 对被恢复删除的 dirty 文档也必须执行 revert，否则用户稍后保存旧 buffer 会把文件重建。
            if (modifiedSet.has(docPath) || deletedSet.has(docPath)) {
                try {
                    await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                } catch (err) {
                    log.warn('refresh_document_revert_failed', {
                        path: doc.uri.fsPath,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        }
        
        // 关闭涉及受影响文件的 diff 视图。
        // 关闭前采样聊天输入框焦点状态：preserveFocus 只能阻止焦点跳进
        // 编辑器，无法阻止 workbench 把焦点从侧边栏 webview 收走，
        // 关闭后按需把焦点归还给聊天视图
        const restoreFocus = shouldRestoreChatInputFocus();
        let closedAnyDiffTab = false;
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputTextDiff) {
                    const diffInput = tab.input as vscode.TabInputTextDiff;
                    const modifiedPath = caseFold(diffInput.modified.fsPath);
                    
                    // 如果 diff 涉及被修改或删除的文件，关闭它
                    if (modifiedSet.has(modifiedPath) || deletedSet.has(modifiedPath)) {
                        await vscode.window.tabGroups.close(tab, true);
                        closedAnyDiffTab = true;
                    }
                }
            }
        }
        if (closedAnyDiffTab) {
            await restoreChatInputFocus(restoreFocus);
        }
    } catch (err) {
        log.error('refresh_affected_documents_failed', {
            error: err instanceof Error ? err.message : String(err)
        });
    }
}


