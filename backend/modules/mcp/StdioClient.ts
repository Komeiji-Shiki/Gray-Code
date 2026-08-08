/**
 * LimCode MCP 模块 - Stdio 客户端
 * 
 * 通过 stdin/stdout 与 MCP 服务器通信
 */

import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { createGrayCodeMcpClientInfo } from '../../core/productMetadata';

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
    private processExited = false;
    private requestId = 0;
    private pendingRequests: Map<number | string, {
        resolve: (result: any) => void;
        reject: (error: Error) => void;
    }> = new Map();
    private buffer = '';

    // 服务器能力和信息
    private serverInfo?: { name: string; version: string };
    private protocolVersion?: string;
    private capabilities?: InitializeResult['capabilities'];

    // 缓存的工具、资源、提示
    private tools: McpTool[] = [];
    private resources: McpResource[] = [];
    private prompts: McpPrompt[] = [];

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
        // 启动子进程
        const processEnv = {
            ...process.env,
            ...this.env
        };
        
        // 收集 stderr 输出用于错误诊断
        this.stderrOutput = '';
        this.stderrTruncated = false;
        
        this.process = cp.spawn(this.command, this.args, {
            env: processEnv,
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            // 不用 shell 包装：命令与参数直通子进程，避免 cmd.exe 对含
            // & | 引号等字符的参数做二次解释（命令注入面）。含空格的
            // 可执行文件路径由调用方自行拼接为单个 command 字符串处理。
            shell: false
        });
        this.processExited = false;

        // 设置 UTF-8 编码，避免逐 chunk .toString() 截断多字节字符
        this.process.stdout?.setEncoding('utf8');
        this.process.stderr?.setEncoding('utf8');

        // stdin 写入错误监听：进程退出与 write() 之间的竞态窗口内
        // write() 会异步触发 EPIPE/ERR_STREAM_DESTROYED，无监听器时
        // Node 会抛未捕获异常导致扩展宿主崩溃（H2）
        this.process.stdin?.on('error', (err: NodeJS.ErrnoException) => {
            // 进程退出/销毁流导致的写入失败是正常竞态，静默吞掉；
            // 仅当进程仍存活时上报（此时写入失败意味着真正的管道故障）
            if (!this.processExited) {
                this.emit('error', err);
            }
        });

        // 设置错误处理
        // spawn 失败（如命令不存在）只触发 'error' 不触发 'exit'，必须立即清理并拒绝所有 pending 请求，
        // 否则 connect 会一直挂到超时
        this.process.on('error', (err) => {
            this.emit('error', err);
            // spawn 失败（ENOENT 等）时不会触发 'exit'，pending 请求会一直挂到超时；
            // 必须在这里立即清理并拒绝，让 connect() 尽快失败
            this.cleanup(`Process error: ${err.message}`);
        });

        this.process.on('exit', (code, signal) => {
            this.processExited = true;
            this.emit('exit', code, signal);
            this.cleanup();
        });

        // 为 stdout/stderr 流补 'error' 监听，避免对已死进程读取时产生未处理的 'error' 事件
        // （stdin 的 'error' 监听已在上面注册：进程存活时上报、退出竞态窗口内静默吞掉）
        this.process.stdout?.on('error', () => {});
        this.process.stderr?.on('error', () => {});

        // 收集 stderr (已 setEncoding，data 为 string)，带 64KB 上限防止内存无限增长
        this.process.stderr?.on('data', (data: string) => {
            this.appendStderr(data);
        });

        // 读取 stdout (已 setEncoding，data 为 string)
        this.process.stdout?.on('data', (data: string) => {
            this.handleData(data);
        });
        
        // 发送初始化请求（带超时和进程退出检测）
        const initResult = await this.sendRequest<InitializeResult>('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {
                roots: { listChanged: true }
            },
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
                const toolsResult = await this.sendRequest<{ tools: McpTool[] }>('tools/list', {});
                this.tools = toolsResult.tools || [];
            } catch {
                // 忽略获取工具失败
            }
        }
        
        // 获取资源列表（如果支持）
        if (this.capabilities?.resources) {
            try {
                const resourcesResult = await this.sendRequest<{ resources: McpResource[] }>('resources/list', {});
                this.resources = resourcesResult.resources || [];
            } catch {
                // 忽略获取资源失败
            }
        }
        
        // 获取提示列表（如果支持）
        if (this.capabilities?.prompts) {
            try {
                const promptsResult = await this.sendRequest<{ prompts: McpPrompt[] }>('prompts/list', {});
                this.prompts = promptsResult.prompts || [];
            } catch {
                // 忽略获取提示失败
            }
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
            // 进程已退出（exitCode/signalCode 已置位）：exit 事件不会再触发，
            // 直接清理返回，避免僵尸进程场景下空等 10s 兜底
            if (this.process.exitCode !== null || this.process.signalCode !== null) {
                this.cleanup();
                return;
            }
            const pid = this.process.pid;
            let timeoutHandle: NodeJS.Timeout | undefined;
            // treeKill 回调报错（进程不存在）时立即 resolve，不等兜底
            let treeKillFailed = false;
            const treeKillError = new Promise<void>((resolve) => {
                treeKill(pid, 'SIGTERM', (err?: Error) => {
                    if (err) {
                        treeKillFailed = true;
                        if (timeoutHandle) {
                            clearTimeout(timeoutHandle);
                        }
                        try { treeKill(pid, 'SIGKILL'); } catch {}
                        resolve();
                    }
                });
            });
            const exitOrTimeout = Promise.race([
                new Promise<void>((resolve) => {
                    this.process!.once('exit', () => {
                        // 进程先退出时清除兜底定时器，避免 MCP 频繁重启时悬空 handle 累积
                        if (timeoutHandle) {
                            clearTimeout(timeoutHandle);
                        }
                        resolve();
                    });
                }),
                treeKillError,
                new Promise<void>((resolve) => {
                    // treeKill 已报错时不再武装兜底定时器
                    if (treeKillFailed) {
                        resolve();
                        return;
                    }
                    timeoutHandle = setTimeout(resolve, 5000);
                })
            ]);
            await exitOrTimeout;
            // SIGTERM 未生效：SIGKILL 强制终止并再等待退出，仍超时则告警（上游 cddf515 分级升级）
            const processAfterSigterm = this.process;
            if (processAfterSigterm && processAfterSigterm.exitCode === null && processAfterSigterm.signalCode === null) {
                await new Promise<void>((resolve) => {
                    try { treeKill(pid, 'SIGKILL'); } catch {}
                    const timer = setTimeout(resolve, 5000);
                    const activeProcess = this.process;
                    if (!activeProcess) {
                        clearTimeout(timer);
                        resolve();
                        return;
                    }
                    activeProcess.once('exit', () => { clearTimeout(timer); resolve(); });
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
        
        // 刷新工具列表（如果支持）
        if (this.capabilities?.tools) {
            try {
                const toolsResult = await this.sendRequest<{ tools: McpTool[] }>('tools/list', {});
                this.tools = toolsResult.tools || [];
            } catch (error) {
                console.error('[MCP] Failed to refresh tools list:', error);
            }
        }
        
        // 刷新资源列表（如果支持）
        if (this.capabilities?.resources) {
            try {
                const resourcesResult = await this.sendRequest<{ resources: McpResource[] }>('resources/list', {});
                this.resources = resourcesResult.resources || [];
            } catch (error) {
                console.error('[MCP] Failed to refresh resources list:', error);
            }
        }
        
        // 刷新提示列表（如果支持）
        if (this.capabilities?.prompts) {
            try {
                const promptsResult = await this.sendRequest<{ prompts: McpPrompt[] }>('prompts/list', {});
                this.prompts = promptsResult.prompts || [];
            } catch (error) {
                console.error('[MCP] Failed to refresh prompts list:', error);
            }
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
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
    }> {
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
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                this.process?.removeListener('exit', onExit);
                signal?.removeEventListener('abort', onAbort);
            };
            
            // 超时处理
            timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request "${method}" timeout (${effectiveTimeout / 1000}s)${this.getStderrInfo()}`));
                }
            }, effectiveTimeout);
            
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
                if (this.processExited || this.process.stdin.destroyed) {
                    const errorInfo = this.stderrOutput ? `\nStderr: ${this.stderrOutput.trim()}` : '';
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        this.pendingRequests.delete(id);
                        reject(new Error(`Process not running${errorInfo}`));
                    }
                    return;
                }
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
    private writeRaw(payload: Record<string, unknown>): void {
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
        try {
            if (this.processExited || this.process.stdin.destroyed) {
                return;
            }
            // 单条消息过大时拒绝发送（与 sendRequest 同口径的背压保护），并记录错误
            if (message.length > StdioMcpClient.MAX_MESSAGE_SIZE) {
                console.error(`[MCP] notification "${method}" exceeds max message size (${StdioMcpClient.MAX_MESSAGE_SIZE} bytes), dropped`);
                return;
            }
            // 背压说明：write 返回 false 仅表示管道缓冲已满，不抛错也不阻塞；通知无响应，不等待 drain
            this.process.stdin.write(message);
        } catch {
            // 进程退出竞态窗口内的写入失败静默忽略
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
            // 随后的 exit 事件会再次调用 cleanup，幂等无害
            if (this.process && this.process.pid) {
                try { treeKill(this.process.pid, 'SIGTERM'); } catch { /* ignore */ }
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
    private handleMessage(message: JsonRpcResponse | any): void {
        // 检查是响应还是通知
        if ('id' in message && message.id !== null) {
            // 这是响应
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                
                if (message.error) {
                    pending.reject(new Error(message.error.message));
                } else {
                    pending.resolve(message.result);
                }
            }
        } else if ('method' in message) {
            // 服务器发来的 JSON-RPC 请求（带 id）：客户端不支持服务器发起的请求，
            // 回 method-not-found 错误，避免服务器等待响应而挂起
            if (message.id !== undefined && message.id !== null) {
                this.writeRaw({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32601, message: `Method not found: ${String(message.method)}` }
                });
                return;
            }
            // 无 id 的通知：按 method 派发
            this.emit('notification', message.method, message.params);
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
        this.process = null;
        this.processExited = true;
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