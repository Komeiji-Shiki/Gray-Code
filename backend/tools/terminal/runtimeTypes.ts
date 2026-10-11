import type * as cp from 'child_process';
import type { TaskManager } from '../taskManager';
import type { createShellRuntime, ShellType } from './shellConfigRuntime';
import type { createOutputRuntime } from './outputDecoderRuntime';
import type { createTerminalPrompts } from './promptDescriptionsRuntime';
import type { ExecuteCommandToolConfig } from '../../modules/settings/types/toolsTypes';
import type { ProcessTreeTracker, ProcessTreePort, ProcessTreeReport } from './processTree';

/** 前台命令被终止的原因，随结果返回给模型。 */
export type TerminalInterruptReason = 'timeout' | 'user_cancelled' | 'task_cancelled' | 'host_closing' | 'stopped' | 'conversation_removed';

/**
 * 终端进程信息
 */
export interface TerminalProcess {
    id: string;
    command: string;
    cwd: string;
    shell: ShellType;
    mode?: 'shell' | 'argv';
    args?: string[];
    process: cp.ChildProcess;
    inputError?: Error;
    output: string[];
    startTime: number;
    endTime?: number;
    exitCode?: number;
    killed?: boolean;
    /** 是否因超时被强制终止（与用户取消区分：超时算失败，不算成功/取消） */
    timedOut?: boolean;
    error?: string;
    /** 因输出行数上限被丢弃的旧行数（长运行进程的内存护栏，配合截断提示展示总量） */
    omittedOutputLines?: number;
    interruptReason?: TerminalInterruptReason;
    /** Windows 上记录后代链，终止时补杀 taskkill /T 够不到的脱链后代。 */
    tracker?: ProcessTreeTracker;
    cleanup?: Promise<ProcessTreeReport | undefined>;
}

/**
 * 终端输出事件类型
 */
export interface TerminalOutputEvent {
    terminalId: string;
    type: 'start' | 'output' | 'error' | 'exit';
    data?: string;
    command?: string; // start 事件时包含命令
    cwd?: string; // start 事件时包含工作目录
    shell?: string; // start 事件时包含 shell 类型
    exitCode?: number;
    killed?: boolean;
    duration?: number;
}
export interface createTerminalRuntimeHost {
    getConfig(): ExecuteCommandToolConfig;
    getAllWorkspaces(): Array<{ name: string; fsPath: string }>;
    parseWorkspacePath(value: string): { workspace?: { name: string; fsPath: string }; relativePath: string };
    shells: ReturnType<typeof createShellRuntime>;
    output: ReturnType<typeof createOutputRuntime>;
    prompts: ReturnType<typeof createTerminalPrompts>;
    tasks: Pick<typeof TaskManager, 'generateTaskId' | 'unregisterTask' | 'registerTask' | 'getTask' | 'emitEvent' | 'cancelTask'>;
    /** 可选：Windows 进程快照与终止端口。未提供时只用 tree-kill 终止根进程树。 */
    processTree?: ProcessTreePort;
}
