/**
 * 使用时间统计消息处理器
 *
 * 提供每日使用时长 / 作息热力 / 连续工作会话数据，
 * 数据来自 ActivityTracker 的按天采样文件。
 *
 * 由于聚合成本极低（每天一个 JSON，最多 1440 个采样点），
 * 仅做 30 秒结果缓存，切换页面/刷新即重新读取。
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import type { MessageHandler } from '../types';
import { getGlobalActivityTracker, getActivityStats } from '../../backend/modules/activity';
import type { ActivityStatsQuery, ActivityStatsResult } from '../../backend/modules/activity';

/** 结果缓存 TTL（毫秒） */
const CACHE_TTL_MS = 30 * 1000;

interface CachedStats {
    result: ActivityStatsResult;
    cachedAt: number;
}

const statsCache = new Map<string, CachedStats>();

function cacheKey(query: ActivityStatsQuery): string {
    return `${query.range ?? '7d'}:${query.includeHourly === true ? 1 : 0}:${query.includeMonthly === true ? 1 : 0}`;
}

/** 清空结果缓存（扩展 dispose 时调用） */
export function disposeActivityStatsCache(): void {
    statsCache.clear();
}

/**
 * 获取使用时间统计
 * range: 'today' | '7d' | '30d' | '90d'（默认 7d）
 * includeHourly: 是否包含 24 小时作息热力（默认 false）
 * force: true 时绕过缓存强制重算
 */
export const getActivityStatsHandler: MessageHandler = async (data, requestId, ctx) => {
    try {
        const tracker = getGlobalActivityTracker();
        if (!tracker) {
            ctx.sendError(requestId, 'ACTIVITY_TRACKER_NOT_READY', 'Activity tracker is not initialized.');
            return;
        }

        const query: ActivityStatsQuery = {
            range: data?.range === 'today' || data?.range === '30d' || data?.range === '90d'
                || data?.range === '365d' || data?.range === 'all'
                ? data.range
                : '7d',
            includeHourly: data?.includeHourly === true,
            includeMonthly: data?.includeMonthly === true
        };
        const force = data?.force === true;

        const key = cacheKey(query);
        const cached = statsCache.get(key);
        if (!force && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            ctx.sendResponse(requestId, cached.result);
            return;
        }

        const result = await getActivityStats(tracker.getStore(), query);
        statsCache.set(key, { result, cachedAt: Date.now() });
        ctx.sendResponse(requestId, result);
    } catch (error: any) {
        ctx.sendError(requestId, 'GET_ACTIVITY_STATS_ERROR', error?.message || 'Failed to load activity stats');
    }
};

/**
 * 注册使用时间统计处理器
 */
export function registerActivityHandlers(registry: Map<string, MessageHandler>): void {
    registry.set(MESSAGE_NAMES['activity.getStats'], getActivityStatsHandler);
}
