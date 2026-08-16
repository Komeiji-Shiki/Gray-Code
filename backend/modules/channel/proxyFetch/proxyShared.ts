/**
 * GrayCode - 代理请求共享工具与类型
 *
 * 由 proxyFetch.ts 拆分而来：承载多个子模块共用的纯工具函数与类型，
 * 避免 proxyFetch 与各子模块之间形成循环依赖。
 */

import { getGlobalSettingsManager } from '../../../core/settingsContext';

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
 *
 * 兼容数组包装错误（官方错误体有时把 message 放进数组，如
 * `{ error: { errors: [{ message }] } }`、`{ error: [{ message }] }`、
 * `{ errors: [{ message }] }`，甚至响应体本身就是数组）。
 */
export function extractUpstreamErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') {
        if (typeof body === 'string' && body.trim()) return body.trim();
        return undefined;
    }

    // 响应体本身是数组包装：逐个元素尝试，取第一个可读消息
    if (Array.isArray(body)) {
        for (const item of body) {
            const message = extractUpstreamErrorMessage(item);
            if (message) return message;
        }
        return undefined;
    }

    const obj = body as Record<string, any>;
    if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)) {
        if (typeof obj.error.message === 'string') {
            return obj.error.message.trim();
        }
        // 数组包装：error.errors: [{ message }]
        if (Array.isArray(obj.error.errors)) {
            for (const item of obj.error.errors) {
                const message = extractUpstreamErrorMessage(item);
                if (message) return message;
            }
        }
    }
    if (typeof obj.error === 'string') {
        return obj.error.trim();
    }
    // 数组包装：error 本身是数组
    if (Array.isArray(obj.error)) {
        for (const item of obj.error) {
            const message = extractUpstreamErrorMessage(item);
            if (message) return message;
        }
    }
    // 数组包装：顶层 errors: [{ message }]
    if (Array.isArray(obj.errors)) {
        for (const item of obj.errors) {
            const message = extractUpstreamErrorMessage(item);
            if (message) return message;
        }
    }
    if (typeof obj.message === 'string') {
        return obj.message.trim();
    }
    return undefined;
}

/**
 * 默认代理请求 User-Agent。GrayCode 是当前扩展的正式产品名（扩展 ID：Komeiji-Shiki.graycode）；
 * LimCode 仅是部分历史模块注释中的旧称，因此这里有意保持 GrayCode。
 */
export const USER_AGENT = 'GrayCode';

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
 * 创建标准 AbortError：ChannelManager 按 error.name === 'AbortError' 区分「用户取消/超时」
 * 与普通网络错误；普通 Error 会被 isRetryableError 误判为可重试，取消操作变成无谓重试。
 *
 * 文案按 signal.reason 区分：调用方以 Error 作为 abort 原因（如超时）时透传其 message；
 * 无原因时保持默认 'Request cancelled'。
 */
export function createAbortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const message = reason instanceof Error && reason.message.trim()
        ? reason.message
        : 'Request cancelled';
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
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
