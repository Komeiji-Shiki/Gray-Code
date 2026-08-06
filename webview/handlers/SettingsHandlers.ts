/**
 * 设置管理消息处理器
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { DEFAULT_SUMMARIZE_CONFIG } from '../../backend/modules/settings/types';
import type { HandlerContext, MessageHandler } from '../types';
import { SettingsExporter } from '../../backend/modules/settings/SettingsExporter';
import { getSkillsManager } from '../../backend/modules/skills';
import { getGlobalMemoryManager, getMemoryManagerForWorkspace, listWorkspaceMemoryScopes } from '../../backend/modules/memory';
import { getProductMetadata } from '../../backend/core/productMetadata';
import { getExtensionVersion } from '../utils/extensionInfo';
import { SAVED_WORKSPACES_KEY } from './WorkspaceHandlers';

/** 批量删除的 ids 数量上限：防御超大数组触发 O(n·T) 全量 LOG 重建 */
const MAX_BATCH_DELETE_IDS = 10000;

/**
 * 记忆 handler 解析目标 MemoryManager：
 * - data.workspaceUri（string）→ 该工作区专属记忆实例（记忆隔离）
 * - 未传 → 全局记忆实例（旧行为）
 * 设置页分区明确传递作用域，不隐式使用当前激活工作区。
 */
async function resolveMemoryManager(data?: any): Promise<import('../../backend/modules/memory').MemoryManager | null> {
  const wsUri = typeof data?.workspaceUri === 'string' && data.workspaceUri ? data.workspaceUri : '';
  if (wsUri) {
    return getMemoryManagerForWorkspace(wsUri);
  }
  return getGlobalMemoryManager();
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
 * 获取记忆配置
 * 合并 SettingsManager 中的用户设置和 MemoryManager 的运行时配置。
 *
 * 数值项（wakeLines/entryChars/partChars/partLines）以目标作用域 MemoryManager 的
 * 运行时配置为权威来源：settings 配置的数值项经 getToolsConfigEntry 深合并默认值后
 * 永远有值（96/280/20000/500），?? 兜底恒不生效，会掩盖工作区各自的运行时配置——
 * 记忆隔离下每个工作区的 config 独立持久化，这里必须按 data.workspaceUri 读对应实例。
 * enabled/systemPrompt 属于全局设置段，仍取 settings 配置。
 */
export const getMemoryConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const config = ctx.settingsManager.getMemoryConfig();
    // 合并 MemoryManager 的运行时配置（如果已初始化；data.workspaceUri 指定时读该工作区实例）
    const mgr = await resolveMemoryManager(data);
    if (mgr) {
      // loadConfig() 保证读到磁盘上的最新配置（含刚被 memory_config 工具改过的值）
      const runtimeConfig = await mgr.loadConfig();
      return ctx.sendResponse(requestId, {
        ...config,
        wakeLines: runtimeConfig.wakeLines,
        entryChars: runtimeConfig.entryChars,
        partChars: runtimeConfig.partChars,
        partLines: runtimeConfig.partLines,
      });
    }
    ctx.sendResponse(requestId, config);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_MEMORY_CONFIG_ERROR', error.message || 'Failed to get memory config');
  }
};

/**
 * 更新记忆配置
 *
 * - 传了 workspaceUri：配置保存到该作用域 MemoryManager（记忆隔离），不写全局
 *   SettingsManager——否则工作区 tab 保存的数值会污染全局配置，且全局 toolsConfig
 *   深合并默认值后所有工作区读到同一份配置，隔离失效。
 * - 未传 workspaceUri（全局）：写 SettingsManager（持久化）并同步全局 MemoryManager 运行时。
 */
