/**
 * GrayCode - 代理 CONNECT 隧道建立
 *
 * 由 proxyFetch.ts 拆分而来：负责「CONNECT 隧道建立」职责——
 * 解析代理地址、发起 CONNECT 握手、（HTTPS 时）在隧道上完成 TLS 握手，
 * 最终返回一个可复用的 socket。流式解析职责见 proxyStreamResponse / proxyStreamReader。
 */

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import { URL } from 'url';
import { resolveProxyInsecureSkipVerify, createAbortError, type FetchOptions } from './proxyShared';

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
 * 建立到目标主机的 CONNECT 隧道（HTTPS 目标时含 TLS 握手），返回可复用的 socket。
 *
 * 统一 fetchWithProxy 与 proxyStreamFetch 的两段握手逻辑（此前二者重复实现）：
 * - 握手超时以 AbortError 呈现，纳入统一超时文案；
 * - 取消信号在握手阶段销毁 CONNECT 请求并 reject AbortError；
 * - 仅当显式开启 skipVerify 时才跳过证书校验。
 */
export function establishConnectTunnel(
    targetUrl: URL,
    init: FetchOptions,
    proxyUrl: string,
    insecureSkipVerify?: boolean
): Promise<tls.TLSSocket | import('net').Socket> {
    const proxyLeg = parseProxyLeg(proxyUrl);
    const targetHost = targetUrl.hostname;
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const isHttps = targetUrl.protocol === 'https:';

    // 仅当用户显式开启（设置或参数）时才跳过证书校验；默认校验证书
    const skipVerify = resolveProxyInsecureSkipVerify(insecureSkipVerify);

    return new Promise<tls.TLSSocket | import('net').Socket>((resolve, reject) => {
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
}
