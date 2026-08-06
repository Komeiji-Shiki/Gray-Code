/**
 * LimCode - 渠道管理器
 *
 * 核心渠道调用管理器，协调配置和格式转换器
 */

import { t } from '../../i18n';
import type { ConfigManager } from '../config/ConfigManager';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { SettingsManager } from '../settings/SettingsManager';
import type { ResolvedPromptModeSnapshot } from '../settings/types';
import type { McpManager } from '../mcp/McpManager';
import { formatterRegistry } from './formatters';
import { ToolDeclarationResolver } from './ToolDeclarationResolver';
import type { ToolDeclaration } from '../../tools/types';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions,
    HttpResponse
} from './types';
import type { Content } from '../conversation/types';
import { ChannelError, ErrorType } from './types';
import { createProxyFetch, proxyStreamFetch } from './proxyFetch';
import { Logger } from '../../core/logger';
import { validateHistoryIntegrity } from './HistoryIntegrityValidator';
import { parseStreamBuffer, MAX_STREAM_BUFFER_CHARS } from './streamBufferParser';

/**
 * 从上游 API 的非 2xx 响应体中提取人类可读的错误消息。
 *
 * 支持格式：
 * - Anthropic:         { error: { message: "..." } }
 * - OpenAI/OpenRouter: { error: { message: "...", code: 429, metadata: {...} } }
 * - 简化 JSON:         { message: "..." } / { error: "..." }
 * - 纯文本:            直接返回文本
 */
function extractUpstreamErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        if (typeof body === 'string' && body.trim()) return body.trim();
        return undefined;
    }
    const obj = body as Record<string, any>;
    // Anthropic/OpenAI/OpenRouter 的 { error: { message: "..." } }
    if (obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string') {
        return obj.error.message.trim();
    }
    // { error: "..." }
    if (typeof obj.error === 'string') {
        return obj.error.trim();
    }
    // { message: "..." }
    if (typeof obj.message === 'string') {
        return obj.message.trim();
    }
    return undefined;
}

/**
 * 判断模型响应内容是否为空（无文本/思考/工具调用/附件）。
 * HTTP 成功但内容全空 = 上游/代理抽风返回的无效响应，应触发自动重试。
 */
function isResponseContentEmpty(content: Content | undefined): boolean {
    if (!content || !Array.isArray(content.parts) || content.parts.length === 0) return true;
    return content.parts.every(part =>
        !(part.text && part.text.length > 0)
        && !part.functionCall
        && !part.inlineData
        && !part.fileData
    );
}

/**
 * 判断流式 chunk 的增量是否携带内容（文本/思考/工具调用）。
 */
function streamChunkHasContent(chunk: StreamChunk): boolean {
    return chunk.delta.some(part =>
        (part.text && part.text.length > 0) || !!part.functionCall
    );
}

/**
 * 重试状态回调类型
 */
export type RetryStatusCallback = (status: {
    type: 'retrying' | 'retrySuccess' | 'retryFailed';
    attempt: number;
    maxAttempts: number;
    error?: string;
    errorDetails?: any;  // 完整的错误详情（如 API 响应体）
    nextRetryIn?: number;
    createdAt: number;
    /** 触发重试的对话 ID（如果请求中提供了 conversationId） */
    conversationId?: string;
}) => void;

/**
 * 渠道管理器
 *
 * 负责：
 * 1. 从配置管理获取配置
 * 2. 选择合适的格式转换器
 * 3. 执行 HTTP 调用
 * 4. 解析响应并返回标准化数据
 * 5. 自动重试失败的请求
 */
export class ChannelManager {
    private retryStatusCallback?: RetryStatusCallback;
    private toolResolver: ToolDeclarationResolver;
    private readonly log = Logger.get('ChannelManager');
    
    constructor(
        private configManager: ConfigManager,
        private toolRegistry?: ToolRegistry,
        private settingsManager?: SettingsManager
    ) {
        this.toolResolver = new ToolDeclarationResolver(this.toolRegistry, this.settingsManager);
    }
    
    /**
     * 设置重试状态回调
     */
    setRetryStatusCallback(callback: RetryStatusCallback): void {
        this.retryStatusCallback = callback;
    }
    
    /**
     * 设置 MCP 管理器（用于获取 MCP 工具声明）
     *
     * 重建内部 ToolDeclarationResolver 以持有 MCP 管理器（resolver 的 MCP 依赖经构造函数注入）。
     */
    setMcpManager(mcpManager: McpManager): void {
        this.toolResolver = new ToolDeclarationResolver(this.toolRegistry, this.settingsManager, mcpManager);
    }
    
