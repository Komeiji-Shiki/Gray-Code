/**
 * History 工具模块
 *
 * 导出所有历史对话检索相关的工具
 */

import type { Tool, ToolRegistration } from '../types';

// 导出 history_search 模块的所有内容（registerHistorySearch / createHistorySearchTool 等）
export * from './history_search';

/**
 * 获取所有 History 工具的注册函数
 */
export function getHistoryToolRegistrations(): ToolRegistration[] {
    const { registerHistorySearch } = require('./history_search');
    return [registerHistorySearch];
}

/**
 * 获取所有 History 工具
 */
export function getAllHistoryTools(): Tool[] {
    const { registerHistorySearch } = require('./history_search');
    return [registerHistorySearch()];
}
