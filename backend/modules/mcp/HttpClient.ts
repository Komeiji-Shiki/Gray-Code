/**
 * LimCode MCP 模块 - HTTP/SSE 客户端
 *
 * 通过 HTTP 或 SSE 与 MCP 服务器通信
 */

import { EventEmitter } from 'events';
import { t } from '../../i18n';

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
 * HTTP/SSE MCP 客户端
 * 
 * 支持两种模式：
 * 1. SSE (Server-Sent Events) - 使用 SSE 接收响应
 * 2. Streamable HTTP - 使用标准 HTTP POST 请求
 */
export class HttpMcpClient extends EventEmitter {
    private requestId = 0;
    private sessionId?: string;
    private connected = false;
    private timeout: number;
    
    // 进行中的 fetch AbortController（disconnect 时统一中止）
    private activeControllers: Set<AbortController> = new Set();
    
    // 进行中的 SSE 读流（disconnect 时统一取消）
    private activeReaders: Set<ReadableStreamDefaultReader<Uint8Array>> = new Set();
    
    // 服务器能力和信息
    private serverInfo?: { name: string; version: string };
    private protocolVersion?: string;
    private capabilities?: InitializeResult['capabilities'];
    
    // 缓存的工具、资源、提示
    private tools: McpTool[] = [];
    private resources: McpResource[] = [];
    private prompts: McpPrompt[] = [];
    
    constructor(
        private url: string,
        private transportType: 'sse' | 'streamable-http',
        private headers: Record<string, string> = {},
        timeout: number = 30000
    ) {
        super();
        this.timeout = timeout;
    }
    
