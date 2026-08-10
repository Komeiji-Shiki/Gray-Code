/**
 * 设置管理消息处理器（通用设置 / 总结配置 / 图像生成配置 / 系统提示配置 / Prompt 模式 / 公告）。
 *
 * 记忆子域（getMemoryConfig 等 8 个消息）已拆分至 ./MemoryHandlers；
 * 设置导入/导出（settings.export / settings.import）已拆分至 ./SettingsTransferHandlers。
 * 本文件保留其余子域，并在文件尾 re-export 两个新模块（保持既有导入路径可用）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { DEFAULT_SUMMARIZE_CONFIG } from '../../backend/modules/settings';
import type { MessageHandler } from '../types';
import { getProductMetadata } from '../../backend/core/productMetadata';

function settingsHandlerBoundary(errorCode: string, fallback: string, handler: MessageHandler): MessageHandler {
  return async (data, requestId, ctx) => {
    try {
      await handler(data || {}, requestId, ctx);
    } catch (error) {
      ctx.sendError(requestId, errorCode, error instanceof Error && error.message ? error.message : fallback);
    }
  };
}

/**
 * 获取设置
 */
export const getSettings: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.settingsHandler.getSettings({});
  ctx.sendResponse(requestId, result);
};

/**
 * 获取应用信息（名称/版本号来自扩展 package.json 产品元数据）
 */
export const getAppInfo: MessageHandler = async (_data, requestId, ctx) => {
  try {
    ctx.sendResponse(requestId, getProductMetadata());
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_APP_INFO_ERROR', error.message || 'Failed to get app info');
  }
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
 * 导出提示词模式
 */
export const exportPromptModes: MessageHandler = async (data, requestId, ctx) => {
  try {
    const filename = typeof data?.filename === 'string' && data.filename.trim()
      ? data.filename.trim()
      : 'graycode-prompt-modes.json';
    const content = typeof data?.content === 'string' ? data.content : '';
    const result = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.resolve(filename)),
      filters: {
        'JSON Files': ['json'],
        'All Files': ['*']
      },
      title: '导出 GrayCode 提示词模式'
    });

    if (!result) {
      ctx.sendResponse(requestId, { success: false, cancelled: true });
      return;
    }

    await fs.writeFile(result.fsPath, content, 'utf-8');
    ctx.sendResponse(requestId, { success: true, filePath: result.fsPath });
  } catch (error: any) {
    ctx.sendError(requestId, 'EXPORT_PROMPT_MODES_ERROR', error.message || 'Failed to export prompt modes');
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
      ctx.sendError(requestId, 'COUNT_SYSTEM_PROMPT_TOKENS_ERROR', result.error?.message || 'Token count failed');
    }
  } catch (error: any) {
    ctx.sendError(requestId, 'COUNT_SYSTEM_PROMPT_TOKENS_ERROR', error.message || 'Token count failed');
  }
};

/**
 * 注册设置管理处理器（通用设置 / 总结配置 / 图像生成 / 系统提示 / Prompt 模式 / 公告）
 *
 * 记忆子域由 ./MemoryHandlers 的 registerMemoryHandlers 注册；
 * 设置导入/导出由 ./SettingsTransferHandlers 的 registerSettingsTransferHandlers 注册。
 */
export function registerSettingsHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('getSettings', settingsHandlerBoundary('GET_SETTINGS_ERROR', 'Failed to get settings', getSettings));
  registry.set('getAppInfo', getAppInfo);
  registry.set('updateSettings', settingsHandlerBoundary('UPDATE_SETTINGS_ERROR', 'Failed to update settings', updateSettings));
  registry.set('updateProxySettings', settingsHandlerBoundary('UPDATE_PROXY_SETTINGS_ERROR', 'Failed to update proxy settings', updateProxySettings));
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
  registry.set('exportPromptModes', exportPromptModes);
  registry.set('renamePromptMode', renamePromptMode);
  registry.set('deletePromptMode', deletePromptMode);
  registry.set('countSystemPromptTokens', countSystemPromptTokens);
  registry.set('checkAnnouncement', checkAnnouncement);
  registry.set('markAnnouncementRead', markAnnouncementRead);
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

// re-export 壳：记忆子域与设置导入/导出已拆分为独立文件，
// 保持既有 `from './SettingsHandlers'` 导入路径可用。
export * from './MemoryHandlers';
export * from './SettingsTransferHandlers';
