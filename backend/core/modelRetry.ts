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
    const supplied = (error as { retryAfterMs?: number })?.retryAfterMs;
    if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0) return supplied;
    return isTransientRateLimit(error) ? interval * Math.pow(2, Math.min(attempt, 10)) * (0.8 + Math.random() * 0.4) : interval;
}
