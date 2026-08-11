/**
 * GrayCode MCP 模块 - HTTP/SSE 客户端
 *
 * 通过 HTTP 或 SSE 与 MCP 服务器通信
 */

import { EventEmitter } from 'events';
import { t } from '../../i18n';
import { createGrayCodeMcpClientInfo } from '../../core/productMetadata';

/**
 * SSE 读流缓冲上限（字符数）：无换行的超长尾行跨 chunk 累积时 bufferParts 永续增长，
 * 超过该值视为垃圾数据流/服务器异常（连接故障），emitError 广播 + 抛错。
 * 注：按 JS 字符串 length（UTF-16 码元）计数，即字符数而非字节数。
 */
const SSE_BUFFER_LIMIT = 16 * 1024 * 1024;

/**
 * 单个 SSE 事件 data 累积上限（字符数）：服务器持续下发 data: 行而不以空行结束事件时
 * eventData 无界累积，超过该值同样视为连接故障，emitError 广播 + 抛错。
 * 注：按 JS 字符串 length（UTF-16 码元）计数，即字符数而非字节数。
 */
const SSE_EVENT_DATA_LIMIT = 64 * 1024 * 1024;

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
    /** disconnect 已调用：中止请求与「外部取消」区分（避免误报 requestTimeout） */
    private disconnected = false;
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
    
    // 能力列表（tools/resources/prompts）拉取是否失败过（失败被吞，列表保持空）。
    // 供上层区分「服务器真的没有工具」与「拉取失败导致列表为空」（与 StdioClient 同口径）。
    private listFetchFailed: boolean = false;
    
    constructor(
        private url: string,
        // transportType 仅为兼容旧配置保留（'sse' 按 streamable-http 语义统一处理：
        // POST + SSE 响应流；经典 SSE 的 GET /sse 端点不支持）。字段只写不读，不存。
        _transportType: 'sse' | 'streamable-http',
        private headers: Record<string, string> = {},
        timeout: number = 30000
    ) {
        super();
        this.timeout = timeout;
    }
    
    /**
     * 广播错误事件。
     *
     * EventEmitter 对无监听的 'error' 事件会直接 throw（未处理异常）——仅在确有
     * 监听器时才 emit，保证单测/独立使用场景下错误仍按普通拒绝路径传播。
     */
    private emitError(error: Error): void {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
    }
    
    /**
     * 连接到服务器
     */
    async connect(): Promise<void> {
        // 支持断开后复用：重置 disconnect 标志，后续请求不再被误判为「已断开」
        this.disconnected = false;
        // 新连接尝试：重置列表拉取失败标记，旧连接的失败不得污染本次连接判定
        this.listFetchFailed = false;
        // 发送初始化请求
        const initResult = await this.sendRequest<InitializeResult>('initialize', {
            protocolVersion: '2025-12-19',
            capabilities: {
                roots: { listChanged: true }
            },
            clientInfo: createGrayCodeMcpClientInfo()
        });
        
        this.serverInfo = initResult.serverInfo;
        this.protocolVersion = initResult.protocolVersion;
        this.capabilities = initResult.capabilities;
        
        // 发送 initialized 通知
        await this.sendNotification('notifications/initialized', {});
        
        // 初始化请求与 initialized 通知都成功后才标记已连接：
        // 若此前任一步失败，connect() 抛错时 connected 仍为 false，
        // 避免「连接失败却已标记 connected」的状态不一致
        // （tools/list 等后续请求依赖 connected 放行，故须在列表拉取之前置位）
        this.connected = true;
        
        // 获取工具列表（如果支持）
        if (this.capabilities?.tools) {
            try {
                const toolsResult = await this.sendRequest<{ tools: McpTool[] }>('tools/list', {});
                this.tools = toolsResult.tools || [];
            } catch {
                // 忽略获取工具失败；标记供上层区分「服务器真无工具」与「拉取失败」
                this.listFetchFailed = true;
            }
        }
        
        // 获取资源列表（如果支持）
        if (this.capabilities?.resources) {
            try {
                const resourcesResult = await this.sendRequest<{ resources: McpResource[] }>('resources/list', {});
                this.resources = resourcesResult.resources || [];
            } catch {
                // 忽略获取资源失败；标记供上层区分「服务器真无资源」与「拉取失败」
                this.listFetchFailed = true;
            }
        }
        
        // 获取提示列表（如果支持）
        if (this.capabilities?.prompts) {
            try {
                const promptsResult = await this.sendRequest<{ prompts: McpPrompt[] }>('prompts/list', {});
                this.prompts = promptsResult.prompts || [];
            } catch {
                // 忽略获取提示失败；标记供上层区分「服务器真无提示」与「拉取失败」
                this.listFetchFailed = true;
            }
        }
    }
    
    /**
     * 断开连接
     */
    async disconnect(): Promise<void> {
        this.connected = false;
        // 标记断开：进行中的请求被 abort 时据此区分「断开中止」与「请求超时」
        this.disconnected = true;
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
     * 重新拉取服务器公开列表。
     * 列表变更通知由 McpManager 串行调用本方法。
     * 逐项独立拉取（allSettled）：单项失败不影响其他列表，成功项覆盖缓存、失败项保留旧缓存；
     * 全部成功时复位 listFetchFailed（拉取失败标记不得永久滞留）。
     */
    async refreshLists(): Promise<void> {
        if (!this.connected) {
            throw new Error('MCP client is not connected');
        }

        const results = await Promise.allSettled([
            this.capabilities?.tools
                ? this.sendRequest<{ tools: McpTool[] }>('tools/list', {}).then(result => result.tools || [])
                : Promise.resolve([] as McpTool[]),
            this.capabilities?.resources
                ? this.sendRequest<{ resources: McpResource[] }>('resources/list', {}).then(result => result.resources || [])
                : Promise.resolve([] as McpResource[]),
            this.capabilities?.prompts
                ? this.sendRequest<{ prompts: McpPrompt[] }>('prompts/list', {}).then(result => result.prompts || [])
                : Promise.resolve([] as McpPrompt[]),
        ]);

        let anyFailed = false;
        const [toolsResult, resourcesResult, promptsResult] = results;
        if (toolsResult.status === 'fulfilled') {
            this.tools = toolsResult.value;
        } else {
            anyFailed = true;
            console.error('[MCP] Failed to refresh tools list:', toolsResult.reason);
        }
        if (resourcesResult.status === 'fulfilled') {
            this.resources = resourcesResult.value;
        } else {
            anyFailed = true;
            console.error('[MCP] Failed to refresh resources list:', resourcesResult.reason);
        }
        if (promptsResult.status === 'fulfilled') {
            this.prompts = promptsResult.value;
        } else {
            anyFailed = true;
            console.error('[MCP] Failed to refresh prompts list:', promptsResult.reason);
        }

        // 全部成功：复位拉取失败标记（连接期间/上次刷新留下的失败标记不得永久滞留）
        if (!anyFailed) {
            this.listFetchFailed = false;
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
     * 避免把失败误报为正常空列表（假 connected）。与 StdioClient 同口径。
     */
    isListFetchFailed(): boolean {
        return this.listFetchFailed;
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
        // 未连接（initialize 之外的请求）：直接拒绝，避免对已断开/未连接客户端发起请求
        if (!this.connected && method !== 'initialize') {
            throw new Error('MCP client is not connected');
        }
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
        
        // 协议头放在用户自定义 headers 之后：Content-Type/Accept 是 MCP 必需，
        // 不能被用户 headers 覆盖导致服务器拒绝
        const headers: Record<string, string> = {
            ...this.headers,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
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
                    // disconnect 触发的中止：报「已断开」而非「请求超时」
                    if (this.disconnected) {
                        throw new Error('MCP client disconnected');
                    }
                    throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
                }
                // 网络层错误（连接拒绝/DNS 失败/服务器进程死亡等）：连接已不可用，
                // 广播错误供上层（McpManager）将状态置为 error——否则服务器死亡后状态永久 connected
                this.emitError(error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
            
            if (!response.ok) {
                // HTTP 层错误：4xx（除 401/403 鉴权类外）属请求级错误（配置/参数问题），
                // 不广播 error、不把服务器状态置为 error——仅抛请求级错误；
                // 仅 5xx / 网络层错误 / 流意外结束才代表连接已不可用（广播 + 状态翻转）。
                const httpError = new Error(`HTTP error: ${response.status} ${response.statusText}`);
                if (response.status >= 500 || response.status === 401 || response.status === 403) {
                    this.emitError(httpError);
                }
                throw httpError;
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
                    // 错误码拼入信息：上层只展示 message，不丢 code
                    throw new Error(`MCP error ${jsonResponse.error.code}: ${jsonResponse.error.message}`);
                }
                
                return jsonResponse.result as T;
            } catch (error: any) {
                if (externalAborted) {
                    throw new Error('MCP tool call aborted');
                }
                if (error?.name === 'AbortError') {
                    // disconnect 触发的中止：报「已断开」而非「请求超时」
                    if (this.disconnected) {
                        throw new Error('MCP client disconnected');
                    }
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
        // 分块累积 SSE 文本：数组 push + 统一 join，避免逐 chunk 字符串拼接退化为 O(n²)
        const bufferParts: string[] = [];
        let result: T | undefined;
        let matched = false;
        // 流是否自然结束（read 返回 done）——区别于超时/外部中止/disconnect 触发的取消：
        // 用于区分「服务器关闭连接」与「请求超时」，前者属断线需广播错误
        let streamEnded = false;
        // 空闲超时/绝对 deadline 是否已触发（超时也会 cancel 读流，cancel 后 read 返回 done，
        // 需据此区分「超时取消」与「服务器主动关闭连接」）
        let timeoutTriggered = false;

        // 空闲超时控制：每次收到数据重置计时器
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                timeoutTriggered = true;
                reader.cancel().catch(() => {});
            }, this.timeout);
        };

        // 总 deadline：不随数据重置——服务器持续推无关事件时，tools/call 不能无限等待
        const absoluteDeadline = setTimeout(() => {
            timeoutTriggered = true;
            reader.cancel().catch(() => {});
        }, Math.max(this.timeout * 3, 120_000));

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
            // 累积的事件数据跨 chunk 保留：SSE 事件可能跨多个数据块，且末事件可能不以空行结尾
            let eventData: string[] | null = null;
            // 当前事件 data 累计长度：服务器持续下发 data: 行而不以空行结束事件时
            // eventData 无界累积，超过上限视为连接故障（垃圾数据流），emitError + 抛错
            let eventDataLength = 0;
            const dispatchEvent = () => {
                if (eventData === null) return;
                const jsonStr = eventData.join('\n').trim();
                eventData = null;
                eventDataLength = 0;
                if (!jsonStr || jsonStr === '[DONE]') return;

                let event: (Partial<JsonRpcResponse> & { method?: string; params?: unknown }) | undefined;
                try {
                    event = JSON.parse(jsonStr) as Partial<JsonRpcResponse> & { method?: string; params?: unknown };
                } catch {
                    // 忽略解析错误（多行 data 已在合并后解析）
                    return;
                }

                // 只消费与请求 id 匹配的响应，服务器下发的通知不会被误当结果
                if (event.jsonrpc === '2.0' && event.id === expectedId) {
                    if (event.error) {
                        // 错误码拼入信息：上层只展示 message，不丢 code
                        throw new Error(`MCP error ${event.error.code}: ${event.error.message}`);
                    }
                    matched = true;
                    result = event.result as T;
                } else if (event.jsonrpc === '2.0'
                    && event.id === undefined
                    && typeof event.method === 'string') {
                    // 服务器通知（无 id）：按 method 派发，供 McpManager 刷新列表缓存等
                    this.emit('notification', event.method, event.params);
                }
            };
            // 解析一段 SSE 文本：data: 行累积进 eventData，空行触发事件派发
            const parseChunkText = (text: string, keepTail: boolean) => {
                const lines = text.split('\n');
                if (keepTail) {
                    // 末尾不完整的行保留到下一 chunk
                    bufferParts.push(lines.pop() || '');
                }
                for (const rawLine of lines) {
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                    if (line.startsWith('data:')) {
                        // SSE 规范：data: 后若跟一个空格，该空格不属于数据
                        const value2 = line.slice(5);
                        const dataLine = value2.startsWith(' ') ? value2.slice(1) : value2;
                        eventData = eventData ?? [];
                        eventData.push(dataLine);
                        eventDataLength += dataLine.length;
                        // 单事件 data 累积超限（字符数，见常量注释）：服务器不结束事件持续灌数据，
                        // 按连接故障处理
                        if (eventDataLength > SSE_EVENT_DATA_LIMIT) {
                            const eventOverflowError = new Error(
                                `MCP SSE event data exceeded ${SSE_EVENT_DATA_LIMIT} characters`
                            );
                            this.emitError(eventOverflowError);
                            throw eventOverflowError;
                        }
                    } else if (line === '' && eventData !== null) {
                        dispatchEvent();
                        if (matched) break;
                    }
                }
            };

            while (!matched) {
                let chunk: { done: boolean; value?: Uint8Array };
                try {
                    chunk = await reader.read();
                } catch (error: any) {
                    // 读流被取消/中止（外部中止、超时或 disconnect）是正常退出路径，
                    // 交由循环后的状态判定区分文案；其他异常（真实网络故障/连接中断）
                    // 不能当取消吞掉——否则上层只会看到「请求超时」甚至无限等待。
                    if (this.disconnected || timeoutTriggered || isExternalAbort?.()) {
                        break;
                    }
                    // 非取消触发的读流错误：连接已不可用，广播错误供上层（McpManager）
                    // 置 error 状态，并抛真实错误（不再静默 break 后误报 requestTimeout）
                    const readError = error instanceof Error ? error : new Error(String(error));
                    this.emitError(readError);
                    throw readError;
                }
                const { done, value } = chunk;
                if (done) {
                    // 流结束：先 flush decoder 中残留的不完整多字节 UTF-8 序列（末 chunk 以不完整
                    // 多字节字符结尾时不 flush 会截断末行，末事件 JSON 解析失败被丢、请求报
                    // requestTimeout），再解析保留的末尾不完整行并派发残留事件——末事件可能不以
                    // 空行结尾，直接 break 会丢弃末事件（tools/call 挂起超时）。原
                    // 「if (done && eventData !== null)」位于 done 提前 break 之后，属死代码。
                    streamEnded = true;
                    bufferParts.push(decoder.decode());
                    parseChunkText(bufferParts.join(''), false);
                    if (eventData !== null) {
                        dispatchEvent();
                    }
                    break;
                }

                resetIdleTimer();

                bufferParts.push(decoder.decode(value, { stream: true }));

                // 按 SSE 规范解析：data: 行累积，空行触发事件
                const chunkText = bufferParts.join('');
                bufferParts.length = 0;
                // 缓冲上限只针对「无换行的残留尾行」（parseChunkText keepTail 保留的唯一部分，
                // 即跨 chunk 累积的唯一增长项）：含换行的完整行会被解析消费、不构成无界增长。
                // 旧实现按整段字符数计数，单 chunk 内完整合法大事件（如 >16MB 单行）会被误判
                // 为连接故障——事件数据量本身由 SSE_EVENT_DATA_LIMIT 约束。超限视为连接故障
                // （垃圾数据流/服务器异常）：emitError 广播 + 抛错，不再无界占用内存。
                const retainedTailLength = chunkText.length - (chunkText.lastIndexOf('\n') + 1);
                if (retainedTailLength > SSE_BUFFER_LIMIT) {
                    const bufferOverflowError = new Error(
                        `MCP SSE stream buffer exceeded ${SSE_BUFFER_LIMIT} characters`
                    );
                    this.emitError(bufferOverflowError);
                    throw bufferOverflowError;
                }
                parseChunkText(chunkText, true);

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
            clearTimeout(absoluteDeadline);
            signal?.removeEventListener('abort', onExternalAbort);
            try {
                reader.releaseLock();
            } catch {
                // 忽略释放失败
            }
            this.activeReaders.delete(reader);
        }

        if (!matched) {
            // 外部中止、断开与超时区分文案
            if (isExternalAbort?.()) {
                throw new Error('MCP tool call aborted');
            }
            // 流中断可能由 disconnect() 触发（reader.cancel 后 read 抛错/返回 done）：
            // 先判断断开再报超时，避免误报 requestTimeout
            if (this.disconnected) {
                throw new Error('MCP client disconnected');
            }
            // 流意外结束（服务器主动关闭连接，非 disconnect/超时/外部中止触发）：
            // 连接已断，广播错误供上层更新状态，并抛独立文案——不再误报「请求超时」——
            // 否则服务器死亡后状态永久 connected 且错误原因失真
            if (streamEnded && !timeoutTriggered) {
                const streamClosedError = new Error('MCP SSE stream closed');
                this.emitError(streamClosedError);
                throw streamClosedError;
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
        
        // 协议头优先（与 sendRequest 同口径），不被用户自定义 headers 覆盖
        const headers: Record<string, string> = {
            ...this.headers,
            'Content-Type': 'application/json'
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
            const response = await fetch(this.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(notification),
                signal: controller.signal
            });
            // 通知无响应体可读，但 HTTP 层失败（非 2xx）必须上抛——
            // 否则初始化握手在服务器报错时仍被当作成功
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                if (this.disconnected) {
                    throw new Error('MCP client disconnected');
                }
                throw new Error(t('modules.mcp.errors.requestTimeout', { timeout: this.timeout }));
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            this.activeControllers.delete(controller);
        }
    }
}