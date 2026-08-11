/**
 * GrayCode - 代理 Fetch 实现
 *
 * 支持通过 HTTP 代理发起 HTTPS 请求（CONNECT 隧道方式）
 */

import { t } from '../../i18n';
import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import { URL } from 'url';
import { ChannelError, ErrorType } from './types';
import { getGlobalSettingsManager } from '../../core/settingsContext';

/**
 * 解析是否跳过 TLS 证书校验。
 *
 * - 显式传入的参数优先（测试或调用方可直接指定）；
 * - 否则读取全局设置 graycode.proxy.insecureSkipVerify（默认 false = 校验证书）。
 *
 * 仅用于自签名证书调试，生产环境应保持校验开启。
 */
export function resolveProxyInsecureSkipVerify(explicit?: boolean): boolean {
    if (explicit !== undefined) {
        return explicit;
    }
    return getGlobalSettingsManager()?.getProxyInsecureSkipVerify() ?? false;
}

/**
 * 从上游 API 的非 2xx 响应体中提取人类可读错误消息。
 */
export function extractUpstreamErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        if (typeof body === 'string' && body.trim()) return body.trim();
        return undefined;
    }

    const obj = body as Record<string, any>;
    if (obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string') {
        return obj.error.message.trim();
    }
    if (typeof obj.error === 'string') {
        return obj.error.trim();
    }
    if (typeof obj.message === 'string') {
        return obj.message.trim();
    }
    return undefined;
}

// User-Agent 标识
/**
 * 默认代理请求 User-Agent。GrayCode 是当前扩展的正式产品名（扩展 ID：Komeiji-Shiki.graycode）；
 * LimCode 仅是部分历史模块注释中的旧称，因此这里有意保持 GrayCode。
 */
const USER_AGENT = 'GrayCode';

/**
 * 优雅关闭 socket：先发 FIN，等待 close 事件（5s 超时兜底防止定时器泄漏）。
 * 多处 onAbort / finally 共用同一个实现。
 */
export function closeSocketGracefully(socket: import('net').Socket): Promise<void> {
    return new Promise<void>((resolve) => {
        if (socket.destroyed || !socket.writable) {
            resolve();
            return;
        }
        const closeTimeout = setTimeout(() => {
            if (!socket.destroyed) {
                socket.destroy();
            }
            resolve();
        }, 5000);
        socket.once('close', () => {
            clearTimeout(closeTimeout);
            resolve();
        });
        socket.end();
    });
}

/**
 * 解析代理 URL → 连接参数。
 *
 * - 正确区分 https://（https.request + 默认 443）和 http://（http.request + 默认 80）
 * - 提取用户名/密码并生成 Proxy-Authorization Basic 头
 */
