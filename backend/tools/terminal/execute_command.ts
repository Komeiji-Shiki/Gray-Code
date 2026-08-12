/**
 * 执行命令工具（壳模块）
 *
 * 原实现已按职责拆分到 terminal/ 子模块：
 * - shellConfig.ts：跨平台 shell 配置与可用性检测
 * - processRunner.ts：进程启动/管理、事件与任务注册、execute_command 工具工厂
 * - outputDecoder.ts：GBK 回退解码与输出截断
 * - promptDescriptions.ts：工具描述与提示词生成
 *
 * 本文件仅 re-export，对外符号与行为保持不变。
 */

export {
    checkShellAvailability,
    checkAllShellsAvailability,
    getShellAvailabilityWithReason,
    warmUpShellAvailabilityCache
} from './shellConfig';

export {
    onTerminalOutput,
    onTerminalTaskEvent,
    createExecuteCommandTool,
    killTerminalProcess,
    cancelTerminalTask,
    detachRunningTerminalsToBackground,
    getTerminalOutput,
    getActiveTerminalProcesses,
    cleanupTerminals,
    registerExecuteCommand,
    getActiveTerminals
} from './processRunner';

// 导出类型
export type { TerminalOutputEvent } from './processRunner';
