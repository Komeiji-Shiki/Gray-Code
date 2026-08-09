/**
 * 终端工具模块
 *
 * 导出所有终端相关的工具
 */

import type { Tool } from '../types';

// 导出执行命令工具
export {
    registerExecuteCommand,
    cleanupTerminals,
    killTerminalProcess,
    getTerminalOutput,
    getActiveTerminalProcesses,
    checkShellAvailability,
    checkAllShellsAvailability,
    onTerminalOutput,
    detachRunningTerminalsToBackground
} from './execute_command';

// 导出类型
export type { TerminalOutputEvent } from './execute_command';

/**
 * 获取所有终端工具
 * @returns 所有终端工具的数组
 */
export function getAllTerminalTools(): Tool[] {
    const { registerExecuteCommand } = require('./execute_command');
    
    return [
        registerExecuteCommand()
    ];
}

/**
 * 获取所有终端工具的注册函数
 * @returns 注册函数数组
 */
export function getTerminalToolRegistrations() {
    const { registerExecuteCommand } = require('./execute_command');
    
    return [
        registerExecuteCommand
    ];
}