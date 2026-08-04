/**
 * 用量统计消息处理器
 *
 * 提供按对话/按模型/按天聚合的 token 用量数据，
 * 数据完全来自已落盘的对话历史（usageMetadata），无需额外打点。
 *
 * 聚合需要全量扫描历史文件，对话多时开销明显；这里做进程内短 TTL 结果缓存，
 * 短时间内重复打开统计页直接命中缓存，手动刷新（force: true）绕过缓存强制重算。
 *
 * ConversationManager 配置了用量索引（FileUsageIndexStore）时，聚合优先读索引：
 * 索引 fresh 的对话不读历史文件，缺失/过期的对话读历史并重建索引（一次性成本）。
 */

import type { MessageHandler } from '../types';
import { aggregateUsageStats, type UsageStatsResult } from '../../backend/modules/conversation/usageStats';

/** 结果缓存 TTL（毫秒）：5 分钟内重复打开直接命中，手动刷新强制重算 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedStats {
    result: UsageStatsResult;
    cachedAt: number;
}

/** 缓存 key 只由时间范围组成；条目数加 LRU 上限（客户端可控 key，无上限会撑爆内存） */
const statsCache = new Map<string, CachedStats>();
const MAX_CACHE_ENTRIES = 20;

function cacheKey(startTime?: number, endTime?: number): string {
    return `${startTime ?? ''}:${endTime ?? ''}`;
}

function setCachedStats(key: string, entry: CachedStats): void {
    statsCache.delete(key);
    statsCache.set(key, entry);
    // 超过上限时淘汰最旧（Map 迭代序 = 插入序）
    while (statsCache.size > MAX_CACHE_ENTRIES) {
        const oldest = statsCache.keys().next().value;
        if (oldest === undefined) break;
        statsCache.delete(oldest);
    }
}

/**
 * 获取用量统计（可选时间范围：startTime / endTime，毫秒时间戳，含端点；
 * force: true 时绕过缓存强制重算）
 */
export const getUsageStats: MessageHandler = async (data, requestId, ctx) => {
  try {
    const startTime = typeof data?.startTime === 'number' && Number.isFinite(data.startTime) ? data.startTime : undefined;
    const endTime = typeof data?.endTime === 'number' && Number.isFinite(data.endTime) ? data.endTime : undefined;
    const force = data?.force === true;

    const key = cacheKey(startTime, endTime);
    const cached = statsCache.get(key);
    if (!force && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      ctx.sendResponse(requestId, cached.result);
      return;
    }

    const stats = await aggregateUsageStats(ctx.conversationManager, {
      startTime,
      endTime,
      indexStore: ctx.conversationManager.getUsageIndexStore()
    });
    setCachedStats(key, { result: stats, cachedAt: Date.now() });
    ctx.sendResponse(requestId, stats);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_USAGE_STATS_ERROR', error?.message || 'Failed to aggregate usage stats');
  }
};

/**
 * 注册用量统计处理器
 */
export function registerUsageHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('usage.getStats', getUsageStats);
}
