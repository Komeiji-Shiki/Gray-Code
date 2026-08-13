/**
 * GrayCode - 代理流式响应体读取（异步生成器）
 *
 * 由 proxyFetch.ts 拆分而来：负责「流式解析」职责——在已建立的 socket 上
 * 发送请求，以事件驱动方式读取响应并逐行（SSE 行）产出原始响应文本。
 */

import * as tls from 'tls';
import { URL } from 'url';
import { t } from '../../../i18n';
import { ChannelError, ErrorType } from '../types';
import {
    USER_AGENT,
    closeSocketGracefully,
    extractUpstreamErrorMessage,
    type FetchOptions
} from './proxyShared';
import { validateChunkedFrames, decodeChunkedBuffer, decodeChunkedStreamIncremental } from './proxyChunked';

/**
 * 在已建立的隧道 socket 上发送请求并逐行读取响应正文（原始响应行）。
 *
 * proxyStreamFetch 建立隧道后调用本函数，本函数负责「发送请求 + 流式读取 + 收尾」。
 */
export async function* readProxyStreamBody(
    socket: tls.TLSSocket | import('net').Socket,
    targetUrl: URL,
    init: FetchOptions
): AsyncGenerator<string> {
    // 发送请求
    const body = init.body || '';
    const bodyBuffer = Buffer.from(body, 'utf8');

    const requestLine = `${init.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;

    // 确保 User-Agent 被包含；init.headers 展开在后，调用方显式传入的 UA 优先生效
    const headersWithUserAgent = { 'User-Agent': USER_AGENT, ...init.headers };
    const streamHeaders = [
        `Host: ${targetUrl.hostname}`,
        ...Object.entries(headersWithUserAgent).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${bodyBuffer.length}`,
        'Connection: close',
        '',
        ''
    ].join('\r\n');

    socket.write(requestLine + streamHeaders);
    if (body) {
        socket.write(bodyBuffer);
    }

    // 读取响应
    let rawBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);  // 使用 Buffer 处理原始数据
    let headersParsed = false;
    let statusCode = 0;
    let isChunked = false;
    let chunkedBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);  // chunked 解码缓冲区（单一 buffer + offset 游标）
    let chunkedOffset = 0;  // 已解码前缀游标：未消费数据 = chunkedBuffer.subarray(chunkedOffset)
    // 流式 TextDecoder：跨 chunk 被切开的 UTF-8 多字节字符在内部缓冲拼接，
    // 不会在第一个包就固化成 U+FFFD 导致后续 SSE 行 JSON.parse 永远失败
    const decoder = new TextDecoder();

    // 监听取消信号（#34 修复：优雅关闭而不是裸 end）
    const onAbort = () => {
        closeSocketGracefully(socket);
    };
    if (init.signal) {
        init.signal.addEventListener('abort', onAbort, { once: true });
    }

    /**
     * 实时解码 chunked 数据（增量版见模块级 decodeChunkedStreamIncremental，
     * 与 sendRequestOverSocket 的流式响应体共用同一实现，避免两份平行解码逻辑）
     */

    // 使用事件监听器代替 for await，避免提前中断时 socket 被自动销毁导致 RST
    // for await 在被提前终止时会销毁流，发送 RST 包而不是 FIN，导致 ECONNRESET
    try {
        // 创建数据读取 Promise
        const readData = (): Promise<void> => {
            return new Promise((resolve, reject) => {
                let settled = false;

                const cleanup = () => {
                    socket.removeListener('data', onData);
                    socket.removeListener('end', onEnd);
                    socket.removeListener('close', onClose);
                    socket.removeListener('error', onError);
                };

                const finishResolve = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve();
                };

                const finishReject = (error: Error) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(error);
                };

                // #37 修复：非 2xx 错误体累积状态，避免取半截 chunk 框架字节
                let errorMode = false;
                let errorBodyBytes: Buffer[] = [];
                let errorContentLength = -1;
                let errorIsChunked = false;
                // 错误体 chunked 帧结构校验状态（与 sendRequestOverSocket 的
                // hasValidChunkedBody 同口径：真实解析替代 0\r\n\r\n 字节模式扫描，
                // 避免错误页内容中恰好出现该字节序列时把截断体当完整体提前 finalize）
                let errorBodyScanOffset = 0;
                let errorValidationBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
                let errorValidationConsumed = 0;
                let errorValidationFailed = false;

                const isErrorBodyComplete = (): boolean => {
                    const totalBytes = errorBodyBytes.reduce((sum, b) => sum + b.length, 0);
                    if (errorContentLength >= 0) {
                        return totalBytes >= errorContentLength;
                    }
                    if (errorIsChunked) {
                        if (errorValidationFailed) {
                            return false;
                        }
                        // 提取未校验的新增字节（相对上一次扫描偏移）
                        const newStart = errorBodyScanOffset;
                        const newParts: Buffer[] = [];
                        let offset = 0;
                        for (const part of errorBodyBytes) {
                            const partEnd = offset + part.length;
                            if (partEnd <= newStart) {
                                offset = partEnd;
                                continue;
                            }
                            newParts.push(part.subarray(Math.max(0, newStart - offset)));
                            offset = partEnd;
                        }
                        const newBytes = newParts.length === 0 ? Buffer.alloc(0) : Buffer.concat(newParts);
                        errorBodyScanOffset = totalBytes;
                        if (errorValidationConsumed > 0) {
                            errorValidationBuffer = errorValidationBuffer.subarray(errorValidationConsumed);
                            errorValidationConsumed = 0;
                        }
                        if (newBytes.length > 0) {
                            errorValidationBuffer = Buffer.concat([errorValidationBuffer, newBytes]);
                        }
                        const result = validateChunkedFrames(errorValidationBuffer, errorValidationConsumed);
                        errorValidationConsumed = result.validatedOffset;
                        if (result.corrupt) {
                            errorValidationFailed = true;
                        }
                        return result.complete;
                    }
                    // 未声明 content-length 也非 chunked → 连接关闭判定
                    return false;
                };

                const finalizeError = () => {
                    if (settled) return;

                    let errorBody: string;
                    if (errorIsChunked && errorBodyBytes.length > 0) {
                        const fullBody = Buffer.concat(errorBodyBytes);
                        errorBody = decodeChunkedBuffer(fullBody);
                    } else {
                        errorBody = Buffer.concat(errorBodyBytes).toString('utf8');
                    }

                    let parsedError: any;
                    try {
                        parsedError = JSON.parse(errorBody);
                    } catch {
                        parsedError = errorBody;
                    }

                    const upstreamMessage = extractUpstreamErrorMessage(parsedError);
                    finishReject(new ChannelError(
                        ErrorType.API_ERROR,
                        upstreamMessage
                            ? `HTTP ${statusCode}: ${upstreamMessage}`
                            : t('modules.channel.errors.apiError', { status: statusCode }),
                        parsedError
                    ));
                };

                const onData = (chunk: Buffer) => {
                    // 检查是否已取消
                    if (init.signal?.aborted) {
                        finishResolve();
                        return;
                    }

                    // PERF：rawBuffer 在 header 解析后被逐包清空（下方 drain），
                    // 空时直接复用新块避免每包一次 Buffer.concat 分配
                    rawBuffer = rawBuffer.length === 0 ? chunk : Buffer.concat([rawBuffer, chunk]);

                    if (!headersParsed) {
                        const headerEndMarker = Buffer.from('\r\n\r\n');
                        const headerEnd = rawBuffer.indexOf(headerEndMarker);

                        if (headerEnd !== -1) {
                            const headerPart = rawBuffer.subarray(0, headerEnd).toString('utf8');
                            // 与 sendRequestOverSocket.tryParseHeaders 同步：状态行取首行，
                            // reason phrase 可缺省（如 "HTTP/1.1 204"），正则放宽为可选组，
                            // 避免无 reason phrase 的状态行匹配失败导致 statusCode 兜底为 0
                            const statusLine = headerPart.split('\r\n')[0];
                            const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)(?: (.+))?/);
                            statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

                            if (statusCode === 0) {
                                // 状态行无法解析（状态码缺失/非法）：立即按协议错误终止，
                                // 不再流入错误体累积/ChannelError 构造（与 tryParseHeaders 551-557 一致）
                                finishReject(new Error(`Invalid HTTP status line: ${statusLine || '(empty)'}`));
                                return;
                            }

                            // 检查是否是 chunked 编码
                            if (headerPart.toLowerCase().includes('transfer-encoding: chunked')) {
                                isChunked = true;
                            }

                            if (statusCode < 200 || statusCode >= 300) {
                                // #37 修复：切换到错误体累积模式，不立即用半截数据构造错误
                                headersParsed = true;
                                errorMode = true;

                                // 解析错误体的 content-length
                                const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
                                errorContentLength = clMatch ? parseInt(clMatch[1], 10) : -1;
                                errorIsChunked = isChunked;

                                // 把 header 之后已收到的 body 字节移到错误体缓冲区
                                const bodyBytes = rawBuffer.subarray(headerEnd + 4);
                                if (bodyBytes.length > 0) {
                                    errorBodyBytes.push(bodyBytes);
                                }

                                if (isErrorBodyComplete()) {
                                    finalizeError();
                                }
                                return;
                            }

                            headersParsed = true;
                            rawBuffer = rawBuffer.subarray(headerEnd + 4);
                        }
                    } else if (errorMode) {
                        // 累积错误体字节
                        errorBodyBytes.push(chunk);
                        if (isErrorBodyComplete()) {
                            finalizeError();
                        }
                        return;
                    }

                    if (headersParsed && rawBuffer.length > 0) {
                        if (isChunked) {
                            // 实时解码 chunked 数据
                            // PERF：offset 游标累积——先压缩已解码前缀（subarray 零拷贝视图），
                            // 再一次性 concat 新字节；解码后只移动游标，不再 Buffer.from 拷贝剩余
                            if (chunkedOffset > 0) {
                                chunkedBuffer = chunkedBuffer.subarray(chunkedOffset);
                                chunkedOffset = 0;
                            }
                            chunkedBuffer = Buffer.concat([chunkedBuffer, rawBuffer]);
                            rawBuffer = Buffer.alloc(0);

                            const { decoded, consumed } = decodeChunkedStreamIncremental(chunkedBuffer);
                            chunkedOffset = consumed;

                            if (decoded) {
                                // 流式解码：跨 chunk 的多字节字符由 TextDecoder 内部缓冲拼接
                                dataQueue.push(decoder.decode(decoded, { stream: true }));
                                wakeDataWaiters();
                            }
                        } else {
                            // 非 chunked：同样走流式解码，跨包多字节字符由 TextDecoder 缓冲拼接
                            dataQueue.push(decoder.decode(rawBuffer, { stream: true }));
                            rawBuffer = Buffer.alloc(0);
                            wakeDataWaiters();
                        }
                    }
                };

                const onEnd = () => {
                    if (init.signal?.aborted) {
                        finishResolve();
                        return;
                    }
                    if (errorMode) {
                        finalizeError();
                        return;
                    }
                    if (!headersParsed) {
                        finishReject(new Error('Connection closed before response headers received'));
                        return;
                    }
                    finishResolve();
                };

                const onClose = () => {
                    if (init.signal?.aborted) {
                        finishResolve();
                        return;
                    }
                    if (errorMode) {
                        finalizeError();
                        return;
                    }
                    if (!headersParsed) {
                        finishReject(new Error('Connection closed before response headers received'));
                        return;
                    }
                    finishResolve();
                };

                const onError = (err: Error) => {
                    if (init.signal?.aborted) {
                        finishResolve();
                        return;
                    }
                    finishReject(err);
                };

                if (init.signal?.aborted) {
                    finishResolve();
                    return;
                }

                socket.on('data', onData);
                socket.on('end', onEnd);
                socket.on('close', onClose);
                socket.on('error', onError);
            });
        };

        // 数据队列
        const dataQueue: string[] = [];
        let readPromise: Promise<void> | null = null;
        let readError: unknown = null;
        let isReading = true;

        // 事件驱动等待链：数据到达 / 读取结束时唤醒等待者（替代 10ms 轮询，
        // 避免流式消费慢时每秒空转上百次定时器）。
        let dataWaiters: Array<() => void> = [];
        function wakeDataWaiters(): void {
            const waiters = dataWaiters;
            dataWaiters = [];
            for (const waiter of waiters) {
                waiter();
            }
        }

        // 启动后台数据读取
        readPromise = readData()
            .catch((err: unknown) => {
                readError = err;
            })
            .finally(() => {
                isReading = false;
                wakeDataWaiters();
            });

        // 事件驱动 yield 数据，避免阻塞：有数据立即产出；无数据时挂起等待
        // onData 推入数据或读取结束被唤醒（替代固定 10ms 轮询）。
        while (isReading || dataQueue.length > 0) {
            // 检查是否已取消
            if (init.signal?.aborted) {
                break;
            }

            if (dataQueue.length > 0) {
                yield dataQueue.shift()!;
            } else if (isReading) {
                // 挂起等待：数据到达 / 读取结束时被唤醒（含竞态复查兜底）
                await new Promise<void>(resolve => {
                    dataWaiters.push(resolve);
                    if (dataQueue.length > 0 || !isReading) {
                        wakeDataWaiters();
                    }
                });
            }
        }

        // 等待读取完成
        if (readPromise) {
            await readPromise;
        }

        if (readError) {
            throw readError;
        }

        // 处理剩余数据
        if (!init.signal?.aborted) {
            if (isChunked && chunkedBuffer.length > 0) {
                // 流结束后的剩余缓冲：一次性增量解码（返回 { decoded, consumed, terminated }）
                const { decoded } = decodeChunkedStreamIncremental(chunkedBuffer.subarray(chunkedOffset));
                if (decoded) {
                    yield decoder.decode(decoded, { stream: true });
                }
            } else if (rawBuffer.length > 0) {
                yield decoder.decode(rawBuffer, { stream: true });
            }

            // flush TextDecoder 内部缓冲：末块被切开的 UTF-8 字符尾部在此输出
            const flushed = decoder.decode();
            if (flushed) {
                yield flushed;
            }
        }
    } finally {
        // 移除取消信号监听
        if (init.signal) {
            init.signal.removeEventListener('abort', onAbort);
        }

        // #34 修复：统一使用 closeSocketGracefully 优雅关闭
        await closeSocketGracefully(socket);
    }
}
