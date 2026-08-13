/**
 * GrayCode 渠道 HTTP / 流式执行层
 *
 * 从 ChannelManager 抽离：非流式请求执行、流式请求执行、缓存保活请求。
 * 通过注入的 getProxyUrl 获取代理地址，自身不持有 SettingsManager 实例。
 */

import { t } from '../../../i18n';
import { ChannelError, ErrorType } from '../types';
import type { HttpRequestOptions, HttpResponse } from '../types';
import { createProxyFetch, proxyStreamFetch } from '../proxyFetch';
import { parseStreamBuffer } from '../streamBufferParser';
import {
    extractUpstreamErrorMessage,
    MAX_STREAM_BUFFER_LENGTH,
    assertStreamBufferWithinLimit,
    readBodyTextWithLimit
} from './channelResponseHelpers';

/**
 * 渠道 HTTP / 流式执行器
 */
export class ChannelHttpExecutor {
    constructor(private readonly getProxyUrl: () => string | undefined) {}

    /**
     * 执行 HTTP 请求
     *
     * @param options 请求选项
     * @param externalSignal 外部取消信号
     * @returns HTTP 响应
     */
    async executeRequest(options: HttpRequestOptions, externalSignal?: AbortSignal): Promise<HttpResponse> {
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
                signal: controller.signal,
                // 透传超时：代理路径由 createProxyFetch 按此值设置请求超时（此前硬编码 120s）
                timeout
            });
            
            // 解析响应体：先读 text() 再尝试解析 JSON——response.json() 会消费响应体，
            // 纯文本/HTML 错误体（网关 502 页等）在 json() 失败后无法再读正文（body used
            // already），上游给出的真实错误内容会丢失；text 原文在解析失败时原样保留，
            // 供 extractUpstreamErrorMessage 提取并进入错误信息。
            // 带大小上限读取：上游异常返回巨型 body 时在内存耗尽前截断报 PARSE_ERROR。
            const rawResponseBody = await readBodyTextWithLimit(response, MAX_STREAM_BUFFER_LENGTH);
            let responseBody: unknown = rawResponseBody;
            try {
                responseBody = JSON.parse(rawResponseBody);
            } catch {
                // 非 JSON（含非 2xx 的纯文本错误体）：保留原文
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
    async *executeStreamRequest(
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
                // PERF：只保留未解析尾部——每包只拼接「未解析尾部 + 新块」，避免对整段
                // 累积缓冲重复复制（O(n²)）。baseline 直接取 parseStreamBuffer 返回的
                // remaining（对 SSE 是重建的 `data: ` 前缀行、对 JSONL 是未完成的末行），
                // 而不是按偏移从头部切——偏移切法在 SSE 事件跨 chunk 且尾随空行时会把
                // `data: ` 前缀切坏，在 JSONL 逐行格式下会直接丢块。
                let lastRemaining = '';
                // 未知格式整段残留标记：parseStreamBuffer 无法识别流格式时把整段缓冲原样
                // 作为 remaining 返回（同一引用），需要完整累积后才能识别格式——此时不清空、
                // 不压缩，保持「完整累积后识别格式」的既有语义。
                // 未知格式整段残留同样受 64MB 上限约束：pendingWholeBuffer 时 noProgress
                // 判定恒成立，异常上游持续输出非 SSE/JSON 内容会在累积超限时被
                // assertStreamBufferWithinLimit 终止（PARSE_ERROR），不会无界累积到流结束。
                let pendingWholeBuffer = false;
                
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
                    
                    // 压缩已解析前缀后再追加新块
                    buffer = pendingWholeBuffer ? buffer : lastRemaining;
                    buffer += chunk;
                    
                    // 处理流式响应（解析窗口只含未解析尾部 + 新块）
                    const result = parseStreamBuffer(buffer);
                    parsedChunkCount += result.chunks.length;
                    pendingWholeBuffer = result.remaining === buffer;
                    // 「解析无进展」判定：SSE 分支的 remaining 是重建字符串（剥离了尾随空行、
                    // chunked 大小行等），引用比较恒不相等，旧判定在上限检查处失效，垃圾 SSE
                    // 数据可无界累积（内存耗尽）。补增量判定：本轮未产出 chunk 且未消费尾部比
                    // 上轮更长 → 无进展累积，按当前缓冲执行上限检查。合法巨型单事件在完成前
                    // 也呈现「无进展」，64MB 阈值为其预留空间；垃圾数据累积超限即终止。
                    const noProgress = result.chunks.length === 0
                        && (pendingWholeBuffer || result.remaining.length > lastRemaining.length);
                    lastRemaining = result.remaining;
                    if (noProgress) {
                        assertStreamBufferWithinLimit(buffer);
                    }

                    
                    for (const parsed of result.chunks) {
                        yield parsed;
                    }
                }
                
                // 处理剩余的 buffer（用户已取消时不产出半截残留：原生 fetch 分支在 abort 时
                // reader.read() 直接抛错，根本走不到这里，两条路径保持一致）
                const finalTail = lastRemaining;
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
                        t('modules.channel.errors.requestTimeoutNoResponse', { timeout })
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
                    // 获取错误详情：必须先读 text() 再尝试解析 JSON——response.json() 会消费
                    // 响应体，纯文本/HTML 错误体（网关 502 页面等）在 json() 失败后再读
                    // text() 只能拿到空串，上游给出的真实错误正文会丢失（body used already）。
                    const rawErrorBody = await response.text();
                    let errorBody: unknown = rawErrorBody;
                    try {
                        errorBody = JSON.parse(rawErrorBody);
                    } catch {
                        // 非 JSON：保留原文（extractUpstreamErrorMessage 直接返回文本）
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
                // 上一轮未消费尾部基准：SSE 分支 remaining 为重建字符串，用长度增量判定「无进展」
                let lastRemaining = '';
                
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
                        
                        // 处理流式响应
                        const result = parseStreamBuffer(buffer);
                        // 「解析无进展」判定：SSE 分支的 remaining 是重建字符串，恒不等于
                        // buffer，旧判定（remaining !== buffer → 有进展）在上限检查处失效，
                        // 垃圾 SSE 数据可无界累积（内存耗尽）。改为：未产出 chunk 且未消费
                        // 尾部比上轮更长 → 无进展累积，按当前缓冲执行上限检查。合法巨型单事件
                        // 在完成前也呈现「无进展」，64MB 阈值为其预留空间；垃圾数据累积超限即终止。
                        const noProgress = result.chunks.length === 0
                            && (result.remaining === buffer || result.remaining.length > lastRemaining.length);
                        if (noProgress) {
                            assertStreamBufferWithinLimit(buffer);
                        }
                        buffer = result.remaining;
                        lastRemaining = result.remaining;
                        parsedChunkCount += result.chunks.length;

                        
                        for (const chunk of result.chunks) {
                            yield chunk;
                        }
                    }
                    
                    // 最终冲刷后的缓冲可能越过上限（末块多字节字符补齐），超限同样终止
                    assertStreamBufferWithinLimit(buffer);
                    
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
     * 发送缓存保活请求（fire-and-forget）
     *
     * 用于在流式请求进行中刷新 Anthropic Prompt Caching 的 5 分钟 TTL。
     * 保活请求使用与主请求相同的 headers/URL，但 max_tokens=5、stream=false。
     *
     * @param httpRequest 主请求选项（用于复用 URL 和 headers）
     * @param keepAliveBody 保活请求体（已设置 max_tokens=5, stream=false）
     */
    async sendKeepAliveRequest(
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
}
