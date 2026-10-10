import { ErrorType } from './errorTypes';

/** 网络恢复采用固定等待，不受普通 API 错误的重试次数和间隔影响。 */
export const NETWORK_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

export function isNetworkModelFailure(error: unknown): boolean {
    const value = error as { type?: string; code?: string; httpStatus?: number; message?: string; cause?: { code?: string }; details?: unknown };
    if (value?.type === ErrorType.CANCELLED_ERROR || isPermanentModelFailure(error) || isTransientRateLimit(error)) return false;
    const status = value?.httpStatus ?? Number(value?.message?.match(/http\s+(\d{3})\b/i)?.[1]);
    // 上游代理的等待超时可能只有 API 错误正文，没有本机 TIMEOUT_ERROR 类型。
    const details = value?.details as { message?: string; error?: { message?: string } | string } | string | undefined;
    const text = [value?.message ?? String(error), typeof details === 'string' ? details : details?.message,
        typeof details === 'object' ? typeof details?.error === 'string' ? details.error : details?.error?.message : undefined].join(' ');
    return value?.type === ErrorType.NETWORK_ERROR || value?.type === ErrorType.TIMEOUT_ERROR
        || [408, 502, 504].includes(status)
        || /\b(?:request|api\s+response)\s+(?:timed\s*out|timeout)\b|\btimeout\s+(?:while\s+)?waiting\s+for\s+(?:api\s+)?response\b/i.test(text)
        || /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(value?.code ?? value?.cause?.code ?? '');
}

/** 只提取控制重试所需的状态；原始错误体仍留在渠道错误的 details 中。 */
export function retryAfterMilliseconds(value: string | undefined, now = Date.now()): number | undefined {
    if (!value?.trim()) return undefined;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export function isPermanentModelFailure(error: unknown): boolean {
    const value = error as { message?: string; httpStatus?: number; details?: unknown };
    const detail = value?.details as { error?: { code?: string; type?: string }; code?: string; type?: string } | undefined;
    const text = [value?.message ?? String(error), detail?.error?.code, detail?.error?.type, detail?.code, detail?.type].join(' ').toLowerCase();
    const status = value?.httpStatus ?? Number(text.match(/http\s+(\d{3})\b/)?.[1]);
    return status >= 400 && status < 500 && ![408, 429].includes(status)
        || /insufficient[_ ]quota|billing_hard_limit|quota[_ ]exhausted|invalid_api_key|authentication_error|invalid_request_error/.test(text);
}

export function isTransientRateLimit(error: unknown): boolean {
    const value = error as { message?: string; httpStatus?: number };
    const details = (error as { details?: { error?: { code?: string }; code?: string } })?.details;
    return !isPermanentModelFailure(error) && (value?.httpStatus === 429 || /\b429\b|rate[_ ]limit|too many requests/i.test([value?.message ?? String(error), details?.error?.code, details?.code].join(' ')));
}

export function modelRetryInterval(error: unknown, attempt: number, interval: number): number {
    if (isNetworkModelFailure(error)) return NETWORK_RETRY_DELAYS_MS[Math.min(attempt, NETWORK_RETRY_DELAYS_MS.length - 1)];
    const supplied = (error as { retryAfterMs?: number })?.retryAfterMs;
    if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0) return supplied;
    return isTransientRateLimit(error) ? interval * Math.pow(2, Math.min(attempt, 10)) * (0.8 + Math.random() * 0.4) : interval;
}
