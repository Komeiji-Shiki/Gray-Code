/**
 * 模型列表管理
 *
 * 提供获取各平台可用模型列表的功能
 * 所有平台均支持分页获取，确保能拿到完整的模型列表
 */

import { t } from '../../i18n';
import type { ChannelConfig, ModelInfo } from '../config';
import { createProxyFetch, extractUpstreamErrorMessage } from './proxyFetch';

// ModelInfo 类型下沉至 config 域（config/configs/base.ts，经 config 门面 re-export）。
// 此处保留 re-export 壳：channel/index.ts、api/models/* 等既有导入方零改动。
export type { ModelInfo };

// ==================== 模型列表进程内 TTL 缓存 ====================
// 模型列表每次请求都重新发起网络请求（含多页分页遍历）；同一渠道配置下的列表在
// 会话生命周期内几乎不变，短 TTL 缓存避免设置页/模型下拉频繁触发完整网络往返。
// 缓存键覆盖所有影响列表来源的输入（类型 / 地址 / 认证密钥 / 自定义标头 / 代理），
// 任一变化都会命中不同条目；错误不缓存（失败后下次调用重试网络）。
const MODEL_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_CACHE_CAPACITY = 64;

interface ModelListCacheEntry {
  models: ModelInfo[];
  expiresAt: number;
}

const modelListCache = new Map<string, ModelListCacheEntry>();

/** LRU 触碰 + 容量淘汰（与 ConversationManager.touchCache 同模式） */
function touchModelListCache(key: string): void {
  const value = modelListCache.get(key);
  if (value !== undefined) {
    modelListCache.delete(key);
    modelListCache.set(key, value);
  }
  if (modelListCache.size > MODEL_LIST_CACHE_CAPACITY) {
    const oldest = modelListCache.keys().next().value;
    if (oldest !== undefined) {
      modelListCache.delete(oldest);
    }
  }
}

/**
 * 读取「是否使用 Authorization Bearer 发送 API Key」这一可选公共字段。
 *
 * 该字段仅 Gemini / Anthropic 渠道声明（OpenAI / OpenAI-Responses 无此语义），
 * 在 ChannelConfig 联合类型上直接访问会报错；按 discriminant 收窄后读取。
 * 非 Gemini/Anthropic 渠道返回 undefined，与历史 `as any` 转型访问时的运行时行为完全一致。
 */
function getUseAuthorizationHeader(config: ChannelConfig): boolean | undefined {
  return config.type === 'gemini' || config.type === 'gemini-interactions' || config.type === 'anthropic'
    ? config.useAuthorizationHeader
    : undefined;
}

function buildModelListCacheKey(type: string, url: string, config: ChannelConfig, proxyUrl?: string): string {
  const customHeaders = config.customHeadersEnabled ? JSON.stringify(config.customHeaders ?? {}) : '';
  const useAuthorizationHeader = getUseAuthorizationHeader(config);
  return `${type}|${url}|${String(config.apiKey ?? '')}|${String(useAuthorizationHeader ?? '')}|${customHeaders}|${proxyUrl ?? ''}`;
}

/** 命中返回克隆（调用方可能修改返回值，克隆避免污染缓存条目） */
function getModelListCached(key: string): ModelInfo[] | null {
  const entry = modelListCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    modelListCache.delete(key);
    return null;
  }
  touchModelListCache(key);
  // ModelInfo 是扁平纯数据对象，浅拷贝一层即可隔离调用方对返回值的修改；
  // 避免 JSON 序列化（丢失 undefined 字段 + 大列表全量序列化开销）。
  return entry.models.map(model => ({ ...model }));
}

function cacheModelList(key: string, models: ModelInfo[]): void {
  // 空结果不缓存：上游临时故障/权限异常可能返回空列表，缓存 5 分钟会让用户一直
  // 看不到模型；空结果不写缓存，下次调用立即重试网络。
  if (models.length === 0) {
    return;
  }
  // 存副本：miss 路径会把调用方传入的列表按引用缓存，若首个调用方随后就地修改
  // （排序/过滤/元素改写）会污染缓存条目——命中路径返回的是浅拷贝，语义不一致。
  modelListCache.set(key, { models: models.map(model => ({ ...model })), expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS });
  touchModelListCache(key);
}