export function parseProxyLeg(proxyUrl: string): {
    request: typeof http.request;
    hostname: string;
    port: number;
    proxyAuthHeader?: string;
} {
    const parsed = new URL(proxyUrl);
    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

    let proxyAuthHeader: string | undefined;
    if (parsed.username || parsed.password) {
        const auth = Buffer.from(
            `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        ).toString('base64');
        proxyAuthHeader = `Basic ${auth}`;
    }

    return {
        request: isHttps ? https.request : http.request,
        hostname: parsed.hostname,
        port,
        proxyAuthHeader
    };
}

/**
 * Fetch 选项
 */
export interface FetchOptions {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeout?: number;
    signal?: AbortSignal;
}

/** createProxyFetch 的请求选项：在标准 RequestInit 之上增加代理专用 timeout */
export interface ProxyFetchInit extends RequestInit {
    /** 代理请求超时（毫秒），缺省 120s */
    timeout?: number;
}

/**
 * Fetch 响应
 */
export interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    text: () => Promise<string>;
    json: () => Promise<any>;
    body: ReadableStream<Uint8Array> | null;
}

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

function createProxyStreamSink(): ProxyStreamSink {
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
 * 创建一个支持代理的 fetch 函数
 *
 * 响应体流式转发：成功响应在头解析完成后即返回，body 字节经 ReadableStream 逐包交付。
 * 修复：此前先 await response.text() 整包读入内存再包新 Response——数百 MB 的 vsix 下载
 * 内存双份、超 V8 字符串上限（~512MB）直接 RangeError 崩溃，且二进制经 UTF-8 往返解码
 * 损坏（无效字节被替换为 U+FFFD）。错误响应（非 2xx）体通常很小，仍走整包文本构造。
 *
 * @param proxyUrl 代理地址（可选），如 http://127.0.0.1:7890
 * @returns fetch 函数
 */
export function createProxyFetch(proxyUrl?: string): (url: string | URL, init?: ProxyFetchInit) => Promise<Response> {
    if (!proxyUrl) {
        // 无代理，使用原生 fetch（原生 fetch 无 timeout 选项：调用方自行以 AbortSignal 控制超时）
        return fetch as (url: string | URL, init?: ProxyFetchInit) => Promise<Response>;
    }
    
    return async (url: string | URL, init?: ProxyFetchInit): Promise<Response> => {
        const targetUrl = typeof url === 'string' ? new URL(url) : url;
        const options: FetchOptions = {
            method: init?.method || 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                ...(init?.headers as Record<string, string> || {})
            },
            body: init?.body as string | undefined,
            // 修复：透传调用方指定的 timeout（此前硬编码 120s，调用方超时被忽略）
            timeout: init?.timeout ?? 120000,
            signal: init?.signal ?? undefined  // 传递 abort signal，null→undefined
        };
        
        const sink = createProxyStreamSink();
        const response = await fetchWithProxy(targetUrl, options, proxyUrl, undefined, sink);
        
        if (response.body) {
            // 流式模式：body 持续流入，消费方（UpdateChecker 等）边读边落盘
            // 204/304 状态码禁止携带响应体：Response 构造器对「非 null body + 204/304」抛 TypeError
            const isNullBodyStatus = response.status === 204 || response.status === 304;
            if (isNullBodyStatus) {
                // 弃用 sink 流前主动关闭：否则底层 socket 仍在读、body 字节持续推入无人
                // 消费的 ReadableStream（无消费者时队列无界积压），连接直到服务器关闭才释放
                sink.end();
            }
            return new Response(isNullBodyStatus ? null : response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }
        
        // 非流式（错误响应等，体通常很小）：保持整包文本构造
        const responseText = await response.text();
        const isNullBodyStatus = response.status === 204 || response.status === 304;
        return new Response(isNullBodyStatus ? null : responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    };
}

/**
 * 创建标准 AbortError：ChannelManager 按 error.name === 'AbortError' 区分「用户取消/超时」
 * 与普通网络错误；普通 Error 会被 isRetryableError 误判为可重试，取消操作变成无谓重试。
 *
 * 文案按 signal.reason 区分：调用方以 Error 作为 abort 原因（如超时）时透传其 message；
 * 无原因时保持默认 'Request cancelled'。
 */
function createAbortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const message = reason instanceof Error && reason.message.trim()
        ? reason.message
        : 'Request cancelled';
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * 通过 HTTP 代理发起请求（CONNECT 隧道方式）
 */
async function fetchWithProxy(
    targetUrl: URL,
    init: FetchOptions,
    proxyUrl: string,
    insecureSkipVerify?: boolean,
    bodySink?: ProxyStreamSink
): Promise<FetchResponse> {
    const proxyLeg = parseProxyLeg(proxyUrl);
    const targetHost = targetUrl.hostname;
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const isHttps = targetUrl.protocol === 'https:';

    // 仅当用户显式开启（设置或参数）时才跳过证书校验；默认校验证书
    const skipVerify = resolveProxyInsecureSkipVerify(insecureSkipVerify);

    // 检查是否已取消
    if (init.signal?.aborted) {
        throw createAbortError(init.signal);
    }

    return new Promise((resolve, reject) => {
        const timeout = init.timeout || 120000;
        let tunnelSocket: import('net').Socket | undefined;

        // 构建 CONNECT 请求头（含 Proxy-Authorization）
        const reqHeaders: Record<string, string> = {};
        if (proxyLeg.proxyAuthHeader) {
            reqHeaders['Proxy-Authorization'] = proxyLeg.proxyAuthHeader;
        }

        // 创建到代理的连接
        const proxyReq = proxyLeg.request({
            hostname: proxyLeg.hostname,
            port: proxyLeg.port,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            timeout,
            // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
            ...(proxyLeg.request === https.request && skipVerify ? { rejectUnauthorized: false } : {}),
            headers: reqHeaders
        });

        // 监听取消信号（#35 修复：握手阶段取消时正确清理隧道 socket）
        const onAbort = () => {
            if (!proxyReq.destroyed) {
                proxyReq.destroy();
            }
            if (tunnelSocket) {
                closeSocketGracefully(tunnelSocket);
            }
            reject(createAbortError(init.signal));
        };
        if (init.signal) {
            init.signal.addEventListener('abort', onAbort, { once: true });
        }

        proxyReq.on('connect', (res, socket) => {
            // 握手成功后移除旧监听：后续取消由 sendRequestOverSocket 自行监听清理，
            // 避免握手后旧监听重复取消已转交的 socket
            if (init.signal) {
                init.signal.removeEventListener('abort', onAbort);
            }
            tunnelSocket = socket;

            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
                return;
            }

            if (isHttps) {
                // 在隧道上建立 TLS 连接
                // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
                const tlsSocket = tls.connect({
                    socket: socket,
                    servername: targetHost,
                    ...(skipVerify ? { rejectUnauthorized: false } : {})
                }, () => {
                    sendRequestOverSocket(tlsSocket, targetUrl, init, resolve, reject, bodySink);
                });

                tlsSocket.on('error', (error: Error) => {
                    reject(new Error(`TLS error: ${error.message}`));
                });
            } else {
                // HTTP 请求直接通过隧道
                sendRequestOverSocket(socket, targetUrl, init, resolve, reject, bodySink);
            }
        });

        proxyReq.on('error', (error) => {
            if (init.signal) {
                init.signal.removeEventListener('abort', onAbort);
            }
            reject(new Error(`Proxy request failed: ${error.message}`));
        });

        proxyReq.on('timeout', () => {
            if (init.signal) {
                init.signal.removeEventListener('abort', onAbort);
            }
            proxyReq.destroy();
            // CONNECT 握手超时以 AbortError 呈现：纳入统一超时文案（ChannelManager
            // 判 TIMEOUT_ERROR / UpdateChecker 转「下载超时」），而非普通 Error 被
            // isRetryableError 误判为可重试（代理不可达时无限重试）
            const error = new Error('Proxy request timeout');
            error.name = 'AbortError';
            reject(error);
        });

        proxyReq.end();
    });
}

/**
 * 通过 socket 发送 HTTP 请求（支持整包与流式响应体两种模式：
 * 提供 bodySink 时头解析完成后即 resolve，body 字节逐包经 sink 转交）
 */
function sendRequestOverSocket(
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

    const isResponseComplete = (): boolean => {
        if (!headersParsed) {
            return false;
        }

        if (contentLength >= 0) {
            return receivedLength - headerEndIndex - 4 >= contentLength;
        }

        if (isChunked) {
            const fullBuffer = Buffer.concat(chunks);
            const bodyBuffer = fullBuffer.subarray(headerEndIndex + 4);
            const endMarker = Buffer.from('0\r\n\r\n');
            const hasEnd = bodyBuffer.includes(endMarker);
            const hasEndAlt = bodyBuffer.toString('utf8').includes('\r\n0\r\n');
            return hasEnd || hasEndAlt;
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
            const fullBuffer = Buffer.concat(chunks);
            const bodyBuffer = fullBuffer.subarray(headerEndIndex + 4);
            const endMarker = Buffer.from('0\r\n\r\n');
            return bodyBuffer.includes(endMarker) || bodyBuffer.toString('utf8').includes('\r\n0\r\n');
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

/**
 * 解码 chunked transfer encoding
 */
export function decodeChunkedBuffer(data: Buffer): string {
    const resultChunks: Buffer[] = [];
    let offset = 0;
    
    while (offset < data.length) {
        // 查找 chunk size 行的结束 (\r\n)
        let sizeEnd = -1;
        for (let i = offset; i < data.length - 1; i++) {
            if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                sizeEnd = i;
                break;
            }
        }
        
        if (sizeEnd === -1) {
            break;
        }
        
        // 解析 chunk size（十六进制）
        const sizeLine = data.subarray(offset, sizeEnd).toString('ascii');
        const chunkSize = parseInt(sizeLine.trim(), 16);
        
        if (chunkSize === 0 || isNaN(chunkSize)) {
            break;
        }
        
        // 计算 chunk 数据的位置
        const chunkDataStart = sizeEnd + 2;
        const chunkDataEnd = chunkDataStart + chunkSize;
        
        if (chunkDataEnd > data.length) {
            break;
        }
        
        // 提取 chunk 数据
        resultChunks.push(data.subarray(chunkDataStart, chunkDataEnd));
        
        // 移动到下一个 chunk
        offset = chunkDataEnd + 2;
    }
    
    return Buffer.concat(resultChunks).toString('utf8');
}

/**
 * 增量解码 chunked transfer encoding：只解码已完整到达的块。
 * 返回已解码字节、已消费偏移与是否遇到终止块（chunkSize 0）。
 * proxyStreamFetch 与 sendRequestOverSocket（流式响应体）共用，避免两份平行解码逻辑。
 */
function decodeChunkedStreamIncremental(data: Buffer): { decoded: Buffer | null; consumed: number; terminated: boolean } {
    const pieces: Buffer[] = [];
    let offset = 0;
    let terminated = false;

    while (offset < data.length) {
        // 查找 chunk size 行的结束 (\r\n)
        let sizeEnd = -1;
        for (let i = offset; i < data.length - 1; i++) {
            if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                sizeEnd = i;
                break;
            }
        }

        if (sizeEnd === -1) {
            // 没找到完整的 size 行，保留剩余数据
            break;
        }

        // 解析 chunk size（十六进制）
        const sizeLine = data.subarray(offset, sizeEnd).toString('ascii').trim();
        const chunkSize = parseInt(sizeLine, 16);

        if (isNaN(chunkSize)) {
            // 无效的 size，跳过这行
            offset = sizeEnd + 2;
            continue;
        }

        if (chunkSize === 0) {
            // 结束标记
            terminated = true;
            offset = data.length;
            break;
        }

        // 计算 chunk 数据的位置
        const chunkDataStart = sizeEnd + 2;
        const chunkDataEnd = chunkDataStart + chunkSize;

        if (chunkDataEnd + 2 > data.length) {
            // 数据不完整，保留从 offset 开始的所有数据
            break;
        }

        // 提取 chunk 数据（原始字节，解码由调用方的流式 TextDecoder 完成）
        pieces.push(data.subarray(chunkDataStart, chunkDataEnd));

        // 移动到下一个 chunk（跳过 \r\n）
        offset = chunkDataEnd + 2;
    }

    return {
        decoded: pieces.length > 0 ? Buffer.concat(pieces) : null,
        consumed: offset,
        terminated
    };
}

/**
 * 创建支持代理的流式 fetch
 *
 * 返回一个异步生成器，产出原始响应行
 *
 * @param insecureSkipVerify 是否跳过 TLS 证书校验（可选，仅用于自签名证书调试；
 *        缺省时读取全局设置 graycode.proxy.insecureSkipVerify，默认 false = 校验证书）
 */
export async function* proxyStreamFetch(
    url: string,
    init: FetchOptions,
    proxyUrl?: string,
    insecureSkipVerify?: boolean
): AsyncGenerator<string> {
    if (!proxyUrl) {
        // 无代理，使用原生 fetch
        const headersWithUserAgent = { 'User-Agent': USER_AGENT, ...init.headers };
        const response = await fetch(url, {
            method: init.method,
            headers: headersWithUserAgent,
            body: init.body,
            signal: init.signal
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
            throw new Error('No response body');
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        try {
            while (true) {
                // 检查是否已取消
                if (init.signal?.aborted) {
                    reader.cancel();
                    break;
                }
                const { done, value } = await reader.read();
                if (done) break;
                yield decoder.decode(value, { stream: true });
            }
        } finally {
            reader.releaseLock();
        }
        return;
    }
    
    // 使用代理（#36 修复：正确解析 proxy URL 的协议/端口/认证）
    const targetUrl = new URL(url);
    const proxyLeg = parseProxyLeg(proxyUrl);
    const targetHost = targetUrl.hostname;
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const isHttps = targetUrl.protocol === 'https:';

    // 仅当用户显式开启（设置或参数）时才跳过证书校验；默认校验证书
    const skipVerify = resolveProxyInsecureSkipVerify(insecureSkipVerify);

    // 检查是否已取消
    if (init.signal?.aborted) {
        throw createAbortError(init.signal);
    }

    const socket = await new Promise<tls.TLSSocket | import('net').Socket>((resolve, reject) => {
        const timeout = init.timeout || 120000;
        let settled = false;
        let proxyReq: http.ClientRequest | null = null;

        const cleanupAbortListener = () => {
            if (init.signal) {
                init.signal.removeEventListener('abort', onAbort);
            }
        };

        const finishResolve = (targetSocket: tls.TLSSocket | import('net').Socket) => {
            if (settled) return;
            settled = true;
            cleanupAbortListener();
            resolve(targetSocket);
        };

        const finishReject = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanupAbortListener();
            reject(error);
        };

        // 监听取消信号
        const onAbort = () => {
            proxyReq?.destroy();
            finishReject(createAbortError(init.signal));
        };

        if (init.signal) {
            if (init.signal.aborted) {
                onAbort();
                return;
            }
            init.signal.addEventListener('abort', onAbort, { once: true });
        }

        // 构建 CONNECT 请求头（含 Proxy-Authorization）
        const reqHeaders: Record<string, string> = {};
        if (proxyLeg.proxyAuthHeader) {
            reqHeaders['Proxy-Authorization'] = proxyLeg.proxyAuthHeader;
        }

        proxyReq = proxyLeg.request({
            hostname: proxyLeg.hostname,
            port: proxyLeg.port,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            timeout,
            // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
            ...(proxyLeg.request === https.request && skipVerify ? { rejectUnauthorized: false } : {}),
            headers: reqHeaders
        });
        
        proxyReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                finishReject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
                return;
            }
            
            if (isHttps) {
                // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
                const tlsSocket = tls.connect({
                    socket: socket,
                    servername: targetHost,
                    ...(skipVerify ? { rejectUnauthorized: false } : {})
                }, () => {
                    finishResolve(tlsSocket);
                });
                
                tlsSocket.on('error', (error: Error) => {
                    finishReject(new Error(`TLS error: ${error.message}`));
                });
            } else {
                finishResolve(socket);
            }
        });
        
        proxyReq.on('error', (error) => {
            finishReject(new Error(`Proxy request failed: ${error.message}`));
        });
        
        proxyReq.on('timeout', () => {
            proxyReq?.destroy();
            // 与 fetchWithProxy 的 CONNECT 握手超时同步：以 AbortError 呈现，纳入统一
            // 超时文案（generateStream 的 AbortError 分支判 TIMEOUT_ERROR），而非普通
            // Error 被 isRetryableError 误判为可重试
            const error = new Error('Proxy request timeout');
            error.name = 'AbortError';
            finishReject(error);
        });
        
        proxyReq.end();
    });
    
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

                const isErrorBodyComplete = (): boolean => {
                    const totalBytes = errorBodyBytes.reduce((sum, b) => sum + b.length, 0);
                    if (errorContentLength >= 0) {
                        return totalBytes >= errorContentLength;
                    }
                    if (errorIsChunked) {
                        const fullBody = Buffer.concat(errorBodyBytes);
                        const endMarker = Buffer.from('0\r\n\r\n');
                        return fullBody.includes(endMarker) || fullBody.toString('utf8').includes('\r\n0\r\n');
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