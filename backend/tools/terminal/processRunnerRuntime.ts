import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { TextDecoder } from 'util';
import crossSpawn from 'cross-spawn';
import type { Tool, ToolResult, ToolContext } from '../types';
import type { ShellType } from './shellConfigRuntime';
import type { StreamDecodeState } from './outputDecoderRuntime';
import { ProcessTreeTracker, type ProcessTreeReport } from './processTree';
import { createExecuteCommandDeclaration } from './commandDeclaration';
import { setTerminalProcessPriority, terminateProcessTreeWithEscalation, abortReason, interruptionOf } from './processControl';
import type { TerminalProcess, TerminalOutputEvent, TerminalInterruptReason, createTerminalRuntimeHost } from './runtimeTypes';
import { writeProcessInput } from './processInput';
import { ProcessSessionError } from '../../../shared/processOutput';
export type { TerminalProcess, TerminalOutputEvent, TerminalInterruptReason, createTerminalRuntimeHost } from './runtimeTypes';

/** 注入宿主服务；进程、解码状态和事件均归属于当前实例。 */
export function createTerminalRuntime(host: createTerminalRuntimeHost) {
    const { getAllWorkspaces, parseWorkspacePath } = host;
    const TaskManager = host.tasks;
    const { getShellConfig, checkShellAvailability } = host.shells;
    const { createOutputLineBuffer, pushOutputLines, getLastLines, getMaxOutputLines, decodeWithMode, flushDecodeState } = host.output;

    // tree-kill library, used to terminate process trees cross-platform
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (error?: Error) => void) => void;

    /** 终端任务类型常量 */
    const TASK_TYPE_TERMINAL = 'terminal';

    /**
     * 活动终端进程管理
     */
    const activeProcesses: Map<string, TerminalProcess> = new Map();

    /**
     * 前台命令的 detach 回调表：terminalId -> detach 函数。
     *
     * 用户在命令运行期间发送新消息时，把等待中的前台命令转为后台任务：
     * 工具立即返回、模型先响应用户；进程继续运行，完成后结果经 TaskManager
     * 完成事件回流为 [Background task completed] 回执消息。
     */
    const detachHandlers: Map<string, () => boolean> = new Map();

    /**
     * 终端事件发射器
     * 用于实时推送终端输出到前端
     */
    const terminalEmitter = new EventEmitter();

    /**
     * 订阅终端输出
     * @param listener 监听器函数
     * @returns 取消订阅函数
     */
    function onTerminalOutput(listener: (event: TerminalOutputEvent) => void): () => void {
        terminalEmitter.on('output', listener);
        return () => terminalEmitter.off('output', listener);
    }

    /**
     * 发送终端输出事件
     */
    function emitTerminalOutput(event: TerminalOutputEvent): void {
        terminalEmitter.emit('output', event);
    }

    /**
     * 生成唯一终端 ID（使用 TaskManager）
     */
    function generateTerminalId(): string {
        return TaskManager.generateTaskId('terminal');
    }

    /**
     * 创建执行命令工具
     */
    function createExecuteCommandTool(declaration?: Tool['declaration']): Tool {
        return {
            declaration: declaration ?? createExecuteCommandDeclaration(host),
            handler: async (args, context?: ToolContext): Promise<ToolResult> => {
                const config = host.getConfig();
                const command = args.command as string;
                const mode = args.mode === 'argv' ? 'argv' : 'shell';
                const argv = mode === 'argv';
                const commandArgs = argv ? (args.args as string[]) : undefined;
                const cwd = args.cwd as string | undefined;
                const shell = (args.shell as ShellType) || 'default';
                // 超时钳制：仅接受有限非负数（0 = 显式不超时）；负数/NaN/非数字回退默认 60000，
                // 避免非法值把 timeout>0 判为 false 而意外禁用超时。
                const rawTimeout = args.timeout;
                const timeout =
                    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 0
                        ? Math.floor(rawTimeout)
                        : argv
                          ? 0
                          : config.defaultTimeout;
                // 修改原因：长耗时命令会阻塞主对话，用户只能干等。
                // 修改方式：background=true 时进程启动后立即返回；不挂外部 abortSignal、不设 timeout，
                //          退出时结果经 TaskManager 完成事件回流。
                // 修改目的：等待期间用户可继续互动；停止当前对话流不会连带杀掉后台命令。
                const background = args.background === true;

                // 使用 context 中的 toolId 或生成新的
                const terminalId = (context?.toolId as string) || generateTerminalId();

                // 获取外部的 abortSignal（用于用户取消对话时终止终端）
                const externalAbortSignal = context?.abortSignal as AbortSignal | undefined;

                if (!command) {
                    return { success: false, error: 'command is required' };
                }
                if (argv && (!Array.isArray(commandArgs) || commandArgs.some((value) => typeof value !== 'string' || value.includes('\0')))) {
                    return { success: false, error: 'argv mode requires an array of string arguments without null characters.' };
                }

                const workspaces = getAllWorkspaces();
                if (workspaces.length === 0) {
                    return { success: false, error: 'No workspace folder open' };
                }

                // 本次命令使用创建运行器时捕获的配置。

                // 确定实际使用的 shell 类型
                let actualShellType = shell;
                if (shell === 'default') {
                    actualShellType = config.defaultShell as ShellType;
                }

                // 检查 shell 是否启用
                const shellInfo = config.shells.find((s) => s.type === actualShellType);
                if (!argv && shellInfo && !shellInfo.enabled) {
                    return {
                        success: false,
                        error: `Shell "${actualShellType}" is not enabled, please enable it in settings and try again`,
                    };
                }

                // 检查 shell 可用性
                const availability = argv ? { available: true, reason: undefined } : await checkShellAvailability(actualShellType, shellInfo?.path);
                if (!availability.available) {
                    return {
                        success: false,
                        error: `Shell "${actualShellType}" is not available: ${availability.reason || 'unknown reason'}. Please configure the correct path in settings.`,
                    };
                }

                // 计算工作目录（支持多工作区）
                let workingDir: string;
                let workspaceName: string | undefined;

                if (cwd) {
                    // 如果 cwd 已经是绝对路径，直接使用，不再拼接到 workspace 根目录
                    if (path.isAbsolute(cwd)) {
                        workingDir = cwd;
                    } else {
                        // 解析带工作区前缀的路径
                        const { workspace, relativePath } = parseWorkspacePath(cwd);
                        if (workspace) {
                            workingDir = path.join(workspace.fsPath, relativePath);
                            workspaceName = workspaces.length > 1 ? workspace.name : undefined;
                        } else {
                            // 使用默认工作区
                            workingDir = path.join(workspaces[0].fsPath, cwd);
                        }
                    }
                } else {
                    // 默认使用第一个工作区
                    workingDir = workspaces[0].fsPath;
                }

                // 验证工作目录是否存在。Windows 上 CreateProcessW 的 lpCurrentDirectory
                // 指向不存在的目录时会返回 ERROR_DIRECTORY，Node.js 映射为 ENOENT，
                // 错误消息却是 "spawn <shell> ENOENT"，极易误导为找不到 shell。
                // 在 spawn 之前主动检查，给出明确的目录错误。
                if (!fs.existsSync(workingDir)) {
                    return {
                        success: false,
                        error: `Working directory does not exist: ${workingDir}. Please check the cwd parameter or create the directory first.`,
                    };
                }

                // 获取 shell 配置
                const shellConfig = argv
                    ? { shell: command, shellArgs: [] as string[], prependCommand: undefined, appendCommand: undefined }
                    : getShellConfig(shell);

                return new Promise((resolve) => {
                    // 检查是否已经取消
                    if (externalAbortSignal?.aborted) {
                        resolve({
                            success: false,
                            error: "⚠️ User cancelled the command execution. Please wait for user's next instruction.",
                            cancelled: true,
                        });
                        return;
                    }

                    try {
                        // 构建最终命令（可能需要添加前置命令）
                        let finalCommand = shellConfig.prependCommand ? `${shellConfig.prependCommand} ${command}` : command;
                        if (shellConfig.appendCommand) finalCommand += shellConfig.appendCommand;

                        // CMD /s /c：不再预先用双引号包裹整条命令。
                        // cmd /s 只在命令行恰好为两个引号时剥离最外层；命令内再含引号
                        // （如 findstr "a b" file、echo "hi"）时整条命令解析失败。
                        // 引号由模型按 cmd 语法负责（见 promptDescriptions 的 CMD 指引）。
                        // 注意：不能用 includes('cmd') 判断——自定义 shell 路径的目录名
                        // 含 "cmd"（如 /tools/cmd-bash/）会被误判；按文件名精确匹配。
                        const shellName = shellConfig.shell.toLowerCase().split(/[\\/]/).pop() || '';
                        const isCmdWithS = (shellName === 'cmd' || shellName === 'cmd.exe') && shellConfig.shellArgs?.includes('/s');
                        const isWindows = os.platform() === 'win32';

                        // 构建命令参数
                        const spawnArgs = commandArgs ?? (shellConfig.shellArgs ? [...shellConfig.shellArgs, finalCommand] : [finalCommand]);

                        // 注入环境变量以便更好地支持 UTF-8（主要针对 Windows 上的 Unix 工具）
                        const env = { ...process.env };
                        if (argv) env.FORCE_COLOR = '0';
                        if (isWindows && !argv) {
                            // 很多工具（如 git, node, python）在 Windows 上通过这些变量识别编码
                            if (!env.LANG) env.LANG = 'en_US.UTF-8';
                            if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
                        }

                        // 启动进程
                        const spawnedAt = Date.now();
                        const proc = (argv ? crossSpawn : cp.spawn)(shellConfig.shell, spawnArgs, {
                            cwd: workingDir,
                            shell: false,
                            env,
                            windowsHide: true,
                            // windowsVerbatimArguments 用于原样传递模型提供的引号，
                            // 避免 Node.js 二次转义；命令引号由模型按 cmd 语法负责
                            // （本模块不再预包外层引号，见上方 CMD /s /c 注释）。
                            // @ts-ignore - windowsVerbatimArguments is a valid option on Windows
                            windowsVerbatimArguments: !argv && isWindows && isCmdWithS,
                        });

                        // CPU 友好：后台命令降优先级（Windows: BELOW_NORMAL_PRIORITY_CLASS；
                        // POSIX: nice）。spawn 后设置 shell 进程，Windows 上子进程树创建时继承
                        // 父进程优先级类——cmd/powershell 后续启动的 node/jest 等子进程同样让出
                        // CPU，跑测试/长任务时不再抢占前台交互（主进程/渲染进程为 normal，竞争时
                        // 自动让路），空闲时仍全速。前台命令保持 normal：模型同步等待，降级会
                        // 无谓拖慢。detach 转后台的进程保持启动时优先级（罕见场景，不动态调整）。
                        if (!argv || background) setTerminalProcessPriority(proc.pid, background);

                        // 创建终端进程信息
                        const terminalProcess: TerminalProcess = {
                            id: terminalId,
                            command,
                            cwd: workingDir,
                            shell,
                            mode,
                            args: commandArgs,
                            process: proc,
                            output: [],
                            startTime: Date.now(),
                        };
                        // stdin 的错误独立于 ChildProcess；保留错误供 input 回执使用，避免未处理的 EPIPE。
                        const inputError = (error: Error) => {
                            terminalProcess.inputError = error;
                        };
                        proc.stdin?.on('error', inputError);
                        proc.once('close', () => proc.stdin?.off('error', inputError));
                        if (host.processTree && isWindows && proc.pid) {
                            // 采样用 spawn 前的时间做身份下限；终止时只处理能追溯到本 Shell 的后代。
                            terminalProcess.tracker = new ProcessTreeTracker(host.processTree, proc.pid, spawnedAt);
                            terminalProcess.tracker.start();
                            proc.once('exit', () => {
                                terminalProcess.tracker?.rootExited();
                                // Shell 先退出而管道仍被后代占用时，趁它们的 ParentProcessId 还能关联到 Shell 采样一次。
                                const timer = setTimeout(() => {
                                    if (terminalProcess.endTime === undefined) void terminalProcess.tracker?.sample();
                                }, 300);
                                timer.unref?.();
                            });
                            proc.once('close', () => {
                                if (!terminalProcess.cleanup) terminalProcess.tracker?.stop();
                            });
                        }

                        // 相同 toolId 并发执行时，第二次 set 会覆盖第一次的条目，
                        // 旧进程成为孤儿、无法取消。覆盖前先终止仍在运行的旧进程。
                        const existingProc = activeProcesses.get(terminalId);
                        if (
                            existingProc &&
                            existingProc.process.exitCode === null &&
                            existingProc.process.pid &&
                            existingProc.process.pid !== proc.pid
                        ) {
                            try {
                                treeKill(existingProc.process.pid, 'SIGTERM');
                            } catch {
                                // 旧进程可能已退出，忽略
                            }
                            // 旧进程被替换：立即注销其任务并摘除条目，否则旧进程的 close/error
                            // 处理器会按 terminalId 把新进程的注册删掉（新进程变孤儿、无法取消）。
                            TaskManager.unregisterTask(terminalId, 'cancelled', {
                                exitCode: null,
                                duration: Date.now() - existingProc.startTime,
                                killed: true,
                                background,
                                conversationId: context?.conversationId,
                                command: existingProc.command,
                                output: '',
                            });
                            if (activeProcesses.get(terminalId) === existingProc) {
                                activeProcesses.delete(terminalId);
                            }
                        }
                        activeProcesses.set(terminalId, terminalProcess);

                        // 命令的“有效后台标记”：background 参数为真，或运行中被 detach 转后台。
                        // close/error 上报 TaskManager 时使用该标记，保证转后台的命令完成事件能回流为回执。
                        let effectiveBackground = background;

                        // 使用 TaskManager 注册任务
                        // 创建一个 AbortController 用于统一取消
                        const taskAbortController = new AbortController();

                        // 监听 taskAbortController 的 signal（通过 TaskManager.cancelTask 取消时触发）
                        {
                            const taskAbortHandler = () => {
                                // 通过 TaskManager 取消时，终止进程树
                                // killTerminalProcess 现在等待进程 close 后才返回，此处不阻塞 abort 流程
                                void killTerminalProcess(terminalId, 'stopped');
                            };

                            taskAbortController.signal.addEventListener('abort', taskAbortHandler, { once: true });

                            // 进程结束时移除监听器
                            proc.on('close', () => {
                                taskAbortController.signal.removeEventListener('abort', taskAbortHandler);
                            });
                        }

                        TaskManager.registerTask(terminalId, TASK_TYPE_TERMINAL, taskAbortController, {
                            command,
                            cwd: workingDir,
                            shell,
                            // 修改原因：TaskManager.cleanup() 的 30 分钟兜底依据 metadata.timeout 判定
                            //          「显式无超时」任务，不写入则前台 timeout=0 或 >30min 的长命令
                            //          会被兜底误杀。
                            // 修改方式：与 background 一起写入注册元数据（detach 转后台时保留该值）。
                            // 修改目的：清理逻辑与任务事实使用同一份元数据。
                            timeout,
                            background,
                            conversationId: context?.conversationId,
                            // 子代理归属标记：子代理内部执行命令时 mailboxRunId 存在（主会话为 undefined）。
                            // 前端据此区分任务归属，子代理内部的后台命令完成不回流为主会话消息。
                            subagentRunId: typeof context?.mailboxRunId === 'string' ? context.mailboxRunId : undefined,
                        });

                        // 监听外部的 abortSignal（用户取消对话时触发）
                        // 后台命令不挂外部 signal：用户停止当前对话流不得连带杀掉后台命令（任务条可单独取消）
                        // detach 转后台时也会移除该监听，保持同样的脱钩语义
                        let removeExternalAbortListener: (() => void) | undefined;
                        if (externalAbortSignal && !background && !argv) {
                            const abortHandler = () => {
                                // 外部取消覆盖先前的超时原因：结果仍按用户/任务取消处理（见 isExternalAbort）
                                terminalProcess.interruptReason = abortReason(externalAbortSignal.reason);
                                void killTerminalProcess(terminalId);
                            };

                            externalAbortSignal.addEventListener('abort', abortHandler, { once: true });

                            removeExternalAbortListener = () => {
                                externalAbortSignal.removeEventListener('abort', abortHandler);
                                removeExternalAbortListener = undefined;
                            };

                            // 进程结束时移除监听器
                            proc.on('close', () => {
                                removeExternalAbortListener?.();
                            });
                        }

                        // 发送 start 事件，通知前端进程已启动
                        emitTerminalOutput({
                            terminalId,
                            type: 'start',
                            command,
                            cwd: workingDir,
                            shell,
                        });

                        // 默认按 UTF-8 解码；Windows 上所有 shell 均支持自动降级到 GBK。
                        // 跨 chunk 前缀缓冲由 outputDecoder 内部自管（StreamDecodeState.pendingBytes），
                        // 不再依赖 StringDecoder 的隐藏缓冲状态，GBK 中途切换不再丢字节。
                        const canUseGbkFallback = isWindows && !argv;
                        const stdoutGbkDecoder = canUseGbkFallback ? new TextDecoder('gbk') : undefined;
                        const stderrGbkDecoder = canUseGbkFallback ? new TextDecoder('gbk') : undefined;
                        const stdoutDecodeModeRef: StreamDecodeState = { mode: 'utf8' };
                        const stderrDecodeModeRef: StreamDecodeState = { mode: 'utf8' };

                        const stdoutLines = createOutputLineBuffer();
                        const stderrLines = createOutputLineBuffer();

                        // 收集输出并实时推送
                        proc.stdout?.on('data', (data: Buffer) => {
                            // 第 3 参（utf8Decoder）为兼容保留参数，本实现不再使用
                            const text = decodeWithMode(data, stdoutDecodeModeRef, undefined, stdoutGbkDecoder);
                            const lines = stdoutLines.push(text);

                            if (lines.length > 0) {
                                pushOutputLines(terminalProcess, lines);
                            }

                            // 实时推送输出到前端
                            emitTerminalOutput({
                                terminalId,
                                type: 'output',
                                data: text,
                            });
                        });

                        proc.stderr?.on('data', (data: Buffer) => {
                            const text = decodeWithMode(data, stderrDecodeModeRef, undefined, stderrGbkDecoder);
                            const lines = stderrLines.push(text);

                            if (lines.length > 0) {
                                pushOutputLines(terminalProcess, lines);
                            }

                            // 实时推送错误输出到前端
                            emitTerminalOutput({
                                terminalId,
                                type: 'error',
                                data: text,
                            });
                        });

                        // 进程结束时处理剩余的输出
                        proc.on('close', () => {
                            // 冲刷流式解码状态：gbk 模式 flush 解码器流缓冲；
                            // utf8 模式冲刷跨 chunk 扣下的未完成前缀（未完成序列 → 替换字符）
                            const stdoutTail = flushDecodeState(stdoutDecodeModeRef, stdoutGbkDecoder);

                            if (stdoutTail) {
                                emitTerminalOutput({ terminalId, type: 'output', data: stdoutTail });
                                const lines = stdoutLines.push(stdoutTail);
                                if (lines.length > 0) {
                                    pushOutputLines(terminalProcess, lines);
                                }
                            }

                            const stderrTail = flushDecodeState(stderrDecodeModeRef, stderrGbkDecoder);

                            if (stderrTail) {
                                emitTerminalOutput({ terminalId, type: 'error', data: stderrTail });
                                const lines = stderrLines.push(stderrTail);
                                if (lines.length > 0) {
                                    pushOutputLines(terminalProcess, lines);
                                }
                            }

                            const stdoutRemaining = stdoutLines.flush();
                            const stderrRemaining = stderrLines.flush();
                            if (stdoutRemaining) {
                                pushOutputLines(terminalProcess, [stdoutRemaining]);
                            }
                            if (stderrRemaining) {
                                pushOutputLines(terminalProcess, [stderrRemaining]);
                            }
                        });

                        // 设置超时（后台命令不受 timeout 约束）
                        let timeoutHandle: NodeJS.Timeout | undefined;
                        if (timeout > 0 && !background) {
                            timeoutHandle = setTimeout(() => {
                                terminalProcess.killed = true;
                                terminalProcess.timedOut = true;
                                terminalProcess.interruptReason ??= 'timeout';
                                terminalProcess.error = `Command timed out after ${timeout}ms`;
                                // 与 killTerminalProcess 相同的「SIGTERM → 等待 → SIGKILL 升级」流程：
                                // 进程树捕获/忽略 SIGTERM 时 'close' 永不触发，execute_command 的
                                // Promise 永不 resolve（模型工具循环挂死）；升级强杀保证 close 必达。
                                void terminateProcessTreeWithEscalation(terminalProcess);
                            }, timeout);
                        }

                        // 进程结束
                        proc.on('close', (code) => {
                            if (timeoutHandle) {
                                clearTimeout(timeoutHandle);
                            }

                            terminalProcess.endTime = Date.now();
                            terminalProcess.exitCode = code ?? undefined;

                            // 从配置获取最大输出行数
                            const maxLines = getMaxOutputLines();
                            const lastOutput = maxLines === -1 ? terminalProcess.output : getLastLines(terminalProcess.output, maxLines);
                            const duration = terminalProcess.endTime - terminalProcess.startTime;

                            // 从活动进程中移除（身份校验：同 toolId 并发时旧进程的 close
                            // 不能误删新进程的条目——预杀分支已注销旧任务并摘除旧条目）
                            const isCurrentProcess = activeProcesses.get(terminalId) === terminalProcess;
                            if (isCurrentProcess) {
                                activeProcesses.delete(terminalId);
                            }

                            // 使用 TaskManager 注销任务；后台任务的完成事件携带输出与会话信息，供前端回流为 [Background task completed] 消息
                            // 超时是失败不是取消：status 必须区分，否则前端把超时当"已取消"展示
                            const status = terminalProcess.timedOut
                                ? 'error'
                                : terminalProcess.killed
                                  ? 'cancelled'
                                  : code === 0
                                    ? 'completed'
                                    : 'error';
                            if (isCurrentProcess) {
                                TaskManager.unregisterTask(terminalId, status, {
                                    exitCode: code,
                                    duration,
                                    killed: terminalProcess.killed,
                                    background: effectiveBackground,
                                    conversationId: context?.conversationId,
                                    subagentRunId: typeof context?.mailboxRunId === 'string' ? context.mailboxRunId : undefined,
                                    command,
                                    output: lastOutput.join('\n'),
                                    error: terminalProcess.error,
                                });
                            }

                            // 检查是否是外部 abortSignal 触发的终止
                            const isExternalAbort = !argv && externalAbortSignal?.aborted && terminalProcess.killed;

                            // 被用户杀死的进程也算成功（不显示错误）；
                            // 但超时强杀的进程必须报失败（即使 close 恰以 0 退出码晚于超时回调到达），
                            // 否则模型会把超时误判为执行成功
                            const success = !terminalProcess.timedOut && (code === 0 || terminalProcess.killed === true);

                            // 确定错误信息
                            let error: string | undefined;
                            if (isExternalAbort) {
                                // 外部取消：用户点击停止、任务被上层取消或宿主关闭
                                error =
                                    terminalProcess.interruptReason === 'task_cancelled'
                                        ? `The task running this command was cancelled (${String((externalAbortSignal?.reason as Error | undefined)?.message ?? 'no reason given')}).`
                                        : terminalProcess.interruptReason === 'host_closing'
                                          ? 'The command was stopped because GrayCode is shutting down.'
                                          : "User cancelled the command execution. Please wait for user's next instruction.";
                            } else if (terminalProcess.error) {
                                // 超时等系统错误
                                error = terminalProcess.error;
                            } else if (terminalProcess.killed) {
                                // 用户通过终端 UI 手动终止，不设置 error（成功状态）
                                error = undefined;
                            } else if (code !== 0 && code !== null) {
                                // 非零退出码
                                error = `Command exited with code ${code}`;
                            }

                            // 推送退出事件到前端
                            emitTerminalOutput({
                                terminalId,
                                type: 'exit',
                                exitCode: code ?? undefined,
                                killed: terminalProcess.killed,
                                duration,
                            });

                            // 简化返回结构：AI 已知 command/cwd/shell，只需返回结果
                            // 如果输出被截断，添加简单提示（含内存护栏丢弃的行数）
                            const totalOutputLines = terminalProcess.output.length + (terminalProcess.omittedOutputLines ?? 0);
                            const wasTruncated = (maxLines !== -1 && totalOutputLines > maxLines) || (terminalProcess.omittedOutputLines ?? 0) > 0;
                            const truncatedNote = wasTruncated
                                ? `(Output truncated: showing last ${lastOutput.length} of ${totalOutputLines} lines)`
                                : undefined;

                            const finish = (processTree: ProcessTreeReport | undefined) => {
                                // 被终止时说明原因与子进程清理结果；未终止的命令结果结构不变。
                                const interruption = terminalProcess.killed ? interruptionOf(terminalProcess, processTree) : undefined;
                                resolve({
                                    success: isExternalAbort ? false : success,
                                    data: {
                                        // 前端需要这些用于 UI 显示，但 AI 不需要（会在 ConversationManager 中过滤）
                                        terminalId,
                                        command,
                                        cwd: workingDir,
                                        shell,
                                        exitCode: code,
                                        killed: terminalProcess.killed || false,
                                        duration,
                                        // AI 只需要 output 和 exitCode
                                        output: lastOutput.join('\n'),
                                        truncatedNote,
                                        ...(interruption ? { interruption } : {}),
                                    },
                                    error: error && interruption ? `${error} ${interruption.summary}` : error,
                                    // 超时不是取消：killed 与 timedOut 非互斥（超时强杀两标记都置位），
                                    // 必须排除 timedOut，否则超时被下游误判为「用户取消」→ 对话被自动暂停
                                    cancelled: isExternalAbort || (terminalProcess.killed === true && !terminalProcess.timedOut),
                                });
                            };
                            // 终止时的后代清理可能晚于 close（需要再取快照核实），等它结束再返回，最多 30 秒。
                            if (terminalProcess.killed && terminalProcess.cleanup) {
                                const limit = new Promise<undefined>((done) => {
                                    const timer = setTimeout(() => done(undefined), 30_000);
                                    timer.unref?.();
                                });
                                void Promise.race([terminalProcess.cleanup, limit]).then(finish, () => finish(undefined));
                            } else finish(undefined);
                        });

                        proc.on('error', (err) => {
                            if (timeoutHandle) {
                                clearTimeout(timeoutHandle);
                            }

                            terminalProcess.endTime = Date.now();
                            terminalProcess.error = err.message;
                            if (argv) {
                                terminalProcess.exitCode = -1;
                                pushOutputLines(terminalProcess, [err.message]);
                                emitTerminalOutput({ terminalId, type: 'error', data: err.message });
                            }

                            const errMaxLines = getMaxOutputLines();
                            const lastOutput = errMaxLines === -1 ? terminalProcess.output : getLastLines(terminalProcess.output, errMaxLines);
                            const duration = terminalProcess.endTime - terminalProcess.startTime;

                            // 从活动进程中移除（身份校验：同 toolId 并发时旧进程的 error
                            // 不能误删新进程的条目）
                            if (activeProcesses.get(terminalId) === terminalProcess) {
                                activeProcesses.delete(terminalId);

                                // 使用 TaskManager 注销任务
                                TaskManager.unregisterTask(terminalId, 'error', {
                                    error: err.message,
                                    ...(argv ? { exitCode: -1 } : {}),
                                    duration,
                                    background: effectiveBackground,
                                    conversationId: context?.conversationId,
                                    command,
                                    output: lastOutput.join('\n'),
                                });
                            }

                            // 推送错误退出事件
                            emitTerminalOutput({
                                terminalId,
                                type: 'exit',
                                exitCode: -1,
                                killed: false,
                                duration,
                            });

                            resolve({
                                success: false,
                                data: {
                                    // 前端需要这些用于 UI 显示
                                    terminalId,
                                    command,
                                    cwd: workingDir,
                                    shell,
                                    output: lastOutput.join('\n'),
                                    ...(argv ? { exitCode: -1 } : {}),
                                },
                                error: `Failed to execute command: ${err.message} (cwd: ${workingDir})`,
                            });
                        });

                        // 后台模式：监听器全部就绪后立即返回；后续 close/error 的 resolve 是 no-op（Promise 仅 resolve 一次），
                        // 最终结果由 TaskManager 完成事件携带输出回流。
                        if (background) {
                            resolve({
                                success: true,
                                data: {
                                    background: true,
                                    taskId: terminalId,
                                    terminalId,
                                    command,
                                    cwd: workingDir,
                                    shell,
                                    note: 'Command started in background. Do NOT wait or poll; the output will arrive later as a "[Background task completed]" user message. Continue with other work or end your turn.',
                                },
                            });
                        }

                        if (argv && !background) {
                            // argv 会话沿用原先的短等待：返回后仍持有同一进程，显式 timeout 继续生效。
                            const yieldTimer = setTimeout(
                                () =>
                                    resolve({
                                        success: true,
                                        data: { taskId: terminalId, terminalId, command, args: commandArgs, mode, cwd: workingDir, running: true },
                                    }),
                                300,
                            );
                            yieldTimer.unref();
                            proc.once('close', () => clearTimeout(yieldTimer));
                            proc.once('error', () => clearTimeout(yieldTimer));
                        }
                        // 用户在前台 Shell 命令运行期间发送新消息时，转入后台并立即响应用户。
                        // argv 会话本身已经返回，无需登记 detach；完成通知仍只由 background 决定。
                        if (!background && !argv) {
                            const detach = (): boolean => {
                                if (terminalProcess.endTime !== undefined || effectiveBackground) {
                                    return false;
                                }
                                effectiveBackground = true;

                                // 转后台后不再受前台超时与对话取消约束（与 background=true 语义对齐）
                                if (timeoutHandle) {
                                    clearTimeout(timeoutHandle);
                                    timeoutHandle = undefined;
                                }
                                removeExternalAbortListener?.();

                                // 更新任务元数据并补发带 background 标记的 start 事件：
                                // 前端任务条按该标记登记任务，之后的完成事件才能回流为回执消息
                                const task = TaskManager.getTask(terminalId);
                                if (task) {
                                    task.metadata = { ...(task.metadata || {}), background: true, detached: true };
                                    TaskManager.emitEvent({
                                        taskId: terminalId,
                                        taskType: TASK_TYPE_TERMINAL,
                                        type: 'start',
                                        data: task.metadata,
                                        createdAt: task.startTime,
                                    });
                                }

                                resolve({
                                    success: true,
                                    data: {
                                        background: true,
                                        detached: true,
                                        taskId: terminalId,
                                        terminalId,
                                        command,
                                        cwd: workingDir,
                                        shell,
                                        note: 'The user sent a new message while this command was still running. The command has been MOVED TO BACKGROUND and keeps running; its final output will arrive later as a "[Background task completed]" user message. Do NOT wait or poll for it. The user\'s new message will be delivered right after this turn — address it now and end your turn promptly.',
                                    },
                                });
                                return true;
                            };

                            detachHandlers.set(terminalId, detach);
                            proc.on('close', () => {
                                detachHandlers.delete(terminalId);
                            });
                        }
                    } catch (error) {
                        resolve({
                            success: false,
                            error: `Failed to start command: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    }
                });
            },
        };
    }

    /**
     * 杀掉终端进程
     * 同时支持直接调用和通过 TaskManager 取消
     *
     * 使用 tree-kill 库来跨平台终止进程树（包括所有子进程）
     * tree-kill 在 Windows 上使用 taskkill /T，在 Unix 上使用 SIGTERM/SIGKILL
     *
     * 修改原因：旧实现 treeKill 发出信号后立即返回，进程树尚未退出，返回的 output 是
     *          杀进程瞬间的中间态，exitCode 也还未落定（close 处理器稍后才写）。
     * 修改方式：标记 killed 后等待进程 close 事件（输出与 exitCode 由 close 处理器落定）
     *          再返回；SIGTERM 可能被进程忽略，超时后 SIGKILL 强杀，保证等待不永久挂起。
     * 修改目的：调用方（前端 kill 按钮、TaskManager 取消）拿到的输出/exitCode 反映最终状态。
     */
    async function killTerminalProcess(
        terminalId: string,
        reason?: TerminalInterruptReason,
    ): Promise<{
        success: boolean;
        output?: string;
        exitCode?: number;
        error?: string;
        interruption?: ReturnType<typeof interruptionOf>;
    }> {
        const terminalProcess = activeProcesses.get(terminalId);

        if (!terminalProcess) {
            // 尝试通过 TaskManager 取消（可能任务存在但进程已结束）
            const taskResult = TaskManager.cancelTask(terminalId);
            if (taskResult.success) {
                return { success: true };
            }
            return {
                success: false,
                error: `Terminal ${terminalId} not found or already exited`,
            };
        }

        try {
            // close 已处理（endTime 已落定）：直接返回最终输出与退出码。
            // Shell 已退出但 close 未到时仍要终止：后代还占着管道，不处理前台命令会一直挂起。
            if (terminalProcess.endTime !== undefined) {
                return buildKillTerminalResult(terminalProcess);
            }

            // 标记为被终止：close 处理器据此把任务终态判定为 cancelled（而非超时失败）
            terminalProcess.killed = true;
            if (reason) terminalProcess.interruptReason ??= reason;

            // 等待进程树真正退出：SIGTERM → 等待 KILL_WAIT_CLOSE_TIMEOUT_MS → SIGKILL 升级
            // （见 terminateProcessTreeWithEscalation：先注册 close 监听再发信号，避免进程在
            // 两者之间退出导致漏监听；SIGKILL 不可捕获、close 必达，等待不会永久挂起）
            await terminateProcessTreeWithEscalation(terminalProcess);
            const processTree = terminalProcess.cleanup ? await terminalProcess.cleanup.catch(() => undefined) : undefined;

            // close 处理器已把 endTime/exitCode/output 落定并注销任务
            return { ...buildKillTerminalResult(terminalProcess), interruption: interruptionOf(terminalProcess, processTree) };
        } catch (error) {
            return {
                success: false,
                error: `Failed to kill terminal: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    /** 从已落定的进程状态构建 kill 返回结果（输出截断规则与 close 处理器一致） */
    function buildKillTerminalResult(terminalProcess: TerminalProcess): {
        success: boolean;
        output?: string;
        exitCode?: number;
    } {
        const killMaxLines = getMaxOutputLines();
        const lastOutput = killMaxLines === -1 ? terminalProcess.output : getLastLines(terminalProcess.output, killMaxLines);

        return {
            success: true,
            output: lastOutput.join('\n'),
            exitCode: terminalProcess.exitCode,
        };
    }

    /**
     * 将正在前台等待的终端命令转入后台。
     *
     * 用户在命令执行期间发送新消息时调用：等待中的 execute_command 立即返回
     * “已转后台”结果，模型得以先响应用户；命令完成后结果经 TaskManager 完成事件
     * 回流为 [Background task completed] 回执消息。
     *
     * @param conversationId 只转移属于该会话的命令；不传则转移全部前台命令
     */
    function detachRunningTerminalsToBackground(conversationId?: string): { detached: string[] } {
        const detached: string[] = [];
        for (const [id, detach] of [...detachHandlers]) {
            if (conversationId) {
                const taskConvId = TaskManager.getTask(id)?.metadata?.conversationId;
                if (typeof taskConvId === 'string' && taskConvId && taskConvId !== conversationId) {
                    continue;
                }
            }
            if (detach()) {
                detached.push(id);
                detachHandlers.delete(id);
            }
        }
        return { detached };
    }

    /**
     * 获取终端进程输出
     */
    function getTerminalOutput(terminalId: string): {
        success: boolean;
        output?: string;
        running?: boolean;
        error?: string;
    } {
        const terminalProcess = activeProcesses.get(terminalId);

        if (!terminalProcess) {
            return {
                success: false,
                error: `Terminal ${terminalId} not found`,
            };
        }

        const outputMaxLines = getMaxOutputLines();
        const lastOutput = outputMaxLines === -1 ? terminalProcess.output : getLastLines(terminalProcess.output, outputMaxLines);

        return {
            success: true,
            output: lastOutput.join('\n'),
            running: terminalProcess.endTime === undefined,
        };
    }

    /**
     * 导出活动终端 Map（用于其他模块）
     */
    function getActiveTerminals(): Map<string, TerminalProcess> {
        return activeProcesses;
    }
    async function inputTerminalProcess(terminalId: string, text: string, signal?: AbortSignal): Promise<void> {
        const terminalProcess = activeProcesses.get(terminalId);
        if (!terminalProcess) throw new ProcessSessionError('EXITED', '命令已经退出，不能再发送输入。');
        await writeProcessInput(terminalProcess.process, text, signal, terminalProcess.inputError);
    }
    return {
        onTerminalOutput,
        createExecuteCommandTool,
        killTerminalProcess,
        detachRunningTerminalsToBackground,
        getTerminalOutput,
        getActiveTerminals,
        inputTerminalProcess,
    };
}
