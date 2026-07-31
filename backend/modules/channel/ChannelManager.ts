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
import { createReadFileTool } from '../../tools/file/read_file';
import { createGenerateImageTool, createRemoveBackgroundTool, createCropImageTool, createResizeImageTool, createRotateImageTool } from '../../tools/media';
import { subAgentRegistry } from '../../tools/subagents';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions,
    HttpResponse
} from './types';
import { ChannelError, ErrorType } from './types';
import { createProxyFetch, proxyStreamFetch } from './proxyFetch';
import { Logger } from '../../core/logger';
import { validateHistoryIntegrity } from './HistoryIntegrityValidator';
import { parseStreamBuffer } from './streamBufferParser';

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
    private mcpManager?: McpManager;
    private retryStatusCallback?: RetryStatusCallback;
    private readonly log = Logger.get('ChannelManager');
    
    constructor(
        private configManager: ConfigManager,
        private toolRegistry?: ToolRegistry,
        private settingsManager?: SettingsManager
    ) {}
    
    /**
     * 设置重试状态回调
     */
    setRetryStatusCallback(callback: RetryStatusCallback): void {
        this.retryStatusCallback = callback;
    }
    
    /**
     * 设置 MCP 管理器（用于获取 MCP 工具声明）
     */
    setMcpManager(mcpManager: McpManager): void {
        this.mcpManager = mcpManager;
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
            
            const timeoutId = setTimeout(() => {
                // 正常超时路径：移除 abort 监听器，避免每次重试等待都在同一信号上累积监听器
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
                resolve();
            }, ms);
            
            // 监听取消信号
            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new ChannelError(
                    ErrorType.CANCELLED_ERROR,
                    t('modules.channel.errors.requestCancelled')
                ));
            };
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
        const maxRetries = (config as any).retryCount ?? 3;         // 默认3次
        const retryInterval = (config as any).retryInterval ?? 3000;  // 默认3秒
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;
        
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
                if (attempt > 1 && this.retryStatusCallback && !request.suppressRetryNotification) {
                    this.retryStatusCallback({
                        type: 'retrySuccess',
                        attempt: attempt - 1,
                        maxAttempts: maxRetries,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }
                
                // 解析响应
                try {
                    return formatter.parseResponse(httpResponse.body);
                } catch (error) {
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
                    if (attempt > 1 && this.retryStatusCallback && !request.suppressRetryNotification) {
                        this.retryStatusCallback({
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
                if (this.retryStatusCallback && !request.suppressRetryNotification) {
                    this.retryStatusCallback({
                        type: 'retrying',
                        attempt,
                        maxAttempts: maxRetries,
                        error: errorMessage,
                        errorDetails,
                        nextRetryIn: retryInterval,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }
                
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
        
        // 5. 构建请求
        const httpRequest = formatter.buildRequest(request, config, tools);
        
        // 5.5 缓存保活：当 promptCachingKeepAlive 启用时，若流式请求在 4 分 30 秒内未完成则自动发送保活请求
        const keepAliveEnabled = config.type === 'anthropic'
            && (config as any).promptCachingEnabled
            && (config as any).promptCachingKeepAlive
            && ((config as any).promptCachingTtl || '5m') === '5m';
        // 保活请求：max_tokens=5, stream=false，其余参数与主请求一致
        const buildKeepAliveBody = () => {
            const body = JSON.parse(JSON.stringify(httpRequest.body));
            body.max_tokens = 5;
            body.stream = false;
            return body;
        };
        
        // 6. 获取重试配置
        // 如果请求指定 skipRetry，则禁用重试
        const retryEnabled = request.skipRetry ? false : ((config as any).retryEnabled ?? true);  // 默认启用重试
        const maxRetries = (config as any).retryCount ?? 3;         // 默认3次
        const retryInterval = (config as any).retryInterval ?? 3000;  // 默认3秒
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;
        
        // 7. 执行流式请求（带重试）
        let lastError: any;
        // 已向下游产出过 chunk：一旦产出过内容就不可重试——
        // 已 yield 的文本/工具卡无法撤回，重试会从零开始重复整段响应（内容重复、历史重复）。
        let hasYieldedChunk = false;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            // 缓存保活定时器（每次重试都重新计时）
            let keepAliveTimer: NodeJS.Timeout | undefined;
            
            try {
                const stream = await this.executeStreamRequest(httpRequest, request.abortSignal);
                
                // 如果是重试成功，通知前端
                if (attempt > 1 && this.retryStatusCallback && !request.suppressRetryNotification) {
                    this.retryStatusCallback({
                        type: 'retrySuccess',
                        attempt: attempt - 1,
                        maxAttempts: maxRetries,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }
                
                // 启动缓存保活循环定时器（每 4 分 30 秒 = 270000ms 发一次保活请求）
                const requestStartTime = Date.now();
                let keepAliveFiredCount = 0;
                let hasToolUse = false;
                
                if (keepAliveEnabled) {
                    keepAliveTimer = setInterval(async () => {
                        keepAliveFiredCount++;
                        this.log.info('prompt_caching_keepalive_sending', { count: keepAliveFiredCount });
                        try {
                            const keepAliveBody = buildKeepAliveBody();
                            await this.sendKeepAliveRequest(httpRequest, keepAliveBody);
                            this.log.info('prompt_caching_keepalive_sent', { count: keepAliveFiredCount });
                        } catch (err: any) {
                            this.log.warn('prompt_caching_keepalive_failed', { error: err.message });
                        }
                    }, 270000);
                }
                
                // 逐块解析和产出
                for await (const rawChunk of stream) {
                    try {
                        const chunk = formatter.parseStreamChunk(rawChunk);
                        // 检测是否有工具调用（用于决定流结束时是否需要退出保活）
                        if (!hasToolUse && chunk.delta.some(p => p.functionCall)) {
                            hasToolUse = true;
                        }
                        hasYieldedChunk = true;
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
                
                // 流正常结束：如果无工具调用且保活未触发过且已过 4 分钟，额外保活一次
                // 防止用户下一轮输入时缓存刚好过期
                if (keepAliveEnabled && !hasToolUse && keepAliveFiredCount === 0) {
                    const elapsed = Date.now() - requestStartTime;
                    if (elapsed >= 240000) {  // 4 分钟 = 240000ms
                        this.log.info('prompt_caching_exit_keepalive_sending', { elapsed });
                        try {
                            const keepAliveBody = buildKeepAliveBody();
                            await this.sendKeepAliveRequest(httpRequest, keepAliveBody);
                            this.log.info('prompt_caching_exit_keepalive_sent');
                        } catch (err: any) {
                            this.log.warn('prompt_caching_exit_keepalive_failed', { error: err.message });
                        }
                    }
                }
                
                // 正常完成，退出重试循环
                return;
            } catch (error) {
                lastError = error;
                
                // 获取错误详情
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                const errorDetails = error instanceof ChannelError ? error.details : undefined;
                
                // 检查是否可重试
                // hasYieldedChunk：流已产出过内容，重试会从零开始重复整段响应（已 yield 的内容无法撤回），禁止重试
                if (!retryEnabled || hasYieldedChunk || !this.isRetryableError(error) || attempt >= totalAttempts) {
                    // 不能重试或已达到最大重试次数
                    if (attempt > 1 && this.retryStatusCallback && !request.suppressRetryNotification) {
                        this.retryStatusCallback({
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
                if (this.retryStatusCallback && !request.suppressRetryNotification) {
                    this.retryStatusCallback({
                        type: 'retrying',
                        attempt,
                        maxAttempts: maxRetries,
                        error: errorMessage,
                        errorDetails,
                        nextRetryIn: retryInterval,
                        createdAt: Date.now(),
                        conversationId: request.conversationId
                    });
                }
                
                // 等待后重试（支持取消）。
                // 先停保活定时器再进入等待：错误后到 delay 完成之间若定时器仍存活，
                // 会在无活动流时发出保活请求（审查报告 L）。
                if (keepAliveTimer) {
                    clearInterval(keepAliveTimer);
                    keepAliveTimer = undefined;
                }
                await this.delay(retryInterval, request.abortSignal);
            } finally {
                // 清理保活循环定时器
                if (keepAliveTimer) {
                    clearInterval(keepAliveTimer);
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
     * 发送缓存保活请求（fire-and-forget）
     *
     * 用于在流式请求进行中刷新 Anthropic Prompt Caching 的 5 分钟 TTL。
     * 保活请求使用与主请求相同的 headers/URL，但 max_tokens=5、stream=false。
     *
     * @param httpRequest 主请求选项（用于复用 URL 和 headers）
     * @param keepAliveBody 保活请求体（已设置 max_tokens=5, stream=false）
     */
    private async sendKeepAliveRequest(
        httpRequest: HttpRequestOptions,
        keepAliveBody: any
    ): Promise<void> {
        const { url, method, headers } = httpRequest;
        const proxyUrl = this.getProxyUrl();
        const fetchFn = createProxyFetch(proxyUrl);

        // 保活请求有独立的短超时
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
        } finally {
            clearTimeout(timeoutId);
        }
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
        const proxyUrl = this.getProxyUrl();
        
        // 使用代理 fetch 或原生 fetch
        const fetchFn = createProxyFetch(proxyUrl);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
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
            
            // 解析响应体
            const responseBody = await response.json();
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
                    t('modules.channel.errors.requestTimeout', { timeout })
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
     * @returns 异步生成器，产生原始响应块
     */
    private async *executeStreamRequest(
        options: HttpRequestOptions,
        externalSignal?: AbortSignal
    ): AsyncGenerator<any> {
        const { url, method, headers, body, timeout = 120000 } = options;
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
            }, timeout);
        };
        
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
                
                for await (const chunk of proxyStreamFetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    timeout,
                    signal: controller.signal
                }, proxyUrl)) {
                    // 检查是否已取消
                    if (externalSignal?.aborted) {
                        break;
                    }
                    
                    // 收到数据，重置超时计时器
                    resetTimeout();
                    
                    buffer += chunk;
                    
                    // 处理流式响应
                    const result = parseStreamBuffer(buffer);
                    buffer = result.remaining;
                    parsedChunkCount += result.chunks.length;

                    
                    for (const parsed of result.chunks) {
                        yield parsed;
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
                
                // 检查是否因超时而结束（proxyStreamFetch 在信号中止时会 break 而非 throw）
                if (isTimedOut) {
                    throw new ChannelError(
                        ErrorType.TIMEOUT_ERROR,
                        t('modules.channel.errors.requestTimeoutNoResponse', { timeout })
                    );
                }
                // 外部取消：代理路径的生成器在信号中止时静默结束，若不显式抛错
                // 会被当作"正常完成"提交空内容/部分内容，前端收不到 cancelled（审查报告 H4）。
                if (externalSignal?.aborted) {
                    throw new ChannelError(
                        ErrorType.CANCELLED_ERROR,
                        t('modules.channel.errors.requestCancelled')
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
                        if (done) break;
                        
                        // 收到数据，重置超时计时器
                        resetTimeout();
                        
                        buffer += decoder.decode(value, { stream: true });
                        
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
                            t('modules.channel.errors.requestTimeoutNoResponse', { timeout })
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
                        t('modules.channel.errors.requestTimeoutNoResponse', { timeout })
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
     * @param multimodalEnabled 是否启用多模态工具
     * @param channelType 渠道类型
     * @param toolMode 工具调用模式
     */
    private getFilteredTools(
        multimodalEnabled?: boolean,
        channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
        toolMode?: 'function_call' | 'xml' | 'json',
        promptModeSnapshot?: ResolvedPromptModeSnapshot
    ) {
        // 获取本次请求模式的工具策略（allowlist）
        const allowlist = Array.isArray(promptModeSnapshot?.toolPolicy) && promptModeSnapshot.toolPolicy.length > 0
            ? promptModeSnapshot.toolPolicy
            : undefined;
        
        const tools: any[] = [];
        
        // 1. 获取内置工具
        if (this.toolRegistry) {
            let builtinTools: any[] | undefined;
            
            if (this.settingsManager) {
                // 使用设置管理器过滤工具
                builtinTools = this.toolRegistry.getDeclarationsBy(
                    toolName => this.settingsManager!.isToolEnabled(toolName)
                );
            } else {
                // 没有设置管理器，返回所有工具
                builtinTools = this.toolRegistry.getAllDeclarations();
            }
            
            // 清理内置工具的 schema，并动态更新特定工具的描述
            if (builtinTools) {
                for (const tool of builtinTools) {
                    let declaration = { ...tool };
                    
                    // 对 read_file 工具动态生成描述
                    if (tool.name === 'read_file') {
                        const dynamicTool = createReadFileTool(multimodalEnabled, channelType, toolMode);
                        declaration = {
                            ...declaration,
                            description: dynamicTool.declaration.description,
                            parameters: dynamicTool.declaration.parameters
                        };
                    }
                    
                    // 对 generate_image 工具：
                    // 1. 未启用多模态时不包含此工具
                    // 2. OpenAI Function Call 模式不包含此工具（不支持多模态返回）
                    if (tool.name === 'generate_image') {
                        // 检查是否应该排除此工具
                        const shouldExclude = !multimodalEnabled ||
                            (channelType === 'openai' && toolMode === 'function_call');
                        
                        if (shouldExclude) {
                            continue;  // 跳过此工具
                        }
                        
                        // 从设置获取配置
                        const imageConfig = this.settingsManager?.getGenerateImageConfig();
                        const maxBatchTasks = imageConfig?.maxBatchTasks || 5;
                        const maxImagesPerTask = imageConfig?.maxImagesPerTask || 1;
                        
                        // 构建参数配置
                        const paramsConfig = {
                            enableAspectRatio: imageConfig?.enableAspectRatio ?? false,
                            forcedAspectRatio: imageConfig?.defaultAspectRatio || undefined,
                            enableImageSize: imageConfig?.enableImageSize ?? false,
                            forcedImageSize: imageConfig?.defaultImageSize || undefined
                        };
                        
                        // 根据配置动态创建工具（影响工具参数定义）
                        const dynamicTool = createGenerateImageTool(maxBatchTasks, maxImagesPerTask, paramsConfig);
                        declaration = {
                            ...declaration,
                            description: dynamicTool.declaration.description,
                            parameters: dynamicTool.declaration.parameters  // 使用动态生成的参数定义
                        };
                    }
                    
                    // 对 remove_background 工具：
                    // 1. 未启用多模态时不包含此工具
                    // 2. OpenAI Function Call 模式不包含此工具（不支持多模态返回）
                    if (tool.name === 'remove_background') {
                        // 检查是否应该排除此工具
                        const shouldExclude = !multimodalEnabled ||
                            (channelType === 'openai' && toolMode === 'function_call');
                        
                        if (shouldExclude) {
                            continue;  // 跳过此工具
                        }
                        
                        // 从设置获取配置（复用 generate_image 配置的批量限制）
                        const imageConfig = this.settingsManager?.getGenerateImageConfig();
                        const maxBatchTasks = imageConfig?.maxBatchTasks || 5;
                        const dynamicTool = createRemoveBackgroundTool(maxBatchTasks);
                        declaration = { ...declaration, description: dynamicTool.declaration.description };
                    }
                    
                    // 对 crop_image 工具：
                    // 1. 未启用多模态时不包含此工具（需要读取和返回图片）
                    // 2. OpenAI Function Call 模式不包含此工具（不支持多模态返回）
                    if (tool.name === 'crop_image') {
                        // 检查是否应该排除此工具
                        const shouldExclude = !multimodalEnabled ||
                            (channelType === 'openai' && toolMode === 'function_call');
                        
                        if (shouldExclude) {
                            continue;  // 跳过此工具
                        }
                        
                        // 从设置获取配置（复用 generate_image 配置的批量限制）
                        const imageConfig = this.settingsManager?.getGenerateImageConfig();
                        const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
                        const dynamicTool = createCropImageTool(maxBatchTasks);
                        declaration = { ...declaration, description: dynamicTool.declaration.description };
                    }
                    
                    // 对 resize_image 工具：
                    // 1. 未启用多模态时不包含此工具（需要读取和返回图片）
                    // 2. OpenAI Function Call 模式不包含此工具（不支持多模态返回）
                    if (tool.name === 'resize_image') {
                        // 检查是否应该排除此工具
                        const shouldExclude = !multimodalEnabled ||
                            (channelType === 'openai' && toolMode === 'function_call');
                        
                        if (shouldExclude) {
                            continue;  // 跳过此工具
                        }
                        
                        // 从设置获取配置（复用 generate_image 配置的批量限制）
                        const imageConfig = this.settingsManager?.getGenerateImageConfig();
                        const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
                        const dynamicTool = createResizeImageTool(maxBatchTasks);
                        declaration = { ...declaration, description: dynamicTool.declaration.description };
                    }
                    
                    // 对 rotate_image 工具：
                    // 1. 未启用多模态时不包含此工具（需要读取和返回图片）
                    // 2. OpenAI Function Call 模式不包含此工具（不支持多模态返回）
                    if (tool.name === 'rotate_image') {
                        // 检查是否应该排除此工具
                        const shouldExclude = !multimodalEnabled ||
                            (channelType === 'openai' && toolMode === 'function_call');
                        
                        if (shouldExclude) {
                            continue;  // 跳过此工具
                        }
                        
                        // 从设置获取配置（复用 generate_image 配置的批量限制）
                        const imageConfig = this.settingsManager?.getGenerateImageConfig();
                        const maxBatchTasks = imageConfig?.maxBatchTasks || 10;
                        const dynamicTool = createRotateImageTool(maxBatchTasks);
                        declaration = { ...declaration, description: dynamicTool.declaration.description };
                    }
                    
                    // 对 subagents 工具：
                    // 只有当有启用的子代理时才包含此工具
                    if (tool.name === 'subagents') {
                        if (subAgentRegistry.countEnabled() === 0) {
                            continue;  // 跳过此工具
                        }
                    }
                    
                    tools.push({
                        ...declaration,
                        parameters: this.cleanJsonSchema(declaration.parameters)
                    });
                }
            }
        }
        
        // 2. 获取 MCP 工具
        if (this.mcpManager) {
            const mcpTools = this.mcpManager.getAllTools();
            for (const serverTools of mcpTools) {
                for (const tool of serverTools.tools || []) {
                    // 将 MCP 工具转换为函数声明格式
                    // 工具名称格式：mcp__{serverId}__{toolName}
                    // 使用双下划线分隔，因为 Gemini API 不允许函数名中包含多个冒号
                    const toolName = `mcp__${serverTools.serverId}__${tool.name}`;
                    
                    // 根据服务器配置决定是否清理 schema
                    const rawSchema = tool.inputSchema || { type: 'object', properties: {} };
                    const schema = serverTools.cleanSchema
                        ? this.cleanJsonSchema(rawSchema)
                        : rawSchema;
                    
                    tools.push({
                        name: toolName,
                        description: tool.description || `MCP tool: ${tool.name}`,
                        parameters: schema
                    });
                }
            }
        }
        
        // 3. 如果设置了 allowlist，根据 allowlist 过滤工具（硬过滤）
        // 只保留 allowlist 里出现的工具名
        if (allowlist && allowlist.length > 0) {
            const allowlistSet = new Set(allowlist);
            const filteredTools = tools.filter(tool => allowlistSet.has(tool.name));
            return filteredTools.length > 0 ? filteredTools : undefined;
        }
        
        // 4. 如果没有设置 allowlist，保持现状（继承 code 工具集，即只按 toolsEnabled + 运行时排除规则过滤）
        return tools.length > 0 ? tools : undefined;
    }
    
    /**
     * 清理 JSON Schema，移除不支持的字段
     *
     * Gemini 不支持以下字段：
     * - $schema
     * - additionalProperties
     */
    private cleanJsonSchema(schema: any): any {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }
        
        const cleaned: any = {};
        
        for (const key of Object.keys(schema)) {
            // 跳过不支持的字段
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            
            const value = schema[key];
            
            // 递归处理嵌套对象
            if (value && typeof value === 'object') {
                if (Array.isArray(value)) {
                    cleaned[key] = value.map(item => this.cleanJsonSchema(item));
                } else {
                    cleaned[key] = this.cleanJsonSchema(value);
                }
            } else {
                cleaned[key] = value;
            }
        }
        
        return cleaned;
    }
    
    /**
     * 清理资源（如果需要）
     */
    async dispose(): Promise<void> {
        // 目前无需特殊清理
    }
}