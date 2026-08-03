/**
 * 用量统计消息处理器
 *
 * 提供按对话/按模型/按天聚合的 token 用量数据，
 * 数据完全来自已落盘的对话历史（usageMetadata），无需额外打点。
 *
 * 性能分层（从快到慢）：
 * 1. 结果缓存：5 分钟内重复打开统计页直接命中（手动刷新 force: true 绕过）；
 * 2. 内存明细缓存 + 目录监听：日常统计只重读最近被写过的对话，
 *    其余对话直接重放内存明细，不再对每个对话做 stat/读文件；
 * 3. 用量索引（FileUsageIndexStore）：未命中内存缓存时优先读索引，
 *    索引 fresh 的对话不读历史文件，缺失/过期读历史并重建（一次性成本）。
 *
 * 目录监听在首次统计时懒初始化；拿不到目录（非文件存储）时退化为全量扫描。
 */

import type { MessageHandler, HandlerContext } from '../types';
import { aggregateUsageStats, type UsageStatsResult } from '../../backend/modules/conversation/usageStats';
import { UsageStatsCache, startUsageDirectoryWatcher } from '../../backend/modules/conversation/usageCache';

/** 结果缓存 TTL（毫秒）：5 分钟内重复打开直接命中，手动刷新强制重算 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedStats {
    result: UsageStatsResult;
    cachedAt: number;
}

/** 缓存 key 只由时间范围组成（全部/今天/近7天/近30天），条目数有界，无泄漏风险 */
const statsCache = new Map<string, CachedStats>();

/** 内存明细缓存与目录监听（懒初始化，扩展 dispose 时释放） */
let usageCache: UsageStatsCache | undefined;
let disposeUsageWatcher: (() => void) | undefined;

function cacheKey(startTime?: number, endTime?: number): string {
    return `${startTime ?? ''}:${endTime ?? ''}`;
}

/**
 * 懒初始化用量内存缓存 + 对话目录监听。
 * 拿不到 conversations 目录（内存存储等）时返回 undefined，统计退化全量扫描。
 */
function getOrInitUsageCache(ctx: HandlerContext): UsageStatsCache | undefined {
    if (usageCache) return usageCache;
    const conversationsDir = ctx.conversationManager.getConversationsDirFsPath?.();
    if (!conversationsDir) return undefined;
    usageCache = new UsageStatsCache();
    disposeUsageWatcher = startUsageDirectoryWatcher(conversationsDir, usageCache);
    return usageCache;
}

/** 释放目录监听与内存缓存（扩展 dispose 时调用） */
export function disposeUsageCache(): void {
    disposeUsageWatcher?.();
    disposeUsageWatcher = undefined;
    usageCache = undefined;
}

/**
 * 获取用量统计（可选时间范围：startTime / endTime，毫秒时间戳，含端点；
 * force: true 时绕过结果缓存强制重算）
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
      indexStore: ctx.conversationManager.getUsageIndexStore(),
      cache: getOrInitUsageCache(ctx)
    });
    statsCache.set(key, { result: stats, cachedAt: Date.now() });
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
