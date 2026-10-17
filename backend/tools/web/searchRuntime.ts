/**
 * GrayCode - DeepSeek Search API 运行时
 *
 * 搜索接口是独立的 HTTP 端点，不使用模型渠道的工具调用能力。
 * 参数与响应字段见 https://api-docs.deepseek.com/guides/search。
 */

import { createProxyFetch } from '../../modules/channel/proxyFetch';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 20_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5_000;
/** 这些状态表示暂时不可用，等待后可以重试；其余 4xx 修改请求前重试没有意义。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface WebSearchRuntimeConfig {
    endpoint: string;
    apiKey: string;
    count: number;
    needContent: boolean;
    proxyUrl?: string;
}

export interface WebSearchArgs {
    query?: unknown;
    count?: unknown;
    needContent?: unknown;
    oriQuestion?: unknown;
}

export interface WebSearchItem {
    title: string;
    url: string;
    snippet: string;
    summary: string;
    content?: string;
    siteName?: string;
    date?: string;
    authority?: number;
    rerankScore?: number;
}

type FetchImplementation = (url: string, init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<Response>;

interface UpstreamItem {
    title?: unknown;
    url?: unknown;
    snippet?: unknown;
    summary?: unknown;
    content?: unknown;
    site_name?: unknown;
    date?: unknown;
    authority?: unknown;
    rerank_score?: unknown;
}

export interface WebSearchSuccess {
    success: true;
    [key: string]: unknown;
    data: {
        query: string;
        resultCount: number;
        needContent: boolean;
        results: WebSearchItem[];
        /** 返回正文超过单条上限时为 true，正文已截断。 */
        contentTruncated?: boolean;
    };
}

export interface WebSearchFailure {
    success: false;
    [key: string]: unknown;
    code: 'WEB_SEARCH_NOT_CONFIGURED' | 'WEB_SEARCH_FAILED' | 'WEB_SEARCH_TIMEOUT';
    error: string;
    status?: number;
}

export type WebSearchOutcome = WebSearchSuccess | WebSearchFailure;

/** 单次搜索：优先使用调用参数，未提供时使用设置中的默认值。 */
export async function executeWebSearch(
    args: WebSearchArgs,
    config: WebSearchRuntimeConfig,
    signal: AbortSignal,
    fetchImpl: FetchImplementation = createProxyFetch(config.proxyUrl) as FetchImplementation
): Promise<WebSearchOutcome> {
    const endpoint = config.endpoint.trim();
    const apiKey = config.apiKey.trim();
    if (!endpoint || !apiKey) {
        return {
            success: false,
            code: 'WEB_SEARCH_NOT_CONFIGURED',
            error: '网页搜索尚未配置。请在设置 → 工具 → 网页搜索中填写 DeepSeek API Key。'
        };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { success: false, code: 'WEB_SEARCH_FAILED', error: '搜索词不能为空。' };

    const count = clampInteger(args.count ?? config.count, 1, 50, 10);
    const needContent = typeof args.needContent === 'boolean' ? args.needContent : config.needContent;
    const requestBody: Record<string, unknown> = { query, count, need_content: needContent };
    const oriQuestion = typeof args.oriQuestion === 'string' ? args.oriQuestion.trim() : '';
    if (oriQuestion) requestBody.ori_question = oriQuestion;

    const result = await requestSearch(fetchImpl, endpoint, apiKey, requestBody, signal);
    if (!result.ok) {
        if (result.timeout) {
            return { success: false, code: 'WEB_SEARCH_TIMEOUT', error: '搜索请求超时，请稍后重试。' };
        }
        return {
            success: false,
            code: 'WEB_SEARCH_FAILED',
            error: explainFailure(result.status, result.message),
            ...(result.status ? { status: result.status } : {})
        };
    }

    const raw = (result.payload as { results?: unknown } | null)?.results;
    const items = Array.isArray(raw) ? raw.map(item => projectItem(item as UpstreamItem, needContent)) : [];
    const results = items.map(item => item.value);
    return {
        success: true,
        data: {
            query,
            resultCount: results.length,
            needContent,
            results,
            ...(items.some(item => item.truncated) ? { contentTruncated: true } : {})
        }
    };
}

type RequestResult =
    | { ok: true; payload: unknown }
    | { ok: false; status?: number; message?: string; timeout?: boolean };

async function requestSearch(
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
            if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
                await delay(retryDelay(response), signal);
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

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function projectItem(item: UpstreamItem, needContent: boolean): { value: WebSearchItem; truncated: boolean } {
    const content = typeof item.content === 'string' ? item.content : '';
    const truncated = needContent && content.length > MAX_CONTENT_CHARS;
    return {
        value: {
            title: stringValue(item.title),
            url: stringValue(item.url),
            snippet: stringValue(item.snippet),
            summary: stringValue(item.summary),
            ...(needContent && content ? { content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content } : {}),
            ...(stringValue(item.site_name) ? { siteName: stringValue(item.site_name) } : {}),
            ...(stringValue(item.date) ? { date: stringValue(item.date) } : {}),
            ...(typeof item.authority === 'number' ? { authority: item.authority } : {}),
            ...(typeof item.rerank_score === 'number' ? { rerankScore: item.rerank_score } : {})
        },
        truncated
    };
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, number));
}

/** 优先采用上游给出的 Retry-After，避免账户级 QPS 限制下连续重试。 */
function retryDelay(response: Response): number {
    const header = response.headers.get('retry-after');
    if (header) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
        const date = Date.parse(header);
        if (Number.isFinite(date)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
    }
    return RETRY_DELAY_MS;
}

function upstreamMessage(text: string, status: number): string | undefined {
    const parsed = parseJson(text) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === 'string' && parsed.error.message) return parsed.error.message;
    const plain = text.trim().slice(0, 500);
    return plain || `HTTP ${status}`;
}

function explainFailure(status: number | undefined, message: string | undefined): string {
    const detail = message ? `：${message}` : '';
    switch (status) {
        case 400: return `搜索请求无效${detail}`;
        case 401: return `搜索服务的 API Key 无效${detail}`;
        case 402: return `搜索账户余额不足${detail}`;
        case 403: return `搜索请求被拒绝${detail}`;
        case 404: return `搜索接口不可用，请检查接口地址${detail}`;
        case 429: return `搜索请求超过频率限制，请稍后重试${detail}`;
        case 500:
        case 502:
        case 503:
        case 504: return `搜索服务暂时不可用${detail}`;
        default: return `搜索失败${detail}`;
    }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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
