/**
 * 记忆子域消息处理器（从 SettingsHandlers 拆分）。
 *
 * 消息 key：getMemoryConfig / updateMemoryConfig / getMemoryEntries / addMemoryEntry /
 * updateMemoryEntry / deleteMemoryEntry / deleteMemoryEntries / listMemoryScopes。
 */

import * as vscode from 'vscode';
import { getGlobalMemoryManager, getMemoryManagerForWorkspace, listWorkspaceMemoryScopes } from '../../backend/modules/memory';
import type { MessageHandler } from '../types';

/**
 * 批量删除记忆条目的单次请求上限。
 *
 * 为什么设上限：MemoryManager.deleteEntries 对不相邻 id 会逐个触发全量 LOG 重建（O(n·T)），
 * 超大 ids 数组会让扩展主线程长时间停滞；前端列表展示上限为 ENTRIES_LIMIT(5000)，此处取 10000 留足余量。
 */
const MAX_BATCH_DELETE_IDS = 10000;
const MAX_MEMORY_ENTRIES_LIMIT = 10000;

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
 * 获取记忆配置
 * 合并 SettingsManager 中的用户设置和 MemoryManager 的运行时配置。
 *
 * 数值项（wakeLines/entryChars）以目标作用域 MemoryManager 的
 * 运行时配置为权威来源：settings 配置的数值项经 getToolsConfigEntry 深合并默认值后
 * 永远有值（96/280），?? 兜底恒不生效，会掩盖工作区各自的运行时配置——
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
      if (Object.keys(runtimeUpdates).length > 0) {
        await mgr.updateConfig(runtimeUpdates);
      }
      return ctx.sendResponse(requestId, { success: true });
    }
    // 全局作用域：写 SettingsManager（持久化）并同步全局 MemoryManager 运行时
    await ctx.settingsManager.updateMemoryConfig(config);
    const mgr = await resolveMemoryManager(data);
    if (mgr) {
      const runtimeUpdates: Record<string, number> = {};
      if (typeof config.wakeLines === 'number') runtimeUpdates.wakeLines = config.wakeLines;
      if (typeof config.entryChars === 'number') runtimeUpdates.entryChars = config.entryChars;
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
    const effectiveLimit = Math.min(
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : 5000,
      MAX_MEMORY_ENTRIES_LIMIT
    );
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
 * 合并「当前打开的工作区文件夹」+「已有记忆数据的工作区」：
 * - 当前打开的工作区（vscode.workspace.workspaceFolders）即使还没有记忆数据也可选——
 *   首次访问时 memory 层会惰性创建记忆目录；
 * - 已有数据的 scope（memory-workspaces/<hash>/scope.json 枚举）优先复用其元信息
 *   （uri/name/hasData），按 fsPath 归一化去重（Windows 大小写不敏感）。
 */
export const listMemoryScopes: MessageHandler = async (_data, requestId, ctx) => {
  try {
    // 已有记忆数据的工作区 scope
    const existing = await listWorkspaceMemoryScopes();

    // 当前打开的工作区文件夹
    const openFolders: Array<{ uri: string; name: string; fsPath: string }> = [];
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const folder of folders) {
        openFolders.push({
          uri: folder.uri.toString(),
          name: folder.name,
          fsPath: folder.uri.fsPath,
        });
      }
    }

    // 路径归一化（Windows 大小写不敏感 + 统一正斜杠），与 memory 层 normalizeWorkspaceKey 一致
    const WIN32 = process.platform === 'win32';
    const normalizeFsPath = (p: string): string => {
      const n = p.replace(/\\/g, '/');
      return WIN32 ? n.toLowerCase() : n;
    };

    // 已有数据按归一化 fsPath 索引，合并时复用其 uri/name/hasData
    const existingByPath = new Map(existing.map((s) => [normalizeFsPath(s.fsPath), s]));

    // 当前打开的工作区文件夹排在最前（前端 loadWorkspaceScopes 默认选中 scopes[0]）：
    // 用户打开新项目 B（尚无记忆）但有历史项目 A 的数据时，默认应选中 B 而不是 A，
    // 否则在工作区 tab 添加记忆会静默写进历史项目 A（记忆隔离错位）。
    const scopes: Array<{ uri: string; name: string; fsPath: string; hasData: boolean }> = [];
    const usedExistingPaths = new Set<string>();
    for (const folder of openFolders) {
      const norm = normalizeFsPath(folder.fsPath);
      const existingEntry = existingByPath.get(norm);
      if (existingEntry) {
        usedExistingPaths.add(norm);
        scopes.push(existingEntry);
      } else {
        scopes.push({
          uri: folder.uri,
          name: folder.name,
          fsPath: folder.fsPath,
          hasData: false,
        });
      }
    }
    // 其余「已有记忆数据但未打开」的工作区追加到末尾
    for (const s of existing) {
      if (usedExistingPaths.has(normalizeFsPath(s.fsPath))) continue;
      scopes.push(s);
    }
    ctx.sendResponse(requestId, { scopes });
  } catch (error: any) {
    ctx.sendError(requestId, 'LIST_MEMORY_SCOPES_ERROR', error.message || 'Failed to list memory scopes');
  }
};

/**
 * 注册记忆子域处理器
 */
export function registerMemoryHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('getMemoryConfig', getMemoryConfig);
  registry.set('updateMemoryConfig', updateMemoryConfig);
  registry.set('getMemoryEntries', getMemoryEntries);
  registry.set('addMemoryEntry', addMemoryEntry);
  registry.set('updateMemoryEntry', updateMemoryEntry);
  registry.set('deleteMemoryEntry', deleteMemoryEntry);
  registry.set('deleteMemoryEntries', deleteMemoryEntries);
  registry.set('listMemoryScopes', listMemoryScopes);
}
