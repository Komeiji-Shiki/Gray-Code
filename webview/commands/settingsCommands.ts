/**
 * GrayCode 设置导入/导出/旧对话历史迁移命令（第六批 P6.1：从 extension.ts activate 外移）
 */

import * as vscode from 'vscode';
import type { ChatViewProvider } from '../ChatViewProvider';
import { exportSettingsToFile, importSettingsFromFile } from '../utils/settingsTransfer';

/**
 * 注册设置相关命令：导出设置 / 导入设置 / 迁移旧版对话历史。
 *
 * @param context 扩展上下文（命令注册挂载点）
 * @param provider ChatViewProvider（可能因初始化失败为 undefined，命令内部做空值保护）
 * @returns 命令注册 Disposable 数组（调用方 push 到 context.subscriptions）
 */
export function registerSettingsCommands(
    context: vscode.ExtensionContext,
    provider: ChatViewProvider | undefined
): vscode.Disposable[] {
    return [
        // 导出设置
        vscode.commands.registerCommand('graycode.exportSettings', async () => {
            if (!provider) {
                vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法导出设置。');
                return;
            }

            try {
                // 等待后端初始化完成后再构造 exporter 依赖来源（发现 7）
                const source = await provider.createSettingsTransferSource();

                const outcome = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'GrayCode：正在导出设置...',
                    cancellable: false
                }, async () => {
                    return await exportSettingsToFile(source);
                });

                if (outcome.cancelled) {
                    return; // 用户取消
                }

                vscode.window.showInformationMessage(`设置已成功导出到：${outcome.filePath}`);
            } catch (error: any) {
                vscode.window.showErrorMessage(`GrayCode 导出设置失败：${error?.message || String(error)}`);
            }
        }),

        // 导入设置
        vscode.commands.registerCommand('graycode.importSettings', async () => {
            if (!provider) {
                vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法导入设置。');
                return;
            }

            try {
                // 等待后端初始化完成后再构造 exporter 依赖来源（发现 7）
                const source = await provider.createSettingsTransferSource();

                const outcome = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'GrayCode：正在导入设置...',
                    cancellable: false
                }, async () => {
                    return await importSettingsFromFile(source);
                });

                if (outcome.cancelled) {
                    return; // 用户取消
                }

                const importResult = outcome.result;

                // 构建结果消息
                const parts: string[] = [];
                if (importResult.imported.vscodeSettings) parts.push('VSCode 设置');
                if (importResult.imported.channelConfigs > 0) parts.push(`${importResult.imported.channelConfigs} 个渠道配置`);
                if (importResult.imported.mcpServers > 0) parts.push(`${importResult.imported.mcpServers} 个 MCP 服务器`);
                if (importResult.imported.skills > 0) parts.push(`${importResult.imported.skills} 个 Skills`);

                if (importResult.success) {
                    const importedItems = parts.length > 0 ? `已导入：${parts.join('、')}` : '没有可导入的项';
                    vscode.window.showInformationMessage(`设置导入完成。${importedItems}。`);
                } else {
                    const importedItems = parts.length > 0 ? `已导入：${parts.join('、')}。` : '';
                    const errorSummary = importResult.errors.join('；');
                    vscode.window.showWarningMessage(`设置导入部分完成。${importedItems}错误：${errorSummary}`);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`GrayCode 导入设置失败：${error?.message || String(error)}`);
            }
        }),

        // 迁移旧版单文件对话历史到分段存储格式
        vscode.commands.registerCommand('graycode.migrateConversationHistories', async () => {
            if (!provider) {
                vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法迁移旧对话历史。');
                return;
            }

            try {
                const result = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'GrayCode：正在迁移旧对话历史',
                    cancellable: false
                }, async progress => {
                    return await provider.migrateConversationHistories(({ current, total, conversationId }) => {
                        progress.report({
                            message: total > 0 ? `${current}/${total}${conversationId ? ` · ${conversationId}` : ''}` : '没有需要迁移的旧对话',
                            increment: total > 0 ? (100 / total) : undefined
                        });
                    });
                });

                const basePath = provider.getEffectiveConversationDataPath();
                const summary = `迁移完成。已迁移 ${result.migrated} 个对话，已跳过 ${result.skipped} 个对话，失败 ${result.failed.length} 个。存储路径：${basePath}`;
                if (result.failed.length > 0) {
                    vscode.window.showWarningMessage(summary);
                } else {
                    vscode.window.showInformationMessage(summary);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`GrayCode 迁移旧对话历史失败：${error?.message || String(error)}`);
            }
        })
    ];
}