    /**
     * 生成内容（自动选择流式或非流式）
     *
     * 决策逻辑：
     * 1. 优先使用配置的 options.stream
     * 2. 否则使用配置的 preferStream
     * 3. 默认为非流式（false）
     *
     * @param request 生成请求
     * @returns 生成响应或流式生成器
     */
    async generate(
        request: GenerateRequest
    ): Promise<GenerateResponse | AsyncGenerator<StreamChunk>> {
        // 1. 获取配置
        const config = await this.configManager.getConfig(request.configId);
        if (!config) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.configNotFound', { configId: request.configId })
            );
        }
        
        if (!config.enabled) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.configDisabled', { configId: request.configId })
            );
        }
        
        // 2. 决定是否使用流式
        // 优先级：config.options.stream > config.preferStream > 默认值（false）
        const optionsStream = (config as any).options?.stream;
        const useStream = optionsStream ?? config.preferStream ?? false;
        
        // 3. 根据 stream 决定调用哪个方法
        if (useStream) {
            return this.generateStream(request);
        } else {
            return this.generateNonStream(request);
        }
    }
    
    /**
     * 延迟函数（支持取消）
     *
     * @param ms 延迟毫秒数
     * @param signal 取消信号
     * @returns Promise，如果被取消则抛出 CANCELLED_ERROR
     */
    private delay(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            // 如果已经取消，立即拒绝
            if (signal?.aborted) {
                reject(new ChannelError(
                    ErrorType.CANCELLED_ERROR,
                    t('modules.channel.errors.requestCancelled')
                ));
                return;
            }

            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new ChannelError(
                    ErrorType.CANCELLED_ERROR,
                    t('modules.channel.errors.requestCancelled')
                ));
            };

            const timeoutId = setTimeout(() => {
                // 正常超时路径必须移除 abort 监听器：否则每次重试都往信号上挂一个
                // 永不清理的监听器，长会话重试多次后累积泄漏。
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);

            // 监听取消信号
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }
    
    /**
     * 判断错误是否可重试
     */
    private isRetryableError(error: any): boolean {
        // API 错误（非 200 状态码）可重试
        if (error instanceof ChannelError) {
            // 用户取消错误不应重试
            if (error.type === ErrorType.CANCELLED_ERROR) {
                return false;
            }
            // 空响应（模型返回空内容）：可重试（无副作用、无已显示内容）
            if (error.type === ErrorType.EMPTY_RESPONSE_ERROR) {
                return true;
            }
            return error.type === ErrorType.API_ERROR ||
                   error.type === ErrorType.NETWORK_ERROR ||
                   error.type === ErrorType.TIMEOUT_ERROR;
        }
        // 网络错误可重试
        return true;
    }

    /**
     * 在请求发送前验证工具调用与工具结果的配对完整性
     */
    private validateHistoryBeforeRequest(request: GenerateRequest, channelType: string): void {
        const validation = validateHistoryIntegrity(request.history, { detectOrphanFunctionCall: true });
        if (validation.valid) {
            return;
        }

        const issue = validation.issues[0];
        const firstMessage = request.history[0];
        const details = {
            conversationId: request.conversationId,
            channelType,
            callId: issue.callId,
            issueKind: issue.kind,
            firstMessageRole: firstMessage?.role ?? null,
            firstMessageIsFunctionResponse: firstMessage?.isFunctionResponse === true,
            issueCount: validation.issues.length,
            issues: validation.issues
        };

        this.log.warn('tool_pair_validation_failed', details);

        throw new ChannelError(
            ErrorType.VALIDATION_ERROR,
            `Invalid tool history: ${issue.kind} (call_id: ${issue.callId})`,
            details
        );
    }
    
    /**
     * 生成内容（非流式）- 内部实现
     *
     * @param request 生成请求
     * @returns 生成响应
     */
    private async generateNonStream(request: GenerateRequest): Promise<GenerateResponse> {
        // 检查是否已取消
        if (request.abortSignal?.aborted) {
            throw new ChannelError(
                ErrorType.CANCELLED_ERROR,
                t('modules.channel.errors.requestCancelled')
            );
        }
        
        // 1. 获取配置（此时已在 generate 中验证过）
        let config = (await this.configManager.getConfig(request.configId))!;
        
        // 2. 如果有 modelOverride，创建临时配置覆盖 model
        if (request.modelOverride) {
            config = { ...config, model: request.modelOverride };
        }
        
        // 3. 获取格式转换器
        const formatter = formatterRegistry.get(config.type);
        if (!formatter) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.unsupportedChannelType', { type: config.type })
            );
        }
        
        // 4. 验证配置
        if (!formatter.validateConfig(config)) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.configValidationFailed', { configId: request.configId })
            );
        }

        // 5. 请求发送前校验工具调用历史完整性
        this.validateHistoryBeforeRequest(request, config.type);
        
        // 5. 获取过滤后的工具声明（除非请求指定跳过工具）
        // 传递配置信息以便动态生成工具描述
        const tools = request.skipTools
            ? undefined
            : (request.toolOverrides
                ? request.toolOverrides
                : this.getFilteredTools(
                    (config as any).multimodalToolsEnabled,
                    config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
                    (config as any).toolMode,
                    request.promptModeSnapshot
                ));
        
        // 6. 构建请求
        let httpRequest: HttpRequestOptions;
        try {
            httpRequest = formatter.buildRequest(request, config, tools);
        } catch (error) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.buildRequestFailed', { error: error instanceof Error ? error.message : t('errors.unknown') }),
                error
            );
        }
        
        // 7. 获取重试配置
        // 如果请求指定 skipRetry，则禁用重试
        const retryEnabled = request.skipRetry ? false : ((config as any).retryEnabled ?? true);  // 默认启用重试
        // retryCount 钳制到 [0, 20]：负数会跳过所有尝试，超大值会让请求挂着数小时
        const rawRetryCount = (config as any).retryCount ?? 3;
        const maxRetries = Number.isFinite(rawRetryCount) ? Math.min(Math.max(Math.floor(rawRetryCount), 0), 20) : 3;
        // 与流式路径一致：非法/负数 retryInterval 钳制为 0，避免 NaN 进入 delay
        const retryInterval = Math.max(0, Number((config as any).retryInterval ?? 3000) || 0);  // 默认3秒
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;

        // 重试状态回调：优先使用请求级回调（SubAgent 等需要把状态路由到 Monitor 的调用方），
        // 否则使用全局回调。suppressRetryNotification 只抑制全局回调，
        // 不抑制显式传入的请求级回调——请求级回调是调用方主动订阅的。
        const notifyRetryStatus = (status: Parameters<RetryStatusCallback>[0]): void => {
            const callback = request.retryStatusCallback ?? this.retryStatusCallback;
            if (!callback) return;
            if (!request.retryStatusCallback && request.suppressRetryNotification) return;
            callback(status);
        };
        
        // 8. 执行 HTTP 调用（带重试）
        let lastError: any;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            // 在每次重试前检查是否已取消
            if (request.abortSignal?.aborted) {
                throw new ChannelError(
                    ErrorType.CANCELLED_ERROR,
                    t('modules.channel.errors.requestCancelled')
                );
            }
            
            try {
                const httpResponse = await this.executeRequest(httpRequest, request.abortSignal);
                
                // 检查 HTTP 状态
                if (httpResponse.status !== 200) {
                    const upstreamMessage = extractUpstreamErrorMessage(httpResponse.body);
                    throw new ChannelError(
                        ErrorType.API_ERROR,
                        upstreamMessage
                            ? `HTTP ${httpResponse.status}: ${upstreamMessage}`
                            : t('modules.channel.errors.apiError', { status: httpResponse.status }),
                        httpResponse.body
                    );
                }
                
                // 如果是重试成功，通知前端
                if (attempt > 1) {
                    notifyRetryStatus({
                        type: 'retrySuccess',
                        attempt: attempt - 1,
                        maxAttempts: maxRetries,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }
                
                // 解析响应
                try {
                    const response = formatter.parseResponse(httpResponse.body);
                    // 空内容检测：HTTP 成功但模型返回空（无文本/思考/工具调用/附件）——
                    // 上游/代理抽风时常见，属于可重试的无效响应（此前会静默当成功返回）。
                    if (isResponseContentEmpty(response.content)) {
                        throw new ChannelError(
                            ErrorType.EMPTY_RESPONSE_ERROR,
                            t('modules.channel.errors.emptyResponse')
                        );
                    }
                    return response;
                } catch (error) {
                    // ChannelError（含空响应检测抛出的）原样透传：再包一层 PARSE_ERROR
                    // 会丢失错误类型与重试判定（EMPTY_RESPONSE_ERROR 会被误判为不可重试）。
                    if (error instanceof ChannelError) {
                        throw error;
                    }
                    throw new ChannelError(
                        ErrorType.PARSE_ERROR,
                        t('modules.channel.errors.parseResponseFailed', { error: error instanceof Error ? error.message : t('errors.unknown') }),
                        { response: httpResponse.body, error }
                    );
                }
            } catch (error) {
                lastError = error;
                
                // 获取错误详情
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                const errorDetails = error instanceof ChannelError ? error.details : undefined;
                
                // 检查是否可重试
                if (!retryEnabled || !this.isRetryableError(error) || attempt >= totalAttempts) {
                    // 不能重试或已达到最大重试次数
                    if (attempt > 1) {
                        notifyRetryStatus({
                            type: 'retryFailed',
                            attempt: Math.min(maxRetries, attempt - 1),
                            maxAttempts: maxRetries,
                            error: errorMessage,
                            errorDetails,
                            createdAt: Date.now(),
                            conversationId: request.conversationId
                        });
                    }
                    break;
                }
                
                // 在调用重试回调之前再次检查是否已取消
                if (request.abortSignal?.aborted) {
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
                    );
                }
                
                // 通知前端正在重试
                notifyRetryStatus({
                    type: 'retrying',
                    attempt,
                    maxAttempts: maxRetries,
                    error: errorMessage,
                    errorDetails,
                    nextRetryIn: retryInterval,
                    createdAt: Date.now(),
                    conversationId: request.conversationId
                });
                
                // 等待后重试（支持取消）
                await this.delay(retryInterval, request.abortSignal);
            }
        }
        
        // 所有重试都失败
        if (lastError instanceof ChannelError) {
            throw lastError;
        }
        throw new ChannelError(
            ErrorType.NETWORK_ERROR,
            t('modules.channel.errors.httpRequestFailed', { error: lastError instanceof Error ? lastError.message : t('errors.unknown') }),
            lastError
        );
    }
    
    /**
     * 生成内容（流式）
     *
     * @param request 生成请求
     * @returns 异步生成器，产生流式响应块
     */
    async *generateStream(request: GenerateRequest): AsyncGenerator<StreamChunk> {
        // 1. 获取配置
        let config = await this.configManager.getConfig(request.configId);
        if (!config) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.configNotFound', { configId: request.configId })
            );
        }
        
        if (!config.enabled) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.configDisabled', { configId: request.configId })
            );
        }
        
        // 2. 如果有 modelOverride，创建临时配置覆盖 model
        if (request.modelOverride) {
            config = { ...config, model: request.modelOverride };
        }
        
        // 3. 获取格式转换器
        const formatter = formatterRegistry.get(config.type);
        if (!formatter) {
            throw new ChannelError(
                ErrorType.CONFIG_ERROR,
                t('modules.channel.errors.unsupportedChannelType', { type: config.type })
            );
        }

        // 4. 请求发送前校验工具调用历史完整性
        this.validateHistoryBeforeRequest(request, config.type);
        
        // 4. 获取过滤后的工具声明（除非请求指定跳过工具）
        // 传递配置信息以便动态生成工具描述
        const tools = request.skipTools
            ? undefined
            : (request.toolOverrides
                ? request.toolOverrides
                : this.getFilteredTools(
                    (config as any).multimodalToolsEnabled,
                    config.type as 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
                    (config as any).toolMode,
                    request.promptModeSnapshot
                ));
        
        // 5. 构建请求（与非流式路径一致：buildRequest 失败统一包成 VALIDATION_ERROR，
        // 否则原始错误会被前端归类为 UNKNOWN_ERROR，错误分类不一致）
        let httpRequest: HttpRequestOptions;
        try {
            httpRequest = formatter.buildRequest(request, config, tools);
        } catch (error) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.buildRequestFailed', { error: error instanceof Error ? error.message : String(error) }),
                error
            );
        }
        
        // 5.5 缓存保活：当 promptCachingKeepAlive 启用时，若流式请求在 4 分 30 秒内未完成则自动发送保活请求
        const keepAliveEnabled = config.type === 'anthropic'
            && (config as any).promptCachingEnabled
            && (config as any).promptCachingKeepAlive
            && ((config as any).promptCachingTtl || '5m') === '5m';
        // 保活请求：max_tokens=5, stream=false，其余参数与主请求一致
        // 浅拷贝即可：仅覆盖顶层 max_tokens/stream 两个字段，避免对含完整历史的
        // 请求体做 JSON 深拷贝（长会话每次保活序列化/解析数百 KB 纯属浪费）
        const buildKeepAliveBody = () => {
            const raw = httpRequest.body;
            const body = (raw && typeof raw === 'object') ? { ...raw } : {};
            body.max_tokens = 5;
            body.stream = false;
            return body;
        };
        
        // 6. 获取重试配置
        // 如果请求指定 skipRetry，则禁用重试
        const retryEnabled = request.skipRetry ? false : ((config as any).retryEnabled ?? true);  // 默认启用重试
        // 与非流式路径一致：钳制到 [0, 20]，防止用户配置超大重试次数把请求挂起数小时
        const rawRetries = (config as any).retryCount ?? 3;         // 默认3次
        const maxRetries = Math.max(0, Math.min(20, Number(rawRetries) || 0));
        const rawRetryInterval = (config as any).retryInterval ?? 3000;  // 默认3秒
        const retryInterval = Math.max(0, Number(rawRetryInterval) || 0);
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;

        // 重试状态回调：优先使用请求级回调（SubAgent 等需要把状态路由到 Monitor 的调用方），
        // 否则使用全局回调。suppressRetryNotification 只抑制全局回调，
        // 不抑制显式传入的请求级回调——请求级回调是调用方主动订阅的。
        const notifyRetryStatus = (status: Parameters<RetryStatusCallback>[0]): void => {
            const callback = request.retryStatusCallback ?? this.retryStatusCallback;
            if (!callback) return;
            if (!request.retryStatusCallback && request.suppressRetryNotification) return;
            callback(status);
        };
        
        // 7. 执行流式请求（带重试）
        let lastError: any;
        // 是否已向调用方产出过 chunk：已产出内容后流中途出错不再重试
        let yieldedAny = false;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            // 缓存保活定时器（每次重试都重新计时）
            let keepAliveTimer: NodeJS.Timeout | undefined;
            // 流是否已结束：结束后不再调度下一轮保活（catch/finally 中置位，
            // 因此声明在 try 外）
            let streamFinished = false;
            // 流的空闲超时控制器句柄：executeStreamRequest 会把 resetTimeout 挂载进来，
            // 保活请求成功 = 上游连接仍然活跃 → 同步刷新流的空闲超时，
            // 让「LLM 模块自己的保活」成为流的活性信号（上游不回传心跳的静默期也能续命）。
            const idleTimeoutHandle: { reset: () => void } = { reset: () => {} };
            
            try {
                const stream = await this.executeStreamRequest(httpRequest, request.abortSignal, idleTimeoutHandle);
                
                // 启动缓存保活调度（缓存 TTL 5 分钟，保活节奏为每 4 分 30 秒一次）
                const requestStartTime = Date.now();
                let keepAliveFiredCount = 0;
                let hasToolUse = false;
                // 保活请求在途标记：链式 setTimeout 下防止上一次未完成时下一次已触发
                let keepAliveInFlight = false;

                /**
                 * 发送一次缓存保活请求（在途互斥 + 成功刷新流空闲超时）。
                 * @returns true = 上游 2xx 接受保活（缓存 TTL 已刷新）
                 */
                const fireKeepAlive = async (): Promise<boolean> => {
                    if (keepAliveInFlight) return false;
                    keepAliveInFlight = true;
                    keepAliveFiredCount++;
                    this.log.info('prompt_caching_keepalive_sending', { count: keepAliveFiredCount });
                    try {
                        const keepAliveBody = buildKeepAliveBody();
                        const ok = await this.sendKeepAliveRequest(httpRequest, keepAliveBody);
                        if (ok) {
                            this.log.info('prompt_caching_keepalive_sent', { count: keepAliveFiredCount });
                            idleTimeoutHandle.reset();
                        }
                        return ok;
                    } catch (err: any) {
                        this.log.warn('prompt_caching_keepalive_failed', { error: err.message });
                        return false;
                    } finally {
                        keepAliveInFlight = false;
                    }
                };

                if (keepAliveEnabled) {
                    // 首个保活请求的调度时机：
                    // - 缓存 TTL 是 5 分钟，首个保活最晚不得晚于 4 分钟；
                    // - 但如果流的空闲超时更短（默认 120s），固定 4 分 30 秒的首发会晚于
                    //   空闲超时触发——上游静默思考期间流已被固定超时掐断，保活根本来不及。
                    //   因此首发提前到「空闲超时前 10 秒」（下限 30s、上限 4 分钟），
                    //   保活成功即刷新流空闲超时，后续按 4 分 30 秒的缓存节奏继续。
                    const streamTimeout = httpRequest.timeout || 120000;
                    const firstKeepAliveDelay = Math.min(240000, Math.max(streamTimeout - 10000, 30000));
                    const scheduleNextKeepAlive = (delay: number) => {
                        if (streamFinished) return;
                        keepAliveTimer = setTimeout(() => {
                            void fireKeepAlive().then(() => scheduleNextKeepAlive(270000));
                        }, delay);
                    };
                    scheduleNextKeepAlive(firstKeepAliveDelay);
                }

                // 逐块解析和产出
                let sawDone = false;
                let yieldedContent = false;
                for await (const rawChunk of stream) {
                    try {
                        const chunk = formatter.parseStreamChunk(rawChunk);
                        // 检测是否有工具调用（用于决定流结束时是否需要退出保活）
                        if (!hasToolUse && chunk.delta.some(p => p.functionCall)) {
                            hasToolUse = true;
                        }
                        if (chunk.done) sawDone = true;
                        if (streamChunkHasContent(chunk)) yieldedContent = true;
                        yieldedAny = true;
                        yield chunk;
                    } catch (error) {
                        // formatter 主动抛出的 ChannelError（如上游在 SSE 流里内联的 error 事件）
                        // 已经带了准确的类型和上游原文，再包一层 PARSE_ERROR 会把「上游返回 429」
                        // 说成「解析失败」，也会改变重试判定
                        if (error instanceof ChannelError) {
                            throw error;
                        }
                        throw new ChannelError(
                            ErrorType.PARSE_ERROR,
                            t('modules.channel.errors.parseStreamChunkFailed', { error: error instanceof Error ? error.message : t('errors.unknown') }),
                            { chunk: rawChunk, error }
                        );
                    }
                }

                // 完整性检测：HTTP 200 但流式响应不完整（上游/代理中途掐断连接时
                // for-await 会静默正常结束而不抛错，此前会被当成「正常完成」）。
                // - 从未收到 done 标记且从未产出内容（无文本/思考/工具调用）：空响应，
                //   可安全重试（前端无显示、无已启动的工具副作用）；
                // - 已产出内容但未收到 done 标记：流被截断，显式抛错（不再把半截内容
                //   当完整成功）；已产出内容无法安全自动重试（重播会与已显示内容重复，
                //   且流式早启动的工具副作用无法撤回），错误透传给调用方/前端。
                if (!sawDone) {
                    if (!yieldedContent) {
                        // 空响应：未产出任何内容（前端无显示、无已启动的工具副作用），
                        // 用专门的错误类型标记为可重试（不受 yieldedAny 阻止）。
                        throw new ChannelError(
                            ErrorType.EMPTY_RESPONSE_ERROR,
                            t('modules.channel.errors.emptyResponse')
                        );
                    }
                    this.log.warn('stream_truncated_detected', {
                        conversationId: request.conversationId,
                        configId: request.configId
                    });
                    throw new ChannelError(
                        ErrorType.API_ERROR,
                        t('modules.channel.errors.streamTruncated')
                    );
                }
                
                // 流正常结束：如果无工具调用且保活未触发过且已过 4 分钟，额外保活一次
                // 防止用户下一轮输入时缓存刚好过期
                if (keepAliveEnabled && !hasToolUse && keepAliveFiredCount === 0) {
                    const elapsed = Date.now() - requestStartTime;
                    if (elapsed >= 240000) {  // 4 分钟 = 240000ms
                        this.log.info('prompt_caching_exit_keepalive_sending', { elapsed });
                        await fireKeepAlive();
                    }
                }

                // 重试成功通知：必须放在「本次尝试真正跑完」之后——
                // executeStreamRequest 是异步生成器，await 它只会拿到生成器对象，
                // 请求实际尚未发出；若在创建后立即通知 retrySuccess，
                // 重试页面会在重试请求真正完成前就消失（且重试再次失败时会闪现错误）。
                // 只有走到这里（for-await 正常结束、无异常），重试才算成功。
                if (attempt > 1) {
                    notifyRetryStatus({
                        type: 'retrySuccess',
                        attempt: attempt - 1,
                        maxAttempts: maxRetries,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }

                // 正常完成，退出重试循环
                return;
            } catch (error) {
                lastError = error;
                
                // 已产出内容后不再重试：流中途出错（网络闪断等）时重试会从头重播，
                // 已 yield 的内容无法撤回（累加器跨重试不重置），导致内容重复、
                // 历史写入重复内容。请求建立阶段（尚未产出任何 chunk）仍可重试。
                // 例外：EMPTY_RESPONSE_ERROR（从未产出内容）可安全重试。
                const isRetryableEmpty = error instanceof ChannelError
                    && error.type === ErrorType.EMPTY_RESPONSE_ERROR;
                if (yieldedAny && !isRetryableEmpty) {
                    break;
                }
                
                // 获取错误详情
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                const errorDetails = error instanceof ChannelError ? error.details : undefined;
                
                // 检查是否可重试
                if (!retryEnabled || !this.isRetryableError(error) || attempt >= totalAttempts) {
                    // 不能重试或已达到最大重试次数
                    if (attempt > 1) {
                        notifyRetryStatus({
                            type: 'retryFailed',
                            attempt: Math.min(maxRetries, attempt - 1),
                            maxAttempts: maxRetries,
                            error: errorMessage,
                            errorDetails,
                            createdAt: Date.now(),
                            conversationId: request.conversationId
                        });
                    }
                    break;
                }
                
                // 在调用重试回调之前检查是否已取消
                if (request.abortSignal?.aborted) {
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
                    );
                }
                
                // 通知前端正在重试
                notifyRetryStatus({
                    type: 'retrying',
                    attempt,
                    maxAttempts: maxRetries,
                    error: errorMessage,
                    errorDetails,
                    nextRetryIn: retryInterval,
                    createdAt: Date.now(),
                    conversationId: request.conversationId
                });
                
                // 等待后重试（支持取消）—— 先停保活调度：错误后到 delay 完成之间定时器仍存活，
                // 会在无活动流时发出保活请求
                streamFinished = true;
                if (keepAliveTimer) {
                    clearTimeout(keepAliveTimer);
                    keepAliveTimer = undefined;
                }
                await this.delay(retryInterval, request.abortSignal);
            } finally {
                // 清理保活调度定时器（兜底）
                streamFinished = true;
                if (keepAliveTimer) {
                    clearTimeout(keepAliveTimer);
                    keepAliveTimer = undefined;
                }
            }
        }
        
        // 所有重试都失败
        if (lastError instanceof ChannelError) {
            throw lastError;
        }
        throw new ChannelError(
            ErrorType.NETWORK_ERROR,
            t('modules.channel.errors.streamRequestFailed', { error: lastError instanceof Error ? lastError.message : t('errors.unknown') }),
            lastError
        );
    }
    
    /**
     * 获取有效的代理 URL
     */
    private getProxyUrl(): string | undefined {
        return this.settingsManager?.getEffectiveProxyUrl();
    }

    /**
     * 发送缓存保活请求
     *
     * 用于在流式请求进行中刷新 Anthropic Prompt Caching 的 5 分钟 TTL。
     * 保活请求使用与主请求相同的 headers/URL，但 max_tokens=5、stream=false。
     *
     * 修复点：
     * - 旧实现不检查 response.ok：非 2xx（429/5xx/错误体）也被当成「保活成功」，
     *   缓存 TTL 实际已过期却静默继续，下一轮对话全价计费；
     * - 瞬时网络失败不重试：一次闪断直接丢失一次 TTL 刷新窗口；
     * - 返回布尔值供调用方判断「上游确实接受了保活」，成功后刷新流的空闲超时。
     *
     * @param httpRequest 主请求选项（用于复用 URL 和 headers）
     * @param keepAliveBody 保活请求体（已设置 max_tokens=5, stream=false）
     * @returns true = 上游 2xx 接受（缓存 TTL 已刷新）
     */
    private async sendKeepAliveRequest(
        httpRequest: HttpRequestOptions,
        keepAliveBody: any
    ): Promise<boolean> {
        const { url, method, headers } = httpRequest;
        const proxyUrl = this.getProxyUrl();
        const fetchFn = createProxyFetch(proxyUrl);

        // 保活请求有独立的短超时；瞬时失败重试一次（保活窗口错过即缓存过期）
        const ATTEMPTS = 2;
        const RETRY_DELAY_MS = 500;

        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetchFn(url, {
                    method,
                    headers,
                    body: JSON.stringify(keepAliveBody),
                    signal: controller.signal
                });
                // 读取并丢弃响应体，确保连接正常关闭
                await response.text().catch(() => {});
                if (!response.ok) {
                    // 非 2xx：上游明确拒绝了本次刷新，不能算保活成功
                    throw new ChannelError(
                        ErrorType.API_ERROR,
                        t('modules.channel.errors.apiError', { status: response.status })
                    );
                }
                return true;
            } catch (error: any) {
                const timedOut = error?.name === 'AbortError';
                if (timedOut || attempt >= ATTEMPTS - 1) {
                    throw error instanceof ChannelError
                        ? error
                        : new ChannelError(ErrorType.NETWORK_ERROR, error?.message || 'Keep-alive request failed', error);
                }
                // 短暂等待后重试（重试期间不阻塞流本身）
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            } finally {
                clearTimeout(timeoutId);
            }
        }
        return false;
    }
    
    /**
     * 执行 HTTP 请求
     *
     * @param options 请求选项
     * @param externalSignal 外部取消信号
     * @returns HTTP 响应
     */
    private async executeRequest(options: HttpRequestOptions, externalSignal?: AbortSignal): Promise<HttpResponse> {
        const { url, method, headers, body, timeout = 60000 } = options;
        // timeout 钳制：非法值（非数字/NaN/负数/0）归一到 60000，上限 1 小时，防止 NaN 进入 setTimeout
        const effectiveTimeout = Number.isFinite(timeout) && timeout > 0
            ? Math.min(timeout, 3600000)
            : 60000;
        const proxyUrl = this.getProxyUrl();
        
        // 使用代理 fetch 或原生 fetch
        const fetchFn = createProxyFetch(proxyUrl);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
        
        // 监听外部取消信号
        const onExternalAbort = () => controller.abort();
        if (externalSignal) {
            externalSignal.addEventListener('abort', onExternalAbort);
        }
        
        try {
            const response = await fetchFn(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            
            // 先判状态再读体：代理网关常回 HTML/纯文本错误体（429/5xx），
            // 直接 response.json() 会抛 SyntaxError，真实状态码与上游错误信息全部丢失。
            // 用 status 区间判断而非 response.ok：测试与代理实现中可能缺少 ok 属性（等价语义）
            const status = response.status ?? 0;
            if (status < 200 || status >= 300) {
                let errorBody: any;
                try {
                    errorBody = await response.json();
                } catch {
                    errorBody = await response.text();
                }
                const upstreamMessage = extractUpstreamErrorMessage(errorBody);
                throw new ChannelError(
                    ErrorType.API_ERROR,
                    upstreamMessage
                        ? `HTTP ${status}: ${upstreamMessage}`
                        : t('modules.channel.errors.apiError', { status }),
                    errorBody
                );
            }
            
            // 正常响应：优先按 JSON 解析，非 JSON（text/plain 等）降级为文本
            let responseBody: any;
            try {
                responseBody = await response.json();
            } catch {
                responseBody = await response.text();
            }
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            
            return {
                status: response.status,
                headers: responseHeaders,
                body: responseBody
            };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                // 检查是外部取消还是超时
                if (externalSignal?.aborted) {
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
                    );
                }
                throw new ChannelError(
                    ErrorType.TIMEOUT_ERROR,
                    t('modules.channel.errors.requestTimeout', { timeout: effectiveTimeout })
                );
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            // 移除外部信号监听
            if (externalSignal) {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        }
    }
    
    /**
     * 执行流式 HTTP 请求
     *
     * @param options 请求选项
     * @param externalSignal 外部取消信号
     * @param idleTimeoutHandle 可选：暴露空闲超时重置函数。
     *        调用方（LLM 保活模块）在保活请求成功后调用 handle.reset()，
     *        把「上游连接仍然活跃」视为流的活性信号，刷新固定超时计时。
     * @returns 异步生成器，产生原始响应块
     */
    private async *executeStreamRequest(
        options: HttpRequestOptions,
        externalSignal?: AbortSignal,
        idleTimeoutHandle?: { reset: () => void }
    ): AsyncGenerator<any> {
        const { url, method, headers, body, timeout = 120000 } = options;
        // timeout 钳制：非法值（非数字/NaN/负数/0）归一到 60000，上限 1 小时，防止 NaN 进入 setTimeout
        const effectiveTimeout = Number.isFinite(timeout) && timeout > 0
            ? Math.min(timeout, 3600000)
            : 60000;
        const proxyUrl = this.getProxyUrl();
        
        const controller = new AbortController();
        
        // 使用可重置的超时机制
        // 每次收到有效内容时重置超时，避免模型慢速生成时被误判为超时
        let timeoutId: NodeJS.Timeout | undefined;
        let isTimedOut = false;
        
        const resetTimeout = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            timeoutId = setTimeout(() => {
                isTimedOut = true;
                controller.abort();
            }, effectiveTimeout);
        };
        
        // 把重置函数暴露给调用方：LLM 保活请求成功后可刷新流的空闲超时
        if (idleTimeoutHandle) {
            idleTimeoutHandle.reset = resetTimeout;
        }
        
        // 初始化超时
        resetTimeout();
        
        // 监听外部取消信号
        const onExternalAbort = () => controller.abort();
        if (externalSignal) {
            externalSignal.addEventListener('abort', onExternalAbort);
        }
        
        try {
            let parsedChunkCount = 0;
            // 流结束时仍无法解析的原始内容（上游用纯文本 / HTML 报错时就落在这里）
            let unparsedTail = '';

            // 使用代理流式请求
            if (proxyUrl) {
                let buffer = '';
                // PERF：offset 游标——已解析前缀不参与后续拼接与解析，
                // 每包只复制「未解析尾部 + 新块」，避免对整段累积缓冲重复复制（O(n²)）
                let bufferOffset = 0;
                // 未知格式整段残留标记：parseStreamBuffer 无法识别流格式时把整段缓冲原样
                // 作为 remaining 返回（同一引用），需要完整累积后才能识别格式——此时不清空、
                // 不压缩，保持「完整累积后识别格式」的既有语义（上限由硬限制保护）
                let pendingWholeBuffer = false;
                
                for await (const chunk of proxyStreamFetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    timeout: effectiveTimeout,
                    signal: controller.signal
                }, proxyUrl)) {
                    // 检查是否已取消
                    if (externalSignal?.aborted) {
                        break;
                    }
                    
                    // 收到数据，重置超时计时器
                    resetTimeout();
                    
                    // 压缩已解析前缀后再追加新块
                    if (pendingWholeBuffer) {
                        // 未知格式：保持完整累积
                    } else if (bufferOffset > 0) {
                        buffer = buffer.slice(bufferOffset);
                        bufferOffset = 0;
                    } else {
                        buffer = '';
                    }
                    buffer += chunk;

                    // 缓冲硬上限：上游异常/恶意代理持续发“永远解析不出”的数据时
                    // 立即失败，避免内存无限增长
                    if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
                        throw new ChannelError(
                            ErrorType.NETWORK_ERROR,
                            t('modules.channel.errors.streamBufferTooLarge', { limit: MAX_STREAM_BUFFER_CHARS })
                        );
                    }
                    
                    // 处理流式响应（解析窗口只含未解析尾部 + 新块）
                    const result = parseStreamBuffer(buffer);
                    parsedChunkCount += result.chunks.length;
                    if (result.remaining === buffer) {
                        pendingWholeBuffer = true;
                        bufferOffset = 0;
                    } else {
                        pendingWholeBuffer = false;
                        bufferOffset = result.remaining.length;
                    }

                    
                    for (const parsed of result.chunks) {
                        yield parsed;
                    }
                }
                
                // 处理剩余的 buffer（用户已取消时不产出半截残留：原生 fetch 分支在 abort 时
                // reader.read() 直接抛错，根本走不到这里，两条路径保持一致）
                const finalTail = pendingWholeBuffer
                    ? buffer
                    : (bufferOffset > 0 ? buffer.slice(bufferOffset) : '');
                if (!externalSignal?.aborted && finalTail.trim()) {
                    const result = parseStreamBuffer(finalTail, true);
                    parsedChunkCount += result.chunks.length;
                    unparsedTail = result.unparsed || '';

                    for (const chunk of result.chunks) {
                        yield chunk;
                    }
                }
                
                // 检查是否被外部取消：proxyStreamFetch 在信号中止时会优雅结束而非抛错，
                // 若不显式抛出，generateStream 会把半截流当成「正常结束」，调用方把不完整
                // 内容当完整助手消息落盘。与原生 fetch 分支（AbortError → CANCELLED_ERROR）
                // 保持一致；顺序上先判取消再判超时（原生 catch 同样优先 CANCELLED_ERROR）。
                if (externalSignal?.aborted) {
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
                    );
                }
                
                // 检查是否因超时而结束（proxyStreamFetch 在信号中止时会 break 而非 throw）
                if (isTimedOut) {
                    throw new ChannelError(
                        ErrorType.TIMEOUT_ERROR,
                        t('modules.channel.errors.requestTimeoutNoResponse', { timeout: effectiveTimeout })
                    );
                }
            } else {
                // 原生 fetch 流式请求
                const response = await fetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal
                });
                
                if (!response.ok) {
                    // 尝试获取错误详情
                    let errorBody: any;
                    try {
                        errorBody = await response.json();
                    } catch {
                        errorBody = await response.text();
                    }
                    const upstreamMessage = extractUpstreamErrorMessage(errorBody);
                    throw new ChannelError(
                        ErrorType.API_ERROR,
                        upstreamMessage
                            ? `HTTP ${response.status}: ${upstreamMessage}`
                            : t('modules.channel.errors.apiError', { status: response.status }),
                        errorBody
                    );
                }
                
                if (!response.body) {
                    throw new ChannelError(
                        ErrorType.NETWORK_ERROR,
                        t('modules.channel.errors.noResponseBody')
                    );
                }
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            // 最终冲刷：末块被切开的 UTF-8 多字节字符尾部缓存在 decoder 内部，
                            // 缺这一步会导致最后一个字符丢失/乱码。
                            buffer += decoder.decode();
                            break;
                        }
                        
                        // 收到数据，重置超时计时器
                        resetTimeout();
                        
                        buffer += decoder.decode(value, { stream: true });

                        // 缓冲硬上限：上游异常/恶意代理持续发“永远解析不出”的数据时
                        // 立即失败，避免内存无限增长
                        if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
                            throw new ChannelError(
                                ErrorType.NETWORK_ERROR,
                                t('modules.channel.errors.streamBufferTooLarge', { limit: MAX_STREAM_BUFFER_CHARS })
                            );
                        }
                        
                        // 处理流式响应
                        const result = parseStreamBuffer(buffer);
                        buffer = result.remaining;
                        parsedChunkCount += result.chunks.length;

                        
                        for (const chunk of result.chunks) {
                            yield chunk;
                        }
                    }
                    
                    // 处理剩余的 buffer
                    if (buffer.trim()) {
                        const result = parseStreamBuffer(buffer, true);
                        parsedChunkCount += result.chunks.length;
                        unparsedTail = result.unparsed || '';

                        for (const chunk of result.chunks) {
                            yield chunk;
                        }
                    }
                    
                    // 检查是否因超时而结束
                    if (isTimedOut) {
                        throw new ChannelError(
                            ErrorType.TIMEOUT_ERROR,
                            t('modules.channel.errors.requestTimeoutNoResponse', { timeout: effectiveTimeout })
                        );
                    }
                } finally {
                    reader.releaseLock();
                }
            }

            // 流式连接结束但未解析出任何有效 chunk：
            // 常见于本地代理/抓包链路提前断开，被误判为“正常结束”。
            // 显式抛网络错误，触发上层重试并避免前端出现空消息。
            //
            // 另一种同样常见的情况是上游根本没按约定格式回：网关的 502 HTML、代理的纯文本错误。
            // 这些内容过去在缓冲区里被静默丢弃，用户只能看到一句「没有响应体」，再往前端走就成了
            // 「模型返回空内容」——上游其实已经说明了原因。这里把原文一并带出去。
            if (!externalSignal?.aborted && parsedChunkCount === 0) {
                const rawResponse = unparsedTail.trim();
                throw new ChannelError(
                    ErrorType.NETWORK_ERROR,
                    t('modules.channel.errors.streamRequestFailed', {
                        error: rawResponse
                            ? (rawResponse.length > 800 ? `${rawResponse.slice(0, 800)}…` : rawResponse)
                            : t('modules.channel.errors.noResponseBody')
                    }),
                    rawResponse ? { rawResponse } : undefined
                );
            }
        } catch (error) {
            if (error instanceof ChannelError) {
                throw error;
            }
            if (error instanceof Error && error.name === 'AbortError') {
                // 检查是外部取消还是超时
                if (externalSignal?.aborted) {
                    // 用户手动取消，使用 CANCELLED_ERROR，不应重试
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
                    );
                }
                if (isTimedOut) {
                    throw new ChannelError(
                        ErrorType.TIMEOUT_ERROR,
                        t('modules.channel.errors.requestTimeoutNoResponse', { timeout: effectiveTimeout })
                    );
                }
                throw new ChannelError(
                    ErrorType.NETWORK_ERROR,
                    t('modules.channel.errors.requestAborted')
                );
            }
            throw new ChannelError(
                ErrorType.NETWORK_ERROR,
                t('modules.channel.errors.streamRequestFailed', { error: error instanceof Error ? error.message : t('errors.unknown') }),
                error
            );
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            // 生成器终止后把手柄复位为 no-op：在途保活请求成功后若仍回调 reset()，
            // 会重建一个永不清理的空闲超时定时器（挂起引用 + 120s 后 abort 已废弃的 controller）。
            if (idleTimeoutHandle) {
                idleTimeoutHandle.reset = () => {};
            }
            // 移除外部信号监听
            if (externalSignal) {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        }
    }
    
    /**
     * 获取过滤后的工具声明
     *
     * 根据 SettingsManager 的配置过滤启用的工具
     * 同时合并 MCP 服务器提供的工具
     * 所有工具的 schema 都会被清理，移除不支持的字段
     *
     * 修改原因：主会话工具声明过去在本方法内与 ToolDeclarationResolver 各写一份，
     * 导致 read_file 多模态描述、图片工具过滤、MCP schema 清理等逻辑容易漏同步。
     * 修改方式：本方法改为委托 ToolDeclarationResolver.resolve()，透传调用点参数。
     * 修改目的：主会话与 SubAgent 共用同一工具声明入口。
     *
     * @param multimodalEnabled 是否启用多模态工具
     * @param channelType 渠道类型
     * @param toolMode 工具调用模式
     * @param promptModeSnapshot 本次请求的提示词模式快照（toolPolicy 作为 allowlist）
     */
    private getFilteredTools(
        multimodalEnabled?: boolean,
        channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
        toolMode?: 'function_call' | 'xml' | 'json',
        promptModeSnapshot?: ResolvedPromptModeSnapshot
    ): ToolDeclaration[] | undefined {
        return this.toolResolver.resolve({
            multimodalEnabled,
            channelType,
            toolMode,
            promptModeSnapshot
        });
    }
    
    /**
     * 清理资源（如果需要）
     */
    async dispose(): Promise<void> {
        // 目前无需特殊清理
    }
}
