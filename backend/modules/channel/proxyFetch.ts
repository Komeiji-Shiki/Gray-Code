/**
 * LimCode - 代理 Fetch 实现
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
 * - 否则读取全局设置 graycode.proxy.insecureSkipVerify（默认 false = 校验证书）；
 * - 兼容 fork 的环境变量开关 GRAYCODE_ALLOW_INSECURE_TLS=1（抓包/自建自签名代理场景）。
 *
 * 仅用于自签名证书调试，生产环境应保持校验开启。
 */
export function resolveProxyInsecureSkipVerify(explicit?: boolean): boolean {
    if (explicit !== undefined) {
        return explicit;
    }
    if (getGlobalSettingsManager()?.getProxyInsecureSkipVerify()) {
        return true;
    }
    const raw = process.env.GRAYCODE_ALLOW_INSECURE_TLS;
    return raw === '1' || raw === 'true' || raw === 'TRUE';
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
 * 窗口期 abort 桥接。
 *
 * 修改原因：fetchWithProxy / proxyStreamFetch 在 CONNECT 成功后先摘除旧 abort 监听，
 *           而新监听要等 tls.connect 异步回调（TLS 握手完成）才挂载，窗口期内 abort 信号丢失，
 *           TLS 握手悬挂、请求永不收敛。
 * 修改方式：窗口期挂一次性监听，记录已 abort 状态并立即销毁隧道 socket；
 *           握手成功或失败后调用 release 摘除桥接（幂等）。
 * 修改目的：TLS 握手阶段的取消与握手前后保持同一语义（AbortError + 连接清理）。
 */
export function createAbortBridge(
    signal: AbortSignal | undefined,
    onAbort: () => void
): { aborted: () => boolean; release: () => void } {
    let didAbort = false;
    if (!signal) {
        return { aborted: () => false, release: () => undefined };
    }
    const handler = () => {
        didAbort = true;
        onAbort();
    };
    signal.addEventListener('abort', handler, { once: true });
    return {
        aborted: () => didAbort,
        release: () => signal.removeEventListener('abort', handler)
    };
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
 * 创建一个支持代理的 fetch 函数
 *
 * @param proxyUrl 代理地址（可选），如 http://127.0.0.1:7890
 * @returns fetch 函数
 */
export function createProxyFetch(proxyUrl?: string) {
    if (!proxyUrl) {
        // 无代理，使用原生 fetch
        return fetch;
    }
    
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const targetUrl = typeof url === 'string' ? new URL(url) : url;
        const options: FetchOptions = {
            method: init?.method || 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                ...(init?.headers as Record<string, string> || {})
            },
            body: init?.body as string | undefined,
            timeout: 120000,
            signal: init?.signal ?? undefined  // 传递 abort signal，null→undefined
        };
        
        const response = await fetchWithProxy(targetUrl, options, proxyUrl);
        
        // 转换为标准 Response 对象
        const responseText = await response.text();
        return new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    };
}

/**
 * 创建标准 AbortError：ChannelManager 按 error.name === 'AbortError' 区分「用户取消/超时」
 * 与普通网络错误；普通 Error 会被 isRetryableError 误判为可重试，取消操作变成无谓重试。
 */
function createAbortError(message = 'Request cancelled'): Error {
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
    insecureSkipVerify?: boolean
): Promise<FetchResponse> {
    const proxyLeg = parseProxyLeg(proxyUrl);
    const targetHost = targetUrl.hostname;
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const isHttps = targetUrl.protocol === 'https:';

    // 仅当用户显式开启（设置或参数）时才跳过证书校验；默认校验证书
    const skipVerify = resolveProxyInsecureSkipVerify(insecureSkipVerify);

    // 检查是否已取消
    if (init.signal?.aborted) {
        throw createAbortError();
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
            reject(createAbortError());
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

            // CONNECT 阶段 http.request({ timeout }) 在 socket 上武装的空闲定时器必须立即解除：
            // 否则长流式请求在「上游思考、无数据可发」的静默期超过 timeout 毫秒时，
            // 旧定时器会触发 proxyReq 'timeout' → destroy() 把已转交的隧道 socket 销毁，
            // 正在进行的流被固定超时强行掐断（keep-alive 心跳也无法挽救）。
            // 流的空闲超时由 ChannelManager.executeStreamRequest 自己的可重置计时器管理。
            if (typeof socket.setTimeout === 'function') {
                socket.setTimeout(0);
            }

            // 修改原因：旧监听已在上面摘除，而新监听要等 tls.connect 异步回调（TLS 握手完成）
            //           才由 sendRequestOverSocket 挂载，窗口期内 abort 信号丢失、握手悬挂。
            // 修改方式：窗口期挂桥接监听（once），记录已 abort 状态并销毁隧道 socket；
            //           TLS 握手结束（成功或出错）或走非 TLS 分支时摘除桥接。
            // 修改目的：握手阶段取消与握手前后语义一致（AbortError + 连接清理），不悬挂。
            const bridge = createAbortBridge(init.signal, () => {
                closeSocketGracefully(socket);
            });

            if (isHttps) {
                // 在隧道上建立 TLS 连接
                // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
                const tlsSocket = tls.connect({
                    socket: socket,
                    servername: targetHost,
                    ...(skipVerify ? { rejectUnauthorized: false } : {})
                }, () => {
                    bridge.release();
                    if (bridge.aborted()) {
                        // 窗口期内已被取消：立即销毁，不发送任何请求
                        tlsSocket.destroy();
                        reject(createAbortError());
                        return;
                    }
                    sendRequestOverSocket(tlsSocket, targetUrl, init, resolve, reject);
                });

                tlsSocket.on('error', (error: Error) => {
                    bridge.release();
                    reject(bridge.aborted() ? createAbortError() : new Error(`TLS error: ${error.message}`));
                });
            } else {
                // HTTP 请求直接通过隧道（窗口期为同步段，直接摘除桥接）
                bridge.release();
                sendRequestOverSocket(socket, targetUrl, init, resolve, reject);
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
            reject(new Error('Proxy request timeout'));
        });

        proxyReq.end();
    });
}

