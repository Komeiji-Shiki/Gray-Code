/**
 * 模型列表管理
 *
 * 提供获取各平台可用模型列表的功能
 * 所有平台均支持分页获取，确保能拿到完整的模型列表
 */

import { t } from '../../i18n';
import { createHash } from 'crypto';
import type { ChannelConfig } from '../config/types';
import { applyCustomHeaders } from '../config/configs/base';
import type { ModelInfo } from '../config';
import { createProxyFetch } from './proxyFetch';

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

function buildModelListCacheKey(type: string, url: string, config: ChannelConfig, proxyUrl?: string): string {
  const cfg = config as any;
  const customHeaders = cfg.customHeadersEnabled ? JSON.stringify(cfg.customHeaders ?? '') : '';
  // apiKey（含 customHeaders 值）原样拼进缓存键会让明文密钥长期驻留进程内存；
  // 改用短摘要作缓存键，碰撞概率可忽略（冲突只会导致多一次网络请求，无正确性影响）。
  const secretPart = createHash('sha256')
    .update(`${String(cfg.apiKey ?? '')}|${String(cfg.useAuthorizationHeader ?? '')}|${customHeaders}`)
    .digest('hex')
    .slice(0, 32);
  return `${type}|${url}|${secretPart}|${proxyUrl ?? ''}`;
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
 * 从渠道配置中提取已启用的自定义标头，合并到已有的 headers 对象中。
 * （含键名校验与保留标头过滤，来自 base.ts 的 applyCustomHeaders）
 */
function applyCustomHeadersFromConfig(headers: Record<string, string>, config: ChannelConfig): void {
  const cfg = config as any;
  applyCustomHeaders(headers, cfg.customHeaders, cfg.customHeadersEnabled);
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
 * 获取 Gemini 模型列表
 * Gemini API 支持 pageSize 和 pageToken 分页参数
 */
export async function getGeminiModels(config: ChannelConfig, proxyUrl?: string): Promise<ModelInfo[]> {
  const apiKey = (config as any).apiKey;
  const url = (config as any).url || 'https://generativelanguage.googleapis.com/v1beta';

  if (!apiKey) {
    throw new Error(t('modules.channel.modelList.errors.apiKeyRequired'));
  }

  const cacheKey = buildModelListCacheKey('gemini', url, config, proxyUrl);
  const cached = getModelListCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const proxyFetch = createProxyFetch(proxyUrl);

    // 循环获取所有分页数据
    const allModels = await fetchAllPages<any>(
      async (pageToken, _pageCount) => {
        const params = new URLSearchParams({ pageSize: '1000' });
        if (pageToken) {
          params.set('pageToken', pageToken);
        }

        const headers: Record<string, string> = {};
        // 使用 useAuthorizationHeader 时，使用 Authorization Bearer 方式
        if ((config as any).useAuthorizationHeader) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else {
          // 始终通过 header 传递密钥（x-goog-api-key），不允许 apiKey 在 URL query 中出现，
          // 避免在代理/网关/服务端日志中泄露
          headers['x-goog-api-key'] = apiKey;
        }
        // 应用自定义请求头
        applyCustomHeadersFromConfig(headers, config);

        const response = await proxyFetch(`${url}/models?${params.toString()}`, { headers });

        if (!response.ok) {
          throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
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
      .map((m: any) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName,
        description: m.description,
        contextWindow: m.inputTokenLimit,
        maxOutputTokens: m.outputTokenLimit
      }));
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
  const apiKey = (config as any).apiKey;
  let url = (config as any).url || 'https://api.openai.com/v1';

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  // 如果是 openai-responses 且 URL 包含 /responses，移除它以获取模型列表
  if (config.type === 'openai-responses' && url.endsWith('/responses')) {
    url = url.slice(0, -10);
  }

  if (!apiKey) {
    throw new Error(t('modules.channel.modelList.errors.apiKeyRequired'));
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
        applyCustomHeadersFromConfig(headers, config);

        const response = await proxyFetch(`${url}/models?${params.toString()}`, {
          headers
        });

        if (!response.ok) {
          throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
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
  const apiKey = (config as any).apiKey;
  const baseUrl = normalizeAnthropicModelsBaseUrl((config as any).url);

  if (!apiKey) {
    throw new Error(t('modules.channel.modelList.errors.apiKeyRequired'));
  }

  const cacheKey = buildModelListCacheKey('anthropic', baseUrl, config, proxyUrl);
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
        if ((config as any).useAuthorizationHeader) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        } else {
          headers['x-api-key'] = apiKey;
        }
        // 应用自定义标头
        applyCustomHeadersFromConfig(headers, config);

        const response = await proxyFetch(`${baseUrl}/models?${params.toString()}`, {
          headers
        });

        if (!response.ok) {
          throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
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
  switch (config.type) {
    case 'gemini':
      return getGeminiModels(config, proxyUrl);
    
    case 'openai':
      return getOpenAIModels(config, proxyUrl);
    
    case 'openai-responses':
      return getOpenAIModels(config, proxyUrl);
    
    case 'anthropic':
      return getClaudeModels(config, proxyUrl);
    
    default:
      throw new Error(t('modules.channel.modelList.errors.unsupportedConfigType', { type: (config as any).type }));
  }
}