export const updateMemoryConfig: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { config } = data;
    const wsUri = typeof data?.workspaceUri === 'string' && data.workspaceUri ? data.workspaceUri : '';
    if (wsUri) {
      // 工作区作用域：仅写该工作区 MemoryManager（数值项校验并持久化到其 config 文件）
      const mgr = await resolveMemoryManager(data);
      if (!mgr) {
        return ctx.sendError(requestId, 'MEMORY_NOT_INITIALIZED', 'MemoryManager is not initialized.');
      }
      const runtimeUpdates: Record<string, number> = {};
      if (typeof config.wakeLines === 'number') runtimeUpdates.wakeLines = config.wakeLines;
      if (typeof config.entryChars === 'number') runtimeUpdates.entryChars = config.entryChars;
      if (typeof config.partChars === 'number') runtimeUpdates.partChars = config.partChars;
      if (typeof config.partLines === 'number') runtimeUpdates.partLines = config.partLines;
      if (Object.keys(runtimeUpdates).length > 0) {
        await mgr.updateConfig(runtimeUpdates);
      }
      return ctx.sendResponse(requestId, { success: true });
    }
    // 全局作用域：写 SettingsManager（持久化）并同步全局 MemoryManager 运行时
    await ctx.settingsManager.updateMemoryConfig(config);
    // 同步运行时参数到 MemoryManager（如果已初始化）
    const mgr = await resolveMemoryManager(data);
    if (mgr) {
      const runtimeUpdates: Record<string, number> = {};
      if (typeof config.wakeLines === 'number') runtimeUpdates.wakeLines = config.wakeLines;
      if (typeof config.entryChars === 'number') runtimeUpdates.entryChars = config.entryChars;
      if (typeof config.partChars === 'number') runtimeUpdates.partChars = config.partChars;
      if (typeof config.partLines === 'number') runtimeUpdates.partLines = config.partLines;
      if (Object.keys(runtimeUpdates).length > 0) {
        await mgr.updateConfig(runtimeUpdates);
      }
    }
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_MEMORY_CONFIG_ERROR', error.message || 'Failed to update memory config');
  }
};

/**
 * 获取所有原始记忆条目列表（用于设置页面管理）
 * @param data.limit 可选：最多返回的条目数（默认 5000）。
 * 超限时响应带 truncated=true，前端提示「仅展示前 N 条」——避免海量记忆
 * （如 10 万条以上）时 postMessage 传输与 v-for 渲染冻结设置页。
 */
export const getMemoryEntries: MessageHandler = async (data, requestId, ctx) => {
  try {
    const mgr = await resolveMemoryManager(data);
    if (!mgr) {
      return ctx.sendResponse(requestId, { entries: [], total: 0, initialized: false });
    }
    const limit = data?.limit;
    const effectiveLimit =
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : 5000;
    const total = await mgr.totalEntries();
    const entries = await mgr.listEntries(effectiveLimit);
    ctx.sendResponse(requestId, {
      entries,
      total,
      truncated: entries.length < total,
      initialized: true,
    });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_MEMORY_ENTRIES_ERROR', error.message || 'Failed to get memory entries');
  }
};

/**
 * 手动新增一条原始记忆（用户在设置页手动记录，等价于 AI 的 memory_note 工具）
 */
export const addMemoryEntry: MessageHandler = async (data, requestId, ctx) => {
  try {
    const mgr = await resolveMemoryManager(data);
    if (!mgr) {
      return ctx.sendError(requestId, 'MEMORY_NOT_INITIALIZED', 'MemoryManager is not initialized.');
    }
    const { text } = data ?? {};
    if (typeof text !== 'string') {
      return ctx.sendError(requestId, 'INVALID_PARAMS', 'text (string) is required.');
    }
    const result = await mgr.note(text);
    ctx.sendResponse(requestId, { success: true, id: result.id });
  } catch (error: any) {
    ctx.sendError(requestId, 'ADD_MEMORY_ENTRY_ERROR', error.message || 'Failed to add memory entry');
  }
};

/**
 * 更新单条原始记忆的文本
 */
