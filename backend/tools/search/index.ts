/**
 * 搜索工具模块
 *
 * 导出所有搜索相关的工具
 */

// 导出各个工具的创建函数
export { registerSearchInFiles } from './search_in_files';
export { registerFindFiles } from './find_files';

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { registerSearchInFiles } from './search_in_files';
import { registerFindFiles } from './find_files';

/**
 * 获取所有搜索工具的注册函数
 * @returns 注册函数数组
 */
export function getSearchToolRegistrations() {
    return [
        registerSearchInFiles,
        registerFindFiles
    ];
}