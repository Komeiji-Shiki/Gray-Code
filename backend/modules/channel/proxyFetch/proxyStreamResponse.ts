/**
 * GrayCode - 代理流式/整包响应解析
 *
 * 由 proxyFetch.ts 拆分而来：负责「流式解析」职责——在已建立的 socket 上
 * 发送 HTTP 请求，解析响应头，支持整包（错误/非 2xx）与流式（2xx body）两种
 * 响应体交付方式。
 */

import * as tls from 'tls';
import { URL } from 'url';
import {
    USER_AGENT,
    createAbortError,
    closeSocketGracefully,
    type FetchOptions,
    type FetchResponse
} from './proxyShared';
import { validateChunkedFrames, decodeChunkedBuffer, decodeChunkedStreamIncremental } from './proxyChunked';

/**
 * 流式响应体接收端：createProxyFetch 用它把代理响应的 body 字节逐包喂给 ReadableStream。
 * 大文件下载（vsix 等）因此无需整包读入内存，也不会经 UTF-8 往返解码损坏二进制。
 */
export interface ProxyStreamSink {
    stream: ReadableStream<Uint8Array>;
    push(chunk: Buffer): void;
    end(): void;
    error(err: Error): void;
}

export function createProxyStreamSink(): ProxyStreamSink {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        }
    });
    return {
        stream,
        push(chunk: Buffer) {
            if (closed || !controller) return;
            try {
                // 与 Buffer 共享内存的零拷贝视图（调用方不修改缓冲区）
                controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } catch {
                // 流已被消费方关闭：忽略
            }
        },
        end() {
            if (closed) return;
            closed = true;
            try {
                controller?.close();
            } catch {
                // 已关闭
            }
        },
        error(err: Error) {
            if (closed) return;
            closed = true;
            try {
                controller?.error(err);
            } catch {
                // 已关闭
            }
        }
    };
}

/**
 * 通过 socket 发送 HTTP 请求（支持整包与流式响应体两种模式：
 * 提供 bodySink 时头解析完成后即 resolve，body 字节逐包经 sink 转交）
 */
