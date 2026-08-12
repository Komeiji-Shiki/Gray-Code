/**
 * Terminal process spawn & management
 *
 * Split from execute_command.ts: process spawn / timeout / process-tree
 * kill / background tasks / detach-to-background, terminal event emitter,
 * TaskManager task registration & cancellation, active process registry,
 * and the execute_command tool factory.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { TextDecoder } from 'util';
import type { Tool, ToolResult, ToolContext } from '../types';

// tree-kill library, used to terminate process trees cross-platform
// eslint-disable-next-line @typescript-eslint/no-var-requires
const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (error?: Error) => void) => void;
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultExecuteCommandConfig } from '../../modules/settings';
import { TaskManager, type TaskEvent } from '../taskManager';
import { getAllWorkspaces, getWorkspaceByUri, parseWorkspacePath } from '../utils';
import {
    getShellConfig,
    getShellAvailabilityWithReason,
    getAvailableShellsDescription,
    getDefaultShellName,
    getEnabledShellTypesForEnum,
    type ShellType
} from './shellConfig';
import {
    pushOutputLines,
    getLastLines,
    getMaxOutputLines,
    decodeWithMode,
    flushDecodeState,
    MAX_SINGLE_LINE_CHARS,
    type StreamDecodeState
} from './outputDecoder';
import {
    getAllWorkspaceRoots,
    getOSName,
    getCwdParameterDescription,
    getExecuteCommandShellGuidanceDescription
} from './promptDescriptions';

/** 终端任务类型常量 */
const TASK_TYPE_TERMINAL = 'terminal';

/**
 * 判定解析后的目录是否仍落在工作区内（cwd 越界守卫）。
 * - 折叠 `..` 段后的结果与工作区根相等或在根下 → 在工作区内；
 * - 工作区根本身可能带尾分隔符（盘根 `C:\` / `/`），此时根 + 分隔符判定仍成立；
 * - Windows 大小写不敏感：实际用途是拒绝 `../..` 越界（大小写翻转属理论误伤，fail-closed 可接受）。
 */
function isWithinWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
    const normalizedRoot = path.normalize(workspaceRoot);
    if (resolvedPath === normalizedRoot) return true;
    const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return resolvedPath.startsWith(rootWithSep);
}

/** killTerminalProcess 等待进程 close 的超时（毫秒）：超时后 SIGKILL 强杀；强杀后继续等真实 close（SIGKILL 必达），同阈值再作最终兜底，保证等待不永久挂起 */
const KILL_WAIT_CLOSE_TIMEOUT_MS = 10_000;
/**
 * 终端进程信息
 */
export interface TerminalProcess {
    id: string;
    command: string;
    cwd: string;
    shell: ShellType;
    process: cp.ChildProcess;
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
}

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
 * 终端输出事件类型
 */
export interface TerminalOutputEvent {
    terminalId: string;
    type: 'start' | 'output' | 'error' | 'exit';
    data?: string;
    command?: string;  // start 事件时包含命令
    cwd?: string;      // start 事件时包含工作目录
    shell?: string;    // start 事件时包含 shell 类型
    exitCode?: number;
    killed?: boolean;
    duration?: number;
}

/**
 * 订阅终端输出
 * @param listener 监听器函数
 * @returns 取消订阅函数
 */
export function onTerminalOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    terminalEmitter.on('output', listener);
    return () => terminalEmitter.off('output', listener);
}

/**
 * 订阅终端任务事件（使用 TaskManager）
 * 这是统一事件系统的入口，可用于未来替换 terminalEmitter
 * @param listener 监听器函数
 * @returns 取消订阅函数
 */
