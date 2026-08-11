/**
 * GrayCode Diff / Selection 子系统注册（第六批 P6.1：从 extension.ts activate 外移）
 *
 * 负责：
 * - DiffCodeLensProvider 注册（file / gemini-diff-original）
 * - DiffManager 状态监听（刷新 CodeLens / 内联高亮 / 标题栏按钮）
 * - Selection Context（Hover + Code Actions + graycode.context.addSelectionToInput 命令）
 * - Diff Inline Provider（Hover + Code Actions）
 * - DiffEditorActionsProvider + 10 个 diff 命令
 *
 * 释放顺序（与旧 deactivate 手工配对保持一致）：
 *   返回数组按「释放顺序」排列：
 *     [0] DiffManager 状态监听器摘除（最先：同步阻断停用期 notifyStatusChange 复活已 dispose 的 provider）
 *     [1] CodeLens 提供者注册注销
 *     [2] Inline Hover 提供者注册注销
 *     [3] DiffInlineProvider 实例释放
 *     [4] DiffEditorActionsProvider 实例释放
 *   调用方需把返回数组逆序 push 到 context.subscriptions（VS Code 在扩展停用时按 LIFO 释放）。
 *   其余顺序不敏感的注册项（命令 / Code Action / Selection）由本函数直接挂到 context.subscriptions。
 */

import * as vscode from 'vscode';
import { t } from '../../backend/i18n';
import { Logger } from '../../backend/core/logger';
import { getDiffCodeLensProvider } from '../../backend/tools/file/DiffCodeLensProvider';
import { getDiffEditorActionsProvider } from '../../backend/tools/file/DiffEditorActionsProvider';
import { getDiffInlineProvider, DiffInlineProvider } from '../../backend/tools/file/DiffInlineProvider';
import { getDiffManager } from '../../backend/core/services/diffManager';
import { getSelectionContextProvider, SelectionContextProvider, type SelectionContextCommandArgs } from '../../backend/tools/file/SelectionContextProvider';
import type { ChatViewProvider } from '../ChatViewProvider';
import { PUSH_MESSAGE_NAMES } from '../../shared/protocol';

const log = Logger.get('diff-ui');

/**
 * 注册 Diff / Selection 提供者与命令。
 *
 * @param context 扩展上下文（顺序不敏感注册项直接挂载）
 * @param chatViewProvider 聊天视图提供者（可能因初始化失败为 undefined，命令内部做空值保护）
 * @returns 顺序敏感释放项（按释放顺序排列，调用方逆序 push 到 context.subscriptions）
 */
