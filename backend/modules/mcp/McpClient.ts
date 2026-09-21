import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import path from 'node:path';
import treeKill from 'tree-kill';
import { StringDecoder } from 'node:string_decoder';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    Client, StreamableHTTPClientTransport, ProtocolError, isInputRequiredResult,
    type InputRequiredResult, type RequestOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createGrayCodeMcpClientInfo, PRODUCT_USER_AGENT } from '../../core/productIdentity';
import type { McpTransportConfig, McpToolDefinition, McpResourceDefinition, McpPromptDefinition, McpRawToolResult } from './types';

/** 直接管理当前管道的进程树，同时让连接探测可以被 disconnect 立即停止。 */
class ManagedStdioTransport extends StdioClientTransport {
    exitedDuringConnect = false;
    private stopping?: Promise<void>;

    async start(): Promise<void> {
        const onclose = this.onclose;
        this.onclose = () => { if (!this.stopping) this.exitedDuringConnect = true; onclose?.(); };
        await super.start();
    }

    close(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.stopping = (async () => {
            try {
                if (this.pid) {
                    const pid = this.pid;
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error('MCP 进程树关闭超时。')), 5000);
                        const done = (error?: Error | null) => {
                            clearTimeout(timer);
                            if (error && this.pid === pid) reject(error); else resolve();
                        };
                        if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
                            ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, done);
                        else treeKill(pid, 'SIGTERM', done);
                    });
                }
            } finally { await super.close(); }
        })();
        return this.stopping;
    }
}

/** 尚未完成的交互请求必须明确保留，不能作为空工具结果返回。 */
export class McpInputRequiredError extends Error {
    constructor(readonly inputRequired: InputRequiredResult) {
        super('MCP 服务需要补充输入，当前调用尚未完成。');
    }
}

export class McpExecutionUnknownError extends Error {
    constructor(cause: unknown) {
        super(`MCP 调用未收到完整结果，执行状态未知：${cause instanceof Error ? cause.message : String(cause)}`);
    }
}

/** 产品只管理连接状态和完整目录，协议编解码、分页、取消由官方 SDK 负责。 */
export class McpClient extends EventEmitter {
    private client?: Client;
    private transport?: ManagedStdioTransport | StreamableHTTPClientTransport;
    private connection?: AbortController;
    private closing?: Promise<void>;
    private tools: McpToolDefinition[] = [];
    private resources: McpResourceDefinition[] = [];
    private prompts: McpPromptDefinition[] = [];
    private stderr = '';
    private connected = false;
    private readonly requests = new AsyncLocalStorage<RequestOptions>();

    constructor(private readonly config: McpTransportConfig, private readonly timeout = 30000) { super(); }

    async connect(): Promise<void> {
        if (this.client || this.closing) throw new Error('MCP 客户端已经连接或正在连接。');
        const connection = this.connection = new AbortController();
        this.stderr = '';
        try {
            // 少数旧服务收到 initialize 之前的未知请求会退出，仅在此情况下启动新的握手连接。
            for (const mode of ['auto', 'legacy'] as const) {
                const client = this.createClient(mode, connection);
                const transport = this.createTransport(connection);
                this.client = client; this.transport = transport;
                try { await client.connect(transport, this.options(connection.signal)); break; }
                catch (error) {
                    await transport.close();
                    if (mode !== 'auto' || connection.signal.aborted || !(transport instanceof ManagedStdioTransport)
                        || !transport.exitedDuringConnect) throw error;
                    await client.close();
                }
            }
            connection.signal.throwIfAborted();
            await this.refreshLists();
            connection.signal.throwIfAborted();
            this.connected = true;
            // 新协议的变更流关闭后，目录可能过期，交给管理器显示连接已经失效。
            void this.client!.autoOpenedSubscription?.closed.then(reason => {
                if (reason === 'remote' && !connection.signal.aborted) this.reportError(new Error('MCP 目录变更订阅已断开。'));
            });
        } catch (error) {
            const details = this.stderr.trim();
            await this.disconnect();
            if (details) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
            throw error;
        }
    }

    private createClient(mode: 'auto' | 'legacy', connection: AbortController): Client {
        const changed = (kind: 'tools' | 'resources' | 'prompts') => ({
            autoRefresh: false, debounceMs: 0,
            onChanged: (error: Error | null) => error ? this.reportError(error)
                : this.emit('notification', `notifications/${kind}/list_changed`, undefined),
        });
        const client = new Client(createGrayCodeMcpClientInfo(), {
            capabilities: {},
            versionNegotiation: { mode },
            inputRequired: { autoFulfill: false },
            listChanged: { tools: changed('tools'), resources: changed('resources'), prompts: changed('prompts') },
        });
        client.onerror = error => { if (this.client === client) this.reportError(error); };
        client.onclose = () => {
            if (this.client !== client) return;
            const wasConnected = this.connected;
            this.connected = false;
            if (wasConnected && !connection.signal.aborted) this.emit('exit');
        };
        client.fallbackNotificationHandler = async notification => { this.emit('notification', notification.method, notification.params); };
        return client;
    }

