/**
 * GrayCode MCP 模块 - Stdio 客户端
 * 
 * 通过 stdin/stdout 与 MCP 服务器通信
 */

import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { collectMcpList, createServerRequestReply, isJsonRpcResponse } from './protocol';
import type { McpRawToolResult } from './types';
import { createGrayCodeMcpClientInfo } from '../../core/productMetadata';

// cross-spawn keeps argv boundaries on Windows while resolving PATHEXT commands
// such as npx.cmd/npm.cmd. For .cmd/.bat launchers it invokes cmd.exe with each
// argument escaped; regular .exe commands are spawned directly without a shell.
const crossSpawn = require('cross-spawn') as typeof cp.spawn;

// tree-kill 库，用于跨平台终止进程树
// eslint-disable-next-line @typescript-eslint/no-var-requires
const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (error?: Error) => void) => void;

/**
 * JSON-RPC 请求
 */
interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: any;
}

/**
 * JSON-RPC 响应
 */
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

/**
 * MCP 初始化响应
 */
interface InitializeResult {
    protocolVersion: string;
    serverInfo: {
        name: string;
        version: string;
    };
    capabilities: {
        tools?: { listChanged?: boolean };
        resources?: { listChanged?: boolean };
        prompts?: { listChanged?: boolean };
    };
}

/**
 * MCP 工具定义
 */
interface McpTool {
    name: string;
    description?: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, any>;
        required?: string[];
    };
}

/**
 * MCP 资源定义
 */
interface McpResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

/**
 * MCP 提示模板定义
 */
interface McpPrompt {
    name: string;
    description?: string;
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
}

/**
 * Stdio MCP 客户端
 */
export class StdioMcpClient extends EventEmitter {
    private process: cp.ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests: Map<number | string, {
        resolve: (result: any) => void;
        reject: (error: Error) => void;
    }> = new Map();
    private buffer = '';

    // 进程事件处理器引用（cleanup 时按引用精确移除，不影响 disconnect 等外部注册的 once 监听）
    private processErrorHandler?: (err: Error) => void;
    private processExitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
    private stdoutDataHandler?: (data: string) => void;
    private stderrDataHandler?: (data: string) => void;

    // 服务器能力和信息
    private serverInfo?: { name: string; version: string };
    private protocolVersion?: string;
    private capabilities?: InitializeResult['capabilities'];

    // 缓存的工具、资源、提示
    private tools: McpTool[] = [];
    private resources: McpResource[] = [];
    private prompts: McpPrompt[] = [];

    // 能力列表（tools/resources/prompts）拉取是否失败过（失败被吞，列表保持空）。
    // 供上层区分「服务器真的没有工具」与「拉取失败导致列表为空」。
    private listFetchFailed: boolean = false;

    // stderr 输出（用于错误诊断）
    private stderrOutput: string = '';

    // stderr 缓存上限（64KB），超出后截断并标记，防止输出冗长的服务器导致内存无限增长
    private static readonly MAX_STDERR = 64 * 1024;
    private stderrTruncated: boolean = false;

    // stdout 缓冲硬上限（16MB）：服务器不输出换行或单条消息超大时，缓冲无上限增长会 OOM；
    // 超过后记录错误并关闭/重置连接（见 handleData）
    private static readonly MAX_BUFFER = 16 * 1024 * 1024;

    // 单条出站消息上限（4MB）：超过则拒绝发送，避免超大负载写入 stdin 造成背压/内存压力
    private static readonly MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

    // 请求超时（毫秒）
    private timeout: number;

    constructor(
        private command: string,
        private args: string[] = [],
        private env?: Record<string, string>,
        private cwd?: string,
        timeout?: number
    ) {
        super();
        this.timeout = timeout ?? 30000;
    }
    