export function registerDiffUi(
    context: vscode.ExtensionContext,
    chatViewProvider: ChatViewProvider | undefined
): vscode.Disposable[] {
    // 顺序敏感释放项：数组顺序即释放顺序（见文件头注释）
    const teardown: vscode.Disposable[] = [];

    // ========== DiffCodeLensProvider 注册 ==========
    const diffCodeLensProvider = getDiffCodeLensProvider();

    // 监听 DiffManager 状态变化，刷新相关 UI（CodeLens、内联高亮、标题栏按钮）
    const diffStatusListener = () => {
        getDiffEditorActionsProvider().refresh();
        getDiffInlineProvider().refreshAllDecorations();
    };
    getDiffManager().addStatusListener(diffStatusListener);
    teardown.push({ dispose: () => getDiffManager().removeStatusListener(diffStatusListener) });

    // 注册 CodeLens 提供者
    teardown.push(vscode.languages.registerCodeLensProvider(
        [
            { scheme: 'file' },
            { scheme: 'gemini-diff-original' }
        ],
        diffCodeLensProvider
    ));

    // ========== Selection Context (Hover + Code Actions) ==========
    const selectionContextProvider = getSelectionContextProvider();

    // Hover: selected text -> "Add to GrayCode input"
    const selectionHoverDisposable = vscode.languages.registerHoverProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }],
        selectionContextProvider
    );
    context.subscriptions.push(selectionHoverDisposable);

    // Lightbulb: add selection as context snippet
    const selectionCodeActionDisposable = vscode.languages.registerCodeActionsProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }],
        selectionContextProvider,
        {
            providedCodeActionKinds: SelectionContextProvider.providedCodeActionKinds
        }
    );
    context.subscriptions.push(selectionCodeActionDisposable);

    // Command used by hover/code actions
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.context.addSelectionToInput', async (args?: SelectionContextCommandArgs) => {
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showInformationMessage(t('tools.file.selectionContext.noActiveEditor'));
                    return;
                }

                let targetUri = editor.document.uri;
                let selection = editor.selection;

                if (args?.uri) {
                    targetUri = vscode.Uri.parse(args.uri);
                    selection = new vscode.Selection(
                        new vscode.Position(args.selection.start.line, args.selection.start.character),
                        new vscode.Position(args.selection.end.line, args.selection.end.character)
                    );
                }

                const doc = (targetUri.toString() === editor.document.uri.toString())
                    ? editor.document
                    : await vscode.workspace.openTextDocument(targetUri);

                if (selection.isEmpty) {
                    vscode.window.showInformationMessage(t('tools.file.selectionContext.noSelection'));
                    return;
                }

                // Expand to whole lines. Adjust end line when selection ends at column 0.
                let startLine = selection.start.line;
                let endLine = selection.end.line;
                if (selection.end.character === 0 && selection.end.line > selection.start.line) {
                    endLine = Math.max(selection.start.line, selection.end.line - 1);
                }

                startLine = Math.max(0, Math.min(startLine, doc.lineCount - 1));
                endLine = Math.max(0, Math.min(endLine, doc.lineCount - 1));
                if (endLine < startLine) {
                    const tmp = startLine;
                    startLine = endLine;
                    endLine = tmp;
                }

                const endChar = doc.lineAt(endLine).text.length;
                const lineRange = new vscode.Range(startLine, 0, endLine, endChar);
                const content = doc.getText(lineRange);

                const lines = content.split(/\r?\n/);
                const width = String(endLine + 1).length;
                const numbered = lines
                    .map((line, i) => `${String(startLine + 1 + i).padStart(width, ' ')} | ${line}`)
                    .join('\n');

                const relativePath = vscode.workspace.asRelativePath(targetUri, false);
                const title = `${relativePath}[L${startLine + 1}-${endLine + 1}]`;

                const contextItem = {
                    id: `snippet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    type: 'snippet' as const,
                    title,
                    content: numbered,
                    filePath: relativePath,
                    language: doc.languageId,
                    enabled: true,
                    addedAt: Date.now()
                };

                // Ensure chat view is visible, then send to webview.
                await vscode.commands.executeCommand('graycode.openChat');
                chatViewProvider?.sendCommand(PUSH_MESSAGE_NAMES['input.addContext'], { contextItem });
            } catch (err: any) {
                log.error('Failed to add selection context:', err);
                vscode.window.showErrorMessage(t('tools.file.selectionContext.failedToAddSelection', { error: err?.message || String(err) }));
            }
        })
    );

    // ========== Diff Inline Provider (Hover + Code Actions) ==========
    const diffInlineProvider = getDiffInlineProvider();

    // 注册 Hover 提供者（悬停显示可点击的 Accept/Reject 链接）
    teardown.push(vscode.languages.registerHoverProvider(
        [
            { scheme: 'file' },
            { scheme: 'gemini-diff-original' }
        ],
        diffInlineProvider
    ));

    // 注册 Code Action 提供者（灯泡操作，自定义来源 "GrayCode Diff"）
    const diffCodeActionDisposable = vscode.languages.registerCodeActionsProvider(
        [
            { scheme: 'file' },
            { scheme: 'gemini-diff-original' }
        ],
        diffInlineProvider,
        {
            providedCodeActionKinds: DiffInlineProvider.providedCodeActionKinds
        }
    );
    context.subscriptions.push(diffCodeActionDisposable);

    // diff 命令失败时的统一错误处理：记录日志 + 提示用户
    const handleDiffCommandError = (command: string, err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`diff.${command}.failed`, { error: message });
        vscode.window.showErrorMessage(`Diff ${command} 操作失败：${message}`);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.confirmBlock', async (sessionId: string, blockIndex?: number) => {
            try {
                await diffCodeLensProvider.confirmBlock(sessionId, blockIndex);
            } catch (err) {
                handleDiffCommandError('confirmBlock', err);
            } finally {
                // 刷新编辑器操作提供者状态
                getDiffEditorActionsProvider().refresh();
                // 刷新内联装饰器
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册 diff 拒绝命令（CodeLens 和 Code Actions 使用）
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff._rejectBlockFromCodeLens', async (sessionId: string, blockIndex?: number) => {
            try {
                await diffCodeLensProvider.rejectBlock(sessionId, blockIndex);
            } catch (err) {
                handleDiffCommandError('_rejectBlockFromCodeLens', err);
            } finally {
                // 刷新编辑器操作提供者状态
                getDiffEditorActionsProvider().refresh();
                // 刷新内联装饰器
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // ========== Diff Editor Actions ==========
    const diffEditorActionsProvider = getDiffEditorActionsProvider();

    // 注册命令：接受所有修改
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.acceptAll', async () => {
            try {
                await diffEditorActionsProvider.acceptAll();
            } catch (err) {
                handleDiffCommandError('acceptAll', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：拒绝所有修改
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.rejectAll', async () => {
            try {
                await diffEditorActionsProvider.rejectAll();
            } catch (err) {
                handleDiffCommandError('rejectAll', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：选择并接受 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.acceptBlock', async () => {
            try {
                await diffEditorActionsProvider.showBlockPicker('accept');
            } catch (err) {
                handleDiffCommandError('acceptBlock', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：选择并拒绝 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.rejectBlock', async () => {
            try {
                await diffEditorActionsProvider.showBlockPicker('reject');
            } catch (err) {
                handleDiffCommandError('rejectBlock', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：接受当前光标位置的 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.acceptCurrentBlock', async () => {
            try {
                await diffEditorActionsProvider.acceptCurrentBlock();
            } catch (err) {
                handleDiffCommandError('acceptCurrentBlock', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：拒绝当前光标位置的 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.rejectCurrentBlock', async () => {
            try {
                await diffEditorActionsProvider.rejectCurrentBlock();
            } catch (err) {
                handleDiffCommandError('rejectCurrentBlock', err);
            } finally {
                diffInlineProvider.refreshAllDecorations();
            }
        })
    );

    // 注册命令：跳转到下一个 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.nextBlock', async () => {
            try {
                await diffEditorActionsProvider.goToNextBlock();
            } catch (err) {
                handleDiffCommandError('nextBlock', err);
            }
        })
    );

    // 注册命令：跳转到上一个 diff 块
    context.subscriptions.push(
        vscode.commands.registerCommand('graycode.diff.prevBlock', async () => {
            try {
                await diffEditorActionsProvider.goToPrevBlock();
            } catch (err) {
                handleDiffCommandError('prevBlock', err);
            }
        })
    );

    // Provider 实例释放：必须在 VS Code 注册注销之后、DiffManager 单例释放之前（顺序见文件头注释）
    teardown.push({ dispose: () => getDiffInlineProvider().dispose() });
    teardown.push({ dispose: () => getDiffEditorActionsProvider().dispose() });

    return teardown;
}