    /**
     * 连接到服务器
     */
    async connect(): Promise<void> {
        // 发送初始化请求
        const initResult = await this.sendRequest<InitializeResult>('initialize', {
            protocolVersion: '2025-12-19',
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
        this.connected = true;
        
        // 发送 initialized 通知
        await this.sendNotification('notifications/initialized', {});
        
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
     */
    async disconnect(): Promise<void> {
        this.connected = false;
        this.sessionId = undefined;
        this.tools = [];
        this.resources = [];
        this.prompts = [];

        // 中止所有进行中的请求
        for (const controller of this.activeControllers) {
            try {
                controller.abort();
            } catch {
                // 忽略中止失败
            }
        }
        this.activeControllers.clear();

        // 取消所有进行中的 SSE 读流
        for (const reader of this.activeReaders) {
            try {
                await reader.cancel();
            } catch {
                // 忽略取消失败
            }
        }
        this.activeReaders.clear();
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
     *
     * @param signal 外部取消信号（可选）；中止时立即拒绝，无需等待内部超时
     */
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
    }> {
        return await this.sendRequest('tools/call', {
            name,
            arguments: args
        }, signal);
    }
    
    /**
     * 读取资源
     *
     * @param signal 外部取消信号（可选）
     */
    async readResource(uri: string, signal?: AbortSignal): Promise<{
        contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
    }> {
        return await this.sendRequest('resources/read', { uri }, signal);
    }
    
    /**
     * 获取提示
     *
     * @param signal 外部取消信号（可选）
     */
    async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<{
        messages: Array<{ role: string; content: { type: string; text?: string } }>;
    }> {
        return await this.sendRequest('prompts/get', { name, arguments: args }, signal);
    }
    
    /**
     * 发送 JSON-RPC 请求
     *
     * 超时通过 AbortController 覆盖整个请求生命周期（含 body 读取）：
     * - JSON 响应：controller 保持到 response.json() 完成
     * - SSE 响应：拿到响应头后由空闲超时接管（每次收到数据重置计时器）
     *
     * 外部取消信号与内部超时 controller 联动：
     * - 外部 abort 时手动调用 controller.abort()，fetch/body 读取立即被中止
     * - 已中止的信号在进入时立即拒绝（不发起 fetch）
     * - 请求结束（成功/失败/超时/中止）时摘除外部 listener 与 activeControllers
     * - 错误文案区分外部中止（'MCP tool call aborted'）与内部超时（requestTimeout）
     */
    private async sendRequest<T>(method: string, params?: any, signal?: AbortSignal): Promise<T> {
        // 外部信号已中止：立即拒绝，不发起请求
        if (signal?.aborted) {
            throw new Error('MCP tool call aborted');
        }

        const id = ++this.requestId;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };
        
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...this.headers
        };
        
        // 如果有 session ID，添加到请求头
        if (this.sessionId) {
            headers['Mcp-Session-Id'] = this.sessionId;
        }
        
        // 创建 AbortController 用于超时控制（保持到 body 读取完成）
        const controller = new AbortController();
        this.activeControllers.add(controller);
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        // 外部中止标记：由外部 signal 的 abort listener 置位，
        // 用于区分「外部中止」与「内部超时」（两者都会触发 controller.abort()）
        let externalAborted = false;
        const onExternalAbort = () => {
            externalAborted = true;
            controller.abort();
        };
        signal?.addEventListener('abort', onExternalAbort);

        try {
            timeoutId = setTimeout(() => {
                controller.abort();
            }, this.timeout);
            
            let response: Response;
            try {
                response = await fetch(this.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(request),
                    signal: controller.signal
                });
            } catch (error: any) {
                if (externalAborted) {
                    throw new Error('MCP tool call aborted');
                }
                if (error?.name === 'AbortError') {
                    throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
                }
                throw error;
            }
            
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
            }
            
            // 检查是否返回了 session ID
            const newSessionId = response.headers.get('Mcp-Session-Id');
            if (newSessionId) {
                this.sessionId = newSessionId;
            }
            
            const contentType = response.headers.get('Content-Type') || '';
            
            // SSE 响应：固定超时到响应头为止，之后由空闲超时接管（数据到达时重置）
            if (contentType.includes('text/event-stream')) {
                if (timeoutId) clearTimeout(timeoutId);
                timeoutId = null;
                return await this.handleSseResponse<T>(response, id, signal, () => externalAborted);
            }
            
            // JSON 响应（controller 保持到 json() 完成，body 读取同样受超时保护）
            try {
                const jsonResponse = await response.json() as JsonRpcResponse;
                
                if (jsonResponse.error) {
                    throw new Error(jsonResponse.error.message);
                }
                
                return jsonResponse.result as T;
            } catch (error: any) {
                if (externalAborted) {
                    throw new Error('MCP tool call aborted');
                }
                if (error?.name === 'AbortError') {
                    throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
                }
                throw error;
            }
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onExternalAbort);
            this.activeControllers.delete(controller);
        }
    }
    
    /**
     * 处理 SSE 响应
     *
     * - 只消费与请求 id 匹配的事件，服务器下发的通知（id: null/缺失）不会被误当结果
     * - 按 SSE 规范合并多行 data:（以 \n 连接，空行结束事件）
     * - 空闲超时：每次收到数据重置计时器，避免误杀合法长任务；收到结果后提前关闭读流
     * - 外部中止：abort 时 reader.cancel() 快速结束读流，按外部中止（'MCP tool call aborted'）处理；
     *   reader 从 activeReaders 移除，abort listener 摘除
     */
    private async handleSseResponse<T>(
        response: Response,
        expectedId: number | string,
        signal?: AbortSignal,
        isExternalAbort?: () => boolean
    ): Promise<T> {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        this.activeReaders.add(reader);
        const decoder = new TextDecoder();
        let buffer = '';
        let result: T | undefined;
        let matched = false;

        // 空闲超时控制：每次收到数据重置计时器
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                reader.cancel().catch(() => {});
            }, this.timeout);
        };

        // 外部中止：取消读流，让 read() 快速结束（中止标记由 sendRequest 的 listener 置位）
        const onExternalAbort = () => {
            reader.cancel().catch(() => {});
        };
        if (signal) {
            if (signal.aborted) {
                reader.cancel().catch(() => {});
            } else {
                signal.addEventListener('abort', onExternalAbort);
            }
        }

        resetIdleTimer();

        try {
            while (!matched) {
                let chunk: { done: boolean; value?: Uint8Array };
                try {
                    chunk = await reader.read();
                } catch {
                    // 读流被取消/中止（外部中止、超时或 disconnect）
                    break;
                }
                const { done, value } = chunk;
                if (done) break;

                resetIdleTimer();

                buffer += decoder.decode(value, { stream: true });

                // 按 SSE 规范解析：data: 行累积，空行触发事件
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                let eventData: string[] | null = null;
                const dispatchEvent = () => {
                    if (eventData === null) return;
                    const jsonStr = eventData.join('\n').trim();
                    eventData = null;
                    if (!jsonStr || jsonStr === '[DONE]') return;

                    let event: Partial<JsonRpcResponse> | undefined;
                    try {
                        event = JSON.parse(jsonStr) as Partial<JsonRpcResponse>;
                    } catch {
                        // 忽略解析错误（多行 data 已在合并后解析）
                        return;
                    }

                    // 只消费与请求 id 匹配的响应，服务器下发的通知不会被误当结果
                    if (event.jsonrpc === '2.0' && event.id === expectedId) {
                        if (event.error) {
                            throw new Error(event.error.message);
                        }
                        matched = true;
                        result = event.result as T;
                    }
                };

                for (const rawLine of lines) {
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                    if (line.startsWith('data:')) {
                        // SSE 规范：data: 后若跟一个空格，该空格不属于数据
                        const value2 = line.slice(5);
                        eventData = eventData ?? [];
                        eventData.push(value2.startsWith(' ') ? value2.slice(1) : value2);
                    } else if (line === '' && eventData !== null) {
                        dispatchEvent();
                        if (matched) break;
                    }
                }

                // 流结束时派发尚未结束的事件
                if (done && eventData !== null) {
                    dispatchEvent();
                }

                if (matched) {
                    // 已拿到结果，提前关闭读流（某些服务器不会主动关闭 SSE 流）
                    try {
                        await reader.cancel();
                    } catch {
                        // 忽略取消失败
                    }
                    break;
                }
            }
        } finally {
            if (idleTimer) clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onExternalAbort);
            try {
                reader.releaseLock();
            } catch {
                // 忽略释放失败
            }
            this.activeReaders.delete(reader);
        }

        if (!matched) {
            // 外部中止与超时/断开区分文案
            if (isExternalAbort?.()) {
                throw new Error('MCP tool call aborted');
            }
            throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
        }

        return result as T;
    }
    
    /**
     * 发送通知（无需响应，同样受超时与 disconnect 中止保护）
     */
    private async sendNotification(method: string, params?: any): Promise<void> {
        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };
        
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.headers
        };
        
        if (this.sessionId) {
            headers['Mcp-Session-Id'] = this.sessionId;
        }
        
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.timeout);
        
        try {
            await fetch(this.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(notification),
                signal: controller.signal
            });
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
        }
    }
}