/**
 * 模型列表请求错误（上游已返回明确失败原因）。
 *
 * message 为已脱敏（apiKey 明文 / URL query 中的 key 已替换为 ***）且截断的安全文案，
 * ModelsHandler 仅对 instanceof ModelListRequestError 的错误透出 message 给 UI，
 * 让用户直接看到真实失败原因（如 Google 403 key 被标记泄露）；
 * 其余未知错误（网络异常、解析失败等）仍返回通用文案。
 */
export class ModelListRequestError extends Error {
    constructor(
        message: string,
        /** 上游 HTTP 状态码（无响应时为 undefined） */
        public readonly status?: number
    ) {
        super(message);
        this.name = 'ModelListRequestError';
    }
}

/** 透传给 UI 的上游错误消息最大长度（防止超长响应体撑爆错误面板/日志） */
const MODEL_LIST_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * 脱敏上游错误消息：
 * 1. 用 *** 替换 apiKey 明文（覆盖 query key / Bearer / x-api-key / x-goog-api-key 被上游回显的场景）
 * 2. 替换 URL query 中常见凭据参数的值，并覆盖 apiKey 的 URL 编码形式
 * 3. 截断到 MODEL_LIST_ERROR_MESSAGE_MAX_LENGTH
 */
export function sanitizeUpstreamMessage(rawMessage: string, apiKey?: string): string {
    let message = rawMessage;
    if (apiKey) {
        for (const secret of new Set([apiKey, encodeURIComponent(apiKey)])) {
            if (secret) message = message.split(secret).join('***');
        }
    }
    // 中转站可能回显完整 URL；常见凭据参数统一遮盖，不依赖其值恰好与 config.apiKey 同编码。
    message = message.replace(
        /([?&](?:key|api[_-]?key|x-goog-api-key|access[_-]?token|token|secret|password|signature|credential)=)[^&\s"'<>]+/gi,
        '$1***'
    );
    if (message.length > MODEL_LIST_ERROR_MESSAGE_MAX_LENGTH) {
        message = `${message.slice(0, MODEL_LIST_ERROR_MESSAGE_MAX_LENGTH)}…`;
    }
    return message;
}

/**
 * 读取非 2xx 响应体并抛出 ModelListRequestError。
 *
 * 必须先读 text() 再尝试 JSON.parse（response.json() 会消费响应体，纯文本/HTML 错误体
 * 在 json() 失败后再读 text() 只能拿到空串）；利用 extractUpstreamErrorMessage 提取
 * 上游给出的真实失败原因（如 Google 403 的 key 泄露提示），替代旧实现只透出 statusText。
 */
async function throwModelListRequestError(response: Response, apiKey?: string): Promise<never> {
    let rawErrorBody = '';
    try {
        rawErrorBody = await response.text();
    } catch {
        // 读取失败（连接中断等）：退回 statusText 兜底
        rawErrorBody = '';
    }

    let errorBody: unknown = rawErrorBody;
    if (rawErrorBody) {
        try {
            errorBody = JSON.parse(rawErrorBody);
        } catch {
            // 非 JSON：extractUpstreamErrorMessage 直接返回文本
        }
    }

    const upstreamMessage = extractUpstreamErrorMessage(errorBody);
    const message = upstreamMessage
        ? `HTTP ${response.status}: ${upstreamMessage}`
        : t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText });
    throw new ModelListRequestError(sanitizeUpstreamMessage(message, apiKey), response.status);
}

/**
 * 从渠道配置中提取已启用的自定义标头，合并到已有的 headers 对象中
 */
function applyCustomHeaders(headers: Record<string, string>, config: ChannelConfig): void {
  if (config.customHeadersEnabled && config.customHeaders) {
    for (const header of config.customHeaders) {
      // 只添加启用的、有键名的标头
      if (header.enabled && header.key && header.key.trim()) {
        headers[header.key.trim()] = header.value || '';
      }
    }
  }
}

/**
 * 规范化 Anthropic 模型列表基础 URL
 *
 * 兼容以下输入：
 * - https://api.anthropic.com
 * - https://api.anthropic.com/v1
 * - https://api.anthropic.com/v1/messages
 * - https://api.anthropic.com/v1/models
 */