export function sendRequestOverSocket(
    socket: tls.TLSSocket | import('net').Socket,
    targetUrl: URL,
    init: FetchOptions,
    resolve: (response: FetchResponse) => void,
    reject: (error: Error) => void,
    bodySink?: ProxyStreamSink
): void {
    // 检查是否已取消
    if (init.signal?.aborted) {
        socket.destroy();
        reject(createAbortError(init.signal));
        return;
    }

    const body = init.body || '';
    const bodyBuffer = Buffer.from(body, 'utf8');

    // 监听取消信号（#34 修复：使用 closeSocketGracefully 优雅关闭）
    let aborted = false;
    const onAbort = () => {
        if (aborted) return;
        aborted = true;
        closeSocketGracefully(socket);
        if (streamingActive()) {
            // 流式模式：fetch 已提前 resolve，取消经 body 流传播（AbortError）
            bodySink?.error(createAbortError(init.signal));
            return;
        }
        reject(createAbortError(init.signal));
    };
    if (init.signal) {
        init.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 清理函数
    const cleanup = () => {
        if (init.signal) {
            init.signal.removeEventListener('abort', onAbort);
        }
    };

    // 发送实际的 HTTP 请求
    const requestLine = `${init.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;

    // 确保 User-Agent 被包含；init.headers 展开在后，调用方显式传入的 UA 优先生效
    const headersWithUserAgent = { 'User-Agent': USER_AGENT, ...init.headers };
    const headers = [
        `Host: ${targetUrl.hostname}`,
        ...Object.entries(headersWithUserAgent).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${bodyBuffer.length}`,
        'Connection: close',
        '',
        ''
    ].join('\r\n');

    socket.write(requestLine + headers);
    if (body) {
        socket.write(bodyBuffer);
    }

    // 收集响应数据（#38 修复：延迟 concat，用 receivedLength 做快速判定）
    const chunks: Buffer[] = [];
    let receivedLength = 0;
    let headersParsed = false;
    let responseFinished = false;
    let statusCode = 0;
    let statusText = '';
    let contentLength = -1;
    let isChunked = false;
    let headerEndIndex = -1;
    let responseHeaders: Record<string, string> = {};
    // chunked 帧结构校验状态（真实解析，替代旧的 0\r\n\r\n 字节模式扫描）：
    // 只保留未校验尾部增量校验（validateChunkedFrames 逐帧解析 size 行/chunk 数据/CRLF，
    // 终止块 + trailer 收尾且与数据末尾对齐才算完整），避免 chunk 内容中恰好出现
    // 0\r\n\r\n 字节序列时把截断响应误判为完整并提前 resolve。
    let chunkedBodyScanOffset = 0;          // 已提取进校验缓冲的 body 字节数
    let chunkedValidationBuffer: Buffer = Buffer.alloc(0);
    let chunkedValidationConsumed = 0;      // 校验缓冲内已通过帧校验的前缀偏移
    let chunkedValidationFailed = false;    // 帧损坏：后续数据无法修复，close 时拒绝

    // 流式响应体状态（bodySink 提供时启用）：头解析完成后立即 resolve（status/headers 可用），
    // body 字节经 bodySink 逐包转交 ReadableStream；连接异常/中止经 bodySink.error 传播。
    let streamResolved = false;
    let streamEmitted = 0;
    let streamChunkedBuffer: Buffer = Buffer.alloc(0);
    let streamChunkedOffset = 0;
    let streamChunkedDone = false;

    const streamingActive = (): boolean => !!bodySink && streamResolved && statusCode >= 200 && statusCode < 300;

    const resolveStreamingResponse = () => {
        if (streamResolved || !bodySink) return;
        streamResolved = true;
        resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText,
            headers: responseHeaders,
            // 流式模式下 body 经 stream 交付，text/json 不再可用（createProxyFetch 只读 stream）
            text: async () => { throw new Error('Streaming response: body delivered via stream'); },
            json: async () => { throw new Error('Streaming response: body delivered via stream'); },
            body: bodySink.stream
        });
    };

    const emitBodyBytes = (bytes: Buffer) => {
        if (!bodySink || aborted) return;
        if (isChunked) {
            // 增量解码：压缩已消费前缀（subarray 零拷贝视图）后拼接新字节，
            // 只保留未消费尾部，避免整段累积的 O(n²) 复制
            if (streamChunkedOffset > 0) {
                streamChunkedBuffer = streamChunkedBuffer.subarray(streamChunkedOffset);
                streamChunkedOffset = 0;
            }
            streamChunkedBuffer = Buffer.concat([streamChunkedBuffer, bytes]);
            const { decoded, consumed, terminated } = decodeChunkedStreamIncremental(streamChunkedBuffer);
            streamChunkedOffset = consumed;
            if (terminated) streamChunkedDone = true;
            if (decoded && decoded.length > 0) {
                streamEmitted += decoded.length;
                bodySink.push(decoded);
            }
            return;
        }
        let data = bytes;
        if (contentLength >= 0) {
            // 按 Content-Length 截断：防御服务器多发字节（Connection: close 下不应发生）
            const remaining = contentLength - streamEmitted;
            if (remaining <= 0) return;
            if (data.length > remaining) data = data.subarray(0, remaining);
        }
        if (data.length === 0) return;
        streamEmitted += data.length;
        bodySink.push(data);
    };

    const isStreamComplete = (): boolean => {
        if (isChunked) return streamChunkedDone;
        if (contentLength >= 0) return streamEmitted >= contentLength;
        return false; // 无长度信息：由 socket end/close 判定
    };

    const isStreamBodyComplete = (): boolean => {
        if (isChunked) return streamChunkedDone;
        if (contentLength >= 0) return streamEmitted >= contentLength;
        return true; // 无长度信息：连接结束即 body 结束
    };

    const finishStreaming = () => {
        if (responseFinished || aborted) return;
        responseFinished = true;
        cleanup();
        bodySink?.end();
    };

    const tryParseHeaders = (fullBuffer: Buffer): boolean => {
        const headerEndMarker = Buffer.from('\r\n\r\n');
        headerEndIndex = fullBuffer.indexOf(headerEndMarker);

        if (headerEndIndex === -1) {
            return false;
        }

        const headerPart = fullBuffer.subarray(0, headerEndIndex).toString('utf8');

        const lines = headerPart.split('\r\n');
        const statusLine = lines[0];
        // reason phrase 可缺省（如 "HTTP/1.1 204"）：正则放宽为可选组，
        // 避免无 reason phrase 的状态行匹配失败导致 statusCode 兜底为 0
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)(?: (.+))?/);
        statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
        statusText = statusMatch?.[2] ?? '';

        if (statusCode === 0) {
            // 状态行无法解析（状态码缺失/非法）：立即按协议错误终止。
            // 不能让 statusCode=0 流入 Response 构造——new Response(body, { status: 0 }) 抛 RangeError
            reject(new Error(`Invalid HTTP status line: ${statusLine || '(empty)'}`));
            cleanup();
            return false;
        }

        for (const line of lines.slice(1)) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim().toLowerCase();
                const value = line.substring(colonIndex + 1).trim();
                responseHeaders[key] = value;

                if (key === 'content-length') {
                    contentLength = parseInt(value);
                } else if (key === 'transfer-encoding' && value.includes('chunked')) {
                    isChunked = true;
                }
            }
        }

        headersParsed = true;
        return true;
    };

    /**
     * 提取「尚未探测过的 body 新增字节」（相对 header 之后的 body 区）。
     *
     * 常规路径（后续 data 事件）新字节落在最新 chunk 尾部，零拷贝 subarray 直接取；
     * 仅首次探测（header 与 body 同包）才需要跨 chunk 收集，且只发生一次。
     */
    const collectNewBodyBytes = (): Buffer => {
        const bodyStart = headerEndIndex + 4;
        const newStart = bodyStart + chunkedBodyScanOffset;
        if (newStart >= receivedLength) {
            return Buffer.alloc(0);
        }
        const lastChunk = chunks[chunks.length - 1];
        const lastChunkStart = receivedLength - lastChunk.length;
        if (newStart >= lastChunkStart) {
            // 新字节全在最新 chunk 内（后续 data 事件的常规路径）
            return lastChunk.subarray(newStart - lastChunkStart);
        }
        // 首次探测：从 header 所在 chunk 的中部开始，跨到后续 chunk
        const parts: Buffer[] = [];
        let offset = 0;
        for (const chunk of chunks) {
            const chunkEnd = offset + chunk.length;
            if (chunkEnd <= newStart) {
                offset = chunkEnd;
                continue;
            }
            parts.push(chunk.subarray(Math.max(0, newStart - offset)));
            offset = chunkEnd;
        }
        return Buffer.concat(parts);
    };

    /** chunked body 完整性校验（增量）：对新增字节做真实帧结构校验，完整终止才返回 true */
    const hasValidChunkedBody = (): boolean => {
        if (chunkedValidationFailed) {
            return false;
        }
        const bodyReceived = receivedLength - headerEndIndex - 4;
        const newBytes = collectNewBodyBytes();
        chunkedBodyScanOffset = bodyReceived;
        if (chunkedValidationConsumed > 0) {
            chunkedValidationBuffer = chunkedValidationBuffer.subarray(chunkedValidationConsumed);
            chunkedValidationConsumed = 0;
        }
        if (newBytes.length > 0) {
            chunkedValidationBuffer = Buffer.concat([chunkedValidationBuffer, newBytes]);
        }
        const result = validateChunkedFrames(chunkedValidationBuffer, chunkedValidationConsumed);
        chunkedValidationConsumed = result.validatedOffset;
        if (result.corrupt) {
            chunkedValidationFailed = true;
        }
        return result.complete;
    };

    const isResponseComplete = (): boolean => {
        if (!headersParsed) {
            return false;
        }

        if (contentLength >= 0) {
            return receivedLength - headerEndIndex - 4 >= contentLength;
        }

        if (isChunked) {
            return hasValidChunkedBody();
        }

        return false;
    };

    // #40 修复：检查响应体是否完整，防止截断响应被当作成功
    const hasValidBody = (): boolean => {
        if (!headersParsed) {
            return false;
        }

        const bodyReceived = receivedLength - headerEndIndex - 4;

        if (contentLength >= 0) {
            return bodyReceived >= contentLength;
        }

        if (isChunked) {
            return hasValidChunkedBody();
        }

        // 未声明 content-length 也非 chunked —— 假定连接断开时即为完整
        return true;
    };

    const finishResponse = () => {
        if (responseFinished || aborted) {
            return;
        }
        responseFinished = true;
        cleanup();

        const fullBuffer = Buffer.concat(chunks);
        const bodyBuffer = fullBuffer.subarray(headerEndIndex + 4);

        let finalBody: string;

        if (isChunked) {
            finalBody = decodeChunkedBuffer(bodyBuffer);
        } else {
            finalBody = bodyBuffer.toString('utf8');
        }

        resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText,
            headers: responseHeaders,
            text: async () => finalBody,
            json: async () => {
                // HTTP 200 + 非 JSON 体（如纯文本错误页）时给出带 body 摘要的明确错误，
                // 避免裸 SyntaxError 逃逸
                try {
                    return JSON.parse(finalBody);
                } catch (error) {
                    const preview = finalBody.length > 200 ? `${finalBody.slice(0, 200)}...` : finalBody;
                    throw new SyntaxError(`Failed to parse response body as JSON: ${preview}`);
                }
            },
            body: null
        });
    };

    socket.on('data', (chunk: Buffer) => {
        // 检查是否已取消
        if (aborted) return;

        if (!headersParsed) {
            // #38 修复：只累积，不做全量 concat
            chunks.push(chunk);
            receivedLength += chunk.length;

            const fullBuffer = Buffer.concat(chunks);
            if (tryParseHeaders(fullBuffer)) {
                if (bodySink && statusCode >= 200 && statusCode < 300) {
                    // 流式模式：头已解析立即 resolve，并把头部之后已到达的 body 字节转交流
                    resolveStreamingResponse();
                    emitBodyBytes(fullBuffer.subarray(headerEndIndex + 4));
                    chunks.length = 0; // 流式模式不再需要整包累积
                    if (isStreamComplete()) {
                        // 使用 end() 进行优雅关闭，避免 ECONNRESET
                        socket.end();
                        finishStreaming();
                    }
                    return;
                }
                if (isResponseComplete()) {
                    // 使用 end() 进行优雅关闭，避免 ECONNRESET
                    socket.end();
                    finishResponse();
                }
            }
            return;
        }

        if (bodySink && statusCode >= 200 && statusCode < 300) {
            // 流式模式：body 字节逐包转交
            emitBodyBytes(chunk);
            if (isStreamComplete()) {
                // 使用 end() 进行优雅关闭，避免 ECONNRESET
                socket.end();
                finishStreaming();
            }
            return;
        }

        // 非流式 / 错误响应：#38 修复，只累积，不做全量 concat
        chunks.push(chunk);
        receivedLength += chunk.length;
        if (isResponseComplete()) {
            // 使用 end() 进行优雅关闭，避免 ECONNRESET
            socket.end();
            finishResponse();
        }
    });

    socket.on('end', () => {
        if (aborted) return;
        cleanup();
        if (streamingActive()) {
            // 流式模式：连接结束即 body 结束（或完整性校验失败时经流报错）
            if (isStreamBodyComplete()) {
                finishStreaming();
            } else {
                bodySink?.error(new Error('Connection closed with incomplete response body'));
            }
            return;
        }
        if (headersParsed) {
            // #40 修复：只有 body 完整才成功返回
            if (hasValidBody()) {
                finishResponse();
            } else {
                reject(new Error('Connection closed with incomplete response body'));
            }
        } else {
            reject(new Error('Connection closed before headers received'));
        }
    });

    socket.on('close', () => {
        if (aborted) return;
        cleanup();
        if (streamingActive()) {
            if (isStreamBodyComplete()) {
                finishStreaming();
            } else {
                bodySink?.error(new Error('Connection closed with incomplete response body'));
            }
            return;
        }
        if (headersParsed && !responseFinished) {
            // #40 修复：只有 body 完整才成功返回
            if (hasValidBody()) {
                finishResponse();
            } else {
                reject(new Error('Connection closed with incomplete response body'));
            }
        }
    });

    socket.on('error', (err) => {
        if (aborted) return;
        cleanup();
        if (streamingActive()) {
            // 流式模式：错误经 body 流传播给消费方
            bodySink?.error(err);
            return;
        }
        reject(err);
    });
}
