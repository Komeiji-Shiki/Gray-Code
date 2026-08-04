/**
 * LimCode MCP 模块 - Stdio 客户端
 * 
 * 通过 stdin/stdout 与 MCP 服务器通信
 */

import * as cp from 'child_process';
import { EventEmitter } from 'events';

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

        // 为 stdin/stdout/stderr 流补 'error' 监听，避免对已死进程写入/读取时产生未处理的 'error' 事件
        this.process.stdin?.on('error', () => {});
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
            clientInfo: {
                name: 'GrayCode',
                version: '1.0.5'
            }
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
            const pid = this.process.pid;
            const exitOrTimeout = Promise.race([
                new Promise<void>((resolve) => {
                    this.process!.once('exit', () => resolve());
                }),
                new Promise<void>((resolve) => {
                    setTimeout(resolve, 10000);
                })
            ]);
            treeKill(pid, 'SIGTERM', (err?: Error) => {
                if (err) {
                    try { treeKill(pid, 'SIGKILL'); } catch {}
                }
            });
            await exitOrTimeout;
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
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<{
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
    }> {
        return await this.sendRequest('tools/call', {
            name,
            arguments: args
        });
    }
    
    /**
     * 读取资源
     */
    async readResource(uri: string): Promise<{
        contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
    }> {
        return await this.sendRequest('resources/read', { uri });
    }
    
    /**
     * 获取提示
     */
    async getPrompt(name: string, args?: Record<string, string>): Promise<{
        messages: Array<{ role: string; content: { type: string; text?: string } }>;
    }> {
        return await this.sendRequest('prompts/get', { name, arguments: args });
    }
    
    /**
     * 发送 JSON-RPC 请求（带超时和进程退出检测）
     */
    private sendRequest<T>(method: string, params?: any, timeout?: number): Promise<T> {
        const effectiveTimeout = timeout ?? this.timeout;
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin || this.process.exitCode !== null || this.process.signalCode !== null) {
                reject(new Error(`Process not started${this.getStderrInfo()}`));
                return;
            }
            
            const id = ++this.requestId;
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };
            
            let resolved = false;
            
            // 超时处理
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request "${method}" timeout (${effectiveTimeout / 1000}s)${this.getStderrInfo()}`));
                }
            }, effectiveTimeout);
            
            // 进程退出检测
            const onExit = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    this.pendingRequests.delete(id);
                    reject(new Error(`Process exited while waiting for "${method}" response${this.getStderrInfo()}`));
                }
            };
            
            this.process.once('exit', onExit);
            
            this.pendingRequests.set(id, {
                resolve: (result) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        this.process?.removeListener('exit', onExit);
                        resolve(result);
                    }
                },
                reject: (error) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        this.process?.removeListener('exit', onExit);
                        reject(error);
                    }
                }
            });
            
            const message = JSON.stringify(request) + '\n';
            try {
                if (this.processExited || this.process.stdin.destroyed) {
                    const errorInfo = this.stderrOutput ? `\nStderr: ${this.stderrOutput.trim()}` : '';
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        this.process?.removeListener('exit', onExit);
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
                    clearTimeout(timeoutId);
                    this.process?.removeListener('exit', onExit);
                    this.pendingRequests.delete(id);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
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
        
        // 缓冲区大小上限，防止服务器发送无界数据导致内存 DoS
        const MAX_BUFFER_SIZE = 16 * 1024 * 1024;
        if (this.buffer.length > MAX_BUFFER_SIZE) {
            this.buffer = '';
            this.emit('error', new Error(`MCP server output exceeded buffer limit (${MAX_BUFFER_SIZE} bytes), disconnecting`));
            this.disconnect().catch(() => {});
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
            // 这是通知或请求
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