export const updateMemoryEntry: MessageHandler = async (data, requestId, ctx) => {
  try {
    const mgr = await resolveMemoryManager(data);
    if (!mgr) {
      return ctx.sendError(requestId, 'MEMORY_NOT_INITIALIZED', 'MemoryManager is not initialized.');
    }
    const { id, text } = data;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || typeof text !== 'string') {
      return ctx.sendError(requestId, 'INVALID_PARAMS', 'id (non-negative integer) and text (string) are required.');
    }
    await mgr.updateEntry(id, text);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_MEMORY_ENTRY_ERROR', error.message || 'Failed to update memory entry');
  }
};

/**
 * 删除单条原始记忆（真·单条删除：该条之后的记录 id 前移一格并重编号，
 * 相关树摘要由 MemoryManager 清空，下次 recall/compress 重建）
 */
export const deleteMemoryEntry: MessageHandler = async (data, requestId, ctx) => {
  try {
    const mgr = await resolveMemoryManager(data);
    if (!mgr) {
      return ctx.sendError(requestId, 'MEMORY_NOT_INITIALIZED', 'MemoryManager is not initialized.');
    }
    const { id } = data;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      return ctx.sendError(requestId, 'INVALID_PARAMS', 'id (non-negative integer) is required.');
    }
    await mgr.deleteEntry(id);
    ctx.sendResponse(requestId, { success: true, removed: 1 });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_MEMORY_ENTRY_ERROR', error.message || 'Failed to delete memory entry');
  }
};

/**
 * 批量删除多条原始记忆（id 数组，可乱序/重复；按闭区间聚合从大到小删除，
 * 删除后剩余记录 id 前移重编号，相关树摘要一并清空）
 */
export const deleteMemoryEntries: MessageHandler = async (data, requestId, ctx) => {
  try {
    const mgr = await resolveMemoryManager(data);
    if (!mgr) {
      return ctx.sendError(requestId, 'MEMORY_NOT_INITIALIZED', 'MemoryManager is not initialized.');
    }
    const { ids } = data ?? {};
    if (!Array.isArray(ids) || ids.length === 0 ||
        ids.length > MAX_BATCH_DELETE_IDS ||
        ids.some(id => typeof id !== 'number' || !Number.isInteger(id) || id < 0)) {
      return ctx.sendError(requestId, 'INVALID_PARAMS',
        `ids (non-empty array of ${MAX_BATCH_DELETE_IDS} non-negative integers max) is required.`);
    }
    const result = await mgr.deleteEntries(ids);
    ctx.sendResponse(requestId, { success: true, removed: result.removed });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_MEMORY_ENTRIES_ERROR', error.message || 'Failed to delete memory entries');
  }
};

/**
 * 枚举全部工作区记忆 scope（设置页记忆分区下拉用）
 *
 * 合并「收藏的工作区」+「已有记忆数据的工作区」：
 * - 当前激活的工作区排在最前（前端 loadWorkspaceScopes 默认选中 scopes[0]）——
 *   用户在历史项目 A（有数据）与当前项目 B（尚无记忆）间切换时默认应选中 B，
 *   否则在工作区 tab 添加记忆会静默写进历史项目 A（记忆隔离错位）；
 * - 收藏工作区（globalState 持久化，与 WorkspaceHandlers.loadSavedFsPaths 同口径）
 *   即使还没有记忆数据也可选——首次访问时 memory 层会惰性创建记忆目录；
 * - 已有数据的 scope（memory-workspaces/<hash>/scope.json 枚举）优先复用其元信息
 *   （uri/name/hasData），按 fsPath 归一化去重（Windows 大小写不敏感）。
 */
