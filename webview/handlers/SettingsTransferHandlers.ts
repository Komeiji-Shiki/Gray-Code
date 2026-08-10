/**
 * 设置导入/导出子域消息处理器（从 SettingsHandlers 拆分）。
 *
 * 消息 key：settings.export / settings.import。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SettingsExporter } from '../../backend/modules/settings/SettingsExporter';
import { getSkillsManager } from '../../backend/modules/skills';
import { getExtensionVersion } from '../utils/extensionInfo';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 获取 Skills 目录路径
 */
function getSkillsDir(ctx: HandlerContext): string {
    return path.join(ctx.storagePathManager.getEffectiveDataPath(), 'skills');
}

/**
 * 创建设置导出器实例
 */
function createExporter(ctx: HandlerContext): SettingsExporter | null {
    const skillsManager = getSkillsManager();
    if (!skillsManager) {
        return null;
    }
    return new SettingsExporter(
        ctx.settingsManager,
        ctx.configManager,
        ctx.mcpManager,
        skillsManager,
        ctx.context ? getExtensionVersion(ctx.context.extensionPath) : '0.0.0',
        getSkillsDir(ctx)
    );
}

/**
 * 导出设置
 * 从设置页面触发，弹出保存对话框，将设置导出为 JSON 文件
 */
export const exportSettings: MessageHandler = async (data, requestId, ctx) => {
    try {
        const exporter = createExporter(ctx);
        if (!exporter) {
            ctx.sendError(requestId, 'EXPORT_ERROR', 'SkillsManager is not initialized.');
            return;
        }

        // 弹出保存对话框
        const result = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.resolve('graycode-settings.json')),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            title: '导出 GrayCode 设置'
        });

        if (!result) {
            ctx.sendResponse(requestId, { success: false, cancelled: true });
            return;
        }

        // 导出为 JSON
        const json = await exporter.exportToJson(true);

        // 写入文件
        await fs.writeFile(result.fsPath, json, 'utf-8');

        ctx.sendResponse(requestId, { success: true, filePath: result.fsPath });
    } catch (error: any) {
        ctx.sendError(requestId, 'EXPORT_ERROR', error.message || 'Failed to export settings');
    }
};

/**
 * 导入设置
 * 从设置页面触发，弹出打开对话框，从 JSON 文件导入设置
 */
export const importSettings: MessageHandler = async (data, requestId, ctx) => {
    try {
        const exporter = createExporter(ctx);
        if (!exporter) {
            ctx.sendError(requestId, 'IMPORT_ERROR', 'SkillsManager is not initialized.');
            return;
        }

        const { overwrite } = data || {}; // 前端传入的覆盖选项

        // 弹出打开对话框
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
            ctx.sendResponse(requestId, { success: false, cancelled: true });
            return;
        }

        const filePath = result[0].fsPath;

        // 读取文件
        const json = await fs.readFile(filePath, 'utf-8');

        // 询问用户导入方式（如果前端未指定）
        let shouldOverwrite = !!overwrite;
        if (!overwrite) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '跳过已存在的项', description: '只导入新的配置，不覆盖已有配置', value: 'skip' },
                    { label: '覆盖所有', description: '覆盖所有已有配置（建议先备份）', value: 'overwrite' }
                ],
                {
                    placeHolder: '选择导入方式',
                    title: 'GrayCode 导入设置'
                }
            );
            if (!choice) {
                ctx.sendResponse(requestId, { success: false, cancelled: true });
                return;
            }
            shouldOverwrite = choice.value === 'overwrite';
        }

        // 解析并导入
        const data_ = exporter.parseExportData(json);
        const importResult = await exporter.importFromData(data_, {
            overwriteChannelConfigs: shouldOverwrite,
            overwriteMcpServers: shouldOverwrite,
            overwriteSkills: shouldOverwrite,
            overwriteVscodeSettings: shouldOverwrite
        });

        ctx.sendResponse(requestId, {
            success: importResult.success,
            imported: importResult.imported,
            errors: importResult.errors
        });
    } catch (error: any) {
        ctx.sendError(requestId, 'IMPORT_ERROR', error.message || 'Failed to import settings');
    }
};

/**
 * 注册设置导入/导出处理器
 */
export function registerSettingsTransferHandlers(registry: Map<string, MessageHandler>): void {
  // 设置导出/导入
  registry.set('settings.export', exportSettings);
  registry.set('settings.import', importSettings);
}
