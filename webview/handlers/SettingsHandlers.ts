/**
 * 设置管理消息处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { DEFAULT_SUMMARIZE_CONFIG } from '../../backend/modules/settings/types';
import type { HandlerContext, MessageHandler } from '../types';
import { SettingsExporter } from '../../backend/modules/settings/SettingsExporter';
import { getSkillsManager } from '../../backend/modules/skills';

/**
 * 获取设置
 */
export const getSettings: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.getSettings({});
  ctx.sendResponse(requestId, result);
};

/**
 * 更新设置
 */
export const updateSettings: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.updateSettings(data);
  ctx.sendResponse(requestId, result);
};

/**
 * 更新代理设置
 */
export const updateProxySettings: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.updateProxySettings(data);
  ctx.sendResponse(requestId, result);
};

/**
 * 更新 UI 设置
 */
export const updateUISettings: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { ui } = data;
    await ctx.settingsManager.updateUISettings(ui);
    
    // 如果语言设置变更，同步到后端 i18n
    if (ui.language) {
      ctx.syncLanguageToBackend?.();
    }
    
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_UI_SETTINGS_ERROR', error.message || t('webview.errors.updateUISettingsFailed'));
  }
};

/**
 * 获取活动渠道 ID
 */
export const getActiveChannelId: MessageHandler = async (data, requestId, ctx) => {
  const channelId = ctx.settingsManager.getActiveChannelId();
  ctx.sendResponse(requestId, { channelId });
};

/**
 * 设置活动渠道 ID
 */
export const setActiveChannelId: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { channelId } = data;
    await ctx.settingsManager.setActiveChannelId(channelId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_ACTIVE_CHANNEL_ERROR', error.message || t('webview.errors.setActiveChannelFailed'));
  }
};

/**
 * 获取总结配置
 */
export const getSummarizeConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getSummarizeConfig();
    ctx.sendResponse(requestId, config);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_SUMMARIZE_CONFIG_ERROR', error.message || t('webview.errors.getSummarizeConfigFailed'));
  }
};

/**
 * 更新总结配置
 */
export const updateSummarizeConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { config } = data;
    await ctx.settingsManager.updateSummarizeConfig(config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_SUMMARIZE_CONFIG_ERROR', error.message || t('webview.errors.updateSummarizeConfigFailed'));
  }
};

/**
 * 获取内置默认总结配置
 */
export const getDefaultSummarizeConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    ctx.sendResponse(requestId, DEFAULT_SUMMARIZE_CONFIG);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_DEFAULT_SUMMARIZE_CONFIG_ERROR', error.message || t('webview.errors.getSummarizeConfigFailed'));
  }
};

/**
 * 获取图像生成配置
 */
export const getGenerateImageConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getGenerateImageConfig();
    ctx.sendResponse(requestId, config);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_GENERATE_IMAGE_CONFIG_ERROR', error.message || t('webview.errors.getGenerateImageConfigFailed'));
  }
};

/**
 * 更新图像生成配置
 */
export const updateGenerateImageConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { config } = data;
    await ctx.settingsManager.updateGenerateImageConfig(config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_GENERATE_IMAGE_CONFIG_ERROR', error.message || t('webview.errors.updateGenerateImageConfigFailed'));
  }
};

/**
 * 获取系统提示词配置
 */
export const getSystemPromptConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getSystemPromptConfig();
    ctx.sendResponse(requestId, config);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_SYSTEM_PROMPT_CONFIG_ERROR', error.message || t('webview.errors.getSystemPromptConfigFailed'));
  }
};

/**
 * 更新系统提示词配置
 */
export const updateSystemPromptConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { config } = data;
    await ctx.settingsManager.updateSystemPromptConfig(config);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_SYSTEM_PROMPT_CONFIG_ERROR', error.message || t('webview.errors.updateSystemPromptConfigFailed'));
  }
};

/**
 * 获取所有提示词模式
 */
export const getPromptModes: MessageHandler = async (data, requestId, ctx) => {
  try {
    const modes = ctx.settingsManager.getAllPromptModes();
    const currentModeId = ctx.settingsManager.getCurrentPromptModeId();
    const dynamicContextStrategy = ctx.settingsManager.getSystemPromptConfig().dynamicContextStrategy;
    ctx.sendResponse(requestId, { modes, currentModeId, dynamicContextStrategy });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_PROMPT_MODES_ERROR', error.message || 'Failed to get prompt modes');
  }
};

/**
 * 切换当前提示词模式
 */
export const setCurrentPromptMode: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { modeId } = data;
    await ctx.settingsManager.setCurrentPromptMode(modeId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_CURRENT_PROMPT_MODE_ERROR', error.message || 'Failed to set current prompt mode');
  }
};