export function onTerminalTaskEvent(listener: (event: TaskEvent) => void): () => void {
    return TaskManager.onTaskEventByType(TASK_TYPE_TERMINAL, listener);
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
export function createExecuteCommandTool(): Tool {
    const osName = getOSName();
    const osArch = os.arch();
    const osRelease = os.release();
    
    // 获取工作区信息
    const workspaceRoots = getAllWorkspaceRoots();
    const isMultiRoot = workspaceRoots.length > 1;
    
    // 生成工作区说明
    let workspaceDescription = '';
    if (isMultiRoot) {
        workspaceDescription = '\n\n**Multi-root Workspace Mode:**\n' +
            workspaceRoots.map(ws => `- ${ws.name}: ${ws.path}`).join('\n') +
            '\n\nUse "workspace_name/path" format to specify the working directory';
    }
    
    // 1.2.2-fix：cwd 参数描述复用统一规则生成器。
    // 为什么要改：旧描述过短，模型经常不知道应填工作区相对路径还是绝对路径。
    // 怎么改：按单根/多根工作区动态生成 schema 字段说明。
    // 目的：让只读取参数 schema 的模型也能正确选择 cwd。
    const cwdDescription = getCwdParameterDescription(workspaceRoots, isMultiRoot);
    
    return {
        declaration: {
            name: 'execute_command',
            category: 'terminal',
            strict: true,  // API 端强制 schema 校验
            description: `执行 Shell 命令并返回输出。

**当前用户环境：**
- OS: ${osName} (${osArch})
- OS Version: ${osRelease}
- Default Shell: ${getDefaultShellName()}

**Enabled Shells / 当前可用 Shell：**
${getAvailableShellsDescription()}${workspaceDescription}

${getExecuteCommandShellGuidanceDescription(workspaceRoots, isMultiRoot)}`,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '要执行的 Shell 命令文本。注意：这是给所选 shell 解析的命令字符串，不是 argv 数组。'
                    },
                    cwd: {
                        type: 'string',
                        description: cwdDescription
                    },
                    shell: {
                        type: 'string',
                        description: `Shell 类型。可选值：${getEnabledShellTypesForEnum().join(', ')}。不传或传 default 时使用当前默认 Shell。`,
                        enum: getEnabledShellTypesForEnum(),
                        default: 'default'
                    },
                    timeout: {
                        type: 'number',
                        description: '超时时间（毫秒）。0 表示不超时，默认 60000（60 秒）。',
                        default: 60000
                    },
                    background: {
                        type: 'boolean',
                        description: 'Run this command in the BACKGROUND. Use ONLY for long-running commands (builds, servers, batch jobs) when the user should not have to wait. The tool returns immediately with a taskId; the final output will arrive later as a "[Background task completed]" user message. Do NOT wait or poll for it. Background commands ignore the timeout parameter.'
                    }
                },
                required: ['command']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const command = args.command as string;
            const cwd = args.cwd as string | undefined;
            const shell = (args.shell as ShellType) || 'default';
            // 超时钳制：仅接受有限非负数（0 = 显式不超时）；负数/NaN/非数字回退默认 60000，
            // 避免非法值把 timeout>0 判为 false 而意外禁用超时。
            const rawTimeout = args.timeout;
            const timeout = (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 0)
                ? Math.floor(rawTimeout)
                : 60000;
            // 修改原因：长耗时命令会阻塞主对话，用户只能干等。
            // 修改方式：background=true 时进程启动后立即返回；不挂外部 abortSignal、不设 timeout，
            //          退出时结果经 TaskManager 完成事件回流。
            // 修改目的：等待期间用户可继续互动；停止当前对话流不会连带杀掉后台命令。
            const background = args.background === true;
            
            // 使用 context 中的 toolId 或生成新的
            const terminalId = context?.toolId as string || generateTerminalId();
            
            // 获取外部的 abortSignal（用于用户取消对话时终止终端）
            const externalAbortSignal = context?.abortSignal as AbortSignal | undefined;

            if (!command) {
                return { success: false, error: 'command is required' };
            }

            const workspaces = getAllWorkspaces();
            // 无打开工作区但对话绑定工作区仍存在（虚拟解析）时允许继续
            if (workspaces.length === 0 && !getWorkspaceByUri(context?.activeWorkspaceUri as string)) {
                return { success: false, error: 'No workspace folder open' };
            }

            // 获取设置管理器和配置
            const settingsManager = getGlobalSettingsManager();
            const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
            
            // 确定实际使用的 shell 类型
            let actualShellType = shell;
            if (shell === 'default') {
                actualShellType = config.defaultShell as ShellType;
            }
            
            // 检查 shell 是否启用
            const shellInfo = config.shells.find(s => s.type === actualShellType);
            if (shellInfo && !shellInfo.enabled) {
                return {
                    success: false,
                    error: `Shell "${actualShellType}" is not enabled, please enable it in settings and try again`
                };
            }
            
            // 检查 shell 可用性（同步缓存版：复用工具创建时的 5 分钟 TTL 缓存，
            // 不再每次执行命令都 spawn 探测子进程；不可用原因与原异步版本语义一致）
            const availability = getShellAvailabilityWithReason(actualShellType, shellInfo?.path);
            if (!availability.available) {
                return {
                    success: false,
                    error: `Shell "${actualShellType}" is not available: ${availability.reason || 'unknown reason'}. Please configure the correct path in settings.`
                };
            }

            // 计算工作目录（支持多工作区）
            // 会话绑定工作区时（未显式指定前缀），相对 cwd 与默认 cwd 都优先解析到该工作区
            const preferredWorkspace = context?.activeWorkspaceUri ? getWorkspaceByUri(context.activeWorkspaceUri) : undefined;
            let workingDir: string;
            let workspaceName: string | undefined;
            
            if (cwd) {
                // 如果 cwd 已经是绝对路径，直接使用，不再拼接到 workspace 根目录
                if (path.isAbsolute(cwd)) {
                    workingDir = cwd;
                } else {
                    // 解析带工作区前缀的路径
                    const { workspace, relativePath } = parseWorkspacePath(cwd, context?.activeWorkspaceUri);
                    if (workspace) {
                        // 折叠 .. 段后校验仍落在工作区内：防止 `../..` 之类的相对路径
                        // 把命令工作目录带出工作区（与 write 类工具的工作区外审批策略对齐）
                        const resolved = path.normalize(path.join(workspace.fsPath, relativePath));
                        if (!isWithinWorkspace(resolved, workspace.fsPath)) {
                            return {
                                success: false,
                                error: `Working directory escapes the workspace: ${cwd}. Please use a path inside the workspace.`
                            };
                        }
                        workingDir = resolved;
                        workspaceName = workspaces.length > 1 ? workspace.name : undefined;
                    } else {
                        // 使用默认工作区（会话绑定工作区优先）
                        const base = preferredWorkspace?.fsPath || workspaces[0].fsPath;
                        const resolved = path.normalize(path.join(base, cwd));
                        if (!isWithinWorkspace(resolved, base)) {
                            return {
                                success: false,
                                error: `Working directory escapes the workspace: ${cwd}. Please use a path inside the workspace.`
                            };
                        }
                        workingDir = resolved;
                    }
                }
            } else {
                // 默认使用第一个工作区（会话绑定工作区优先）
                workingDir = (preferredWorkspace?.fsPath || workspaces[0].fsPath);
            }

            // 验证工作目录是否存在。Windows 上 CreateProcessW 的 lpCurrentDirectory
            // 指向不存在的目录时会返回 ERROR_DIRECTORY，Node.js 映射为 ENOENT，
            // 错误消息却是 "spawn <shell> ENOENT"，极易误导为找不到 shell。
            // 在 spawn 之前主动检查，给出明确的目录错误。
            if (!fs.existsSync(workingDir)) {
                return {
                    success: false,
                    error: `Working directory does not exist: ${workingDir}. Please check the cwd parameter or create the directory first.`
                };
            }

            // 获取 shell 配置
            const shellConfig = getShellConfig(shell);

            return new Promise((resolve) => {
                // 检查是否已经取消
                if (externalAbortSignal?.aborted) {
                    resolve({
                        success: false,
                        error: '⚠️ User cancelled the command execution. Please wait for user\'s next instruction.',
                        cancelled: true
                    });
                    return;
                }
                
                try {
                    // 构建最终命令（可能需要添加前置命令）
                    let finalCommand = shellConfig.prependCommand
                        ? `${shellConfig.prependCommand} ${command}`
                        : command;

                    // CMD /s /c：不再预先用双引号包裹整条命令。
                    // cmd /s 只在命令行恰好为两个引号时剥离最外层；命令内再含引号
                    // （如 findstr "a b" file、echo "hi"）时整条命令解析失败。
                    // 引号由模型按 cmd 语法负责（见 promptDescriptions 的 CMD 指引）。
                    // 注意：不能用 includes('cmd') 判断——自定义 shell 路径的目录名
                    // 含 "cmd"（如 /tools/cmd-bash/）会被误判；按文件名精确匹配。
                    const shellName = (shellConfig.shell.toLowerCase().split(/[\\/]/).pop() || '');
                    const isCmdWithS = (shellName === 'cmd' || shellName === 'cmd.exe') &&
                        shellConfig.shellArgs?.includes('/s');
                    const isWindows = os.platform() === 'win32';

                    // 构建命令参数
                    const spawnArgs = shellConfig.shellArgs
                        ? [...shellConfig.shellArgs, finalCommand]
                        : [finalCommand];

                    // 注入环境变量以便更好地支持 UTF-8（主要针对 Windows 上的 Unix 工具）
                    const env = { ...process.env };
                    if (isWindows) {
                        // 很多工具（如 git, node, python）在 Windows 上通过这些变量识别编码
                        if (!env.LANG) env.LANG = 'en_US.UTF-8';
                        if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
                    }

                    // 启动进程
                    const proc = cp.spawn(shellConfig.shell, spawnArgs, {
                        cwd: workingDir,
                        shell: false,
                        env,
                        windowsHide: true,
                        // windowsVerbatimArguments 用于原样传递模型提供的引号，
                        // 避免 Node.js 二次转义；命令引号由模型按 cmd 语法负责
                        // （本模块不再预包外层引号，见上方 CMD /s /c 注释）。
                        // @ts-ignore - windowsVerbatimArguments is a valid option on Windows
                        windowsVerbatimArguments: isWindows && isCmdWithS
                    });

                    // CPU 友好：后台命令降优先级（Windows: BELOW_NORMAL_PRIORITY_CLASS；
                    // POSIX: nice）。spawn 后设置 shell 进程，Windows 上子进程树创建时继承
                    // 父进程优先级类——cmd/powershell 后续启动的 node/jest 等子进程同样让出
                    // CPU，跑测试/长任务时不再抢占前台交互（主进程/渲染进程为 normal，竞争时
                    // 自动让路），空闲时仍全速。前台命令保持 normal：模型同步等待，降级会
                    // 无谓拖慢。detach 转后台的进程保持启动时优先级（罕见场景，不动态调整）。
                    setTerminalProcessPriority(proc.pid, background);

                    // 创建终端进程信息
                    const terminalProcess: TerminalProcess = {
                        id: terminalId,
                        command,
                        cwd: workingDir,
                        shell,
                        process: proc,
                        output: [],
                        startTime: Date.now()
                    };

                    // 相同 toolId 并发执行时，第二次 set 会覆盖第一次的条目，
                    // 旧进程成为孤儿、无法取消。覆盖前先终止仍在运行的旧进程。
                    const existingProc = activeProcesses.get(terminalId);
                    if (existingProc && existingProc.process.exitCode === null && existingProc.process.pid && existingProc.process.pid !== proc.pid) {
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
                            output: ''
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
                            void killTerminalProcess(terminalId);
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
                        subagentRunId: typeof context?.mailboxRunId === 'string' ? context.mailboxRunId : undefined
                    });
                    
                    // 监听外部的 abortSignal（用户取消对话时触发）
                    // 后台命令不挂外部 signal：用户停止当前对话流不得连带杀掉后台命令（任务条可单独取消）
                    // detach 转后台时也会移除该监听，保持同样的脱钩语义
                    let removeExternalAbortListener: (() => void) | undefined;
                    if (externalAbortSignal && !background) {
                        const abortHandler = () => {
                            // 调用 killTerminalProcess 终止进程
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
                        shell
                    });

                    // 默认按 UTF-8 解码；Windows 上所有 shell 均支持自动降级到 GBK。
                    // 跨 chunk 前缀缓冲由 outputDecoder 内部自管（StreamDecodeState.pendingBytes），
                    // 不再依赖 StringDecoder 的隐藏缓冲状态，GBK 中途切换不再丢字节。
                    const canUseGbkFallback = isWindows;
                    const stdoutGbkDecoder = canUseGbkFallback ? new TextDecoder('gbk') : undefined;
                    const stderrGbkDecoder = canUseGbkFallback ? new TextDecoder('gbk') : undefined;
                    const stdoutDecodeModeRef: StreamDecodeState = { mode: 'utf8' };
                    const stderrDecodeModeRef: StreamDecodeState = { mode: 'utf8' };

                    let stdoutRemaining = '';
                    let stderrRemaining = '';

                    // 收集输出并实时推送
                    proc.stdout?.on('data', (data: Buffer) => {
                        // 第 3 参（utf8Decoder）为兼容保留参数，本实现不再使用
                        const text = decodeWithMode(data, stdoutDecodeModeRef, undefined, stdoutGbkDecoder);
                        const content = stdoutRemaining + text;
                        const lines = content.split(/\r?\n/);
                        stdoutRemaining = lines.pop() || '';
                        // 无换行的巨块会在 stdoutRemaining 内无限累积（有界护栏见 pushOutputLines）：
                        // 保留尾部（模型更关心末尾的最新输出），头部截断并计数
                        if (stdoutRemaining.length > MAX_SINGLE_LINE_CHARS) {
                            stdoutRemaining = stdoutRemaining.slice(stdoutRemaining.length - MAX_SINGLE_LINE_CHARS);
                            terminalProcess.omittedOutputLines = (terminalProcess.omittedOutputLines ?? 0) + 1;
                        }
                        
                        if (lines.length > 0) {
                            pushOutputLines(terminalProcess, lines);
                        }
                        
                        // 实时推送输出到前端
                        emitTerminalOutput({
                            terminalId,
                            type: 'output',
                            data: text
                        });
                    });

                    proc.stderr?.on('data', (data: Buffer) => {
                        const text = decodeWithMode(data, stderrDecodeModeRef, undefined, stderrGbkDecoder);
                        const content = stderrRemaining + text;
                        const lines = content.split(/\r?\n/);
                        stderrRemaining = lines.pop() || '';
                        // 与 stdout 同一护栏：保留尾部，头部截断并计数
                        if (stderrRemaining.length > MAX_SINGLE_LINE_CHARS) {
                            stderrRemaining = stderrRemaining.slice(stderrRemaining.length - MAX_SINGLE_LINE_CHARS);
                            terminalProcess.omittedOutputLines = (terminalProcess.omittedOutputLines ?? 0) + 1;
                        }

                        if (lines.length > 0) {
                            pushOutputLines(terminalProcess, lines);
                        }
                        
                        // 实时推送错误输出到前端
                        emitTerminalOutput({
                            terminalId,
                            type: 'error',
                            data: text
                        });
                    });

                    // 进程结束时处理剩余的输出
                    proc.on('close', () => {
                        // 冲刷流式解码状态：gbk 模式 flush 解码器流缓冲；
                        // utf8 模式冲刷跨 chunk 扣下的未完成前缀（未完成序列 → 替换字符）
                        const stdoutTail = flushDecodeState(stdoutDecodeModeRef, stdoutGbkDecoder);

                        if (stdoutTail) {
                            const content = stdoutRemaining + stdoutTail;
                            const lines = content.split(/\r?\n/);
                            stdoutRemaining = lines.pop() || '';
                            if (lines.length > 0) {
                                pushOutputLines(terminalProcess, lines);
                            }
                        }

                        const stderrTail = flushDecodeState(stderrDecodeModeRef, stderrGbkDecoder);

                        if (stderrTail) {
                            const content = stderrRemaining + stderrTail;
                            const lines = content.split(/\r?\n/);
                            stderrRemaining = lines.pop() || '';
                            if (lines.length > 0) {
                                pushOutputLines(terminalProcess, lines);
                            }
                        }

                        if (stdoutRemaining) {
                            pushOutputLines(terminalProcess, [stdoutRemaining]);
                            stdoutRemaining = '';
                        }
                        if (stderrRemaining) {
                            pushOutputLines(terminalProcess, [stderrRemaining]);
                            stderrRemaining = '';
                        }
                    });

                    // 设置超时（后台命令不受 timeout 约束）
                    let timeoutHandle: NodeJS.Timeout | undefined;
                    if (timeout > 0 && !background) {
                        timeoutHandle = setTimeout(() => {
                            terminalProcess.killed = true;
                            terminalProcess.timedOut = true;
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
                        const lastOutput = maxLines === -1
                            ? terminalProcess.output
                            : getLastLines(terminalProcess.output, maxLines);
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
                            : (terminalProcess.killed ? 'cancelled' : (code === 0 ? 'completed' : 'error'));
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
                                error: terminalProcess.error
                            });
                        }

                        // 检查是否是外部 abortSignal 触发的终止
                        const isExternalAbort = externalAbortSignal?.aborted && terminalProcess.killed;
                        
                        // 被用户杀死的进程也算成功（不显示错误）；
                        // 但超时强杀的进程必须报失败（即使 close 恰以 0 退出码晚于超时回调到达），
                        // 否则模型会把超时误判为执行成功
                        const success = !terminalProcess.timedOut && (code === 0 || terminalProcess.killed === true);
                        
                        // 确定错误信息
                        let error: string | undefined;
                        if (isExternalAbort) {
                            // 外部取消（用户点击中断按钮）
                            error = 'User cancelled the command execution. Please wait for user\'s next instruction.';
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
                            duration
                        });

                        // 简化返回结构：AI 已知 command/cwd/shell，只需返回结果
                        // 如果输出被截断，添加简单提示（含内存护栏丢弃的行数）
                        const totalOutputLines = terminalProcess.output.length + (terminalProcess.omittedOutputLines ?? 0);
                        const wasTruncated = (maxLines !== -1 && totalOutputLines > maxLines) || (terminalProcess.omittedOutputLines ?? 0) > 0;
                        const truncatedNote = wasTruncated
                            ? `(Output truncated: showing last ${lastOutput.length} of ${totalOutputLines} lines)`
                            : undefined;
                        
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
                                truncatedNote
                            },
                            error,
                            // 超时不是取消：killed 与 timedOut 非互斥（超时强杀两标记都置位），
                            // 必须排除 timedOut，否则超时被下游误判为「用户取消」→ 对话被自动暂停
                            cancelled: isExternalAbort || (terminalProcess.killed === true && !terminalProcess.timedOut)
                        });
                    });

                    proc.on('error', (err) => {
                        if (timeoutHandle) {
                            clearTimeout(timeoutHandle);
                        }

                        terminalProcess.endTime = Date.now();
                        terminalProcess.error = err.message;

                        const errMaxLines = getMaxOutputLines();
                        const lastOutput = errMaxLines === -1
                            ? terminalProcess.output
                            : getLastLines(terminalProcess.output, errMaxLines);
                        const duration = terminalProcess.endTime - terminalProcess.startTime;

                        // 从活动进程中移除（身份校验：同 toolId 并发时旧进程的 error
                        // 不能误删新进程的条目）
                        if (activeProcesses.get(terminalId) === terminalProcess) {
                            activeProcesses.delete(terminalId);
                            
                            // 使用 TaskManager 注销任务
                            TaskManager.unregisterTask(terminalId, 'error', {
                                error: err.message,
                                duration,
                                background: effectiveBackground,
                                conversationId: context?.conversationId,
                                command,
                                output: lastOutput.join('\n')
                            });
                        }

                        // 推送错误退出事件
                        emitTerminalOutput({
                            terminalId,
                            type: 'exit',
                            exitCode: -1,
                            killed: false,
                            duration
                        });

                        resolve({
                            success: false,
                            data: {
                                // 前端需要这些用于 UI 显示
                                terminalId,
                                command,
                                cwd: workingDir,
                                shell,
                                output: lastOutput.join('\n')
                            },
                            error: `Failed to execute command: ${err.message} (cwd: ${workingDir})`
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
                                note: 'Command started in background. Do NOT wait or poll; the output will arrive later as a "[Background task completed]" user message. Continue with other work or end your turn.'
                            }
                        });
                    }

                    // 前台模式：注册 detach 回调。
                    // 用户在命令运行期间发送新消息时（webview 调 terminal.detachToBackground），
                    // 把该命令转入后台：工具立即返回、模型先响应用户，进程继续运行，
                    // 完成后结果经 TaskManager 完成事件回流为 [Background task completed] 回执。
                    if (!background) {
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
                                    createdAt: task.startTime
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
                                    note: 'The user sent a new message while this command was still running. The command has been MOVED TO BACKGROUND and keeps running; its final output will arrive later as a "[Background task completed]" user message. Do NOT wait or poll for it. The user\'s new message will be delivered right after this turn — address it now and end your turn promptly.'
                                }
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
                        error: `Failed to start command: ${error instanceof Error ? error.message : String(error)}`
                    });
                }
            });
        }
    };
}

