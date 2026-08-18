/**
 * GrayCode - 代理 Fetch 实现
 *
 * 支持通过 HTTP 代理发起 HTTPS 请求（CONNECT 隧道方式）。
 *
 * 本文件仅保留公共 API 编排；「CONNECT 隧道建立」与「流式解析」两个职责
 * 已拆分到 proxyFetch/ 子目录：
 * - proxyConnectTunnel.ts   —— CONNECT 握手 + TLS
 * - proxyStreamResponse.ts  —— 整包/流式响应解析（sendRequestOverSocket）
 * - proxyStreamReader.ts    —— 代理流式响应体逐行读取（异步生成器）
 * - proxyChunked.ts         —— chunked transfer encoding 解析
 * - proxyShared.ts          —— 共享工具函数与类型
 */

import { URL } from 'url';
import { t } from '../../i18n';
import { ChannelError, ErrorType } from './types';
import {
    USER_AGENT,
    extractUpstreamErrorMessage,
    type FetchOptions,
    type ProxyFetchInit,
    type FetchResponse
} from './proxyFetch/proxyShared';
import { establishConnectTunnel } from './proxyFetch/proxyConnectTunnel';
import { createProxyStreamSink, sendRequestOverSocket, type ProxyStreamSink } from './proxyFetch/proxyStreamResponse';
import { readProxyStreamBody } from './proxyFetch/proxyStreamReader';

// 公共 API 再导出：保持 proxyFetch.ts 对外导出符号完全不变
export { resolveProxyInsecureSkipVerify, closeSocketGracefully, USER_AGENT } from './proxyFetch/proxyShared';
export { parseProxyLeg } from './proxyFetch/proxyConnectTunnel';
export { decodeChunkedBuffer } from './proxyFetch/proxyChunked';
export { extractUpstreamErrorMessage };
export type { FetchOptions, ProxyFetchInit, FetchResponse };
export type { ProxyStreamSink };

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
    // 取消/超时在握手阶段由 establishConnectTunnel 处理；此处先建立隧道，
    // 成功后由 sendRequestOverSocket 接管后续取消监听（与旧实现顺序一致）。
    const socket = await establishConnectTunnel(targetUrl, init, proxyUrl, insecureSkipVerify);
    return new Promise<FetchResponse>((resolve, reject) => {
        sendRequestOverSocket(socket, targetUrl, init, resolve, reject, bodySink);
    });
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
        // 无代理：包装原生 fetch 注入默认 User-Agent，与代理路径行为一致
        // （原生 fetch 无 timeout 选项：调用方自行以 AbortSignal 控制超时；调用方显式 UA 优先生效）
        return async (url: string | URL, init?: ProxyFetchInit): Promise<Response> => {
            const headers = {
                'User-Agent': USER_AGENT,
                ...(init?.headers as Record<string, string> | undefined)
            };
            return fetch(url, { ...init, headers });
        };
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
    const socket = await establishConnectTunnel(targetUrl, init, proxyUrl, insecureSkipVerify);
    yield* readProxyStreamBody(socket, targetUrl, init);
}
