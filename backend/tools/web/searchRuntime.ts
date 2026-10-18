/**
 * GrayCode - DeepSeek Search API 运行时
 *
 * 搜索接口是独立的 HTTP 端点，不使用模型渠道的工具调用能力。
 * 参数与响应字段见 https://api-docs.deepseek.com/guides/search。
 */

import { createProxyFetch } from '../../modules/channel/proxyFetch';
import { clampInteger, postJson, type FetchImplementation } from './request';

const MAX_CONTENT_CHARS = 20_000;

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

    const result = await postJson(fetchImpl, endpoint, apiKey, requestBody, signal);
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
