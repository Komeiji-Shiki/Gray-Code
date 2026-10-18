/**
 * DeepSeek Search / Fetch API 共用的 HTTP 请求层。
 *
 * 两个端点使用同一套 Bearer 认证、超时与重试规则；响应体都是原始 JSON。
 */

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
/** 等待超过这个时限就不再重试：整次工具调用会被一次限流拖住，直接返回上游状态更清楚。 */
const MAX_RETRY_DELAY_MS = 10_000;
/** 这些状态表示暂时不可用，等待后可以重试；其余 4xx 修改请求前重试没有意义。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type FetchImplementation = (url: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<Response>;

export type RequestResult =
    | { ok: true; payload: unknown }
    | { ok: false; status?: number; message?: string; timeout?: boolean };

/** POST 一个 JSON 请求；可重试状态与网络错误在短等待后重试一次。 */
export async function postJson(
    fetchImpl: FetchImplementation,
    endpoint: string,
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal
): Promise<RequestResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        try {
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
                signal: controller
            });
            const text = await response.text();
            if (response.ok) return { ok: true, payload: parseJson(text) };
            const wait = attempt === 0 && RETRYABLE_STATUS.has(response.status) ? retryDelay(response) : undefined;
            if (wait !== undefined) {
                await delay(wait, signal);
                continue;
            }
            return { ok: false, status: response.status, message: upstreamMessage(text, response.status) };
        } catch (error) {
            // 调用方取消时直接向上传递，不把用户停止运行当成网络故障。
            signal.throwIfAborted();
            if (attempt === 0) {
                await delay(RETRY_DELAY_MS, signal);
                continue;
            }
            return {
                ok: false,
                timeout: error instanceof Error && error.name === 'TimeoutError',
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
    return { ok: false };
}

export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, number));
}

/**
 * 优先采用上游给出的 Retry-After，避免账户级 QPS 限制下连续重试。
 * 上游要求的等待超过上限时返回 undefined：按 429 直接失败，比等完上限再被拒更省时间。
 */
function retryDelay(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (header) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000 <= MAX_RETRY_DELAY_MS ? seconds * 1000 : undefined;
        const date = Date.parse(header);
        if (Number.isFinite(date)) {
            const wait = Math.max(0, date - Date.now());
            return wait <= MAX_RETRY_DELAY_MS ? wait : undefined;
        }
    }
    return RETRY_DELAY_MS;
}

function upstreamMessage(text: string, status: number): string | undefined {
    const parsed = parseJson(text) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === 'string' && parsed.error.message) return parsed.error.message;
    const plain = text.trim().slice(0, 500);
    return plain || `HTTP ${status}`;
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
