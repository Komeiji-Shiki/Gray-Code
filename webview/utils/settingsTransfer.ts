/**
 * 设置导出/导入共享工具（发现 7 收敛）。
 *
 * 收敛三处入口的重复实现：
 * - ChatViewProvider.exportSettings/importSettings（设置序列化 API）
 * - handlers/SettingsTransferHandlers（webview 设置页按钮）
 * - commands/settingsCommands（命令面板入口）
 *
 * 共享内容：
 * - SettingsExporter 构造参数（5 个 manager + 版本 + skills 目录）→ createSettingsExporter
 * - 保存/打开对话框 + 写文件/解析导入 → exportSettingsToFile / importSettingsFromFile
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { SettingsExporter } from '../../backend/modules/settings';
import type { SettingsManager, StoragePathManager, ImportResult } from '../../backend/modules/settings';
import type { ConfigManager } from '../../backend/modules/config';
import type { McpManager } from '../../backend/modules/mcp';
import type { HandlerContext } from '../types';
import { getSkillsManager } from '../../backend/modules/skills';
import { getExtensionVersion } from './extensionInfo';

/** 导出文件的默认文件名（三处入口统一） */
export const DEFAULT_SETTINGS_FILENAME = 'graycode-settings.json';

/** SettingsExporter 所需的依赖来源（webview handler 与命令入口分别提供） */
export interface SettingsTransferSource {
    settingsManager: SettingsManager;
    configManager: ConfigManager;
    mcpManager: McpManager;
    storagePathManager: StoragePathManager;
    /** 扩展路径（用于读取插件版本；缺失时版本回退 '0.0.0'） */
    extensionPath?: string;
}

/** 从 HandlerContext 提取 SettingsExporter 依赖（webview handler 入口） */
export function toSettingsTransferSource(ctx: HandlerContext): SettingsTransferSource {
    return {
        settingsManager: ctx.settingsManager,
        configManager: ctx.configManager,
        mcpManager: ctx.mcpManager,
        storagePathManager: ctx.storagePathManager,
        extensionPath: ctx.context?.extensionPath
    };
}

export function createSettingsExporter(source: SettingsTransferSource): SettingsExporter | null {
    const skillsManager = getSkillsManager();
    if (!skillsManager) {
        return null;
    }
    return new SettingsExporter(
        source.settingsManager,
        source.configManager,
        source.mcpManager,
        skillsManager,
        source.extensionPath ? getExtensionVersion(source.extensionPath) : '0.0.0',
        path.join(source.storagePathManager.getEffectiveDataPath(), 'skills')
    );
}

export type ExportSettingsToFileResult =
    | { cancelled: true }
    | { cancelled: false; filePath: string };

/**
 * 导出设置到用户选择的文件：构造 exporter + 保存对话框 + 写文件。
 * 用户取消对话框返回 { cancelled: true }。
 */
export async function exportSettingsToFile(source: SettingsTransferSource): Promise<ExportSettingsToFileResult> {
    const exporter = createSettingsExporter(source);
    if (!exporter) {
        throw new Error('SkillsManager is not initialized.');
    }

    const result = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.resolve(DEFAULT_SETTINGS_FILENAME)),
        filters: {
            'JSON Files': ['json'],
            'All Files': ['*']
        },
        title: '导出 GrayCode 设置'
    });

    if (!result) {
        return { cancelled: true };
    }

    const json = await exporter.exportToJson(true);
    await fs.writeFile(result.fsPath, json, 'utf-8');

    return { cancelled: false, filePath: result.fsPath };
}

export interface ImportSettingsFileOptions {
    /** 调用方已指定的覆盖方式；true=覆盖所有，省略/假值=弹窗询问用户 */
    overwrite?: boolean;
}

export type ImportSettingsFromFileResult =
    | { cancelled: true }
    | { cancelled: false; result: ImportResult };

/**
 * 从用户选择的文件导入设置：构造 exporter + 打开对话框 + 读取文件 + 覆盖询问 + 解析导入。
 * 用户取消（打开对话框或覆盖询问）返回 { cancelled: true }。
 */
export async function importSettingsFromFile(
    source: SettingsTransferSource,
    options?: ImportSettingsFileOptions
): Promise<ImportSettingsFromFileResult> {
    const exporter = createSettingsExporter(source);
    if (!exporter) {
        throw new Error('SkillsManager is not initialized.');
    }

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
        return { cancelled: true };
    }

    const filePath = result[0].fsPath;
    const json = await fs.readFile(filePath, 'utf-8');

    let shouldOverwrite = !!options?.overwrite;
    if (!options?.overwrite) {
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
            return { cancelled: true };
        }
        shouldOverwrite = choice.value === 'overwrite';
    }

    const data = exporter.parseExportData(json);
    const importResult = await exporter.importFromData(data, {
        overwriteChannelConfigs: shouldOverwrite,
        overwriteMcpServers: shouldOverwrite,
        overwriteSkills: shouldOverwrite,
        overwriteVscodeSettings: shouldOverwrite
    });

    return { cancelled: false, result: importResult };
}