/**
 * 保存提示词模式
 */
export const savePromptMode: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { mode } = data;
    await ctx.settingsManager.savePromptMode(mode);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SAVE_PROMPT_MODE_ERROR', error.message || 'Failed to save prompt mode');
  }
};

/**
 * 重命名提示词模式
 */
export const renamePromptMode: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { modeId, name } = data;
    const mode = await ctx.settingsManager.renamePromptMode(modeId, name);
    ctx.sendResponse(requestId, { success: true, mode });
  } catch (error: any) {
    ctx.sendError(requestId, 'RENAME_PROMPT_MODE_ERROR', error.message || 'Failed to rename prompt mode');
  }
};

/**
 * 删除提示词模式
 */
export const deletePromptMode: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { modeId } = data;
    await ctx.settingsManager.deletePromptMode(modeId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_PROMPT_MODE_ERROR', error.message || 'Failed to delete prompt mode');
  }
};

/**
 * 计算系统提示词 Token 数（分别计算静态和动态部分）
 */
export const countSystemPromptTokens: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { staticText, channelType, conversationId } = data;
    const result = await ctx.settingsHandler.countSystemPromptTokensSeparate({ 
      staticText, 
      channelType,
      conversationId 
    });
    if (result.success) {
      ctx.sendResponse(requestId, { 
        success: true, 
        staticTokens: result.staticTokens,
        dynamicTokens: result.dynamicTokens
      });
    } else {
      ctx.sendResponse(requestId, { success: false, error: result.error?.message });
    }
  } catch (error: any) {
    ctx.sendResponse(requestId, { success: false, error: error.message || 'Token count failed' });
  }
};

/**
 * 注册设置管理处理器
 */
export function registerSettingsHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('getSettings', getSettings);
  registry.set('updateSettings', updateSettings);
  registry.set('updateProxySettings', updateProxySettings);
  registry.set('updateUISettings', updateUISettings);
  registry.set('settings.getActiveChannelId', getActiveChannelId);
  registry.set('settings.setActiveChannelId', setActiveChannelId);
  registry.set('getSummarizeConfig', getSummarizeConfig);
  registry.set('getDefaultSummarizeConfig', getDefaultSummarizeConfig);
  registry.set('updateSummarizeConfig', updateSummarizeConfig);
  registry.set('getGenerateImageConfig', getGenerateImageConfig);
  registry.set('updateGenerateImageConfig', updateGenerateImageConfig);
  registry.set('getSystemPromptConfig', getSystemPromptConfig);
  registry.set('updateSystemPromptConfig', updateSystemPromptConfig);
  // 模式管理
  registry.set('getPromptModes', getPromptModes);
  registry.set('setCurrentPromptMode', setCurrentPromptMode);
  registry.set('savePromptMode', savePromptMode);
  registry.set('renamePromptMode', renamePromptMode);
  registry.set('deletePromptMode', deletePromptMode);
  registry.set('countSystemPromptTokens', countSystemPromptTokens);
  registry.set('checkAnnouncement', checkAnnouncement);
  registry.set('markAnnouncementRead', markAnnouncementRead);
  // 设置导出/导入
  registry.set('settings.export', exportSettings);
  registry.set('settings.import', importSettings);
}

/**
 * 检查是否需要显示版本更新公告
 */
export const checkAnnouncement: MessageHandler = async (data, requestId, ctx) => {
  try {
    const result = await ctx.settingsHandler.checkAnnouncement();
    ctx.sendResponse(requestId, result);
  } catch (error: any) {
    ctx.sendError(requestId, 'CHECK_ANNOUNCEMENT_ERROR', error.message || 'Failed to check announcement');
  }
};

/**
 * 标记公告已读
 */
export const markAnnouncementRead: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { version } = data;
    await ctx.settingsHandler.markAnnouncementRead(version);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'MARK_ANNOUNCEMENT_READ_ERROR', error.message || 'Failed to mark announcement as read');
  }
};

/**
 * 获取扩展版本号
 */
function getExtensionVersion(ctx: HandlerContext): string {
    try {
        if (ctx.context) {
            const packageJsonPath = path.join(ctx.context.extensionPath, 'package.json');
            const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
            return packageJson.version || '0.0.0';
        }
    } catch (error) {
        console.warn('[SettingsHandlers] Failed to read extension version from package.json:', error);
    }
    return '0.0.0';
}

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
        getExtensionVersion(ctx),
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
            defaultUri: vscode.Uri.file('limcode-settings.json'),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            title: '导出 LimCode 设置'
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

        const { overwrite } = data; // 前端传入的覆盖选项

        // 弹出打开对话框
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            title: '导入 LimCode 设置'
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
                    title: 'LimCode 导入设置'
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
            overwriteSkills: shouldOverwrite
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