function normalizeAnthropicModelsBaseUrl(rawUrl?: string): string {
  let normalizedUrl = (rawUrl || 'https://api.anthropic.com/v1').trim().replace(/\/+$/, '');

  normalizedUrl = normalizedUrl
    .replace(/\/v1\/models$/i, '/v1')
    .replace(/\/v1\/messages(?:\/count_tokens)?$/i, '/v1')
    .replace(/\/v1\/complete$/i, '/v1')
    .replace(/\/messages(?:\/count_tokens)?$/i, '')
    .replace(/\/complete$/i, '');

  if (/\/v1$/i.test(normalizedUrl)) {
    return normalizedUrl;
  }

  return `${normalizedUrl}/v1`;
}

/**
 * 通用分页遍历：逐页拉取直到无更多数据 / 游标重复 / 到达页数上限。
 *
 * Gemini / OpenAI / Anthropic 三个平台的 /models 分页逻辑本质相同
 * （拉页 → 取游标 → 防重复/防无限循环），抽成公共函数避免三份近似重复的实现。
 *
 * @param fetchPage 拉取一页：入参为当前游标（首轮 undefined）与页号（1-based）
 * @param resolveNextCursor 从本页结果与原始响应中解析下一页游标；返回 undefined 表示没有更多页
 */
async function fetchAllPages<T>(
    fetchPage: (cursor: string | undefined, pageNumber: number) => Promise<{ models: T[]; data: any }>,
    resolveNextCursor: (pageModels: T[], rawData: any) => string | undefined,
    options: { maxPages?: number; name: string } = { name: '' }
): Promise<T[]> {
    const { maxPages = 500, name } = options;
    const all: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    let hasMore = true;

    do {
        pageCount += 1;
        const { models, data } = await fetchPage(cursor, pageCount);
        all.push(...models);

        if (models.length === 0) {
            hasMore = false;
            break;
        }

        const nextCursor = resolveNextCursor(models, data);
        if (!nextCursor) {
            hasMore = false;
        } else if (nextCursor === cursor || seenCursors.has(nextCursor)) {
            console.warn(`[modelList] ${name} models pagination stopped: repeated cursor`, nextCursor);
            hasMore = false;
        } else if (pageCount >= maxPages) {
            console.warn(`[modelList] ${name} models pagination stopped: reached max pages`, maxPages);
            hasMore = false;
        } else {
            seenCursors.add(nextCursor);
            cursor = nextCursor;
            hasMore = true;
        }
    } while (hasMore);

    return all;
}

/**
 * 规范化 Gemini 模型列表基础 URL。
 *
 * - trim 首尾空白（WHATWG URL 构造器自动去除）
 * - 去除路径尾斜杠（避免拼接出 //models）
 * - 基础 URL 自带的 query 参数（如中转站要求的 ?key=xxx / ?api-version=...）单独取出，
 *   请求时合并进 /models 查询串——旧实现 `${url}/models?...` 会把 query 整体拼进路径段
 *   （如 https://host/v1beta?foo=bar/models?...），导致请求 404
 */
export function normalizeGeminiModelsBaseUrl(rawUrl?: string): { baseUrl: string; baseQuery: URLSearchParams } {
  const fallback = 'https://generativelanguage.googleapis.com/v1beta';
  const raw = (rawUrl || fallback).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 不能把无效的第三方地址静默替换成官方端点，否则会把凭据发往用户未填写的目标。
    throw new ModelListRequestError(t('modules.config.validation.invalidUrl'));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelListRequestError(t('modules.config.validation.invalidUrl'));
  }
  const baseQuery = new URLSearchParams(parsed.search);
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return { baseUrl: `${parsed.origin}${pathname}`, baseQuery };
}

/**
 * 获取 Gemini 模型列表
 * Gemini API 支持 pageSize 和 pageToken 分页参数
 */