/**
 * 调整终端进程的 CPU 优先级（尽力而为，失败静默）。
 *
 * Windows：用 PowerShell 设置 shell 进程的优先级类（BELOW_NORMAL / NORMAL）。
 * Windows 上子进程在创建时继承父进程的优先级类，因此 cmd/powershell 后续启动的
 * node/jest 等子进程树同样降级——后台跑测试/长任务时让出 CPU 给前台交互，
 * 空闲时仍全速执行。
 * POSIX：process.setPriority（nice 值），子进程同样继承。
 *
 * 注：Node 的 spawn priority 选项在 Windows 上实测不生效，且 @types/node 24 类型
 * 定义缺失，故采用 spawn 后外部设置。spawn→设置的竞态窗口（毫秒级）内启动的
 * 子进程可能继承 normal，可接受。
 */
function setTerminalProcessPriority(pid: number | undefined, background: boolean): void {
    if (!pid) return;
    try {
        if (os.platform() === 'win32') {
            const priorityClass = background ? 'BelowNormal' : 'Normal';
            // 参数通过 argv 传递，不拼进 shell 命令（纵深防御；pid 为 Node 内部数值、
            // priorityClass 为硬编码常量，当前无注入面）
            cp.execFile(
                'powershell.exe',
                ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PriorityClass = '${priorityClass}'`],
                { windowsHide: true, timeout: 5000 },
                () => { /* 失败静默：优先级是软约束 */ }
            );
        } else {
            // POSIX：belowNormal ≈ nice +5，normal = 0
            const setPriority = (process as any).setPriority as ((pid: number, p: number | string) => void) | undefined;
            setPriority?.(pid, background ? 'belowNormal' : 'normal');
        }
    } catch {
        // 忽略：优先级设置失败不影响命令执行
    }
}

/**
 * 以「SIGTERM → 等待 KILL_WAIT_CLOSE_TIMEOUT_MS → SIGKILL 升级」终止进程树。
 *
 * 修改原因：超时/取消路径此前只发一次 SIGTERM——POSIX 上进程树捕获/忽略 SIGTERM 时
 *          'close' 永不触发，execute_command 的 Promise 永不 resolve，模型工具循环挂死。
 * 修改方式：与 killTerminalProcess 的强杀流程共用同一升级逻辑（幂等：进程已退出或
 *          close 已触发时不再重复发信号；SIGKILL 不可捕获、close 必达，等待不永久挂起）。
 * 修改目的：SIGTERM 免疫进程最终被 SIGKILL 强杀，等待方必然收到 close。
 */
function terminateProcessTreeWithEscalation(terminalProcess: TerminalProcess): Promise<void> {
    const proc = terminalProcess.process;
    return new Promise<void>((resolve) => {
        // 进程已结束（close/error 处理器已落定 exitCode）：close 不会再触发，直接返回
        if (proc.exitCode !== null) {
            resolve();
            return;
        }

        let settled = false;
        let forceKillTimer: NodeJS.Timeout | undefined;

        const onClose = (): void => {
            if (settled) return;
            settled = true;
            if (forceKillTimer) clearTimeout(forceKillTimer);
            resolve();
        };

        // 先注册 close 监听再发信号，避免进程在两者之间退出导致漏监听
        proc.once('close', onClose);

        // 注册监听后再检查：进程可能在注册前已退出，close 不会再触发
        if (proc.exitCode !== null) {
            onClose();
            return;
        }

        forceKillTimer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch {
                // 可能已退出，忽略
            }
            // 修改原因：发 SIGKILL 后立即 onClose() 会让等待方在 close 处理器（落定
            //          endTime/exitCode/output）执行前就返回，拿到 stale 结果。
            // 修改方式：SIGKILL 不可捕获、close 必达——发完信号不 resolve，继续等真实
            //          close 让 close 处理器落定终态；本定时器仅负责强杀，若 close
            //          异常迟迟未达（极端情况），由最终兜底定时器 resolve。
            forceKillTimer = setTimeout(() => onClose(), KILL_WAIT_CLOSE_TIMEOUT_MS);
        }, KILL_WAIT_CLOSE_TIMEOUT_MS);

        const pid = proc.pid;
        if (pid) {
            // 使用 tree-kill 终止进程树（Windows: taskkill /F /T；Unix: 递归发信号）
            treeKill(pid, 'SIGTERM', (err) => {
                if (err) {
                    // tree-kill 失败：回退到直接 SIGKILL
                    try {
                        proc.kill('SIGKILL');
                    } catch {
                        // 忽略错误，进程可能已经退出
                    }
                }
            });
        } else {
            // 没有 PID，使用默认方式
            try {
                proc.kill('SIGTERM');
            } catch {
                // 忽略错误，进程可能已经退出
            }
        }
    });
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
export async function killTerminalProcess(terminalId: string): Promise<{
    success: boolean;
    output?: string;
    exitCode?: number;
    error?: string;
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
            error: `Terminal ${terminalId} not found or already exited`
        };
    }

    try {
        // 进程已结束（close/error 处理器已落定 endTime 与 exitCode）：
        // close 事件不会再触发，直接返回最终输出与退出码
        if (terminalProcess.endTime !== undefined || terminalProcess.process.exitCode !== null) {
            return buildKillTerminalResult(terminalProcess);
        }

        // 标记为被终止：close 处理器据此把任务终态判定为 cancelled（而非超时失败）
        terminalProcess.killed = true;

        // 等待进程树真正退出：SIGTERM → 等待 KILL_WAIT_CLOSE_TIMEOUT_MS → SIGKILL 升级
        // （见 terminateProcessTreeWithEscalation：先注册 close 监听再发信号，避免进程在
        // 两者之间退出导致漏监听；SIGKILL 不可捕获、close 必达，等待不会永久挂起）
        await terminateProcessTreeWithEscalation(terminalProcess);

        // close 处理器已把 endTime/exitCode/output 落定并注销任务
        return buildKillTerminalResult(terminalProcess);
    } catch (error) {
        return {
            success: false,
            error: `Failed to kill terminal: ${error instanceof Error ? error.message : String(error)}`
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
    const lastOutput = killMaxLines === -1
        ? terminalProcess.output
        : getLastLines(terminalProcess.output, killMaxLines);

    return {
        success: true,
        output: lastOutput.join('\n'),
        exitCode: terminalProcess.exitCode
    };
}

/**
 * 通过 TaskManager 取消终端任务
 * 这是统一的取消接口
 */
export async function cancelTerminalTask(terminalId: string): Promise<{
    success: boolean;
    error?: string;
}> {
    // 先尝试杀掉进程（等待 close，输出/exitCode 落定后返回）
    const killResult = await killTerminalProcess(terminalId);
    if (killResult.success) {
        return { success: true };
    }

    // 如果进程不存在，尝试通过 TaskManager 取消
    return TaskManager.cancelTask(terminalId);
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
export function detachRunningTerminalsToBackground(conversationId?: string): { detached: string[] } {
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
export function getTerminalOutput(terminalId: string): {
    success: boolean;
    output?: string;
    running?: boolean;
    error?: string;
} {
    const terminalProcess = activeProcesses.get(terminalId);
    
    if (!terminalProcess) {
        return {
            success: false,
            error: `Terminal ${terminalId} not found`
        };
    }

    const outputMaxLines = getMaxOutputLines();
    const lastOutput = outputMaxLines === -1
        ? terminalProcess.output
        : getLastLines(terminalProcess.output, outputMaxLines);
    
    return {
        success: true,
        output: lastOutput.join('\n'),
        running: terminalProcess.endTime === undefined
    };
}

/**
 * 获取所有活动终端
 */
export function getActiveTerminalProcesses(): Array<{
    id: string;
    command: string;
    cwd: string;
    shell: ShellType;
    running: boolean;
    startTime: number;
}> {
    const result: Array<{id: string; command: string; cwd: string; shell: ShellType; running: boolean; startTime: number}> = [];
    for (const [id, proc] of (activeProcesses as Map<string, TerminalProcess>)) {
        result.push({
            id,
            command: proc.command,
            cwd: proc.cwd,
            shell: proc.shell,
            running: proc.endTime === undefined,
            startTime: proc.startTime
        });
    }
    return result;
}

/**
 * 清理已完成的终端进程
 */
export function cleanupTerminals(): void {
    for (const [id, proc] of (activeProcesses as Map<string, TerminalProcess>)) {
        if (proc.endTime !== undefined) {
            activeProcesses.delete(id);
        }
    }
}

/**
 * 注册执行命令工具
 */
export function registerExecuteCommand(): Tool {
    return createExecuteCommandTool();
}

/**
 * 导出活动终端 Map（用于其他模块）
 */
export function getActiveTerminals(): Map<string, TerminalProcess> {
    return activeProcesses;
}