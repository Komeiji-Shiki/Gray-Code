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

import { MESSAGE_NAMES } from '../../shared/protocol';
import type { MessageHandler, HandlerContext } from '../types';
import { aggregateUsageStats, type UsageStatsResult } from '../../backend/modules/conversation';
import { UsageStatsCache, startUsageDirectoryWatcher } from '../../backend/modules/conversation';

/** 结果缓存 TTL（毫秒）：5 分钟内重复打开直接命中，手动刷新强制重算 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_STATS_CACHE_ENTRIES = 32;

interface CachedStats {
    result: UsageStatsResult;
    cachedAt: number;
}

/** 缓存 key 只由时间范围组成（全部/今天/近7天/近30天）；条目数加 LRU 上限（客户端可控 key，无上限会撑爆内存） */
const statsCache = new Map<string, CachedStats>();

/** 内存明细缓存与目录监听（懒初始化，宿主 dispose 时释放） */
let usageCache: UsageStatsCache | undefined;
let disposeUsageWatcher: (() => void) | undefined;
/** 当前 watcher 绑定的 conversations 目录（storagePath.migrate 后目录变化需重建） */
let usageCacheDir: string | undefined;
/** watcher 初始化失败时间戳（R2-07）：失败后 WATCHER_RETRY_BACKOFF_MS 内不再重试 */
let watcherInitFailedAt = 0;
/** watcher 初始化失败关联的 conversations 目录（R2-09）：目录迁移后旧失败退避不再适用 */
let watcherInitFailedDir: string | undefined;
/** watcher 初始化失败后的退避窗口（毫秒）：失败通常是目录/FS 权限问题，短时间重试只会重复报错 */
const WATCHER_RETRY_BACKOFF_MS = 30_000;

function cacheKey(startTime?: number, endTime?: number): string {
    return `${startTime ?? ''}:${endTime ?? ''}`;
}

/**
 * 懒初始化用量内存缓存 + 对话目录监听。
 * 拿不到 conversations 目录（内存存储等）时返回 undefined，统计退化全量扫描。
 */
function getOrInitUsageCache(ctx: HandlerContext): UsageStatsCache | undefined {
    const conversationsDir = ctx.conversationManager.getConversationsDirFsPath?.();
    if (!conversationsDir) return undefined;
    // 存储路径迁移后 conversations 目录变化：旧缓存与 watcher 仍绑定旧目录（R2-08 复查）。
    // StoragePathManager 无迁移事件，用「目录与缓存绑定目录不一致」检测迁移并重建。
    if (usageCacheDir !== conversationsDir) {
        disposeUsageWatcher?.();
        disposeUsageWatcher = undefined;
        usageCache = undefined;
        usageCacheDir = undefined;
    }
    // R2-09：初始化失败（无 usageCache）后目录迁移——失败单独记录关联目录
    // watcherInitFailedDir，与当前目录不一致时旧失败退避不再适用，复位以允许对新目录立即重试。
    // （仅当存在失败记录时参与判断，避免成功/首次场景误触发。）
    if (watcherInitFailedDir !== undefined && watcherInitFailedDir !== conversationsDir) {
        watcherInitFailedAt = 0;
        watcherInitFailedDir = undefined;
    }
    if (usageCache) return usageCache;
    // R2-07：watcher 初始化失败后进入退避窗口，避免每次统计请求都重试初始化
    if (watcherInitFailedAt > 0 && Date.now() - watcherInitFailedAt < WATCHER_RETRY_BACKOFF_MS) {
        return undefined;
    }
    const candidate = new UsageStatsCache();
    try {
        const disposeWatcher = startUsageDirectoryWatcher(conversationsDir, candidate);
        usageCache = candidate;
        usageCacheDir = conversationsDir;
        disposeUsageWatcher = disposeWatcher;
        watcherInitFailedAt = 0;
        watcherInitFailedDir = undefined;
        return usageCache;
    } catch (error) {
        usageCache = undefined;
        disposeUsageWatcher = undefined;
        usageCacheDir = undefined;
        watcherInitFailedAt = Date.now();
        watcherInitFailedDir = conversationsDir;
        console.warn('[UsageHandlers] Failed to initialize usage directory watcher:', error);
        return undefined;
    }
}

/** 释放目录监听与内存缓存（宿主 dispose 时调用） */
export function disposeUsageCache(): void {
    disposeUsageWatcher?.();
    disposeUsageWatcher = undefined;
    usageCache = undefined;
    usageCacheDir = undefined;
    // R2-07：扩展重载后重新允许 watcher 初始化重试
    watcherInitFailedAt = 0;
    watcherInitFailedDir = undefined;
    // 结果缓存同样要清空：扩展重载/存储路径迁移后 statsCache 仍会命中旧统计直到 TTL 过期
    statsCache.clear();
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
      indexStore: ctx.conversationManager.getUsageIndexStore(),
      cache: getOrInitUsageCache(ctx)
    });
    const now = Date.now();
    for (const [cacheKey_, entry] of statsCache) {
      if (now - entry.cachedAt >= CACHE_TTL_MS) statsCache.delete(cacheKey_);
    }
    if (!statsCache.has(key) && statsCache.size >= MAX_STATS_CACHE_ENTRIES) {
      const oldestKey = [...statsCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0]?.[0];
      if (oldestKey) statsCache.delete(oldestKey);
    }
    statsCache.set(key, { result: stats, cachedAt: now });
    ctx.sendResponse(requestId, stats);
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_USAGE_STATS_ERROR', error?.message || 'Failed to aggregate usage stats');
  }
};

/**
 * 注册用量统计处理器
 */
export function registerUsageHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES['usage.getStats'], getUsageStats);
}