export async function getGeminiModels(config: ChannelConfig, proxyUrl?: string): Promise<ModelInfo[]> {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new ModelListRequestError(t('modules.channel.modelList.errors.apiKeyRequired'));
  }

  const { baseUrl, baseQuery } = normalizeGeminiModelsBaseUrl(config.url);
  const useAuthorizationHeader = getUseAuthorizationHeader(config);

  // 缓存键使用真实 config.type（gemini / gemini-interactions 分开缓存）与规范化 URL
  // （trim + 去尾斜杠，含基础 query，避免同义写法产生重复条目）
  const normalizedUrl = baseQuery.toString() ? `${baseUrl}?${baseQuery.toString()}` : baseUrl;
  const cacheKey = buildModelListCacheKey(config.type, normalizedUrl, config, proxyUrl);
  const cached = getModelListCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const proxyFetch = createProxyFetch(proxyUrl);

    // 循环获取所有分页数据
    const allModels = await fetchAllPages<any>(
      async (pageToken, _pageCount) => {
        // 基础 URL 自带的 query 合并进每次请求；分页/认证参数覆盖同名基础参数
        const params = new URLSearchParams(baseQuery);
        params.set('pageSize', '1000');
        // 未启用 useAuthorizationHeader 时，将 apiKey 放入 query parameter
        if (!useAuthorizationHeader) {
          params.set('key', apiKey);
        }
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const headers: Record<string, string> = {};
        // 启用 useAuthorizationHeader 时，使用 Authorization Bearer 格式
        if (useAuthorizationHeader) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else {
          // 兼容行为保持：默认同时发送 key query 与 x-goog-api-key 头
          headers['x-goog-api-key'] = apiKey;
        }
        // 应用自定义标头
        applyCustomHeaders(headers, config);

        const response = await proxyFetch(`${baseUrl}/models?${params.toString()}`, { headers });

        if (!response.ok) {
          await throwModelListRequestError(response, apiKey);
        }

        const data = await response.json() as any;
        return { models: data.models || [], data };
      },
      (_models, data) => data.nextPageToken as string | undefined,
      { name: 'Gemini' }
    );

    // 过滤出支持 generateContent 的模型（兼容第三方中转站未返回 supportedGenerationMethods 的情况）
    const models = allModels
      .filter((m: any) => 
        !m.supportedGenerationMethods || (Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      )
      .map((m: any) => {
        // 健壮映射：id 仅去除开头的 models/ 前缀（名称中部的 models/ 原样保留）；
        // displayName 缺失时回退 id；id 为空（name/id 均缺失）的条目剔除
        const rawId = typeof m.name === 'string' && m.name.trim() ? m.name : (typeof m.id === 'string' ? m.id : '');
        const id = rawId.replace(/^models\//, '');
        const displayName = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName : undefined;
        return {
          id,
          name: displayName || id,
          description: typeof m.description === 'string' ? m.description : undefined,
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit
        };
      })
      .filter((m: any) => m.id);
    cacheModelList(cacheKey, models);
    return models;
  } catch (error) {
    console.error('Failed to get Gemini models:', error);
    throw error;
  }
}

/**
 * 获取 OpenAI 兼容模型列表
 * 很多第三方中转站会对 /models 接口做分页限制（默认可能只返回 500 条）
 * 通过传递较大的 limit 参数并支持分页遍历来获取所有模型
 */
export async function getOpenAIModels(config: ChannelConfig, proxyUrl?: string): Promise<ModelInfo[]> {
  const apiKey = config.apiKey;
  let url = config.url || 'https://api.openai.com/v1';

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 如果是 openai-responses 且 URL 包含 /responses，移除它以获取模型列表
  if (config.type === 'openai-responses' && url.endsWith('/responses')) {
    url = url.slice(0, -10);
  }

  if (!apiKey) {
    throw new ModelListRequestError(t('modules.channel.modelList.errors.apiKeyRequired'));
  }

  const cacheKey = buildModelListCacheKey(config.type, url, config, proxyUrl);
  const cached = getModelListCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const proxyFetch = createProxyFetch(proxyUrl);

    // 循环获取所有分页数据
    // OpenAI 官方 API 不分页，但第三方中转站可能支持 limit/after 分页
    const allModels = await fetchAllPages<any>(
      async (afterCursor, _pageCount) => {
        const params = new URLSearchParams({ limit: '10000' });
        if (afterCursor) {
          params.set('after', afterCursor);
        }

        const headers: Record<string, string> = {
          'Authorization': `Bearer ${apiKey}`
        };
        // 应用自定义标头
        applyCustomHeaders(headers, config);

        const response = await proxyFetch(`${url}/models?${params.toString()}`, {
          headers
        });

        if (!response.ok) {
          await throwModelListRequestError(response, apiKey);
        }

        const data = await response.json() as any;
        return { models: data.data || [], data };
      },
      // has_more 为 true 时以本页最后一条 id 作为下一页游标
      (models, data) => (data.has_more ? (models[models.length - 1]?.id as string | undefined) : undefined),
      { name: 'OpenAI' }
    );

    const uniqueModels = Array.from(
      new Map(
        allModels
          .filter((m: any) => m?.id)
          .map((m: any) => [m.id, m])
      ).values()
    );

    const models = uniqueModels.map((m: any) => ({
      id: m.id,
      name: m.id,
      description: m.created ? `Created: ${new Date(m.created * 1000).toLocaleDateString()}` : undefined
    }));
    cacheModelList(cacheKey, models);
    return models;
  } catch (error) {
    console.error('Failed to get OpenAI models:', error);
    throw error;
  }
}