/**
 * 通过 socket 发送 HTTP 请求（非流式路径）
 */
function sendRequestOverSocket(
    socket: tls.TLSSocket | import('net').Socket,
    targetUrl: URL,
    init: FetchOptions,
    resolve: (response: FetchResponse) => void,
    reject: (error: Error) => void
): void {
    // 检查是否已取消
    if (init.signal?.aborted) {
        socket.destroy();
        reject(createAbortError());
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
        reject(createAbortError());
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

    // 确保 User-Agent 被包含
    const headersWithUserAgent = { 'User-Agent': USER_AGENT, ...init.headers };
    // 防御纵深：header 名/值剥离 CR/LF，防止含换行的配置值构造请求头注入/走私（L3）
    const sanitizeHeaderValue = (value: unknown): string =>
        String(value).replace(/[\r\n]+/g, ' ').trim();
    const headers = [
        `Host: ${targetUrl.hostname}`,
        ...Object.entries(headersWithUserAgent).map(([k, v]) => `${k}: ${sanitizeHeaderValue(v)}`),
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

    const tryParseHeaders = (fullBuffer: Buffer): boolean => {
        const headerEndMarker = Buffer.from('\r\n\r\n');
        headerEndIndex = fullBuffer.indexOf(headerEndMarker);

        if (headerEndIndex === -1) {
            return false;
        }

        const headerPart = fullBuffer.subarray(0, headerEndIndex).toString('utf8');

        const lines = headerPart.split('\r\n');
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) (.+)/);
        statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
        statusText = statusMatch ? statusMatch[2] : '';

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
            json: async () => JSON.parse(finalBody),
            body: null
        });
    };

    socket.on('data', (chunk: Buffer) => {
        // 检查是否已取消
        if (aborted) return;

        // #38 修复：只累积，不做全量 concat
        chunks.push(chunk);
        receivedLength += chunk.length;

        if (!headersParsed) {
            const fullBuffer = Buffer.concat(chunks);
            if (tryParseHeaders(fullBuffer) && isResponseComplete()) {
                // 使用 end() 进行优雅关闭，避免 ECONNRESET
                socket.end();
                finishResponse();
            }
        } else {
            if (isResponseComplete()) {
                // 使用 end() 进行优雅关闭，避免 ECONNRESET
                socket.end();
                finishResponse();
            }
        }
    });

    socket.on('end', () => {
        if (aborted) return;
        cleanup();
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
        throw createAbortError();
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
            finishReject(createAbortError());
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

            // CONNECT 阶段 http.request({ timeout }) 武装的 socket 空闲定时器必须立即解除：
            // 否则流式请求在「上游思考、无数据可发」的静默期超过 timeout 毫秒时，
            // 旧定时器触发 proxyReq 'timeout' → destroy() 把已转交的隧道 socket 销毁，
            // 正在进行的流被固定超时强行掐断（keep-alive 心跳也无法挽救）。
            // 流的空闲超时由 ChannelManager.executeStreamRequest 的可重置计时器管理。
            if (typeof socket.setTimeout === 'function') {
                socket.setTimeout(0);
            }

            // CONNECT 成功后旧监听已无用（proxyReq 职责结束），立即摘除；
            // 窗口期取消改由下面的桥接监听接管，避免与新监听双重处理。
            cleanupAbortListener();

            // 修改原因：旧监听已摘除，而新监听要等 tls.connect 异步回调（TLS 握手完成）
            //           且 socket Promise resolve 后才挂载，窗口期内 abort 信号丢失、握手悬挂。
            // 修改方式：窗口期挂桥接监听（once），记录已 abort 状态并销毁隧道 socket；
            //           TLS 握手结束（成功或出错）或走非 TLS 分支时摘除桥接。
            // 修改目的：握手阶段取消与握手前后语义一致（AbortError + 连接清理），不悬挂。
            const bridge = createAbortBridge(init.signal, () => {
                closeSocketGracefully(socket);
            });

            if (isHttps) {
                // 仅用于自签名证书调试：只有显式开启 skipVerify 时才跳过证书校验
                const tlsSocket = tls.connect({
                    socket: socket,
                    servername: targetHost,
                    ...(skipVerify ? { rejectUnauthorized: false } : {})
                }, () => {
                    bridge.release();
                    if (bridge.aborted()) {
                        // 窗口期内已被取消：立即销毁，不进入流式发送流程
                        tlsSocket.destroy();
                        finishReject(createAbortError());
                        return;
                    }
                    finishResolve(tlsSocket);
                });
                
                tlsSocket.on('error', (error: Error) => {
                    bridge.release();
                    finishReject(bridge.aborted() ? createAbortError() : new Error(`TLS error: ${error.message}`));
                });
            } else {
                // 非 TLS 分支为同步段，直接摘除桥接
                bridge.release();
                finishResolve(socket);
            }
        });
        
        proxyReq.on('error', (error) => {
            finishReject(new Error(`Proxy request failed: ${error.message}`));
        });
        
        proxyReq.on('timeout', () => {
            proxyReq?.destroy();
            finishReject(new Error('Proxy request timeout'));
        });
        
        proxyReq.end();
    });
    
    // 发送请求
    const body = init.body || '';
    const bodyBuffer = Buffer.from(body, 'utf8');
    
    const requestLine = `${init.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
    
    // 确保 User-Agent 被包含
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
    let rawBuffer = Buffer.alloc(0);  // 使用 Buffer 处理原始数据
    let headersParsed = false;
    let statusCode = 0;
    let isChunked = false;
    let chunkedBuffer = Buffer.alloc(0);  // chunked 解码缓冲区
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
     * 实时解码 chunked 数据
     * 返回已解码的数据和剩余的未完成 chunk
     */
    const decodeChunkedStream = (data: Buffer): { decoded: Buffer | null, remaining: Buffer } => {
        // 只收集原始字节，不做字符串解码：被 TCP/chunk 边界切开的 UTF-8 多字节字符
        // 若在第一个包就 toString('utf8') 会固化成 U+FFFD，中文内容损坏/流中断
        const pieces: Buffer[] = [];
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
            remaining: data.subarray(offset)
        };
    };
    
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

                    rawBuffer = Buffer.concat([rawBuffer, chunk]);

                    if (!headersParsed) {
                        const headerEndMarker = Buffer.from('\r\n\r\n');
                        const headerEnd = rawBuffer.indexOf(headerEndMarker);

                        if (headerEnd !== -1) {
                            const headerPart = rawBuffer.subarray(0, headerEnd).toString('utf8');
                            const statusMatch = headerPart.match(/HTTP\/\d\.\d (\d+)/);
                            statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

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
                            chunkedBuffer = Buffer.concat([chunkedBuffer, rawBuffer]);
                            rawBuffer = Buffer.alloc(0);

                            const { decoded, remaining } = decodeChunkedStream(chunkedBuffer);
                            chunkedBuffer = Buffer.from(remaining);

                            if (decoded) {
                                // 流式解码：跨 chunk 的多字节字符由 TextDecoder 内部缓冲拼接
                                dataQueue.push(decoder.decode(decoded, { stream: true }));
                                notify();
                            }
                        } else {
                            // 非 chunked：同样走流式解码，跨包多字节字符由 TextDecoder 缓冲拼接
                            dataQueue.push(decoder.decode(rawBuffer, { stream: true }));
                            rawBuffer = Buffer.alloc(0);
                            notify();
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
        
        // 数据队列（生产者：socket data 事件；消费者：下方 for-await 循环）
        const dataQueue: string[] = [];
        let readPromise: Promise<void> | null = null;
        let readError: unknown = null;
        let isReading = true;

        // 生产-消费唤醒：队列为空且仍在读取时，等待 socket 事件驱动的唤醒，
        // 替代每 10ms 空转轮询（模型生成 token 的间隔常达数秒，期间事件循环每秒被无谓唤醒 100 次）
        let wakePromise: Promise<void> | null = null;
        let wakeResolve: (() => void) | null = null;
        const notify = () => {
            if (wakeResolve) {
                const resolve = wakeResolve;
                wakeResolve = null;
                wakePromise = null;
                resolve();
            }
        };
        const waitForData = (): Promise<void> => {
            if (wakePromise) return wakePromise;
            wakePromise = new Promise<void>((resolve) => {
                wakeResolve = resolve;
            });
            return wakePromise;
        };
        
        // 启动后台数据读取
        readPromise = readData()
            .catch((err: unknown) => {
                readError = err;
            })
            .finally(() => {
                isReading = false;
                notify();
            });

        try {
            while (isReading || dataQueue.length > 0) {
                // 检查是否已取消
                if (init.signal?.aborted) {
                    break;
                }

                if (dataQueue.length > 0) {
                    yield dataQueue.shift()!;
                } else if (isReading) {
                    // 无数据时挂起等待 socket 数据 / 结束 / 关闭事件唤醒
                    await waitForData();
                }
            }
        } finally {
            // 唤醒 promise 挂起时同步清理，避免悬挂引用
            if (wakeResolve) {
                wakeResolve = null;
                wakePromise = null;
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
                const { decoded } = decodeChunkedStream(chunkedBuffer);
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