    private createTransport(connection: AbortController): ManagedStdioTransport | StreamableHTTPClientTransport {
        if (this.config.type === 'stdio') {
            const transport = new ManagedStdioTransport({
                command: this.config.command, args: this.config.args,
                env: { ...process.env, ...this.config.env } as Record<string, string>, stderr: 'pipe',
                maxBufferSize: 16 * 1024 * 1024,
            });
            // 使用尾部诊断，避免启动阶段的大量输出挤掉真正的失败原因。
            const decoder = new StringDecoder('utf8');
            transport.stderr?.on('data', chunk => { this.stderr = (this.stderr + decoder.write(chunk)).slice(-64 * 1024); });
            return transport;
        }
        // 历史 sse 配置一直采用 POST + SSE 响应语义，继续使用相同端点。
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
            requestInit: { headers: { 'User-Agent': PRODUCT_USER_AGENT, ...this.config.headers } },
            fetch: (url, init) => {
                // 旧协议 SDK 只通知服务端取消；同一调用的 HTTP 读取也要释放，且不能影响并行调用和订阅。
                const request = init?.method === 'POST' ? this.requests.getStore() : undefined;
                const signals = [connection.signal];
                if (init?.signal) signals.push(init.signal);
                if (request?.signal) signals.push(request.signal);
                if (request?.timeout && request.timeout > 0) signals.push(AbortSignal.timeout(request.timeout));
                return fetch(url, { ...init, signal: AbortSignal.any(signals) });
            },
        });
    }

    disconnect(): Promise<void> {
        if (this.closing) return this.closing;
        this.connection?.abort(new Error('MCP connection closed'));
        this.connected = false;
        const client = this.client, transport = this.transport;
        const close = async () => {
            try {
                await transport?.close();
            } finally {
                await client?.close();
                if (transport instanceof StdioClientTransport) transport.stderr?.removeAllListeners('data');
                if (this.client === client) { this.client = undefined; this.transport = undefined; }
            }
        };
        this.closing = close().finally(() => { this.closing = undefined; });
        return this.closing;
    }

    async refreshLists(): Promise<void> {
        const client = this.requireClient(), capabilities = client.getServerCapabilities();
        const options = { ...this.options(this.connection?.signal), cacheMode: 'refresh' as const };
        const [tools, resources, prompts] = await this.requests.run(options, () => Promise.all([
            capabilities?.tools ? client.listTools(undefined, options).then(result => result.tools) : [],
            capabilities?.resources ? client.listResources(undefined, options).then(result => result.resources) : [],
            capabilities?.prompts ? client.listPrompts(undefined, options).then(result => result.prompts) : [],
        ]));
        // 三类目录全部取回后一次替换，失败时保留上一份完整目录及工具顺序。
        this.tools = tools; this.resources = resources; this.prompts = prompts;
    }

    getTools(): McpToolDefinition[] { return this.tools; }
    getResources(): McpResourceDefinition[] { return this.resources; }
    getPrompts(): McpPromptDefinition[] { return this.prompts; }
    getServerInfo(): { name: string; version: string } | undefined { return this.client?.getServerVersion(); }
    getProtocolVersion(): string | undefined { return this.client?.getNegotiatedProtocolVersion(); }

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpRawToolResult> {
        signal?.throwIfAborted();
        const client = this.requireClient();
        if (!this.connected) throw new Error('MCP 客户端尚未连接。');
        try {
            return await this.request(signal, options => client.callTool({ name, arguments: args }, options));
        } catch (error) {
            if (error instanceof McpInputRequiredError || error instanceof ProtocolError) throw error;
            // 未收到结果不能假设服务端没有执行，尤其不能自动重放有副作用的调用。
            throw new McpExecutionUnknownError(error);
        }
    }

    async readResource(uri: string, signal?: AbortSignal) {
        return this.request(signal, options => this.requireClient().readResource({ uri }, { ...options, cacheMode: 'refresh' }));
    }

    async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal) {
        return this.request(signal, options => this.requireClient().getPrompt({ name, arguments: args }, options));
    }

    private async request<T>(signal: AbortSignal | undefined, send: (options: RequestOptions) => Promise<T>): Promise<T> {
        const options = this.options(signal);
        const result = await this.requests.run(options, () => send(options));
        if (isInputRequiredResult(result)) throw new McpInputRequiredError(result);
        return result;
    }

    private options(signal?: AbortSignal): RequestOptions {
        return { timeout: this.timeout, signal, allowInputRequired: true };
    }

    private requireClient(): Client {
        if (!this.client) throw new Error('MCP 客户端尚未连接。');
        return this.client;
    }

    private reportError(error: Error): void {
        if (!this.connection?.signal.aborted && this.listenerCount('error')) this.emit('error', error);
    }
}
