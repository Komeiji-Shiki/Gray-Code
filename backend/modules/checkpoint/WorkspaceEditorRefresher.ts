/**
 * LimCode - 工作区文档刷新器（CPF-12：从 CheckpointManager 拆分）
 *
 * 恢复检查点后刷新 VSCode 中被修改/删除的打开文档（把文档 buffer 替换为磁盘内容后
 * 静默保存，applyEdit 失败时回退 revert），并关闭涉及受影响文件的 diff 视图
 * （关闭前采样聊天输入框焦点，关闭后按需归还焦点）。
 *
 * 纯重构：方法体自 CheckpointManager.refreshAffectedDocuments 原样平移，不改变行为。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { restoreChatInputFocus, shouldRestoreChatInputFocus } from '../../core/chatFocusGuard';

/**
 * 只刷新受影响的文档
 *
 * 相比刷新所有文档，这种方式更高效，只处理实际被修改或删除的文件
 *
 * @param modifiedFiles 被修改或新增的文件路径列表
 * @param deletedFiles 被删除的文件路径列表
 */
export async function refreshAffectedDocuments(modifiedFiles: string[], deletedFiles: string[]): Promise<void> {
    // 创建快速查找集合
    const modifiedSet = new Set(modifiedFiles.map(f => f.toLowerCase()));
    const deletedSet = new Set(deletedFiles.map(f => f.toLowerCase()));
    
    try {
        // 获取所有已打开的文本文档
        const openDocuments = vscode.workspace.textDocuments;
        
        for (const doc of openDocuments) {
            if (doc.uri.scheme !== 'file') continue;
            
            const docPath = doc.uri.fsPath.toLowerCase();
            
            // 检查文档是否在受影响列表中
            if (modifiedSet.has(docPath)) {
                // 恢复场景：磁盘上已是恢复后的内容，打开着的文档 buffer 是旧内容。
                // 绝不能直接 doc.save()（会把用户旧 buffer 写回磁盘，覆盖刚恢复的内容），
                // 也不能直接 revert（dirty 时会弹 VSCode 原生"是否放弃更改？"确认框阻塞流程）。
                // 方案：把文档 buffer 替换为磁盘内容后静默 save，丢弃旧 buffer。
                try {
                    if (doc.isDirty) {
                        const diskText = await fs.readFile(doc.uri.fsPath, 'utf8');
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(doc.getText().length)
                        );
                        edit.replace(doc.uri, fullRange, diskText);
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (applied) {
                            await doc.save();
                            continue;
                        }
                    }
                    // applyEdit 失败时回退到 revert（可能弹框，作为最后手段）
                    await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                } catch (err) {
                    console.warn(`[CheckpointManager] Failed to revert ${doc.uri.fsPath}:`, err);
                }
            }
            // 删除的文件不做任何处理，让 VSCode 自然显示"文件已删除"的状态
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
                    const modifiedPath = diffInput.modified.fsPath.toLowerCase();
                    
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
        console.error('[CheckpointManager] Failed to refresh affected documents:', err);
    }
}

