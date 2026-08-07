/**
 * 沙箱工具模块
 *
 * 导出沙箱相关工具
 */

import type { Tool } from '../types';

// 导出沙箱工具
export { registerSandbox, createSandboxTool, SANDBOX_LANGUAGES } from './sandbox';

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
