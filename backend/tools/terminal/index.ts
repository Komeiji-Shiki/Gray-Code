/**
 * 终端工具模块
 *
 * 导出所有终端相关的工具
 */

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

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { registerExecuteCommand } from './execute_command';

/**
 * 获取所有终端工具的注册函数
 * @returns 注册函数数组
 */
export function getTerminalToolRegistrations() {
    return [
        registerExecuteCommand
    ];
}