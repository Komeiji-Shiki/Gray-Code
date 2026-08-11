/**
 * History 工具模块
 *
 * 导出所有历史对话检索相关的工具
 */

import type { ToolRegistration } from '../types';

// 导出 history_search 模块的所有内容（registerHistorySearch / createHistorySearchTool 等）
export * from './history_search';

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { registerHistorySearch } from './history_search';

/**
 * 获取所有 History 工具的注册函数
 */
export function getHistoryToolRegistrations(): ToolRegistration[] {
    return [registerHistorySearch];
}