/**
 * 获取 Claude 模型列表（通过 Anthropic Models API）
 * Anthropic Models API 默认 limit=20，最大 limit=1000，支持分页游标
 */
export async function getClaudeModels(config: ChannelConfig, proxyUrl?: string): Promise<ModelInfo[]> {
  const apiKey = config.apiKey;
  const baseUrl = normalizeAnthropicModelsBaseUrl(config.url);
  const useAuthorizationHeader = getUseAuthorizationHeader(config);

  if (!apiKey) {
    throw new ModelListRequestError(t('modules.channel.modelList.errors.apiKeyRequired'));
  }

  const cacheKey = buildModelListCacheKey(config.type, baseUrl, config, proxyUrl);
  const cached = getModelListCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const proxyFetch = createProxyFetch(proxyUrl);

    // 循环获取所有分页数据
    const allModels = await fetchAllPages<any>(
      async (afterId, _pageCount) => {
        const params = new URLSearchParams({ limit: '1000' });
        if (afterId) {
          params.set('after_id', afterId);
        }

        const headers: Record<string, string> = {
          'anthropic-version': '2023-06-01'
        };
        // 根据 useAuthorizationHeader 选项决定认证方式
        if (useAuthorizationHeader) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else {
          headers['x-api-key'] = apiKey;
        }
        // 应用自定义标头
        applyCustomHeaders(headers, config);

        const response = await proxyFetch(`${baseUrl}/models?${params.toString()}`, {
          headers
        });

        if (!response.ok) {
          await throwModelListRequestError(response, apiKey);
        }

        const data = await response.json() as any;
        return { models: data.data || [], data };
      },
      // has_more 为 true 时优先用 last_id，缺失时退回本页最后一条 id
      (models, data) => (data.has_more
        ? ((data.last_id as string | undefined) || (models[models.length - 1]?.id as string | undefined))
        : undefined),
      { name: 'Anthropic' }
    );

    const uniqueModels = Array.from(
      new Map(
        allModels
          .filter((m: any) => m?.id)
          .map((m: any) => [m.id, m])
      ).values()
    );

    const models = uniqueModels.map((m: any) => ({
      id: m.id,
      name: m.display_name || m.id,
      description: m.display_name ? m.id : undefined,
      contextWindow: m.input_token_limit,
      maxOutputTokens: m.output_token_limit
    }));
    cacheModelList(cacheKey, models);
    return models;
  } catch (error) {
    console.error('Failed to get Claude models:', error);
    throw error;
  }
}

/**
 * 根据配置类型获取模型列表
 */
export async function getModels(config: ChannelConfig, proxyUrl?: string): Promise<ModelInfo[]> {
  const configType = config.type;
  switch (config.type) {
    case 'gemini':
    case 'gemini-interactions':
      return getGeminiModels(config, proxyUrl);
    
    case 'openai':
      return getOpenAIModels(config, proxyUrl);
    
    case 'openai-responses':
      return getOpenAIModels(config, proxyUrl);
    
    case 'anthropic':
      return getClaudeModels(config, proxyUrl);
    
    default:
      throw new Error(t('modules.channel.modelList.errors.unsupportedConfigType', { type: configType }));
  }
}
