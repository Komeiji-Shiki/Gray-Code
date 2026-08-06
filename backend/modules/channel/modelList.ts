/**
 * 模型列表管理
 *
 * 提供获取各平台可用模型列表的功能
 * 所有平台均支持分页获取，确保能拿到完整的模型列表
 */

import { t } from '../../i18n';
import type { ChannelConfig } from '../config/types';
import type { CustomHeader } from '../config/configs/base';
import { createProxyFetch } from './proxyFetch';

/**
 * 模型信息
 */
export interface ModelInfo {
  /** 模型 ID */
  id: string;
  
  /** 模型名称 */
  name?: string;
  
  /** 模型描述 */
  description?: string;
  
  /** 上下文窗口大小 */
  contextWindow?: number;
  
  /** 最大输出token */
  maxOutputTokens?: number;
}

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
  const customHeaders = cfg.customHeadersEnabled ? JSON.stringify(cfg.customHeaders ?? {}) : '';
  return `${type}|${url}|${String(cfg.apiKey ?? '')}|${String(cfg.useAuthorizationHeader ?? '')}|${customHeaders}|${proxyUrl ?? ''}`;
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
  return JSON.parse(JSON.stringify(entry.models));
}

function cacheModelList(key: string, models: ModelInfo[]): void {
  modelListCache.set(key, { models, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS });
  touchModelListCache(key);
}

/**
 * 从渠道配置中提取已启用的自定义标头，合并到已有的 headers 对象中
 */
function applyCustomHeaders(headers: Record<string, string>, config: ChannelConfig): void {
  const cfg = config as any;
  if (cfg.customHeadersEnabled && cfg.customHeaders) {
    for (const header of cfg.customHeaders as CustomHeader[]) {
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
    const allModels: any[] = [];
    let pageToken: string | undefined;

    // 循环获取所有分页数据
    do {
      const params = new URLSearchParams({ pageSize: '1000' });
      // 未启用 useAuthorizationHeader 时，将 apiKey 放入 query parameter
      if (!(config as any).useAuthorizationHeader) {
        params.set('key', apiKey);
      }
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const headers: Record<string, string> = {};
      // 启用 useAuthorizationHeader 时，使用 Authorization Bearer 格式
      if ((config as any).useAuthorizationHeader) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
      // 应用自定义标头
      applyCustomHeaders(headers, config);

      const response = await proxyFetch(`${url}/models?${params.toString()}`, { headers });

      if (!response.ok) {
        throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
      }

      const data = await response.json() as any;
      const models = data.models || [];
      allModels.push(...models);

      pageToken = data.nextPageToken;
    } while (pageToken);

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
    const allModels: any[] = [];
    let hasMore = true;
    let afterCursor: string | undefined;
    const seenCursors = new Set<string>();
    const MAX_PAGES = 500;
    let pageCount = 0;

    // 循环获取所有分页数据
    // OpenAI 官方 API 不分页，但第三方中转站可能支持 limit/after 分页
    do {
      const params = new URLSearchParams({ limit: '10000' });
      if (afterCursor) {
        params.set('after', afterCursor);
      }

      pageCount += 1;

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`
      };
      // 应用自定义标头
      applyCustomHeaders(headers, config);

      const response = await proxyFetch(`${url}/models?${params.toString()}`, {
        headers
      });

      if (!response.ok) {
        throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
      }

      const data = await response.json() as any;
      const models = data.data || [];
      allModels.push(...models);

      if (models.length === 0) {
        break;
      }

      // 检查是否还有更多数据（OpenAI list API 支持 has_more 字段）
      if (data.has_more) {
        const nextCursor = models[models.length - 1]?.id;
        if (!nextCursor) {
          hasMore = false;
        } else if (nextCursor === afterCursor || seenCursors.has(nextCursor)) {
          console.warn('[modelList] OpenAI models pagination stopped: repeated cursor', nextCursor);
          hasMore = false;
        } else if (pageCount >= MAX_PAGES) {
          console.warn('[modelList] OpenAI models pagination stopped: reached max pages', MAX_PAGES);
          hasMore = false;
        } else {
          seenCursors.add(nextCursor);
          afterCursor = nextCursor;
          hasMore = true;
        }
      } else {
        hasMore = false;
      }
    } while (hasMore);

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
    const allModels: any[] = [];
    let afterId: string | undefined;
    const seenAfterIds = new Set<string>();
    const MAX_PAGES = 500;
    let pageCount = 0;

    // 循环获取所有分页数据
    do {
      const params = new URLSearchParams({ limit: '1000' });
      if (afterId) {
        params.set('after_id', afterId);
      }

      pageCount += 1;

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
      applyCustomHeaders(headers, config);

      const response = await proxyFetch(`${baseUrl}/models?${params.toString()}`, {
        headers
      });

      if (!response.ok) {
        throw new Error(t('modules.channel.modelList.errors.fetchModelsFailed', { error: response.statusText }));
      }

      const data = await response.json() as any;
      const models = data.data || [];
      allModels.push(...models);

      if (models.length === 0) {
        break;
      }

      // Anthropic API 返回 has_more 和 last_id 用于分页
      if (data.has_more) {
        const nextAfterId = data.last_id || models[models.length - 1]?.id;
        if (!nextAfterId) {
          afterId = undefined;
        } else if (nextAfterId === afterId || seenAfterIds.has(nextAfterId)) {
          console.warn('[modelList] Anthropic models pagination stopped: repeated after_id', nextAfterId);
          afterId = undefined;
        } else if (pageCount >= MAX_PAGES) {
          console.warn('[modelList] Anthropic models pagination stopped: reached max pages', MAX_PAGES);
          afterId = undefined;
        } else {
          seenAfterIds.add(nextAfterId);
          afterId = nextAfterId;
        }
      } else {
        afterId = undefined;
      }
    } while (afterId);

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
