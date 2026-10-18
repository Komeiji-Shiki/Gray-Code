/**
 * GrayCode - DeepSeek Fetch API 运行时
 *
 * 抓取单个网页并返回 Markdown 正文；与 Search 共用凭据和请求规则。
 * 参数与响应字段见 https://api-docs.deepseek.com/guides/search。
 */

import { createProxyFetch } from '../../modules/channel/proxyFetch';
import { clampInteger, postJson, type FetchImplementation } from './request';

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 60_000;

export interface WebFetchRuntimeConfig {
    endpoint: string;
    apiKey: string;
    proxyUrl?: string;
}

export interface WebFetchArgs {
    url?: unknown;
    maxChars?: unknown;
}

export interface WebFetchSuccess {
    success: true;
    [key: string]: unknown;
    data: {
        url: string;
        title: string;
        content: string;
        /** 截断前正文的字符数。 */
        contentLength: number;
        truncated: boolean;
    };
}

export interface WebFetchFailure {
    success: false;
    [key: string]: unknown;
    code: 'WEB_FETCH_NOT_CONFIGURED' | 'WEB_FETCH_FAILED' | 'WEB_FETCH_TIMEOUT';
    error: string;
    status?: number;
}

export type WebFetchOutcome = WebFetchSuccess | WebFetchFailure;

/** 抓取单个页面；正文超过 maxChars 时截断并标记。 */
export async function executeWebFetch(
    args: WebFetchArgs,
    config: WebFetchRuntimeConfig,
    signal: AbortSignal,
    fetchImpl: FetchImplementation = createProxyFetch(config.proxyUrl) as FetchImplementation
): Promise<WebFetchOutcome> {
    const endpoint = config.endpoint.trim();
    const apiKey = config.apiKey.trim();
    if (!endpoint || !apiKey) {
        return {
            success: false,
            code: 'WEB_FETCH_NOT_CONFIGURED',
            error: '网页抓取尚未配置。请在设置 → 工具 → 网页搜索中填写 DeepSeek API Key。'
        };
    }
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const invalid = validateUrl(url);
    if (invalid) return { success: false, code: 'WEB_FETCH_FAILED', error: invalid };

    const maxChars = clampInteger(args.maxChars, MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
    const result = await postJson(fetchImpl, endpoint, apiKey, { url }, signal);
    if (!result.ok) {
        if (result.timeout) {
            return { success: false, code: 'WEB_FETCH_TIMEOUT', error: '抓取请求超时，请稍后重试。' };
        }
        return {
            success: false,
            code: 'WEB_FETCH_FAILED',
            error: explainFailure(result.status, result.message),
            ...(result.status ? { status: result.status } : {})
        };
    }

    const payload = result.payload as { title?: unknown; content?: unknown } | null;
    const title = typeof payload?.title === 'string' ? payload.title : '';
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!content) return { success: false, code: 'WEB_FETCH_FAILED', error: '页面没有可提取的正文。' };

    const truncated = content.length > maxChars;
    return {
        success: true,
        data: {
            url,
            title,
            content: truncated ? content.slice(0, maxChars) : content,
            contentLength: content.length,
            truncated
        }
    };
}

function validateUrl(value: string): string | undefined {
    if (!value) return '网页地址不能为空。';
    if (value.length > 8192) return '网页地址不能超过 8192 个字符。';
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return '网页地址必须是有效的 HTTP 或 HTTPS URL。';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '只支持 HTTP 或 HTTPS 地址。';
    if (!parsed.hostname) return '网页地址必须包含主机名。';
    if (parsed.username || parsed.password) return '网页地址不能包含用户名或密码。';
    return undefined;
}

function explainFailure(status: number | undefined, message: string | undefined): string {
    const detail = message ? `：${message}` : '';
    switch (status) {
        case 400: return `抓取请求无效${detail}`;
        case 401: return `搜索服务的 API Key 无效${detail}`;
        case 402: return `搜索账户余额不足${detail}`;
        case 403: return `页面被安全策略拒绝${detail}`;
        case 404: return `无法取得页面内容，可能不可用、被站点阻止或内容类型不支持${detail}`;
        case 429: return `抓取请求超过频率限制，请稍后重试${detail}`;
        case 500:
        case 502:
        case 503:
        case 504: return `抓取服务暂时不可用${detail}`;
        default: return `抓取失败${detail}`;
    }
}
