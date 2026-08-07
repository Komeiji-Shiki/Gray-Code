/**
 * 沙箱工具模块
 *
 * 导出沙箱相关工具
 */

import type { Tool } from '../types';

// 导出沙箱工具
export { registerSandbox, createSandboxTool } from './sandbox';
// 语言白名单唯一权威来源在 settings 层（toolsTypes.ts），避免 tools -> settings 循环依赖
export { SANDBOX_LANGUAGES } from '../../modules/settings';

/**
 * 获取所有沙箱工具
 * @returns 所有沙箱工具的数组
 */
export function getAllSandboxTools(): Tool[] {
    const { registerSandbox } = require('./sandbox');

    return [
        registerSandbox()
    ];
}

/**
 * 获取所有沙箱工具的注册函数
 * @returns 注册函数数组
 */
export function getSandboxToolRegistrations() {
    const { registerSandbox } = require('./sandbox');

    return [
        registerSandbox
    ];
}
