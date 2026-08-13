/**
 * GrayCode - 渠道管理器
 *
 * 核心渠道调用管理器，协调配置和格式转换器
 */

import { t } from '../../i18n';
import type { ConfigManager } from '../config';
import type { ToolRegistry } from '../../tools/ToolRegistry';
import type { SettingsManager } from '../settings';
import type { ResolvedPromptModeSnapshot } from '../settings';
import type { McpManager } from '../mcp';
import { formatterRegistry } from './formatters';
import { ToolDeclarationResolver } from './ToolDeclarationResolver';
import type { ToolDeclaration, ToolOptions } from '../../tools/types';
import type {
    GenerateRequest,
    GenerateResponse,
    StreamChunk,
    HttpRequestOptions,
    HttpResponse
} from './types';
import { ChannelError, ErrorType } from './types';
import { isRetryableError as isRetryableErrorType } from '../../core/errors';
import { Logger } from '../../core/logger';
import { validateHistoryIntegrity } from './HistoryIntegrityValidator';
import { ChannelHttpExecutor } from './channelManager/channelHttpExecutor';
import { extractUpstreamErrorMessage, isResponseContentEmpty, streamChunkHasContent } from './channelManager/channelResponseHelpers';


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
    private readonly httpExecutor: ChannelHttpExecutor;
    
    constructor(
        private configManager: ConfigManager,
        private toolRegistry?: ToolRegistry,
        private settingsManager?: SettingsManager
    ) {
        this.toolResolver = new ToolDeclarationResolver(this.toolRegistry, this.settingsManager);
        this.httpExecutor = new ChannelHttpExecutor(() => this.getProxyUrl());
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
     * 替换前必须 dispose 旧实例：resolver 在 McpManager 单例上注册了工具列表变更监听器，
     * 不释放会在重初始化/热重载时逐轮泄漏监听器（0c53117 的防泄漏修复漏掉了此替换路径）。
     */
    setMcpManager(mcpManager: McpManager): void {
        const previous = this.toolResolver;
        this.toolResolver = new ToolDeclarationResolver(this.toolRegistry, this.settingsManager, mcpManager);
        try {
            previous?.dispose();
        } catch (error) {
            this.log.warn('tool_resolver_dispose_failed', {
                error: (error as Error)?.message ?? String(error),
            });
        }
    }
    
    /**
     * 执行 HTTP 请求（委托给 ChannelHttpExecutor，保持对外 API 兼容）。
     */
    async executeRequest(options: HttpRequestOptions, externalSignal?: AbortSignal): Promise<HttpResponse> {
        return this.httpExecutor.executeRequest(options, externalSignal);
    }
    
    /**
     * 执行流式 HTTP 请求（委托给 ChannelHttpExecutor，保持对外 API 兼容）。
     */
    async *executeStreamRequest(options: HttpRequestOptions, externalSignal?: AbortSignal): AsyncGenerator<any> {
        yield* this.httpExecutor.executeStreamRequest(options, externalSignal);
    }
    
    /**
     * 发送 Prompt Caching 保活请求（委托给 ChannelHttpExecutor，保持对外 API 兼容）。
     */
    async sendKeepAliveRequest(httpRequest: HttpRequestOptions, keepAliveBody: any): Promise<void> {
        return this.httpExecutor.sendKeepAliveRequest(httpRequest, keepAliveBody);
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
        const optionsStream = config.options?.stream;
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
            // ChannelError.type 判定统一委托 core/errors（白名单：
            // API/NETWORK/TIMEOUT/EMPTY_RESPONSE，其余含 CANCELLED 均不可重试）
            return isRetryableErrorType(error.type);
        }
        // 确定性编程错误不重试（重试只会重复失败）：
        // RangeError（超大字符串/缓冲超限等）、SyntaxError（解析失败）。
        // 注意 TypeError 不能一概排除——Node 原生 fetch 的网络失败（'fetch failed'）就是
        // TypeError，全排除会破坏网络错误重试。
        if (error instanceof RangeError || error instanceof SyntaxError) {
            return false;
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
                    config.multimodalToolsEnabled,
                    config.type,
                    config.toolMode,
                    request.promptModeSnapshot,
                    config.toolOptions
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
        const retryEnabled = request.skipRetry ? false : (config.retryEnabled ?? true);  // 默认启用重试
        // 钳制兜底：配置来源可能绕过 TS 类型（webview/导入），负值 retryCount 会让
        // totalAttempts <= 0、NaN 会让 for 循环零次执行（误报网络错误）；至少尝试一次
        const maxRetries = Math.max(0, Math.floor(config.retryCount ?? 3));  // 默认3次
        const retryInterval = Math.max(0, config.retryInterval ?? 3000);  // 默认3秒
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;
        // 钳制后仍无效（retryCount 为 NaN/Infinity 等）：转为明确的配置错误而非网络错误
        if (!Number.isInteger(totalAttempts) || totalAttempts <= 0) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.invalidRetryConfig', { configId: request.configId })
            );
        }
        
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
                const httpResponse = await this.httpExecutor.executeRequest(httpRequest, request.abortSignal);
                
                // 检查 HTTP 状态（与流式 response.ok 一致：接受全部 2xx）
                if (httpResponse.status < 200 || httpResponse.status >= 300) {
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

        // 4. 验证配置（与非流式 generateNonStream 路径对齐）。
        // 修改原因（SEC）：流式路径过去跳过 formatter.validateConfig，无效 API Key / URL /
        // 模型配置不会在发起网络请求前被拦截，而是表现为网络错误、鉴权错误或解析错误。
        // 修改方式：发起请求前与 generateNonStream 一致调用同一校验。
        // 修改目的：无效配置提前失败，错误信息直达配置问题，且不浪费重试次数。
        if (!formatter.validateConfig(config)) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.configValidationFailed', { configId: request.configId })
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
                    config.multimodalToolsEnabled,
                    config.type,
                    config.toolMode,
                    request.promptModeSnapshot,
                    config.toolOptions
                ));
        
        // 5. 构建请求
        const httpRequest = formatter.buildRequest(request, config, tools);
        
        // 5.5 缓存保活：当 promptCachingKeepAlive 启用时，若流式请求在 4 分 30 秒内未完成则自动发送保活请求
        const keepAliveEnabled = config.type === 'anthropic'
            && config.promptCachingEnabled
            && config.promptCachingKeepAlive
            && (config.promptCachingTtl || '5m') === '5m';
        // 保活请求：max_tokens=5, stream=false，其余参数与主请求一致
        const buildKeepAliveBody = () => {
            // 只浅拷贝并覆写 max_tokens/stream 两个字段：请求体可能很大
            // （工具定义/系统提示词/多模态附件），深拷贝整份 JSON 纯属浪费。
            const body = { ...httpRequest.body };
            body.max_tokens = 5;
            body.stream = false;
            return body;
        };
        
        // 6. 获取重试配置
        // 如果请求指定 skipRetry，则禁用重试
        const retryEnabled = request.skipRetry ? false : (config.retryEnabled ?? true);  // 默认启用重试
        // 钳制兜底（与 generateNonStream 同口径）：负值/NaN retryCount 不得导致零次尝试
        const maxRetries = Math.max(0, Math.floor(config.retryCount ?? 3));  // 默认3次
        const retryInterval = Math.max(0, config.retryInterval ?? 3000);  // 默认3秒
        const totalAttempts = retryEnabled ? (maxRetries + 1) : 1;
        // 钳制后仍无效（retryCount 为 NaN/Infinity 等）：转为明确的配置错误而非网络错误
        if (!Number.isInteger(totalAttempts) || totalAttempts <= 0) {
            throw new ChannelError(
                ErrorType.VALIDATION_ERROR,
                t('modules.channel.errors.invalidRetryConfig', { configId: request.configId })
            );
        }
        
        // 7. 执行流式请求（带重试）
        let lastError: any;
        // 是否已向调用方产出过 chunk：已产出内容后流中途出错不再重试
        let yieldedAny = false;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            // 缓存保活定时器（每次重试都重新计时）
            let keepAliveTimer: NodeJS.Timeout | undefined;
            
            try {
                // executeStreamRequest 是惰性 async generator：函数体（含发起 HTTP 请求）在
                // 首次 next() 时才真正执行。此前 retrySuccess 在请求建立前就回调——若该次重试
                // 在建立阶段即失败（网络错误等），前端会误收「重试成功」。先消费首个 chunk 确认
                // 请求实际建立（失败时错误在此抛出，走下方重试逻辑且不误报），再回调；首个
                // chunk 通过包装生成器回填，消费语义与直接 for-await 完全一致。
                const stream = this.httpExecutor.executeStreamRequest(httpRequest, request.abortSignal);
                const firstResult = await stream.next();
                const replayStream: AsyncGenerator<any> = firstResult.done
                    // 请求已建立但未产出任何块（空流）：仍按「已建立」处理并回调，空响应由下方
                    // 完整性检测抛 EMPTY_RESPONSE_ERROR 走重试。
                    ? (async function* () { /* 空流：不产出任何块 */ })()
                    : (async function* () { yield firstResult.value; yield* stream; })();

                // 如果是重试成功，通知前端（请求已实际建立）
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
                    let keepAliveInFlight = false;
                    keepAliveTimer = setInterval(async () => {
                        // 防重入：上一次保活请求未完成时跳过本轮，避免慢响应堆积
                        if (keepAliveInFlight) {
                            return;
                        }
                        keepAliveInFlight = true;
                        keepAliveFiredCount++;
                        this.log.info('prompt_caching_keepalive_sending', { count: keepAliveFiredCount });
                        try {
                            const keepAliveBody = buildKeepAliveBody();
                            await this.httpExecutor.sendKeepAliveRequest(httpRequest, keepAliveBody);
                            this.log.info('prompt_caching_keepalive_sent', { count: keepAliveFiredCount });
                        } catch (err: any) {
                            this.log.warn('prompt_caching_keepalive_failed', { error: err.message });
                        } finally {
                            keepAliveInFlight = false;
                        }
                    }, 270000);
                }
                
                // 逐块解析和产出
                let sawDone = false;
                let yieldedContent = false;
                for await (const rawChunk of replayStream) {
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
                        try {
                            const keepAliveBody = buildKeepAliveBody();
                            await this.httpExecutor.sendKeepAliveRequest(httpRequest, keepAliveBody);
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
                
                // 等待后重试（支持取消）—— 先停保活定时器：错误后到 delay 完成之间定时器仍存活，
                // 会在无活动流时发出保活请求
                if (keepAliveTimer) {
                    clearInterval(keepAliveTimer);
                    keepAliveTimer = undefined;
                }
                await this.delay(retryInterval, request.abortSignal);
            } finally {
                // 清理保活循环定时器（兜底）
                if (keepAliveTimer) {
                    clearInterval(keepAliveTimer);
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
        promptModeSnapshot?: ResolvedPromptModeSnapshot,
        toolOptions?: ToolOptions
    ): ToolDeclaration[] | undefined {
        return this.toolResolver.resolve({
            multimodalEnabled,
            channelType,
            toolMode,
            promptModeSnapshot,
            toolOptions
        });
    }
    
    /**
     * 清理资源：释放 ToolDeclarationResolver 持有的 MCP 事件监听
     * （一次性实例向 McpManager 单例无界累积监听器的防泄漏修复）
     */
    async dispose(): Promise<void> {
        try {
            this.toolResolver?.dispose();
        } catch (error) {
            this.log.warn('tool_resolver_dispose_failed', {
                error: (error as Error)?.message ?? String(error),
            });
        }
    }
}