    /**
     * 启动服务器进程并初始化
     */
    async connect(): Promise<void> {
        // 重入保护：同一实例并发 connect 时第二次 spawn 会覆盖 this.process 并重新
        // 注册处理器，第一个子进程失去引用（既不被 kill、stdout 也无人消费），造成
        // 进程与管道泄漏。必须先 disconnect()（其 cleanup 置 process=null）才能重连。
        if (this.process) {
            throw new Error('Already connected or connecting. Call disconnect() before reconnecting.');
        }
        // 启动子进程
        const processEnv = {
            ...process.env,
            ...this.env
        };
        
        // 收集 stderr 输出用于错误诊断
        this.stderrOutput = '';
        this.stderrTruncated = false;
        // 新连接尝试：重置列表拉取失败标记，旧连接的失败不得污染本次连接判定
        this.listFetchFailed = false;
        
        this.process = crossSpawn(this.command, this.args, {
            env: processEnv,
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Never concatenate untrusted argv into a generic shell command.
            // cross-spawn performs the narrowly-scoped .cmd/.bat adaptation on
            // Windows and otherwise delegates to child_process.spawn directly.
            shell: false,
            windowsHide: true
        });

        // 设置 UTF-8 编码，避免逐 chunk .toString() 截断多字节字符
        this.process.stdout?.setEncoding('utf8');
        this.process.stderr?.setEncoding('utf8');

        // 设置错误处理
        // spawn 失败（如命令不存在）只触发 'error' 不触发 'exit'，必须立即清理并拒绝所有 pending 请求，
        // 否则 connect 会一直挂到超时
        // 处理器引用保存在字段中：cleanup() 时按引用精确移除，不影响 disconnect 等外部注册的 once 监听
        this.processErrorHandler = (err) => {
            this.emit('error', err);
            this.cleanup(`Process error: ${err.message}`);
        };
        this.process.on('error', this.processErrorHandler);

        this.processExitHandler = (code, signal) => {
            this.emit('exit', code, signal);
            this.cleanup();
        };
        this.process.on('exit', this.processExitHandler);

        // 为 stdin/stdout/stderr 流补 'error' 监听，避免对已死进程写入/读取时产生未处理的 'error' 事件
        this.process.stdin?.on('error', () => {});
        this.process.stdout?.on('error', () => {});
        this.process.stderr?.on('error', () => {});

        // 收集 stderr (已 setEncoding，data 为 string)，带 64KB 上限防止内存无限增长
        this.stderrDataHandler = (data: string) => {
            this.appendStderr(data);
        };
        this.process.stderr?.on('data', this.stderrDataHandler);

        // 读取 stdout (已 setEncoding，data 为 string)
        this.stdoutDataHandler = (data: string) => {
            this.handleData(data);
        };
        this.process.stdout?.on('data', this.stdoutDataHandler);
        
        try {
            // 发送初始化请求（带超时和进程退出检测）
            const initResult = await this.sendRequest<InitializeResult>('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: createGrayCodeMcpClientInfo()
            });
            
            this.serverInfo = initResult.serverInfo;
            this.protocolVersion = initResult.protocolVersion;
            this.capabilities = initResult.capabilities;
            
            // 发送 initialized 通知
            this.sendNotification('notifications/initialized', {});
            
            // 获取工具列表（如果支持）
            if (this.capabilities?.tools) {
                try {
                    this.tools = await collectMcpList<McpTool>(params => this.sendRequest('tools/list', params), 'tools');
                } catch {
                    this.listFetchFailed = true; // tools/list 失败被吞：标记供上层判定连接质量
                }
            }
            
            // 获取资源列表（如果支持）
            if (this.capabilities?.resources) {
                try {
                    this.resources = await collectMcpList<McpResource>(params => this.sendRequest('resources/list', params), 'resources');
                } catch {
                    this.listFetchFailed = true;
                }
            }
            
            // 获取提示列表（如果支持）
            if (this.capabilities?.prompts) {
                try {
                    this.prompts = await collectMcpList<McpPrompt>(params => this.sendRequest('prompts/list', params), 'prompts');
                } catch {
                    this.listFetchFailed = true;
                }
            }
        } catch (error) {
            // 初始化失败（如 initialize 超时/进程退出）：进程可能仍在运行，
            // 复用 disconnect 的 SIGTERM→SIGKILL→等待流程终止进程树——
            // 单次 SIGTERM 未生效时可能残留子进程（M5）；cleanup 幂等，进程已死时无害。
            await this.disconnect().catch(() => { /* 进程已死/已清理则忽略 */ });
            this.cleanup(`Connect failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    
    /**
     * 断开连接
     *
     * 使用 tree-kill 终止整个进程树（Windows 上避免只杀 cmd.exe 而漏掉真正服务进程），
     * 并等待进程退出后再清理资源。
     */
    async disconnect(): Promise<void> {
        if (this.process && this.process.pid) {
            const pid = this.process.pid;
            // 进程已退出（exit 事件可能已错过）：无需再杀，直接清理
            if (this.process.exitCode !== null || this.process.signalCode !== null) {
                this.cleanup();
                return;
            }
            const proc = this.process;
            let resolveExited!: () => void;
            const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
            const onExitOnce = () => resolveExited();
            proc.once('exit', onExitOnce);
            // 可取消的等待定时器：race 由 exited 先行结束时必须取消 5s 兜底定时器——
            // 残留定时器会持有闭包并让事件循环空转至超时，快速退出路径上多次
            // disconnect 后逐个堆积（disconnect wait 定时器残留）。
            let waitTimer: ReturnType<typeof setTimeout> | null = null;
            const wait = (ms: number): Promise<void> => new Promise(resolve => {
                waitTimer = setTimeout(resolve, ms);
            });
            treeKill(pid, 'SIGTERM', (err?: Error) => {
                if (err) {
                    try { treeKill(pid, 'SIGKILL', () => {}); } catch {}
                }
            });
            await Promise.race([exited, wait(5000)]);
            if (waitTimer) clearTimeout(waitTimer);
            // 超时路径：进程未在 5s 内退出，once('exit') 尚未触发——显式移除，避免监听泄漏
            //（进程随后退出时该监听已无意义；若进程已退出，once 已自移除，removeListener 为无害空操作）
            proc.removeListener('exit', onExitOnce);
            const processAfterSigterm = this.process;
            if (processAfterSigterm && processAfterSigterm.exitCode === null && processAfterSigterm.signalCode === null) {
                // SIGTERM 未生效：SIGKILL 强制终止并再等待退出，仍超时则告警
                await new Promise<void>((resolve) => {
                    const activeProcess = this.process;
                    if (!activeProcess) {
                        resolve();
                        return;
                    }
                    let timer: ReturnType<typeof setTimeout>;
                    let settled = false;
                    const settle = () => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };
                    const onKillExit = () => {
                        clearTimeout(timer);
                        settle();
                    };
                    timer = setTimeout(() => {
                        // 超时路径：进程仍未退出，移除未触发的 once('exit') 监听，避免泄漏
                        activeProcess.removeListener('exit', onKillExit);
                        settle();
                    }, 5000);
                    try { treeKill(pid, 'SIGKILL', () => {}); } catch {}
                    activeProcess.once('exit', onKillExit);
                });
                const processAfterSigkill = this.process;
                if (processAfterSigkill && processAfterSigkill.exitCode === null && processAfterSigkill.signalCode === null) {
                    console.warn(`[MCP] stdio process ${pid} did not exit after SIGKILL`);
                }
            }
            this.cleanup();
        } else {
            this.cleanup();
        }
    }
    
    /**
     * 获取工具列表
     */
    getTools(): McpTool[] {
        return this.tools;
    }
    
    /**
     * 获取资源列表
     */
    getResources(): McpResource[] {
        return this.resources;
    }
    
    /**
     * 获取提示列表
     */
    getPrompts(): McpPrompt[] {
        return this.prompts;
    }

    /**
     * 能力列表（tools/resources/prompts）拉取是否失败过。
     * 拉取失败被吞且列表保持空——上层据此区分「服务器真无工具」与「拉取失败」，
     * 避免把失败误报为正常空列表（假 connected）。
     */
    isListFetchFailed(): boolean {
        return this.listFetchFailed;
    }
    
    /**
     * 刷新工具/资源/提示列表缓存
     *
     * 服务器通过 notifications/tools|resources|prompts/list_changed 通知列表变化时调用，
     * 重新请求列表并覆盖本地缓存。逐项独立 try/catch：单项失败不影响其他列表，
     * 失败项保留旧缓存。
     */
    async refreshLists(): Promise<void> {
        if (!this.process || !this.process.stdin) {
            throw new Error('Process not started');
        }
        
        let anyFailed = false;
        
        // 刷新工具列表（如果支持）
        if (this.capabilities?.tools) {
            try {
                this.tools = await collectMcpList<McpTool>(params => this.sendRequest('tools/list', params), 'tools');
            } catch (error) {
                anyFailed = true;
                console.error('[MCP] Failed to refresh tools list:', error);
            }
        }
        
        // 刷新资源列表（如果支持）
        if (this.capabilities?.resources) {
            try {
                this.resources = await collectMcpList<McpResource>(params => this.sendRequest('resources/list', params), 'resources');
            } catch (error) {
                anyFailed = true;
                console.error('[MCP] Failed to refresh resources list:', error);
            }
        }
        
        // 刷新提示列表（如果支持）
        if (this.capabilities?.prompts) {
            try {
                this.prompts = await collectMcpList<McpPrompt>(params => this.sendRequest('prompts/list', params), 'prompts');
            } catch (error) {
                anyFailed = true;
                console.error('[MCP] Failed to refresh prompts list:', error);
            }
        }
        
        // 全部成功：复位拉取失败标记（连接期间/上次刷新留下的失败标记不得永久滞留）
        if (!anyFailed) {
            this.listFetchFailed = false;
        }
    }
    
    /**
     * 获取服务器信息
     */
    getServerInfo(): { name: string; version: string } | undefined {
        return this.serverInfo;
    }
    
    /**
     * 获取协议版本
     */
    getProtocolVersion(): string | undefined {
        return this.protocolVersion;
    }
    
    /**
     * 调用工具
     *
     * @param signal 外部取消信号（可选）；中止时拒绝 pending 并清理监听
     */
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpRawToolResult> {
        return await this.sendRequest('tools/call', {
            name,
            arguments: args
        }, undefined, signal);
    }
    
    /**
     * 读取资源
     *
     * @param signal 外部取消信号（可选）
     */
    async readResource(uri: string, signal?: AbortSignal): Promise<{
        contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
    }> {
        return await this.sendRequest('resources/read', { uri }, undefined, signal);
    }
    
    /**
     * 获取提示
     *
     * @param signal 外部取消信号（可选）
     */
    async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<{
        messages: Array<{ role: string; content: { type: string; text?: string } }>;
    }> {
        return await this.sendRequest('prompts/get', { name, arguments: args }, undefined, signal);
    }
    
    /**
     * 发送 JSON-RPC 请求（带超时、进程退出检测与外部取消）
     *
     * 外部取消信号：
     * - 已中止的信号在进入时立即拒绝（不写 stdin）
     * - 请求期间外部 abort：清 timeout、摘 exit 监听、删 pendingRequests，以明确文案拒绝
     * - resolve/reject 闭包摘除 abort listener；resolved 守卫防止重复 settle
     */
    private sendRequest<T>(method: string, params?: any, timeout?: number, signal?: AbortSignal): Promise<T> {
        const effectiveTimeout = timeout ?? this.timeout;
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin || this.process.exitCode !== null || this.process.signalCode !== null) {
                reject(new Error(`Process not started${this.getStderrInfo()}`));
                return;
            }

            // 外部信号已中止：不写 stdin，立即拒绝
            if (signal?.aborted) {
                reject(new Error('MCP tool call aborted'));
                return;
            }
            
            const id = ++this.requestId;
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            const message = JSON.stringify(request) + '\n';
            // 单条消息过大时拒绝发送（背压保护）：避免超大负载写入 stdin 造成背压/内存压力
            if (message.length > StdioMcpClient.MAX_MESSAGE_SIZE) {
                reject(new Error(`MCP request "${method}" exceeds max message size (${StdioMcpClient.MAX_MESSAGE_SIZE} bytes)`));
                return;
            }
            
            let resolved = false;

            // 统一清理：清超时、摘 exit 监听、摘外部 abort 监听
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            // M6：捕获请求发起时的进程引用——客户端级 cleanup 先置 this.process=null
            // 再 reject pending，届时 this.process?.removeListener 拿不到引用、监听残留
            // 至进程对象 GC；按发起时引用精确移除才能兑现「每请求监听精确摘除」承诺。
            const proc = this.process;
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                proc?.removeListener('exit', onExit);
                signal?.removeEventListener('abort', onAbort);
            };
            
            // 超时处理；timeout<=0 = 无超时（与 HttpMcpClient 同语义）：不调度超时定时器，
            // 请求完全依赖进程退出检测/外部取消/disconnect 兜底（setTimeout(0) 会立即触发，
            // 与「无超时」语义冲突）。
            if (effectiveTimeout > 0) {
                timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        this.pendingRequests.delete(id);
                        reject(new Error(`Request "${method}" timeout (${effectiveTimeout / 1000}s)${this.getStderrInfo()}`));
                    }
                }, effectiveTimeout);
            }
            
            // 进程退出检测
            const onExit = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    this.pendingRequests.delete(id);
                    reject(new Error(`Process exited while waiting for "${method}" response${this.getStderrInfo()}`));
                }
            };
            
            // 外部中止：拒绝 pending（清 timeout、exit 监听、删 pendingRequests）
            const onAbort = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    this.pendingRequests.delete(id);
                    reject(new Error('MCP tool call aborted'));
                }
            };

            this.process.once('exit', onExit);
            signal?.addEventListener('abort', onAbort);
            
            this.pendingRequests.set(id, {
                resolve: (result) => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        resolve(result);
                    }
                },
                reject: (error) => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        reject(error);
                    }
                }
            });
            
            // 背压说明：write 返回 false 仅表示管道缓冲已满，不抛错也不阻塞；
            // 这里不等待 drain（保持请求语义简单），由超时与进程退出检测兜底；
            // 如需严格背压可改为 await 一次 drain 事件后再 resolve
            try {
                this.process.stdin.write(message);
            } catch (error) {
                // 流已销毁/关闭导致同步抛错（例如进程刚退出），立即拒绝请求
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    this.pendingRequests.delete(id);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
    }
    
    /** 直接向 stdin 写入一条 JSON-RPC 消息（带换行）；进程已退出时忽略 */
    private writeRaw(payload: object): void {
        if (!this.process || !this.process.stdin) return;
        try {
            this.process.stdin.write(JSON.stringify(payload) + '\n');
        } catch {
            // 进程刚退出，忽略
        }
    }

    /**
     * 发送 JSON-RPC 通知（无需响应）
     */
    private sendNotification(method: string, params?: any): void {
        if (!this.process || !this.process.stdin) {
            return;
        }
        
        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };
        
        const message = JSON.stringify(notification) + '\n';
        // 单条消息过大时拒绝发送（与 sendRequest 同口径的背压保护），并记录错误
        if (message.length > StdioMcpClient.MAX_MESSAGE_SIZE) {
            console.error(`[MCP] notification "${method}" exceeds max message size (${StdioMcpClient.MAX_MESSAGE_SIZE} bytes), dropped`);
            return;
        }
        // 背压说明：write 返回 false 仅表示管道缓冲已满，不抛错也不阻塞；通知无响应，不等待 drain
        try {
            this.process.stdin.write(message);
        } catch (error) {
            // 进程刚死（EPIPE/closed stdin）时 write 会同步抛错；通知路径无响应可吞，
            // 但必须吞住——否则会冒泡进 connect() 流程，让初始化在成功后失败。
            console.warn(`[MCP] failed to send notification "${method}":`, error instanceof Error ? error.message : String(error));
        }
    }
    
    /**
     * 处理收到的数据
     */
    private handleData(data: string): void {
        this.buffer += data;

        // 缓冲硬上限：服务器不输出换行或单条消息超大时，防止缓冲无上限增长（OOM）
        if (this.buffer.length > StdioMcpClient.MAX_BUFFER) {
            console.error(`[MCP] stdout buffer exceeded ${StdioMcpClient.MAX_BUFFER} bytes; killing process and closing connection`);
            // 与 disconnect() 相同的进程树终止路径；handleData 是同步事件回调无法 await，
            // 直接 kill + 同步清理（cleanup 会拒绝全部 pending 请求并清空缓冲），
            // 随后的 exit 事件会再次调用 cleanup，幂等无害。
            // 必须传 callback：tree-kill 无 callback 时出错会异步 throw（uncaughtException）。
            if (this.process && this.process.pid) {
                // 显式广播 exit：cleanup() 会先移除 processExitHandler（唯一 emit 'exit' 的地方），
                // 而 kill 是异步的——进程真正退出时已无人监听，上层（McpManager）将永远收不到
                // exit 通知、状态停留在 connected。此处模拟进程被 SIGTERM 杀死的退出事件。
                this.emit('exit', null, 'SIGTERM');
                try { treeKill(this.process.pid, 'SIGTERM', () => {}); } catch { /* ignore */ }
            }
            this.cleanup('Stdout buffer exceeded limit');
            return;
        }
        
        // 处理每一行（JSON-RPC 消息以换行符分隔）
        let newlineIndex: number;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);
            
            if (!line) continue;
            
            try {
                const message = JSON.parse(line);
                this.handleMessage(message);
            } catch {
                // 忽略解析错误
            }
        }
    }
    
    /**
     * 处理 JSON-RPC 消息
     */
    private handleMessage(message: unknown): void {
        // Server request IDs are independent of our outbound request IDs.
        const reply = createServerRequestReply(message);
        if (reply) {
            this.writeRaw(reply);
            return;
        }
        if (isJsonRpcResponse(message)) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }
        if (message && typeof message === 'object') {
            const notification = message as Record<string, unknown>;
            if (notification.jsonrpc === '2.0' && notification.id === undefined && typeof notification.method === 'string') {
                this.emit('notification', notification.method, notification.params);
            }
        }
    }

    /**
     * 附加 stderr 输出（带 64KB 上限，超出截断并标记）
     */
    private appendStderr(data: string): void {
        if (this.stderrOutput.length >= StdioMcpClient.MAX_STDERR) {
            this.stderrTruncated = true;
            return;
        }
        this.stderrOutput += data;
        if (this.stderrOutput.length > StdioMcpClient.MAX_STDERR) {
            this.stderrOutput = this.stderrOutput.slice(0, StdioMcpClient.MAX_STDERR);
            this.stderrTruncated = true;
        }
    }

    /**
     * 获取 stderr 诊断信息（含截断标记）
     */
    private getStderrInfo(): string {
        if (!this.stderrOutput) {
            return '';
        }
        const truncated = this.stderrTruncated ? '\n[stderr truncated]' : '';
        return `\nStderr: ${this.stderrOutput.trim()}${truncated}`;
    }

    /**
     * 清理资源
     *
     * @param errorMessage 可选的自定义错误信息（如 spawn 失败），用于拒绝 pending 请求
     */
    private cleanup(errorMessage?: string): void {
        // 移除本客户端注册的进程/流监听并 end stdin：进程对象弃用后，迟到的
        // exit/error/data 事件不得再触发回调（否则已清理的 client 会再次 emit
        // exit/error 影响上层状态）。按引用精确移除，保留 disconnect() 等外部
        // 注册的 once('exit') 等待监听，避免断开流程失去退出通知而空等超时。
        const proc = this.process;
        if (proc) {
            if (this.processErrorHandler) proc.removeListener('error', this.processErrorHandler);
            if (this.processExitHandler) proc.removeListener('exit', this.processExitHandler);
            if (this.stdoutDataHandler) proc.stdout?.removeListener('data', this.stdoutDataHandler);
            if (this.stderrDataHandler) proc.stderr?.removeListener('data', this.stderrDataHandler);
            // 兜底：进程再 emit 'error' 时若无任何监听会触发未处理异常，补一个空监听吞掉
            if (proc.listenerCount('error') === 0) {
                proc.on('error', () => {});
            }
            try {
                proc.stdin?.end();
            } catch {
                // stdin 已销毁/关闭，忽略
            }
        }
        this.process = null;
        this.buffer = '';
        
        // 拒绝所有等待中的请求（包含 stderr 信息）
        const errorInfo = this.getStderrInfo();
        const message = errorMessage ? `${errorMessage}${errorInfo}` : `Connection closed${errorInfo}`;
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error(message));
        }
        this.pendingRequests.clear();
        
        this.tools = [];
        this.resources = [];
        this.prompts = [];
        this.stderrOutput = '';
        this.stderrTruncated = false;
    }
}

