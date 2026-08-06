/**
 * 设置导入导出 / 旧对话迁移的命令 UI 流程（M-8 结构拆分）。
 *
 * 从 extension.ts 抽出的三个命令体：exportSettings / importSettings / migrateConversationHistories。
 * 全部为纯函数，依赖注入 ChatViewProvider 接口与 vscode API；extension.ts 只保留命令注册。
 * 行为与原实现完全一致（错误处理 / withProgress / i18n 文案逐字保留）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';

/**
 * 命令体所需的最小 ChatViewProvider 接口（依赖注入，便于测试与结构解耦）。
 */
export interface SettingsTransferProvider {
    exportSettings(): Promise<string>;
    importSettings(
        json: string,
        options?: { overwriteChannelConfigs?: boolean; overwriteMcpServers?: boolean; overwriteSkills?: boolean }
    ): Promise<{ success: boolean; imported: { vscodeSettings: boolean; channelConfigs: number; mcpServers: number; skills: number }; errors: string[] }>;
    migrateConversationHistories(progressCallback?: (status: { current: number; total: number; conversationId?: string }) => void): Promise<{
        migrated: number;
        skipped: number;
        failed: Array<{ conversationId: string; error: string }>;
    }>;
    getEffectiveConversationDataPath(): string;
}

/** 未初始化时统一提示（与命令体内文案一致） */
function assertProviderReady(provider: SettingsTransferProvider | undefined): boolean {
    return !!provider;
}

/**
 * 导出设置：选择保存位置 → withProgress 收集 → 写文件 → 结果提示。
 */
export async function runExportSettings(provider: SettingsTransferProvider | undefined): Promise<void> {
    if (!assertProviderReady(provider)) {
        vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法导出设置。');
        return;
    }

    try {
        // 让用户选择保存位置
        const result = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('graycode-settings.json'),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            title: '导出 GrayCode 设置'
        });

        if (!result) {
            return; // 用户取消
        }

        const json = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'GrayCode：正在导出设置...',
            cancellable: false
        }, async () => {
            return await provider!.exportSettings();
        });

        // 写入文件
        await fs.writeFile(result.fsPath, json, 'utf-8');

        vscode.window.showInformationMessage(`设置已成功导出到：${result.fsPath}`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`GrayCode 导出设置失败：${error?.message || String(error)}`);
    }
}

/**
 * 导入设置：选择文件 → 读取 → 选择覆盖方式 → withProgress 导入 → 汇总提示。
 */
export async function runImportSettings(provider: SettingsTransferProvider | undefined): Promise<void> {
    if (!assertProviderReady(provider)) {
        vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法导入设置。');
        return;
    }

    try {
        // 让用户选择导入文件
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            title: '导入 GrayCode 设置'
        });

        if (!result || result.length === 0) {
            return; // 用户取消
        }

        const filePath = result[0].fsPath;

        // 读取文件
        const json = await fs.readFile(filePath, 'utf-8');

        // 让用户确认导入选项
        const overwriteChoice = await vscode.window.showQuickPick(
            [
                { label: '跳过已存在的项', description: '只导入新的配置，不覆盖已有配置', value: 'skip' },
                { label: '覆盖所有', description: '覆盖所有已有配置（建议先备份）', value: 'overwrite' }
            ],
            {
                placeHolder: '选择导入方式',
                title: 'GrayCode 导入设置'
            }
        );

        if (!overwriteChoice) {
            return; // 用户取消
        }

        const overwrite = overwriteChoice.value === 'overwrite';

        const importResult = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'GrayCode：正在导入设置...',
            cancellable: false
        }, async () => {
            return await provider!.importSettings(json, {
                overwriteChannelConfigs: overwrite,
                overwriteMcpServers: overwrite,
                overwriteSkills: overwrite
            });
        });

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
}

/**
 * 迁移旧版单文件对话历史：withProgress（带进度回调）→ 结果汇总提示。
 */
export async function runMigrateConversationHistories(provider: SettingsTransferProvider | undefined): Promise<void> {
    if (!assertProviderReady(provider)) {
        vscode.window.showErrorMessage('GrayCode 尚未完成初始化，无法迁移旧对话历史。');
        return;
    }

    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'GrayCode：正在迁移旧对话历史',
            cancellable: false
        }, async progress => {
            return await provider!.migrateConversationHistories(({ current, total, conversationId }) => {
                progress.report({
                    message: total > 0 ? `${current}/${total}${conversationId ? ` · ${conversationId}` : ''}` : '没有需要迁移的旧对话',
                    increment: total > 0 ? (100 / total) : undefined
                });
            });
        });

        const basePath = provider!.getEffectiveConversationDataPath();
        const summary = `迁移完成。已迁移 ${result.migrated} 个对话，已跳过 ${result.skipped} 个对话，失败 ${result.failed.length} 个。存储路径：${basePath}`;
        if (result.failed.length > 0) {
            vscode.window.showWarningMessage(summary);
        } else {
            vscode.window.showInformationMessage(summary);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`GrayCode 迁移旧对话历史失败：${error?.message || String(error)}`);
    }
}