export const listMemoryScopes: MessageHandler = async (_data, requestId, ctx) => {
  try {
    // 已有记忆数据的工作区 scope
    const existing = await listWorkspaceMemoryScopes();

    // 收藏的工作区列表（过滤 string、去空，与 WorkspaceHandlers.loadSavedFsPaths 同口径）
    let savedFsPaths: string[] = [];
    try {
      const raw = ctx.context?.globalState?.get<string[]>(SAVED_WORKSPACES_KEY);
      if (Array.isArray(raw)) {
        savedFsPaths = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
      }
    } catch {
      savedFsPaths = [];
    }

    // 路径归一化（Windows 大小写不敏感 + 统一正斜杠），与 memory 层 normalizeWorkspaceKey 一致
    const WIN32 = process.platform === 'win32';
    const normalizeFsPath = (p: string): string => {
      const n = p.replace(/\\/g, '/');
      return WIN32 ? n.toLowerCase() : n;
    };

    // 已有数据按归一化 fsPath 索引，合并时复用其 uri/name/hasData
    const existingByPath = new Map(existing.map((s) => [normalizeFsPath(s.fsPath), s]));

    // 当前激活工作区排在最前（前端 loadWorkspaceScopes 默认选中 scopes[0]）：
    // 用户打开新项目 B（尚无记忆）但有历史项目 A 的数据时，默认应选中 B 而不是 A，
    // 否则在工作区 tab 添加记忆会静默写进历史项目 A（记忆隔离错位）。
    const scopes: Array<{ uri: string; name: string; fsPath: string; hasData: boolean }> = [];
    const usedPaths = new Set<string>();
    let activeFsPath: string | null = null;
    const activeUri = ctx.getCurrentWorkspaceUri?.() ?? null;
    if (activeUri) {
      try {
        activeFsPath = vscode.Uri.parse(activeUri).fsPath;
      } catch {
        activeFsPath = null;
      }
    }
    if (activeFsPath) {
      const norm = normalizeFsPath(activeFsPath);
      const existingEntry = existingByPath.get(norm);
      if (existingEntry) {
        usedPaths.add(norm);
        scopes.push(existingEntry);
      } else if (savedFsPaths.some((p) => normalizeFsPath(p) === norm)) {
        usedPaths.add(norm);
        scopes.push({
          uri: activeUri!,
          name: path.basename(activeFsPath) || activeFsPath,
          fsPath: activeFsPath,
          hasData: false,
        });
      }
    }
    // 其余「已有记忆数据」的工作区（去重后）
    for (const s of existing) {
      const norm = normalizeFsPath(s.fsPath);
      if (usedPaths.has(norm)) continue;
      usedPaths.add(norm);
      scopes.push(s);
    }
    // 其余收藏的工作区（去重后）
    for (const fsPath of savedFsPaths) {
      const norm = normalizeFsPath(fsPath);
      if (usedPaths.has(norm)) continue;
      usedPaths.add(norm);
      scopes.push({
        uri: vscode.Uri.file(fsPath).toString(),
        name: path.basename(fsPath) || fsPath,
        fsPath,
        hasData: false,
      });
    }
    ctx.sendResponse(requestId, { scopes });
  } catch (error: any) {
    ctx.sendError(requestId, 'LIST_MEMORY_SCOPES_ERROR', error.message || 'Failed to list memory scopes');
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
  registry.set('getAppInfo', getAppInfo);
  registry.set('updateSettings', updateSettings);
  registry.set('updateProxySettings', updateProxySettings);
  registry.set('updateUISettings', updateUISettings);
  registry.set('settings.getActiveChannelId', getActiveChannelId);
  registry.set('settings.setActiveChannelId', setActiveChannelId);
  registry.set('getSummarizeConfig', getSummarizeConfig);
  registry.set('getDefaultSummarizeConfig', getDefaultSummarizeConfig);
  registry.set('updateSummarizeConfig', updateSummarizeConfig);
  registry.set('getMemoryConfig', getMemoryConfig);
  registry.set('updateMemoryConfig', updateMemoryConfig);
  registry.set('getMemoryEntries', getMemoryEntries);
  registry.set('addMemoryEntry', addMemoryEntry);
  registry.set('updateMemoryEntry', updateMemoryEntry);
  registry.set('deleteMemoryEntry', deleteMemoryEntry);
  registry.set('deleteMemoryEntries', deleteMemoryEntries);
  registry.set('listMemoryScopes', listMemoryScopes);
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
            defaultUri: vscode.Uri.file('graycode-settings.json'),
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

